/**
 * rolloutView.test.mjs — 運用画面の集計
 *   node --test src/lib/marketing/rolloutView.test.mjs
 *
 * 守る性質:
 *   - 購入者を「停止」に混ぜない
 *   - 母集団を読み切れていないときは**割合を作らない**
 *   - 反応率は送信済みが母数（0 通で率を作らない）
 *   - PII を持たない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyMember, buildFunnel, buildStepView, buildRolloutView, assertNoPii,
  MEMBER_STATE,
} from './rolloutView.js';
import { planRolloutTick, defaultRolloutState, ROLLOUT_STAGE, ROLLOUT_BLOCK } from './rolloutPlan.js';

const NOW = Date.parse('2026-08-16T00:00:00Z');

// ── 1 人の分類 ───────────────────────────────────────────────

test('【重要】購入者を「停止」に混ぜない（購入が最優先）', () => {
  assert.equal(classifyMember({ purchased: true, stopped: true, sentCount: 3 }), MEMBER_STATE.PURCHASED);
});

test('最大回数まで送り終えたら「完了」', () => {
  assert.equal(classifyMember({ sentCount: 24, maxSends: 24 }), MEMBER_STATE.COMPLETED);
  assert.equal(classifyMember({ sentCount: 23, maxSends: 24 }), MEMBER_STATE.IN_PROGRESS);
});

test('1 通も出していなければ「未開始」', () => {
  assert.equal(classifyMember({ sentCount: 0 }), MEMBER_STATE.NOT_STARTED);
  assert.equal(classifyMember({}), MEMBER_STATE.NOT_STARTED);
});

test('停止は完了・購入の次に見る', () => {
  assert.equal(classifyMember({ stopped: true, sentCount: 2, maxSends: 10 }), MEMBER_STATE.STOPPED);
});

// ── ファネル ────────────────────────────────────────────────

const rows = [
  { sentCount: 0 },
  { sentCount: 0 },
  { sentCount: 3 },
  { sentCount: 5, purchased: true },
  { sentCount: 2, stopped: true, stopReason: 'unsubscribed' },
  { sentCount: 1, stopped: true, stopReason: 'hard_bounce' },
  { sentCount: 24 },
];

test('5 分類を数え、内訳の合計が観測数と一致する', () => {
  const f = buildFunnel({ rows, maxSends: 24, cohortTotal: 7 });
  assert.deepEqual(f.counts, {
    not_started: 2, in_progress: 1, purchased: 1, stopped: 2, completed: 1,
  });
  assert.equal(f.balanced, true);
  assert.equal(f.observed, 7);
  assert.equal(f.notStarted, 2);
});

test('停止理由の内訳を出す', () => {
  const f = buildFunnel({ rows, maxSends: 24, cohortTotal: 7 });
  assert.deepEqual(f.byStopReason, { unsubscribed: 1, hard_bounce: 1 });
  assert.ok(f.stopReasonLabels.unsubscribed);
});

test('【重要】母集団を読み切れていないときは割合を作らない', () => {
  const partial = buildFunnel({ rows, maxSends: 24, cohortTotal: null });
  assert.equal(partial.partial, true);
  assert.equal(partial.cohortTotal, null);
  const flagged = buildFunnel({ rows, maxSends: 24, cohortTotal: 14479, cohortPartial: true });
  assert.equal(flagged.partial, true, '打ち切りを黙って全体扱いしている');
});

test('母集団が確定していれば partial ではない', () => {
  const f = buildFunnel({ rows, maxSends: 24, cohortTotal: 7, cohortPartial: false });
  assert.equal(f.partial, false);
  assert.equal(f.cohortTotal, 7);
});

// ── Step 別 ─────────────────────────────────────────────────

const stepRows = [
  { sentSteps: [1, 2], dueStep: 3, openedSteps: [1], clickedSteps: [] },
  { sentSteps: [1], waitingStep: 2, openedSteps: [1], clickedSteps: [1] },
  { sentSteps: [1, 2, 3], dueStep: 4, openedSteps: [], clickedSteps: [], failedSteps: [3] },
  { sentSteps: [], dueStep: 1 },
];

test('Step 別に 送信 / いま送れる / 待機 / 失敗 / 反応 を数える', () => {
  const v = buildStepView({ steps: [1, 2, 3, 4], rows: stepRows });
  const s1 = v.find((x) => x.step === 1);
  assert.equal(s1.sent, 3);
  assert.equal(s1.due, 1);
  assert.equal(s1.opened, 2);
  assert.equal(s1.clicked, 1);
  const s2 = v.find((x) => x.step === 2);
  assert.equal(s2.sent, 2);
  assert.equal(s2.waiting, 1);
  const s3 = v.find((x) => x.step === 3);
  assert.equal(s3.failed, 1);
  assert.equal(s3.due, 1);
});

test('【重要】0 通の Step で反応率を作らない', () => {
  const v = buildStepView({ steps: [9], rows: stepRows });
  assert.equal(v[0].sent, 0);
  assert.equal(v[0].openRate, null);
  assert.equal(v[0].clickRate, null);
});

test('反応率は送信済みが母数', () => {
  const v = buildStepView({ steps: [1], rows: stepRows });
  assert.equal(v[0].openRate, 2 / 3);
  assert.equal(v[0].clickRate, 1 / 3);
});

// ── 画面全体 ────────────────────────────────────────────────

const running = (over = {}) => ({
  ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, alwaysArmed: true, ...over,
});

const view = (over = {}) => {
  const state = over.state || running();
  const plan = planRolloutTick({
    state, nowMs: NOW, remainingCandidates: 14479, previousOutstanding: 0, envEnabled: true,
    ...(over.planOver || {}),
  });
  return buildRolloutView({
    state, envEnabled: true, plan,
    funnel: buildFunnel({ rows, maxSends: 24, cohortTotal: 14489 }),
    stepView: buildStepView({ steps: [1, 2, 3, 4], rows: stepRows }),
    remainingCandidates: 14479,
    nextScheduledAtMs: NOW + 24 * 3600_000,
    ...(over.viewOver || {}),
  });
};

test('運用画面に必要な 6 つが揃う', () => {
  const v = view();
  assert.ok(v.control, 'kill switch / 段階');
  assert.ok(v.batch, 'バッチ進行');
  assert.ok(v.funnel, '母集団と 5 分類');
  assert.ok(Array.isArray(v.steps), 'Step 別');
  assert.ok(v.nextScheduledAt, '次回予定');
  assert.equal(v.control.canProceed, true);
});

test('【重要】kill switch の状態と、進めない理由が読める', () => {
  const killed = view({ state: running({ killed: true }) });
  assert.equal(killed.control.killed, true);
  assert.equal(killed.control.canProceed, false);
  assert.equal(killed.control.blockedReason, ROLLOUT_BLOCK.KILLED);
  assert.match(killed.control.blockedLabel, /緊急停止/);
});

test('【重要】残り日数を数字で出す（145 日という現実を隠さない）', () => {
  const v = view();
  assert.equal(v.batch.remainingCandidates, 14479);
  assert.equal(v.batch.estimatedDays, 145);
  const fast = view({ state: running({ dailyLimit: 1000 }) });
  assert.equal(fast.batch.estimatedDays, 15);
});

test('今日進められる件数を出す', () => {
  const v = view();
  assert.equal(v.batch.allowanceToday, 100);
  const killed = view({ state: running({ killed: true }) });
  assert.equal(killed.batch.allowanceToday, 0);
});

test('累計と前回実績を出す', () => {
  const v = view({ state: running({ totalGranted: 110, lastRunDay: '2026-08-15', lastRunCount: 100 }) });
  assert.equal(v.batch.totalGranted, 110);
  assert.equal(v.batch.lastRunCount, 100);
  assert.equal(v.batch.lastRunDay, '2026-08-15');
});

test('【重要】画面へ返す内容に PII を含めない', () => {
  const v = view();
  const r = assertNoPii(v);
  assert.equal(r.ok, true, `PII が含まれる: ${r.reason}`);
  // 検査そのものが機能することも確かめる
  assert.equal(assertNoPii({ x: 'a@example.com' }).ok, false);
  assert.equal(assertNoPii({ x: 'recABCDEFGHIJKLMN' }).ok, false);
});

test('env の許可が無い状態も画面から分かる', () => {
  const state = running();
  const plan = planRolloutTick({
    state, nowMs: NOW, remainingCandidates: 100, previousOutstanding: 0, envEnabled: false,
  });
  const v = buildRolloutView({
    state, envEnabled: false, plan,
    funnel: buildFunnel({ rows, maxSends: 24, cohortTotal: 7 }),
    stepView: [], remainingCandidates: 100, nextScheduledAtMs: null,
  });
  assert.equal(v.control.envEnabled, false);
  assert.equal(v.control.canProceed, false);
  assert.equal(v.nextScheduledAt, null);
});
