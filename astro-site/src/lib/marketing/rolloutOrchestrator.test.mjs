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
import {
  defaultRolloutState, ROLLOUT_STAGE, ROLLOUT_BLOCK, jstDay, resolveDailyLimit,
} from './rolloutPlan.js';

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
  followUpStep: null,
  followUpDue: 0,
  ...over,
});

/** 工程ゲートが全部開いている env（**既定は閉**なので、開けた形を明示する） */
const ENV_OPEN = Object.freeze({
  MARKETING_ROLLOUT_ENABLED: 'true',
  COMEBACK_GRANT_FIELDS_READY: '1',
  COMEBACK_GRANT_ENABLED: 'true',
  LIGHT_TRIAL_AUTOGRANT_ENABLED: 'true',
  MARKETING_CAMPAIGN_ENABLED: 'true',
  MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
});

const tick = (over = {}) => tickRollout({
  state: running(), nowMs: NOW, envEnabled: true, facts: facts(), env: ENV_OPEN, ...over,
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

test('【重要】送信待ちが最優先（積んだのに出ていないメールを放置しない）', () => {
  const r = tick({ facts: facts({ grantedPendingQueue: 5, pendingJobs: 3 }) });
  assert.equal(r.action, TICK_ACTION.DISPATCH);
});

// ── Step2〜24（既存ユーザーの期日）─────────────────────────────

test('【重要】期日が来た Step があれば、新しく配るより先に積む', () => {
  const r = tick({ facts: facts({ followUpStep: 7, followUpDue: 42 }) });
  assert.equal(r.action, TICK_ACTION.FOLLOW_UP);
  assert.equal(r.step, 7);
  assert.equal(r.count, 42);
});

test('期日 0 名なら follow-up しない（新規付与へ進む）', () => {
  const r = tick({ facts: facts({ followUpStep: 7, followUpDue: 0 }) });
  assert.equal(r.action, TICK_ACTION.GRANT);
});

test('【重要】期日が読めなければ follow-up しない（推測で送らない）', () => {
  const r = tick({ facts: facts({ followUpStep: null, followUpDue: 42 }) });
  assert.equal(r.action, TICK_ACTION.GRANT, '何通目か不明なのに積んでいる');
});

test('【重要】送信待ち → queue 漏れ → 期日 → 新規付与 の順', () => {
  const all = { grantedPendingQueue: 5, pendingJobs: 3, followUpStep: 7, followUpDue: 42 };
  assert.equal(tick({ facts: facts(all) }).action, TICK_ACTION.DISPATCH);
  assert.equal(tick({ facts: facts({ ...all, pendingJobs: 0 }) }).action, TICK_ACTION.QUEUE);
  assert.equal(tick({ facts: facts({ ...all, pendingJobs: 0, grantedPendingQueue: 0 }) }).action, TICK_ACTION.FOLLOW_UP);
  assert.equal(
    tick({ facts: facts({ ...all, pendingJobs: 0, grantedPendingQueue: 0, followUpDue: 0 }) }).action,
    TICK_ACTION.GRANT,
  );
});

// ── 工程ゲート（既存 env を迂回しない）───────────────────────────

test('【重要】キュー登録の env が閉じていれば queue しない', () => {
  const env = { ...ENV_OPEN, MARKETING_CAMPAIGN_ENABLED: '' };
  const r = tick({ env, facts: facts({ grantedPendingQueue: 5 }) });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, TICK_BLOCK.GATE_CLOSED_QUEUE);
});

test('【重要】実送信の env が閉じていれば送信を起動しない', () => {
  const env = { ...ENV_OPEN, MARKETING_CAMPAIGN_DISPATCH_ENABLED: '' };
  const r = tick({ env, facts: facts({ pendingJobs: 2 }) });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, TICK_BLOCK.GATE_CLOSED_DISPATCH);
});

test('【重要】付与の env が閉じていれば付与しない', () => {
  const env = { ...ENV_OPEN, COMEBACK_GRANT_ENABLED: '' };
  const r = tick({ env });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, TICK_BLOCK.GATE_CLOSED_GRANT);
});

test('【重要】Step2〜24 もキュー登録ゲートに従う', () => {
  const env = { ...ENV_OPEN, MARKETING_CAMPAIGN_ENABLED: '' };
  const r = tick({ env, facts: facts({ followUpStep: 7, followUpDue: 42 }) });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, TICK_BLOCK.GATE_CLOSED_QUEUE);
});

test('【重要】env を渡さなければ何も進めない（既定は閉）', () => {
  const r = tickRollout({ state: running(), nowMs: NOW, envEnabled: true, facts: facts() });
  assert.equal(r.action, TICK_ACTION.SKIP);
});

test('閉じている env の名前をそのまま返す（運用者が開けられるように）', () => {
  const env = { ...ENV_OPEN, MARKETING_CAMPAIGN_DISPATCH_ENABLED: '' };
  const r = tick({ env, facts: facts({ pendingJobs: 2 }) });
  const names = (r.gates.blocked || []).flatMap((b) => b.missing);
  assert.ok(names.includes('MARKETING_CAMPAIGN_DISPATCH_ENABLED'), names.join(','));
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
  const again = tickRollout({ state: after, nowMs: NOW, envEnabled: true, facts: facts(), env: ENV_OPEN });
  assert.equal(again.action, TICK_ACTION.SKIP);
  assert.equal(again.reason, ROLLOUT_BLOCK.ALREADY_RAN_TODAY);
});

// ── 通しで回す ──────────────────────────────────────────────

test('【重要】付与 → queue → dispatch が tick をまたいで続く', () => {
  let state = running();
  const seen = [];
  // 1 tick 目: 付与
  let r = tickRollout({ state, nowMs: NOW, envEnabled: true, facts: facts(), env: ENV_OPEN });
  seen.push(r.action);
  assert.equal(r.action, TICK_ACTION.GRANT);
  state = settleTick({ state, nowMs: NOW, granted: r.count });

  // 2 tick 目（同じ日）: 付与は済んでいるが queue が残っている → queue
  r = tickRollout({
    state, nowMs: NOW + 3600_000, envEnabled: true, env: ENV_OPEN,
    facts: facts({ grantedPendingQueue: 100 }),
  });
  seen.push(r.action);
  assert.equal(r.action, TICK_ACTION.QUEUE);
  assert.equal(r.count, 100);

  // 3 tick 目: queue 済み → 送信を起動
  r = tickRollout({
    state, nowMs: NOW + 2 * 3600_000, envEnabled: true, env: ENV_OPEN,
    facts: facts({ pendingJobs: 1 }),
  });
  seen.push(r.action);
  assert.equal(r.action, TICK_ACTION.DISPATCH);

  // 4 tick 目: 片付いた。同じ日なので次は配らない
  r = tickRollout({ state, nowMs: NOW + 3 * 3600_000, envEnabled: true, facts: facts(), env: ENV_OPEN });
  seen.push(r.action);
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.ALREADY_RAN_TODAY);

  // 翌日は再び配る
  r = tickRollout({ state, nowMs: NOW + DAY, envEnabled: true, env: ENV_OPEN, facts: facts({ remainingCandidates: 14379 }) });
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
    let r = tickRollout({ state, nowMs, envEnabled: true, env: ENV_OPEN, facts: facts({ remainingCandidates: remaining }) });
    if (r.action === TICK_ACTION.SKIP && r.reason === ROLLOUT_BLOCK.ALREADY_RAN_TODAY) { day += 1; continue; }
    assert.equal(r.action, TICK_ACTION.GRANT, `${day} 日目で止まった: ${r.reason}`);
    const n = r.count;
    state = settleTick({ state, nowMs, granted: n });
    remaining -= n;
    granted += n;

    // queue と dispatch は同じ日の後続 tick で片付く
    r = tickRollout({ state, nowMs: nowMs + 3600_000, envEnabled: true, env: ENV_OPEN, facts: facts({ grantedPendingQueue: n }) });
    assert.equal(r.action, TICK_ACTION.QUEUE);
    r = tickRollout({ state, nowMs: nowMs + 2 * 3600_000, envEnabled: true, env: ENV_OPEN, facts: facts({ pendingJobs: 1 }) });
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
  let r = tickRollout({ state, nowMs: NOW, envEnabled: true, facts: facts(), env: ENV_OPEN });
  assert.equal(r.action, TICK_ACTION.GRANT);
  state = settleTick({ state, nowMs: NOW, granted: r.count });
  // 緊急停止
  state = { ...state, killed: true };
  r = tickRollout({ state, nowMs: NOW + DAY, envEnabled: true, facts: facts(), env: ENV_OPEN });
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

// ── one-shot（当日だけ武装）────────────────────────────────────
//    100 名カナリアは「1 回だけ配って、結果を見るまで次を配らない」。
//    そのため `alwaysArmed: false` + `armedFor: <当日>` で始める。
//    ⚠️ このとき**積み残し（queue / 送信）まで止めてはいけない**。
//       止めると、付与だけされて案内が届かない人が残る。

const oneShot = (nowMs) => ({
  ...defaultRolloutState(),
  stage: ROLLOUT_STAGE.CANARY,
  dailyLimit: 100,
  alwaysArmed: false,
  armedFor: jstDay(nowMs),
});

test('【重要】one-shot: 武装した当日は配る', () => {
  const state = oneShot(NOW);
  const r = tickRollout({ state, nowMs: NOW, envEnabled: true, facts: facts(), env: ENV_OPEN });
  assert.equal(r.action, TICK_ACTION.GRANT);
  assert.equal(r.count, 100, 'dailyLimit が stage 既定（canary=10）を上書きしていない');
});

test('【重要】one-shot: 翌日は新規付与を止める（自動で次バッチへ進まない）', () => {
  const state = oneShot(NOW);
  const r = tickRollout({ state, nowMs: NOW + DAY, envEnabled: false, facts: facts(), env: ENV_OPEN });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.PAUSED);
});

test('【重要】one-shot: 武装が切れても queue の積み残しは進む', () => {
  const state = oneShot(NOW);
  const r = tickRollout({
    state, nowMs: NOW + DAY, envEnabled: false,
    facts: facts({ grantedPendingQueue: 100 }), env: ENV_OPEN,
  });
  assert.equal(r.action, TICK_ACTION.QUEUE, '付与した人への案内が止まっている');
  assert.equal(r.count, 100);
});

test('【重要】one-shot: 武装が切れても送信待ちジョブは流す（何日経っても）', () => {
  const state = oneShot(NOW);
  for (const days of [1, 3, 30]) {
    const r = tickRollout({
      state, nowMs: NOW + days * DAY, envEnabled: false,
      facts: facts({ pendingJobs: 1 }), env: ENV_OPEN,
    });
    assert.equal(r.action, TICK_ACTION.DISPATCH, `${days} 日後に送信が止まっている`);
  }
});

test('【重要】one-shot: 武装が切れても期日の follow-up は進む', () => {
  const state = oneShot(NOW);
  const r = tickRollout({
    state, nowMs: NOW + 10 * DAY, envEnabled: false,
    facts: facts({ followUpStep: 2, followUpDue: 40 }), env: ENV_OPEN,
  });
  assert.equal(r.action, TICK_ACTION.FOLLOW_UP, '続きの通が止まっている');
});

test('stage は実装が持つ 5 値のみ（画面・runbook が勝手な値を使わない）', () => {
  assert.deepEqual(Object.values(ROLLOUT_STAGE), ['paused', 'canary', 'steady', 'scale', 'completed']);
});

test('【重要】dailyLimit は stage 既定を上書きする（canary でも 100 名にできる）', () => {
  assert.equal(resolveDailyLimit({ ...defaultRolloutState(), stage: ROLLOUT_STAGE.CANARY }), 10);
  assert.equal(resolveDailyLimit({ ...defaultRolloutState(), stage: ROLLOUT_STAGE.CANARY, dailyLimit: 100 }), 100);
  // 拡大は stage=scale（既定 500）
  assert.equal(resolveDailyLimit({ ...defaultRolloutState(), stage: ROLLOUT_STAGE.SCALE }), 500);
});

// ── kill switch は全アクションに優先する ──────────────────────
//    ⚠️ 以前は「新規付与」の判定でしか killed を見ておらず、
//       `killed: true` にしても送信・キュー登録・続きの通が進んでいた
//       （runbook の「次 tick から緊急停止」という契約と食い違っていた）。

const killedState = (over = {}) => ({
  ...defaultRolloutState(),
  stage: ROLLOUT_STAGE.STEADY,
  dailyLimit: 100,
  alwaysArmed: true,
  killed: true,
  ...over,
});

test('【重要】kill switch: 送信待ちジョブがあっても送信を起動しない', () => {
  const r = tick({ state: killedState(), facts: facts({ pendingJobs: 3 }) });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.KILLED);
});

test('【重要】kill switch: queue の積み残しがあってもキュー登録しない', () => {
  const r = tick({ state: killedState(), facts: facts({ grantedPendingQueue: 100 }) });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.KILLED);
});

test('【重要】kill switch: 期日の follow-up（touch2〜24）も積まない', () => {
  const r = tick({ state: killedState(), facts: facts({ followUpStep: 7, followUpDue: 42 }) });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.KILLED);
});

test('【重要】kill switch: 新規付与もしない', () => {
  const r = tick({ state: killedState(), facts: facts({ remainingCandidates: 14479 }) });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.KILLED);
});

test('【重要】kill switch: 全部同時に積まれていても 1 つも実行しない', () => {
  const r = tick({
    state: killedState(),
    facts: facts({ pendingJobs: 3, grantedPendingQueue: 100, followUpStep: 7, followUpDue: 42 }),
  });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.KILLED);
});

test('【重要】kill switch: 事実が読めない状態でも止まる（判定より先に効く）', () => {
  const r = tick({ state: killedState(), facts: facts({ pendingJobs: null, grantedPendingQueue: null }) });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.KILLED, '事実不明が理由になっている（kill が後回し）');
});

test('【重要】kill switch: env が全部開いていても止まる', () => {
  const r = tickRollout({
    state: killedState(), nowMs: NOW, envEnabled: true,
    facts: facts({ pendingJobs: 1 }), env: ENV_OPEN,
  });
  assert.equal(r.action, TICK_ACTION.SKIP);
  assert.equal(r.reason, ROLLOUT_BLOCK.KILLED);
});

test('【重要】stage=paused は従来どおり「新規付与だけ」停止（積み残しは進む）', () => {
  const paused = { ...defaultRolloutState(), stage: 'paused', alwaysArmed: true };
  assert.equal(tick({ state: paused, facts: facts({ pendingJobs: 2 }) }).action, TICK_ACTION.DISPATCH);
  assert.equal(tick({ state: paused, facts: facts({ grantedPendingQueue: 5 }) }).action, TICK_ACTION.QUEUE);
  assert.equal(tick({ state: paused, facts: facts({ followUpStep: 3, followUpDue: 9 }) }).action, TICK_ACTION.FOLLOW_UP);
  // 新規付与だけは止まる
  assert.equal(tick({ state: paused }).action, TICK_ACTION.SKIP);
});

test('killed=false なら従来どおり動く（one-shot の挙動を壊していない）', () => {
  const alive = { ...killedState(), killed: false };
  assert.equal(tick({ state: alive, facts: facts({ pendingJobs: 1 }) }).action, TICK_ACTION.DISPATCH);
  assert.equal(tick({ state: alive, facts: facts({ grantedPendingQueue: 5 }) }).action, TICK_ACTION.QUEUE);
  assert.equal(tick({ state: alive }).action, TICK_ACTION.GRANT);
});
