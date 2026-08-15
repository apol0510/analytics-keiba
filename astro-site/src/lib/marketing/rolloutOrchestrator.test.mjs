/**
 * rolloutOrchestrator.test.mjs — 1 tick の判断（付与 → queue → dispatch）
 *   node --test src/lib/marketing/rolloutOrchestrator.test.mjs
 *
 * 守る性質:
 *   - **積み残しを先に片付ける**（付与だけ増えて案内が出ない人を作らない）
 *   - 事実が読めないなら何もしない（推測で付与・送信しない）
 *   - 同じ日に二重に配らない / 途中で落ちても次の tick が続きを拾う
 *   - kill switch は次の tick から効く
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  tickRollout, planQueueAfterGrant, settleTick, describeTick,
  TICK_ACTION, TICK_BLOCK,
} from './rolloutOrchestrator.js';
import { defaultRolloutState, ROLLOUT_STAGE, ROLLOUT_BLOCK, jstDay } from './rolloutPlan.js';

const NOW = Date.parse('2026-08-16T00:00:00Z');
const DAY = 24 * 3600_000;

const running = (over = {}) => ({
  ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, alwaysArmed: true, ...over,
});

const facts = (over = {}) => ({
  remainingCandidates: 14479,
  grantedPendingQueue: 0,
  pendingJobs: 0,
  outstandingStep1: 0,
  ...over,
});

const tick = (over = {}) => tickRollout({
  state: running(), nowMs: NOW, envEnabled: true, facts: facts(), ...over,
});

// ── 積み残しを先に片付ける ────────────────────────────────────

test('【重要】付与済みで queue していない人がいれば、新しく配る前に queue する', () => {
  const r = tick({ facts: facts({ grantedPendingQueue: 37 }) });
  assert.equal(r.action, TICK_ACTION.QUEUE);
  assert.equal(r.count, 37);
});

test('【重要】送信待ちのジョブがあれば、新しく配る前に送信を起動する', () => {
  const r = tick({ facts: facts({ pendingJobs: 2 }) });
  assert.equal(r.action, TICK_ACTION.DISPATCH);
  assert.equal(r.count, 2);
});

test('queue の積み残しは dispatch より先（案内が出ない人を先に救う）', () => {
  const r = tick({ facts: facts({ grantedPendingQueue: 5, pendingJobs: 3 }) });
  assert.equal(r.action, TICK_ACTION.QUEUE);
});

test('積み残しが無ければ新しく配る', () => {
  const r = tick();
  assert.equal(r.action, TICK_ACTION.GRANT);
  assert.equal(r.count, 100);
});

// ── 事実が読めないとき ──────────────────────────────────────

test('【重要】事実が 1 つでも読めなければ何もしない', () => {
  for (const k of ['remainingCandidates', 'grantedPendingQueue', 'pendingJobs', 'outstandingStep1']) {
    const r = tick({ facts: facts({ [k]: null }) });
    assert.equal(r.action, TICK_ACTION.SKIP, `${k} が不明でも進んでいる`);
    assert.equal(r.reason, TICK_BLOCK.FACTS_UNREADABLE);
  }
});

test('壊れた値も「読めない」として扱う', () => {
  const r = tick({ facts: facts({ remainingCandidates: 'たくさん' }) });
  assert.equal(r.action, TICK_ACTION.SKIP);
});

// ── 止める条件 ──────────────────────────────────────────────

test('【重要】kill switch が入っていれば配らない', () => {
  const r = tick({ state: running({ killed: true }) });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.KILLED);
});

test('【重要】env の許可が無ければ配らない', () => {
  const r = tick({ envEnabled: false });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.PAUSED);
});

test('【重要】同じ日に二度配らない', () => {
  const r = tick({ state: running({ lastRunDay: jstDay(NOW) }) });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.ALREADY_RAN_TODAY);
});

test('【重要】関所（前回ぶんの未処理）が残っていれば配らない', () => {
  const r = tick({ facts: facts({ outstandingStep1: 4 }) });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.WAITING_PREVIOUS);
});

test('候補がいなければ配らない', () => {
  const r = tick({ facts: facts({ remainingCandidates: 0 }) });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.NO_CANDIDATES);
});

// ── 付与後の queue 対象 ─────────────────────────────────────

test('【重要】queue するのは付与できた人だけ', () => {
  const r = planQueueAfterGrant({ grantedRecordIds: ['recA', 'recB', null, '', 'recC'] });
  assert.equal(r.count, 3);
  assert.deepEqual(r.recordIds, ['recA', 'recB', 'recC']);
});

test('1 人も付与できなければ queue しない', () => {
  assert.equal(planQueueAfterGrant({ grantedRecordIds: [] }).count, 0);
  assert.equal(planQueueAfterGrant({}).count, 0);
});

// ── 状態の更新 ──────────────────────────────────────────────

test('【重要】付与した数だけを刻む（queue が落ちても二重に配らない）', () => {
  const after = settleTick({ state: running(), nowMs: NOW, granted: 100 });
  assert.equal(after.lastRunDay, jstDay(NOW));
  assert.equal(after.lastRunCount, 100);
  assert.equal(after.totalGranted, 100);
  // 同じ日にもう一度 tick しても配らない
  const again = tickRollout({ state: after, nowMs: NOW, envEnabled: true, facts: facts() });
  assert.equal(again.action, TICK_ACTION.SKIP);
  assert.equal(again.reason, ROLLOUT_BLOCK.ALREADY_RAN_TODAY);
});

// ── 通しで回す ──────────────────────────────────────────────

test('【重要】付与 → queue → dispatch が tick をまたいで続く', () => {
  let state = running();
  const seen = [];
  // 1 tick 目: 付与
  let r = tickRollout({ state, nowMs: NOW, envEnabled: true, facts: facts() });
  seen.push(r.action);
  assert.equal(r.action, TICK_ACTION.GRANT);
  state = settleTick({ state, nowMs: NOW, granted: r.count });

  // 2 tick 目（同じ日）: 付与は済んでいるが queue が残っている → queue
  r = tickRollout({
    state, nowMs: NOW + 3600_000, envEnabled: true,
    facts: facts({ grantedPendingQueue: 100 }),
  });
  seen.push(r.action);
  assert.equal(r.action, TICK_ACTION.QUEUE);
  assert.equal(r.count, 100);

  // 3 tick 目: queue 済み → 送信を起動
  r = tickRollout({
    state, nowMs: NOW + 2 * 3600_000, envEnabled: true,
    facts: facts({ pendingJobs: 1 }),
  });
  seen.push(r.action);
  assert.equal(r.action, TICK_ACTION.DISPATCH);

  // 4 tick 目: 片付いた。同じ日なので次は配らない
  r = tickRollout({ state, nowMs: NOW + 3 * 3600_000, envEnabled: true, facts: facts() });
  seen.push(r.action);
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.ALREADY_RAN_TODAY);

  // 翌日は再び配る
  r = tickRollout({ state, nowMs: NOW + DAY, envEnabled: true, facts: facts({ remainingCandidates: 14379 }) });
  seen.push(r.action);
  assert.equal(r.action, TICK_ACTION.GRANT);

  assert.deepEqual(seen, ['grant', 'queue', 'dispatch', 'skip', 'grant']);
});

test('【重要】14,479 名を tick の繰り返しで配り切れる（人手を挟まない）', () => {
  let state = running({ dailyLimit: 500 });
  let remaining = 14_479;
  let day = 0;
  let granted = 0;
  let guard = 0;
  while (remaining > 0 && guard < 2000) {
    guard += 1;
    const nowMs = NOW + day * DAY;
    // 1 日のうちに 付与 → queue → dispatch を tick で進める
    let r = tickRollout({ state, nowMs, envEnabled: true, facts: facts({ remainingCandidates: remaining }) });
    if (r.action === TICK_ACTION.SKIP && r.reason === ROLLOUT_BLOCK.ALREADY_RAN_TODAY) { day += 1; continue; }
    assert.equal(r.action, TICK_ACTION.GRANT, `${day} 日目で止まった: ${r.reason}`);
    const n = r.count;
    state = settleTick({ state, nowMs, granted: n });
    remaining -= n;
    granted += n;

    // queue と dispatch は同じ日の後続 tick で片付く
    r = tickRollout({ state, nowMs: nowMs + 3600_000, envEnabled: true, facts: facts({ grantedPendingQueue: n }) });
    assert.equal(r.action, TICK_ACTION.QUEUE);
    r = tickRollout({ state, nowMs: nowMs + 2 * 3600_000, envEnabled: true, facts: facts({ pendingJobs: 1 }) });
    assert.equal(r.action, TICK_ACTION.DISPATCH);
    day += 1;
  }
  assert.equal(remaining, 0, '配り切れていない');
  assert.equal(granted, 14_479);
  assert.equal(state.totalGranted, 14_479);
  assert.equal(day, Math.ceil(14_479 / 500), `${day} 日かかっている`);
});

test('【重要】途中で kill すると次の tick から止まる', () => {
  let state = running({ dailyLimit: 500 });
  let r = tickRollout({ state, nowMs: NOW, envEnabled: true, facts: facts() });
  assert.equal(r.action, TICK_ACTION.GRANT);
  state = settleTick({ state, nowMs: NOW, granted: r.count });
  // 緊急停止
  state = { ...state, killed: true };
  r = tickRollout({ state, nowMs: NOW + DAY, envEnabled: true, facts: facts() });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.KILLED);
});

test('describeTick は件数と理由だけを返す（PII なし）', () => {
  const r = tick();
  const d = describeTick(r);
  assert.equal(d.action, 'grant');
  assert.equal(d.count, 100);
  assert.equal(d.stage, ROLLOUT_STAGE.STEADY);
  assert.equal(JSON.stringify(d).includes('@'), false);
});
