/**
 * grantBatchAlignment.test.mjs — 論理 batchSize と「付与 1 回の上限」の分離
 *   node --test src/lib/marketing/grantBatchAlignment.test.mjs
 *
 * 2026-08-17 の本番で 2 回踏んだ silent cap を両方固定する:
 *   午前 … 観測が付与側の既定 100 で打ち切られ、batchSize=500 でも 100 名しか配らなかった
 *   午後 … allowance 400 を 1 回で依頼し、`too_many_records:400>200` で
 *          **granted 0 のまま 14 tick 空回り**（batchSeq だけ進んだ）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planRolloutTick, applyRolloutRun, defaultRolloutState,
  resolveObservationWindow, dailyRoomToday,
  ROLLOUT_STAGE, ROLLOUT_BLOCK, jstDay,
} from './rolloutPlan.js';
import { deriveFacts } from '../../../netlify/functions/cron-marketing-rollout.js';
import { planRolloutStart } from './rolloutControl.js';
import {
  classifyGrantOutcome, describeGrantOutcome, GRANT_OUTCOME, GRANT_FAILURE,
} from './grantOutcome.js';
import {
  GRANT_OPERATION_MAX, HARD_MAX_BATCH_SIZE, DEFAULT_BATCH_SIZE,
  buildTrialOperationId,
} from '../comeback/lightTrialAutoGrant.js';
import { MAX_GRANT_RECORDS, buildComebackPlan } from '../comeback/comebackGrantPlan.js';
import { candidateFormulaAccepts } from '../comeback/lightTrialSelection.js';

const NOW = Date.UTC(2026, 7, 17, 1, 0, 0);   // JST 2026-08-17 10:00
const DAY = jstDay(NOW);

const state = (over = {}) => ({
  ...defaultRolloutState(),
  stage: ROLLOUT_STAGE.SCALE,
  dailyLimit: 500,
  batchSize: 500,
  alwaysArmed: false,
  armedFor: DAY,
  ...over,
});

/** 本番と同じ順序（観測窓 → 事実 → 計画）で 1 tick 進める */
function tick({ s, cohortSize, previousOutstanding = 0, nowMs = NOW }) {
  const window = resolveObservationWindow(s, nowMs, { perCallMax: GRANT_OPERATION_MAX });
  const observed = Math.min(window, cohortSize);
  const facts = deriveFacts({
    barrier: { outstanding: previousOutstanding },
    moreAvailable: cohortSize > observed,
    pendingJobs: 0,
    candidatesObserved: observed,
    cohortObserved: observed,
  });
  const plan = planRolloutTick({
    state: s, nowMs,
    remainingCandidates: facts.remainingCandidates,
    previousOutstanding: facts.outstandingStep1,
    envEnabled: true,
  });
  return { window, facts, plan };
}

/** 付与が計画どおり通った前提で、同じ日を回し切る */
function runDay({ s, cohortSize, nowMs = NOW, maxTicks = 40 }) {
  let cur = s;
  const granted = [];
  const ops = [];
  for (let i = 0; i < maxTicks; i += 1) {
    const r = tick({ s: cur, cohortSize: cohortSize - granted.reduce((a, b) => a + b, 0), nowMs });
    if (!r.plan.ok) return { granted, ops, state: cur, stoppedBy: r.plan.reason };
    granted.push(r.plan.allowance);
    ops.push(buildTrialOperationId(nowMs, r.plan.batchSeq));
    cur = applyRolloutRun({ state: cur, nowMs, granted: r.plan.allowance, batchSeq: r.plan.batchSeq });
  }
  return { granted, ops, state: cur, stoppedBy: null };
}

// ── 1 回の依頼人数を、実際に扱える上限へ揃える ──────────────────────

test('【重要】付与 1 回の上限は 2 つの既存上限の小さい方（重複定数を作らない）', () => {
  assert.equal(GRANT_OPERATION_MAX, Math.min(HARD_MAX_BATCH_SIZE, MAX_GRANT_RECORDS));
  assert.equal(GRANT_OPERATION_MAX, 200, '実効上限が 200 でない（計画側の上限とズレている）');
  assert.ok(GRANT_OPERATION_MAX < HARD_MAX_BATCH_SIZE, '低い方が勝っていない');
});

test('【重要】計画側の上限を超えると計画自体が作られない（これが 400 空回りの原因）', () => {
  const selected = Array.from({ length: MAX_GRANT_RECORDS + 1 }, (_, i) => ({
    recordId: `rec${String(i).padStart(14, '0')}`, fields: {}, marketing: {},
  }));
  const plan = buildComebackPlan({
    grantOffers: [], purchaseOffer: null, selected,
    nowMs: NOW, operationId: `light-trial-${DAY}`, actor: 'test', source: 'test',
  });
  assert.equal(plan.ok, false, '201 件の計画が作れてしまう（上限が効いていない）');
});

test('【重要】batchSize=500 は同じ日に 200 + 200 + 100 で 500 まで進む', () => {
  const r = runDay({ s: state(), cohortSize: 14_000 });
  assert.deepEqual(r.granted, [200, 200, 100]);
  assert.equal(r.granted.reduce((a, b) => a + b, 0), 500);
  assert.equal(r.state.dayGrantedCount, 500);
  assert.equal(r.stoppedBy, ROLLOUT_BLOCK.DAILY_LIMIT_REACHED);
  assert.equal(new Set(r.ops).size, 3, 'operationId が重複している（再付与になる）');
  assert.equal(r.ops[0], `light-trial-${DAY}`, '1 バッチ目が従来の形でない');
});

test('【重要】batchSize=1000 は 200 × 5 で 1000 まで進む', () => {
  const r = runDay({ s: state({ dailyLimit: 1000, batchSize: 1000 }), cohortSize: 14_000 });
  assert.deepEqual(r.granted, [200, 200, 200, 200, 200]);
  assert.equal(r.state.dayGrantedCount, 1000);
  assert.equal(new Set(r.ops).size, 5);
});

test('【重要】今日すでに 100 名なら 200 + 200 で残り 400 を配り切る', () => {
  const s = state({ lastRunDay: DAY, dayGrantedCount: 100, batchSeq: 1 });
  assert.equal(dailyRoomToday(s, NOW), 400);
  const r = runDay({ s, cohortSize: 14_000 });
  assert.deepEqual(r.granted, [200, 200]);
  assert.equal(r.state.dayGrantedCount, 500, '1 日上限を超えている / 届いていない');
  assert.equal(r.stoppedBy, ROLLOUT_BLOCK.DAILY_LIMIT_REACHED);
});

test('【重要】既定 100 への silent cap を復活させない', () => {
  for (const size of [500, 1000]) {
    const w = resolveObservationWindow(
      state({ dailyLimit: 15_000, batchSize: size }), NOW, { perCallMax: GRANT_OPERATION_MAX },
    );
    assert.notEqual(w, DEFAULT_BATCH_SIZE, `batchSize=${size} が既定 100 に落ちている`);
    assert.equal(w, GRANT_OPERATION_MAX);
  }
});

test('batchSize=500 / 1000 とも従来どおり保存できる（新しい制約を足さない）', () => {
  const req = {
    stage: ROLLOUT_STAGE.SCALE, dailyLimit: 15_000,
    alwaysArmed: false, armedFor: DAY, expectedVersion: 1,
  };
  for (const size of [200, 500, 1000]) {
    const r = planRolloutStart({ current: state(), exists: true, nowMs: NOW, req: { ...req, batchSize: size } });
    assert.equal(r.ok, true, `batchSize=${size} を断っている: ${r.reason}`);
    assert.equal(r.state.batchSize, size);
  }
});

test('関所が閉じていれば新規付与 0（既存の安全契約）', () => {
  const r = tick({ s: state(), cohortSize: 14_000, previousOutstanding: 3 });
  assert.equal(r.plan.ok, false);
  assert.equal(r.plan.reason, ROLLOUT_BLOCK.WAITING_PREVIOUS);
  assert.equal(r.plan.allowance, 0);
});

test('付与済みの人は候補に戻らない（再付与 0）', () => {
  const base = { Source: 'customer-import:imp-2026-08-09-001', Email: 'x@example.com' };
  assert.equal(candidateFormulaAccepts(base), true);
  assert.equal(candidateFormulaAccepts({ ...base, LightGrantedAt: '2026-08-17T04:40:00.000Z' }), false);
  assert.equal(candidateFormulaAccepts({ ...base, LightGrantLifetime: true }), false);
});

// ── 0 件だった実行を「成功」として記録しない ───────────────────────

test('【重要】予定があったのに 0 件なら settle しない（batchSeq も日次集計も進めない）', () => {
  const v = classifyGrantOutcome({
    requested: 400, granted: 0, failed: 0, abort: `too_many_records:400>${MAX_GRANT_RECORDS}`,
  });
  assert.equal(v.outcome, GRANT_OUTCOME.FAILED);
  assert.equal(v.reason, GRANT_FAILURE.ABORTED);
  assert.equal(v.settle, false, '0 件の実行を記録しようとしている');
  assert.equal(v.pause, true, '空回りを止めない');

  // settle しない = 状態が 1 ミリも動かない
  const before = state({ lastRunDay: DAY, dayGrantedCount: 100, batchSeq: 1, lastRunCount: 100 });
  const after = v.settle
    ? applyRolloutRun({ state: before, nowMs: NOW, granted: 0, batchSeq: 2 })
    : before;
  assert.equal(after.batchSeq, 1, 'batchSeq が進んでいる');
  assert.equal(after.dayGrantedCount, 100, '日次集計が動いている');
  assert.equal(after.lastRunCount, 100, 'lastRunCount=0 を正常実行として記録している');
});

test('【重要】同じ異常で cron ごとに無限に空回りしない（自動停止する）', () => {
  let s = state();
  let ticks = 0;
  for (let i = 0; i < 10; i += 1) {
    const r = tick({ s, cohortSize: 14_000 });
    if (!r.plan.ok) break;
    ticks += 1;
    // 付与側が毎回同じ異常を返す状況
    const v = classifyGrantOutcome({ requested: r.plan.allowance, granted: 0, abort: 'too_many_records:400>200' });
    if (v.pause) { s = { ...s, stage: ROLLOUT_STAGE.PAUSED }; break; }
    s = applyRolloutRun({ state: s, nowMs: NOW, granted: 0, batchSeq: r.plan.batchSeq });
  }
  assert.equal(ticks, 1, `${ticks} 回空回りしている（1 回で止まるべき）`);
  assert.equal(s.stage, ROLLOUT_STAGE.PAUSED);
  const stopped = tick({ s, cohortSize: 14_000 });
  assert.equal(stopped.plan.ok, false);
  assert.equal(stopped.plan.reason, ROLLOUT_BLOCK.PAUSED);
});

test('【重要】正常な「候補 0」と実行エラーを区別する', () => {
  const idle = classifyGrantOutcome({ requested: 200, granted: 0, abort: 'no_candidates' });
  assert.equal(idle.outcome, GRANT_OUTCOME.IDLE);
  assert.equal(idle.settle, false, '候補 0 で状態を汚している');
  assert.equal(idle.pause, false, '候補 0 で止めてしまっている');

  const wrote = classifyGrantOutcome({ requested: 200, granted: 0, failed: 200, abort: null });
  assert.equal(wrote.outcome, GRANT_OUTCOME.FAILED);
  assert.equal(wrote.reason, GRANT_FAILURE.WRITE_FAILED);

  const silent = classifyGrantOutcome({ requested: 200, granted: 0 });
  assert.equal(silent.reason, GRANT_FAILURE.ZERO_WITHOUT_REASON, '理由不明の 0 件を成功にしている');
});

test('部分成功は実数で記録する（配れた分は無かったことにしない）', () => {
  const v = classifyGrantOutcome({ requested: 200, granted: 173, failed: 27 });
  assert.equal(v.outcome, GRANT_OUTCOME.GRANTED);
  assert.equal(v.settle, true);
  assert.equal(v.pause, false);
  assert.equal(v.granted, 173);
  const s = applyRolloutRun({ state: state(), nowMs: NOW, granted: v.granted, batchSeq: 1 });
  assert.equal(s.dayGrantedCount, 173);
});

test('報告用の説明に PII も secret も混ぜない', () => {
  const d = describeGrantOutcome(classifyGrantOutcome({
    requested: 400, granted: 0, abort: 'too_many_records:400>200',
  }));
  const dump = JSON.stringify(d);
  assert.equal(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(dump), false, 'メールアドレスが混ざっている');
  assert.equal(/rec[A-Za-z0-9]{14}/.test(dump), false, 'recordId が混ざっている');
  assert.equal(d.detail, 'too_many_records:400>200');
});

test('operationId はバッチごとに一意・同じバッチなら同じ（冪等性の土台）', () => {
  assert.equal(buildTrialOperationId(NOW, 1), `light-trial-${DAY}`);
  assert.equal(buildTrialOperationId(NOW, 3), buildTrialOperationId(NOW + 60_000, 3));
  assert.notEqual(buildTrialOperationId(NOW, 3), buildTrialOperationId(NOW, 4));
});
