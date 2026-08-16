/**
 * rolloutPlan.test.mjs — 段階展開の判断
 *   node --test src/lib/marketing/rolloutPlan.test.mjs
 *
 * 守る性質:
 *   - 既定は**止まっている**（何もしなければ 1 通も出ない）
 *   - kill switch は段階より強く、**次の tick から効く**
 *   - 同じ日でも**上限の範囲でバッチを重ねられる**（関所が直列化する）
 *   - 前回ぶんの Step1 が片付くまで次を配らない
 *   - 読めない値は「0 件」ではなく**停止**（fail closed）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planRolloutTick, applyRolloutRun, normalizeRolloutState, defaultRolloutState,
  resolveDailyLimit, resolveBatchSize, grantedToday, suggestNextStage, estimateRemainingDays, jstDay,
  ROLLOUT_STAGE, ROLLOUT_BLOCK, STAGE_DEFAULT_DAILY, HARD_DAILY_MAX,
} from './rolloutPlan.js';

/** 2026-08-16 09:00 JST */
const NOW = Date.parse('2026-08-16T00:00:00Z');
const DAY = jstDay(NOW);

const running = (over = {}) => ({
  ...defaultRolloutState(),
  stage: ROLLOUT_STAGE.STEADY,
  alwaysArmed: true,
  ...over,
});

const tick = (over = {}) => planRolloutTick({
  state: running(),
  nowMs: NOW,
  remainingCandidates: 14479,
  previousOutstanding: 0,
  envEnabled: true,
  ...over,
});

// ── 既定は止まっている ────────────────────────────────────────

test('【重要】既定の状態では 1 件も進めない', () => {
  const r = planRolloutTick({
    state: defaultRolloutState(), nowMs: NOW,
    remainingCandidates: 14479, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.allowance, 0);
  assert.equal(r.reason, ROLLOUT_BLOCK.PAUSED);
});

test('【重要】env のマスタースイッチが無ければ進めない（コード側の最後の砦）', () => {
  const r = tick({ envEnabled: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, ROLLOUT_BLOCK.PAUSED);
});

test('【重要】kill switch は段階より強い（即時停止）', () => {
  const r = tick({ state: running({ killed: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.allowance, 0);
  assert.equal(r.reason, ROLLOUT_BLOCK.KILLED);
});

// ── 正常系と段階 ─────────────────────────────────────────────

test('通常運用では段階の既定件数だけ進む', () => {
  const r = tick();
  assert.equal(r.ok, true);
  assert.equal(r.allowance, STAGE_DEFAULT_DAILY.steady);
  assert.equal(r.stage, ROLLOUT_STAGE.STEADY);
  assert.equal(r.day, DAY);
});

test('段階ごとに既定件数が変わる（10 → 100 → 500）', () => {
  assert.equal(tick({ state: running({ stage: ROLLOUT_STAGE.CANARY }) }).allowance, 10);
  assert.equal(tick({ state: running({ stage: ROLLOUT_STAGE.STEADY }) }).allowance, 100);
  assert.equal(tick({ state: running({ stage: ROLLOUT_STAGE.SCALE }) }).allowance, 500);
});

test('【重要】1 日あたりの上限は状態で変えられる（env の開閉・redeploy は不要）', () => {
  assert.equal(tick({ state: running({ dailyLimit: 250 }) }).allowance, 250);
  assert.equal(tick({ state: running({ dailyLimit: 0 }) }).reason, ROLLOUT_BLOCK.DAILY_LIMIT_REACHED);
});

test('【重要】絶対上限を超える指定は頭打ちにする（状態が壊れても暴走しない）', () => {
  assert.equal(resolveDailyLimit({ stage: ROLLOUT_STAGE.SCALE, dailyLimit: 999999 }), HARD_DAILY_MAX);
  assert.equal(tick({ state: running({ dailyLimit: 999999 }) }).allowance, HARD_DAILY_MAX);
});

test('残り候補が上限より少なければ残りだけ進む', () => {
  assert.equal(tick({ remainingCandidates: 37 }).allowance, 37);
});

// ── 二重実行・関所・fail closed ────────────────────────────────

test('【重要】同じ日でも上限の範囲なら次のバッチへ進める（1 日 1 回をやめた）', () => {
  // 今日すでに 100 名配ったが、1 日上限 2000・バッチ 500 なのでまだ進める
  const r = tick({
    state: running({ lastRunDay: DAY, dayGrantedCount: 100, dailyLimit: 2000, batchSize: 500 }),
  });
  assert.equal(r.ok, true, `止まっている: ${r.reason}`);
  assert.equal(r.allowance, 500);
  assert.equal(r.grantedToday, 100);
});

test('【重要】今日の合計が 1 日上限に達したら止まる', () => {
  const r = tick({
    state: running({ lastRunDay: DAY, dayGrantedCount: 2000, dailyLimit: 2000, batchSize: 500 }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, ROLLOUT_BLOCK.DAILY_LIMIT_REACHED);
});

test('【重要】1 日上限の残りがバッチ未満なら、残りぶんだけ配る', () => {
  const r = tick({
    state: running({ lastRunDay: DAY, dayGrantedCount: 1800, dailyLimit: 2000, batchSize: 500 }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.allowance, 200, '上限を超えて配ろうとしている');
});

test('【重要】日付が変われば今日の集計は 0 に戻る', () => {
  const YESTERDAY = jstDay(NOW - 86400_000);
  const s = running({ lastRunDay: YESTERDAY, dayGrantedCount: 2000, dailyLimit: 2000, batchSize: 500 });
  assert.equal(grantedToday(s, NOW), 0);
  const r = tick({ state: s });
  assert.equal(r.ok, true);
  assert.equal(r.allowance, 500);
});

test('【重要】バッチ番号は同じ日の中で増える（operationId の枝番になる）', () => {
  const first = tick({ state: running({ lastRunDay: null, batchSize: 500, dailyLimit: 2000 }) });
  assert.equal(first.batchSeq, 1);
  const second = tick({
    state: running({ lastRunDay: DAY, batchSeq: 1, dayGrantedCount: 500, batchSize: 500, dailyLimit: 2000 }),
  });
  assert.equal(second.batchSeq, 2);
  // 日付が変われば 1 から
  const nextDay = tick({
    state: running({
      lastRunDay: jstDay(NOW - 86400_000), batchSeq: 4, dayGrantedCount: 2000,
      batchSize: 500, dailyLimit: 2000,
    }),
  });
  assert.equal(nextDay.batchSeq, 1);
});

test('【重要】バッチ人数は 1 日上限を超えない', () => {
  assert.equal(resolveBatchSize({ ...defaultRolloutState(), dailyLimit: 300, batchSize: 500 }), 300);
  assert.equal(resolveBatchSize({ ...defaultRolloutState(), stage: 'scale', batchSize: null }), 500);
});

test('【重要】前回ぶんの Step1 が残っていれば次を配らない（関所）', () => {
  const r = tick({ previousOutstanding: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, ROLLOUT_BLOCK.WAITING_PREVIOUS);
});

test('【重要】読めない値は 0 件ではなく停止（fail closed）', () => {
  assert.equal(tick({ previousOutstanding: null }).reason, ROLLOUT_BLOCK.STATE_UNREADABLE);
  assert.equal(tick({ remainingCandidates: null }).reason, ROLLOUT_BLOCK.STATE_UNREADABLE);
  assert.equal(tick({ remainingCandidates: 'たくさん' }).reason, ROLLOUT_BLOCK.STATE_UNREADABLE);
});

test('対象がいなければ進めない', () => {
  assert.equal(tick({ remainingCandidates: 0 }).reason, ROLLOUT_BLOCK.NO_CANDIDATES);
});

test('配り終えた状態では進めない', () => {
  assert.equal(tick({ state: running({ stage: ROLLOUT_STAGE.COMPLETED }) }).reason, ROLLOUT_BLOCK.COMPLETED);
});

// ── armed（日付指定）と継続運用 ────────────────────────────────

test('【重要】日付指定の運用では、置きっぱなしでも翌日には効かない', () => {
  const s = { ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, armedFor: '2026-08-15' };
  const r = planRolloutTick({
    state: s, nowMs: NOW, remainingCandidates: 100, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, ROLLOUT_BLOCK.NOT_ARMED);
});

test('日付を今日に合わせれば進む', () => {
  const s = { ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, armedFor: DAY };
  const r = planRolloutTick({
    state: s, nowMs: NOW, remainingCandidates: 100, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(r.ok, true);
});

test('【重要】継続運用（alwaysArmed）では毎日の日付置き直しが要らない', () => {
  const r = tick();
  assert.equal(r.ok, true, '毎日 env を触らないと止まる設計になっている');
});

// ── 実行後の状態 ─────────────────────────────────────────────

test('【重要】実行後は今日の集計とバッチ番号が進む', () => {
  const after = applyRolloutRun({ state: running(), nowMs: NOW, granted: 100, batchSeq: 1 });
  assert.equal(after.lastRunDay, DAY);
  assert.equal(after.lastRunCount, 100);
  assert.equal(after.dayGrantedCount, 100);
  assert.equal(after.batchSeq, 1);
  assert.equal(after.totalGranted, 100);
});

test('【重要】同じ日に続けて実行すると集計が積み上がる（1 日上限まで）', () => {
  let s = running({ dailyLimit: 2000, batchSize: 500 });
  for (let i = 1; i <= 4; i += 1) {
    const p = planRolloutTick({
      state: s, nowMs: NOW, remainingCandidates: 10000, previousOutstanding: 0, envEnabled: true,
    });
    assert.equal(p.ok, true, `${i} バッチ目で止まった: ${p.reason}`);
    assert.equal(p.batchSeq, i);
    s = applyRolloutRun({ state: s, nowMs: NOW, granted: p.allowance, batchSeq: p.batchSeq });
  }
  assert.equal(s.dayGrantedCount, 2000);
  assert.equal(s.totalGranted, 2000);
  const done = planRolloutTick({
    state: s, nowMs: NOW, remainingCandidates: 10000, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(done.reason, ROLLOUT_BLOCK.DAILY_LIMIT_REACHED);
});

test('【重要】関所が閉じている間は同じ日でも次のバッチを始めない', () => {
  const s = running({ lastRunDay: DAY, dayGrantedCount: 500, batchSize: 500, dailyLimit: 2000 });
  const p = planRolloutTick({
    state: s, nowMs: NOW, remainingCandidates: 10000, previousOutstanding: 12, envEnabled: true,
  });
  assert.equal(p.ok, false);
  assert.equal(p.reason, ROLLOUT_BLOCK.WAITING_PREVIOUS);
});

test('累計は積み上がる', () => {
  let s = running({ totalGranted: 10 });
  s = applyRolloutRun({ state: s, nowMs: NOW, granted: 100 });
  assert.equal(s.totalGranted, 110);
});

test('【重要】武装した日はその日のうちバッチを続けられる（翌日には失効する）', () => {
  const s = { ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, armedFor: DAY, batchSize: 500, dailyLimit: 2000 };
  const after = applyRolloutRun({ state: s, nowMs: NOW, granted: 500, batchSeq: 1 });
  assert.equal(after.armedFor, DAY, '同じ日の 2 バッチ目が not_armed で止まる');
  const next = planRolloutTick({
    state: after, nowMs: NOW, remainingCandidates: 10000, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(next.ok, true);
  // 翌日は武装が効かない
  const tomorrow = planRolloutTick({
    state: after, nowMs: NOW + 86400_000, remainingCandidates: 10000, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(tomorrow.reason, ROLLOUT_BLOCK.NOT_ARMED);
});

test('【重要】armedFor が今日でなければ、実行しても付け直さない（置きっぱなし防止）', () => {
  const s = { ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, armedFor: jstDay(NOW - 86400_000) };
  const after = applyRolloutRun({ state: s, nowMs: NOW, granted: 10, batchSeq: 1 });
  assert.equal(after.armedFor, null, '置きっぱなしになる');
});

// ── 正規化（壊れた状態を安全側へ）──────────────────────────────

test('【重要】壊れた状態は既定（停止）へ倒す', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const s = normalizeRolloutState(bad);
    assert.equal(s.stage, ROLLOUT_STAGE.PAUSED, `${String(bad)} を動く状態にしている`);
    assert.equal(s.killed, false);
  }
  const weird = normalizeRolloutState({ stage: 'とても速い', dailyLimit: -5, armedFor: 'きょう' });
  assert.equal(weird.stage, ROLLOUT_STAGE.PAUSED);
  assert.equal(weird.dailyLimit, null);
  assert.equal(weird.armedFor, null);
});

test('note は長さを制限する（画面・ログを壊さない）', () => {
  const s = normalizeRolloutState({ note: 'あ'.repeat(1000) });
  assert.ok(s.note.length <= 200);
});

// ── 段階の提案（自動では上げない）──────────────────────────────

test('【重要】実績が読めなければ段階を上げない', () => {
  const r = suggestNextStage({ state: running(), deliveredRate: null, bounceRate: 0.01, complaintRate: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.stage, ROLLOUT_STAGE.STEADY);
});

test('【重要】バウンス・苦情が高ければ停止を提案する', () => {
  const b = suggestNextStage({ state: running(), deliveredRate: 0.99, bounceRate: 0.06, complaintRate: 0 });
  assert.equal(b.stage, ROLLOUT_STAGE.PAUSED);
  const c = suggestNextStage({ state: running(), deliveredRate: 0.99, bounceRate: 0.01, complaintRate: 0.002 });
  assert.equal(c.stage, ROLLOUT_STAGE.PAUSED);
});

test('実績が基準内なら次段階を提案する（適用は人が決める）', () => {
  const r = suggestNextStage({ state: running({ stage: ROLLOUT_STAGE.CANARY }), deliveredRate: 0.98, bounceRate: 0.01, complaintRate: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.stage, ROLLOUT_STAGE.STEADY);
  // 最大段階では上げない
  const top = suggestNextStage({ state: running({ stage: ROLLOUT_STAGE.SCALE }), deliveredRate: 0.98, bounceRate: 0.01, complaintRate: 0 });
  assert.equal(top.ok, false);
});

test('到達率が低ければ据え置く', () => {
  const r = suggestNextStage({ state: running({ stage: ROLLOUT_STAGE.CANARY }), deliveredRate: 0.8, bounceRate: 0.01, complaintRate: 0 });
  assert.equal(r.ok, false);
});

// ── 見積り ──────────────────────────────────────────────────

test('残り日数の見積り（14,479 名の現実を数字で出す）', () => {
  assert.equal(estimateRemainingDays({ remainingCandidates: 14479, dailyLimit: 100 }), 145);
  assert.equal(estimateRemainingDays({ remainingCandidates: 14479, dailyLimit: 500 }), 29);
  assert.equal(estimateRemainingDays({ remainingCandidates: 14479, dailyLimit: 2000 }), 8);
  assert.equal(estimateRemainingDays({ remainingCandidates: 100, dailyLimit: 0 }), null);
  assert.equal(estimateRemainingDays({ remainingCandidates: null, dailyLimit: 100 }), null);
});

test('JST の暦日で切る（UTC 基準にしない）', () => {
  // 2026-08-15 23:30 UTC = 2026-08-16 08:30 JST
  assert.equal(jstDay(Date.parse('2026-08-15T23:30:00Z')), '2026-08-16');
  // 2026-08-16 00:30 UTC = 2026-08-16 09:30 JST
  assert.equal(jstDay(Date.parse('2026-08-16T00:30:00Z')), '2026-08-16');
  // 2026-08-15 14:00 UTC = 2026-08-15 23:00 JST
  assert.equal(jstDay(Date.parse('2026-08-15T14:00:00Z')), '2026-08-15');
});
