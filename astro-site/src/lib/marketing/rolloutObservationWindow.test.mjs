/**
 * rolloutObservationWindow.test.mjs
 *
 * 「候補の観測窓」が展開状態（`batchSize` / 今日の残り枠）と一致することを固定する。
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 2026-08-17 の本番事故: `batchSize=500 / dailyLimit=500` で `rolloutStart` したのに、
 * tick が **100 名しか付与しなかった**。事実収集が付与側の既定バッチ（100）で
 * 候補を打ち切って読んでいたため、`remainingCandidates=100` になり、
 * `allowance = min(batchSize, dailyRoom, remaining)` が **エラーを出さずに** 100 へ縮んだ。
 *
 * ここでは「窓 → 事実 → allowance」の 1 本を通しで固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planRolloutTick, applyRolloutRun, defaultRolloutState,
  resolveObservationWindow, dailyRoomToday, resolveBatchSize,
  ROLLOUT_STAGE, ROLLOUT_BLOCK, jstDay,
} from './rolloutPlan.js';
import { deriveFacts } from '../../../netlify/functions/cron-marketing-rollout.js';
import { planRolloutStart } from './rolloutControl.js';
import {
  buildTrialOperationId, HARD_MAX_BATCH_SIZE, DEFAULT_BATCH_SIZE, resolveBatchSize as resolveGrantBatchSize,
} from '../comeback/lightTrialAutoGrant.js';
import { candidateFormulaAccepts } from '../comeback/lightTrialSelection.js';

/** 2026-08-17 10:00 JST */
const NOW = Date.UTC(2026, 7, 17, 1, 0, 0);
const DAY = jstDay(NOW);

/** 展開状態（scale / 当日武装済み）を作る */
function state(over = {}) {
  return {
    ...defaultRolloutState(),
    stage: ROLLOUT_STAGE.SCALE,
    dailyLimit: 500,
    batchSize: 500,
    alwaysArmed: false,
    armedFor: DAY,
    ...over,
  };
}

/**
 * 本番と同じ順序で「観測 → 事実 → 計画」を通す。
 * `cohortSize` は**まだ配っていない候補の総数**（テスト内の真の値）。
 */
function tickThrough({ s, cohortSize, previousOutstanding = 0, nowMs = NOW }) {
  // 本番の tick と同じ引数（付与 1 回の上限を渡す）
  const window = resolveObservationWindow(s, nowMs, { perCallMax: HARD_MAX_BATCH_SIZE });
  // bounded 取得の再現: 窓のぶんだけ取れる。取り切れなければ「まだ居る」
  const observed = Math.min(window, cohortSize);
  const moreAvailable = cohortSize > observed;
  const facts = deriveFacts({
    barrier: { outstanding: previousOutstanding },
    moreAvailable,
    pendingJobs: 0,
    candidatesObserved: observed,
    cohortObserved: observed,
    followUpStep: null,
    followUpDue: null,
  });
  const plan = planRolloutTick({
    state: s,
    nowMs,
    remainingCandidates: facts.remainingCandidates,
    previousOutstanding: facts.outstandingStep1,
    envEnabled: true,
  });
  return { window, observed, facts, plan };
}

test('batchSize=500 なら観測窓も 500 で、GRANT は 500 名', () => {
  const s = state();
  const r = tickThrough({ s, cohortSize: 14_000 });
  assert.equal(r.window, 500, '観測窓が batchSize と一致していない（silent cap の再発）');
  assert.equal(r.observed, 500);
  assert.equal(r.plan.ok, true, `止まった: ${r.plan.reason}`);
  assert.equal(r.plan.allowance, 500, '500 名ぶん配れていない');
  assert.equal(r.plan.batchSeq, 1);
});

test('付与側の既定（100）へ黙って縮まない', () => {
  const s = state();
  const r = tickThrough({ s, cohortSize: 14_000 });
  assert.notEqual(r.plan.allowance, 100, '2026-08-17 の事故と同じ 100 名に落ちている');
  assert.equal(resolveBatchSize(s), 500);
});

test('今日すでに 100 名配っていれば、次の allowance は残り 400', () => {
  const s = state({ lastRunDay: DAY, dayGrantedCount: 100, batchSeq: 1 });
  assert.equal(dailyRoomToday(s, NOW), 400);
  const r = tickThrough({ s, cohortSize: 14_000 });
  assert.equal(r.window, 400, '観測窓が今日の残り枠に合っていない（400 を超えて取ろうとしている）');
  assert.equal(r.plan.ok, true, `止まった: ${r.plan.reason}`);
  assert.equal(r.plan.allowance, 400, '1 日上限を超える / 下回る配り方になっている');
  assert.equal(r.plan.batchSeq, 2, '同じ日の 2 バッチ目として数えていない');
});

test('1 日上限を使い切ったらその日はもう配らない', () => {
  const s = state({ lastRunDay: DAY, dayGrantedCount: 500, batchSeq: 2 });
  assert.equal(dailyRoomToday(s, NOW), 0);
  assert.equal(resolveObservationWindow(s, NOW), 0, '配れないのに候補を読もうとしている');
  const r = tickThrough({ s, cohortSize: 14_000 });
  assert.equal(r.plan.ok, false);
  assert.equal(r.plan.reason, ROLLOUT_BLOCK.DAILY_LIMIT_REACHED);
  assert.equal(r.plan.allowance, 0);
});

test('bounded の観測件数を「全残数」と読み替えない', () => {
  const s = state();
  const r = tickThrough({ s, cohortSize: 14_000 });
  // 実際は 14,000 人いるが、観測できたのは 500 人だけ
  assert.equal(r.facts.remainingCandidates, 500);
  assert.equal(r.facts.remainingIsLowerBound, true, '下限であることを持ち回っていない');
  assert.ok(r.facts.remainingCandidates < 14_000, '観測値を全残数として扱っている');

  // 取り切れた（moreAvailable=false）ときだけ確定値
  const tail = tickThrough({ s, cohortSize: 30 });
  assert.equal(tail.facts.remainingCandidates, 30);
  assert.equal(tail.facts.remainingIsLowerBound, false);
  assert.equal(tail.plan.allowance, 30, '最後の端数を配れずに取りこぼしている');
});

test('数えられないものは 0 で埋めない（fail closed）', () => {
  const unreadable = deriveFacts({
    barrier: null, moreAvailable: true, pendingJobs: 0,
    candidatesObserved: 500, cohortObserved: 500,
  });
  assert.equal(unreadable.remainingCandidates, null);
  assert.equal(unreadable.remainingIsLowerBound, false);

  const noFlag = deriveFacts({
    barrier: { outstanding: 0 }, moreAvailable: null, pendingJobs: 0,
    candidatesObserved: 500, cohortObserved: 500,
  });
  assert.equal(noFlag.remainingCandidates, null, 'moreAvailable 不明で件数を確定させている');

  const s = state();
  const stopped = planRolloutTick({
    state: s, nowMs: NOW, remainingCandidates: null, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, ROLLOUT_BLOCK.STATE_UNREADABLE);
});

test('前のバッチが片付いていなければ新規付与 0（関所は維持）', () => {
  const s = state();
  const r = tickThrough({ s, cohortSize: 14_000, previousOutstanding: 7 });
  assert.equal(r.plan.ok, false);
  assert.equal(r.plan.reason, ROLLOUT_BLOCK.WAITING_PREVIOUS);
  assert.equal(r.plan.allowance, 0);
});

test('緊急停止と一時停止は観測窓に関係なく優先される', () => {
  const killed = tickThrough({ s: state({ killed: true }), cohortSize: 14_000 });
  assert.equal(killed.plan.ok, false);
  assert.equal(killed.plan.reason, ROLLOUT_BLOCK.KILLED);

  const paused = tickThrough({ s: state({ stage: ROLLOUT_STAGE.PAUSED }), cohortSize: 14_000 });
  assert.equal(paused.plan.ok, false);
  assert.equal(paused.plan.reason, ROLLOUT_BLOCK.PAUSED);
});

test('2026-08-17 の続き: 100 名付与済みの状態から残り 400 を計画できる', () => {
  // 実際に起きた 1 バッチ目（100 名）を適用した状態から始める
  const afterBatch1 = applyRolloutRun({
    state: state(), nowMs: NOW, granted: 100, batchSeq: 1,
  });
  assert.equal(afterBatch1.dayGrantedCount, 100, '今日の集計が保持されていない');
  assert.equal(afterBatch1.batchSeq, 1);

  const r = tickThrough({ s: afterBatch1, cohortSize: 14_000 });
  assert.equal(r.plan.allowance, 400);
  assert.equal(r.plan.batchSeq, 2);
  assert.equal(
    buildTrialOperationId(NOW, r.plan.batchSeq), `light-trial-${DAY}-b2`,
    '2 バッチ目の operationId が 1 バッチ目と衝突している（再付与になる）',
  );
});

test('operationId は同じバッチなら同じ・別バッチなら別（冪等性の土台）', () => {
  assert.equal(buildTrialOperationId(NOW, 1), `light-trial-${DAY}`);
  assert.equal(buildTrialOperationId(NOW, 1), buildTrialOperationId(NOW, 1));
  assert.notEqual(buildTrialOperationId(NOW, 2), buildTrialOperationId(NOW, 1));
});

test('付与済みの人は候補に戻らない（既存 100 名の再付与 0）', () => {
  const base = {
    Source: 'customer-import:imp-2026-08-09-001',
    Email: 'x@example.com',
    UnsubscribedAnalyticsKeiba: false,
  };
  assert.equal(candidateFormulaAccepts(base), true, '未付与の人が候補から漏れている');
  // 2026-08-17 に配った 100 名はこの形で記録される
  assert.equal(candidateFormulaAccepts({
    ...base, LightGrantedAt: '2026-08-17T04:40:00.000Z', LightGrantUntil: '2026-09-16',
  }), false, '付与済みの人を再び候補にしている');
  assert.equal(candidateFormulaAccepts({ ...base, LightGrantLifetime: true }), false);
  assert.equal(candidateFormulaAccepts({ ...base, PremiumGrantedAt: '2026-08-01' }), false);
});

// ── 500 / 1000 いずれの刻みも使える（新たに狭めない）──────────────────

test('【重要】batchSize=1000 も従来どおり保存できる（今回の修正で禁止しない）', () => {
  const req = {
    stage: ROLLOUT_STAGE.SCALE, dailyLimit: 15_000,
    alwaysArmed: false, armedFor: DAY, expectedVersion: 1,
  };
  for (const size of [100, 500, 1000]) {
    const r = planRolloutStart({
      current: state(), exists: true, nowMs: NOW, req: { ...req, batchSize: size },
    });
    assert.equal(r.ok, true, `batchSize=${size} を断っている: ${r.reason}`);
    assert.equal(r.state.batchSize, size);
    assert.equal(r.expectedVersion, 1, 'CAS の前提値が落ちている');
  }
});

test('【重要】batchSize=1000 でも付与側の既定 100 へ落ちない（silent cap の再発防止）', () => {
  const s = state({ dailyLimit: 15_000, batchSize: 1000 });
  const r = tickThrough({ s, cohortSize: 14_000 });
  assert.notEqual(r.plan.allowance, DEFAULT_BATCH_SIZE, '既定 100 へ縮んでいる（事故の再発）');
  assert.ok(r.plan.allowance >= HARD_MAX_BATCH_SIZE, `${r.plan.allowance} 名しか配ろうとしていない`);
  assert.equal(r.plan.ok, true, `止まった: ${r.plan.reason}`);
});

test('【重要】1 回の付与呼び出しは付与側の上限（500）を超えない＝ fail closed させない', () => {
  // 付与側は 500 超の指定を**実行しない**（#319 以来の既存仕様）。
  // だから観測窓＝1 回の依頼人数は 500 で刻む（断るのではなく分ける）。
  assert.equal(resolveGrantBatchSize({ LIGHT_TRIAL_AUTOGRANT_BATCH_SIZE: '1000' }).ok, false);
  assert.equal(resolveGrantBatchSize({ LIGHT_TRIAL_AUTOGRANT_BATCH_SIZE: '500' }).ok, true);

  const s = state({ dailyLimit: 15_000, batchSize: 1000 });
  const window = resolveObservationWindow(s, NOW, { perCallMax: HARD_MAX_BATCH_SIZE });
  assert.equal(window, HARD_MAX_BATCH_SIZE, '付与側が断る人数を 1 回で依頼しようとしている');
  // 上限を渡さなければ設定どおり（純粋な計画としては 1000）
  assert.equal(resolveObservationWindow(s, NOW), 1000);
});

test('【重要】batchSize=1000 は同じ日に 500 + 500 で進む（設定を拒否せず配り切る）', () => {
  let s = state({ dailyLimit: 15_000, batchSize: 1000 });
  const granted = [];
  const ops = [];
  for (let i = 0; i < 2; i += 1) {
    const r = tickThrough({ s, cohortSize: 14_000 });
    assert.equal(r.plan.ok, true, `${i + 1} 回目で止まった: ${r.plan.reason}`);
    granted.push(r.plan.allowance);
    ops.push(buildTrialOperationId(NOW, r.plan.batchSeq));
    s = applyRolloutRun({ state: s, nowMs: NOW, granted: r.plan.allowance, batchSeq: r.plan.batchSeq });
  }
  assert.deepEqual(granted, [500, 500]);
  assert.equal(s.dayGrantedCount, 1000, '1000 名ぶん進んでいない');
  assert.equal(new Set(ops).size, 2, 'operationId が重複している（再付与になる）');
});

test('batchSize=1000 でも今日の残り枠を超えない（100 付与済みなら 400）', () => {
  const s = state({ dailyLimit: 500, batchSize: 1000, lastRunDay: DAY, dayGrantedCount: 100, batchSeq: 1 });
  const r = tickThrough({ s, cohortSize: 14_000 });
  assert.equal(r.window, 400);
  assert.equal(r.plan.allowance, 400, '1 日上限を超えて配ろうとしている');
});
