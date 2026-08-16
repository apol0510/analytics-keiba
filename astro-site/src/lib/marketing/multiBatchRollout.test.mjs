/**
 * multiBatchRollout.test.mjs — 同じ日に複数バッチを回す（グループ配信）
 *   node --test src/lib/marketing/multiBatchRollout.test.mjs
 *
 * 「1 日 1 回」をやめた代わりに何が守っているかを固定する:
 *   - 関所（前バッチが片付くまで次を始めない）＝ バッチの直列化
 *   - 1 日の**合計人数**の上限（回数ではない）
 *   - バッチごとに一意な operationId（同じ値の再実行は冪等）
 *   - 前バッチの結果が悪ければ**自分で止まる**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planRolloutTick, applyRolloutRun, defaultRolloutState, jstDay,
  ROLLOUT_STAGE, ROLLOUT_BLOCK, HARD_DAILY_MAX,
} from './rolloutPlan.js';
import { buildTrialOperationId } from '../comeback/lightTrialAutoGrant.js';
import { canStartNextBatch, BATCH_STOP } from './batchHealth.js';

const NOW = Date.parse('2026-08-17T01:00:00Z');   // JST 10:00
const DAY = jstDay(NOW);

const scale = (over = {}) => ({
  ...defaultRolloutState(),
  stage: ROLLOUT_STAGE.SCALE,
  dailyLimit: 2000,
  batchSize: 500,
  alwaysArmed: false,
  armedFor: DAY,
  ...over,
});

/** 1 バッチ回す（関所は「片付いた」前提） */
function runBatch(state, { remaining = 14000, outstanding = 0, nowMs = NOW } = {}) {
  const plan = planRolloutTick({
    state, nowMs, remainingCandidates: remaining, previousOutstanding: outstanding, envEnabled: true,
  });
  if (!plan.ok) return { plan, state };
  return {
    plan,
    state: applyRolloutRun({ state, nowMs, granted: plan.allowance, batchSeq: plan.batchSeq }),
    operationId: buildTrialOperationId(nowMs, plan.batchSeq),
  };
}

test('【重要】同じ日に 500 名 × 4 バッチまで進み、そこで止まる', () => {
  let s = scale();
  const ops = [];
  for (let i = 1; i <= 4; i += 1) {
    const r = runBatch(s);
    assert.equal(r.plan.ok, true, `${i} バッチ目で止まった: ${r.plan.reason}`);
    assert.equal(r.plan.allowance, 500);
    ops.push(r.operationId);
    s = r.state;
  }
  assert.equal(s.dayGrantedCount, 2000);
  const fifth = runBatch(s);
  assert.equal(fifth.plan.ok, false);
  assert.equal(fifth.plan.reason, ROLLOUT_BLOCK.DAILY_LIMIT_REACHED);

  // ── バッチごとに operationId が違う（＝別の付与として記録される）──
  assert.equal(new Set(ops).size, 4, `operationId が重複している: ${ops.join(', ')}`);
  assert.equal(ops[0], `light-trial-${DAY}`, '1 バッチ目は従来と同じ形でない（既存データと不整合）');
  assert.deepEqual(ops.slice(1), [
    `light-trial-${DAY}-b2`, `light-trial-${DAY}-b3`, `light-trial-${DAY}-b4`,
  ]);
});

test('【重要】前バッチが片付くまで次のバッチを始めない（直列化）', () => {
  let s = scale();
  const first = runBatch(s);
  s = first.state;
  // Step1 がまだ 500 名ぶん未処理
  const blocked = planRolloutTick({
    state: s, nowMs: NOW, remainingCandidates: 14000, previousOutstanding: 500, envEnabled: true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, ROLLOUT_BLOCK.WAITING_PREVIOUS);
  // 片付けば進む
  const next = runBatch(s);
  assert.equal(next.plan.ok, true);
  assert.equal(next.plan.batchSeq, 2);
});

test('【重要】同じバッチの再実行は同じ operationId（付与が冪等）', () => {
  const a = buildTrialOperationId(NOW, 2);
  const b = buildTrialOperationId(NOW + 5 * 60_000, 2);   // 同じ日・同じバッチ番号
  assert.equal(a, b);
  // 別バッチなら必ず別
  assert.notEqual(buildTrialOperationId(NOW, 2), buildTrialOperationId(NOW, 3));
  // 翌日は別
  assert.notEqual(buildTrialOperationId(NOW, 2), buildTrialOperationId(NOW + 86400_000, 2));
});

test('【重要】1 日上限は絶対上限を超えられない', () => {
  const s = scale({ dailyLimit: HARD_DAILY_MAX + 5000, batchSize: HARD_DAILY_MAX + 1000 });
  const r = planRolloutTick({
    state: s, nowMs: NOW, remainingCandidates: 100000, previousOutstanding: 0, envEnabled: true,
  });
  assert.ok(r.allowance <= HARD_DAILY_MAX, `${r.allowance} 名配ろうとしている`);
});

test('【重要】残り候補がバッチ人数より少なければ、残りぶんだけ', () => {
  const r = runBatch(scale(), { remaining: 120 });
  assert.equal(r.plan.allowance, 120);
});

test('【重要】緊急停止は同日バッチにも優先する', () => {
  const r = planRolloutTick({
    state: scale({ killed: true }), nowMs: NOW,
    remainingCandidates: 14000, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, ROLLOUT_BLOCK.KILLED);
});

test('【重要】武装した日のうちは複数バッチ、翌日は止まる', () => {
  let s = scale();
  s = runBatch(s).state;
  s = runBatch(s).state;
  assert.equal(s.dayGrantedCount, 1000);
  const tomorrow = planRolloutTick({
    state: s, nowMs: NOW + 86400_000, remainingCandidates: 14000, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(tomorrow.ok, false);
  assert.equal(tomorrow.reason, ROLLOUT_BLOCK.NOT_ARMED, '翌日も勝手に配っている');
});

test('【重要】前バッチの結果が悪ければ次を始めない（自動停止の材料）', () => {
  // 送信失敗が多い
  assert.equal(canStartNextBatch({
    sent: 500, failed: 100, duplicates: 0, bounces: 0, complaints: 0, unsubscribes: 0,
    previousOutstanding: 0, suppressionReadable: true,
  }).reason, BATCH_STOP.FAILED_RATE);
  // 二重が出た
  assert.equal(canStartNextBatch({
    sent: 500, failed: 0, duplicates: 2, bounces: 0, complaints: 0, unsubscribes: 0,
    previousOutstanding: 0, suppressionReadable: true,
  }).reason, BATCH_STOP.DUPLICATES);
  // 数えられない
  assert.equal(canStartNextBatch({
    sent: 500, failed: null, duplicates: 0, bounces: 0, complaints: 0, unsubscribes: 0,
    previousOutstanding: 0, suppressionReadable: true,
  }).reason, BATCH_STOP.UNREADABLE);
});

test('【重要】1 日 1 バッチの運用も従来どおりできる（batchSize 未指定）', () => {
  let s = { ...defaultRolloutState(), stage: ROLLOUT_STAGE.CANARY, dailyLimit: 100, alwaysArmed: false, armedFor: DAY };
  const first = runBatch(s, { remaining: 14000 });
  assert.equal(first.plan.allowance, 100);
  s = first.state;
  const second = runBatch(s, { remaining: 14000 });
  assert.equal(second.plan.ok, false);
  assert.equal(second.plan.reason, ROLLOUT_BLOCK.DAILY_LIMIT_REACHED, '上限を超えて配っている');
});

test('15,000 件を 500 名 × 2000/日 で配り切る日数', () => {
  let s = scale();
  let remaining = 15000;
  let day = 0;
  let guard = 0;
  while (remaining > 0 && guard < 200) {
    guard += 1;
    const nowMs = NOW + day * 86400_000;
    // その日の武装（運用では毎日 rolloutStart で armedFor を入れる）
    s = { ...s, armedFor: jstDay(nowMs) };
    let progressed = false;
    for (let b = 0; b < 10; b += 1) {
      const r = runBatch(s, { remaining, nowMs });
      if (!r.plan.ok) break;
      remaining -= r.plan.allowance;
      s = r.state;
      progressed = true;
    }
    assert.equal(progressed, true, `${day} 日目に 1 バッチも進まなかった`);
    day += 1;
  }
  assert.equal(remaining, 0);
  assert.equal(day, Math.ceil(15000 / 2000), `${day} 日かかっている`);
});
