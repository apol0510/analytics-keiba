/**
 * rolloutPlan.test.mjs — 段階展開の判断
 *   node --test src/lib/marketing/rolloutPlan.test.mjs
 *
 * 守る性質:
 *   - 既定は**止まっている**（何もしなければ 1 通も出ない）
 *   - kill switch は段階より強く、**次の tick から効く**
 *   - 同じ日に二重に走らせない
 *   - 前回ぶんの Step1 が片付くまで次を配らない
 *   - 読めない値は「0 件」ではなく**停止**（fail closed）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planRolloutTick, applyRolloutRun, normalizeRolloutState, defaultRolloutState,
  resolveDailyLimit, suggestNextStage, estimateRemainingDays, jstDay,
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

test('【重要】同じ日に二重に走らせない', () => {
  const r = tick({ state: running({ lastRunDay: DAY }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, ROLLOUT_BLOCK.ALREADY_RAN_TODAY);
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

test('【重要】実行後は同じ日にもう一度走らせない印が付く', () => {
  const after = applyRolloutRun({ state: running(), nowMs: NOW, granted: 100 });
  assert.equal(after.lastRunDay, DAY);
  assert.equal(after.lastRunCount, 100);
  assert.equal(after.totalGranted, 100);
  const again = planRolloutTick({
    state: after, nowMs: NOW, remainingCandidates: 100, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(again.reason, ROLLOUT_BLOCK.ALREADY_RAN_TODAY);
});

test('累計は積み上がる', () => {
  let s = running({ totalGranted: 10 });
  s = applyRolloutRun({ state: s, nowMs: NOW, granted: 100 });
  assert.equal(s.totalGranted, 110);
});

test('日付指定の運用は 1 回で自動的に閉じる', () => {
  const s = { ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, armedFor: DAY };
  const after = applyRolloutRun({ state: s, nowMs: NOW, granted: 10 });
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
