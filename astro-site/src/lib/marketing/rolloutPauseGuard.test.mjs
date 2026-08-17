/**
 * rolloutPauseGuard.test.mjs — 「止めた」と報告してよいのは本当に止まったときだけ
 *   node --test src/lib/marketing/rolloutPauseGuard.test.mjs
 *
 * 展開状態の保存は CAS（`expectedVersion`）。競合したら保存されない。
 * 旧実装は保存の成否を見ずに `autoStopped: true` と返していたので、
 * **「止めたと報告したのに止まっていない」** が起こり得た。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pauseWithRetry, describePauseResult, PAUSE_CONFLICT, PAUSE_MAX_ATTEMPTS } from './rolloutPauseGuard.js';
import { defaultRolloutState, normalizeRolloutState, ROLLOUT_STAGE, jstDay } from './rolloutPlan.js';

const NOW = Date.UTC(2026, 7, 17, 1, 0, 0);
const DAY = jstDay(NOW);
const CAMPAIGN = 'light-trial-to-premium-sequence';

/** CAS つきの偽ストア。`conflictTimes` 回だけ競合させる */
function fakeStore({ state, conflictTimes = 0, exists = true } = {}) {
  let cur = { ...defaultRolloutState(), ...state };
  let conflicts = conflictTimes;
  const calls = { load: 0, save: 0 };
  return {
    calls,
    get state() { return cur; },
    /** 競合の相手（他の書き手）が版を進めた体にする */
    bumpExternally(patch = {}) { cur = { ...cur, ...patch, version: cur.version + 1 }; },
    async load() { calls.load += 1; return { exists, state: cur }; },
    async save({ state: next, expectedVersion }) {
      calls.save += 1;
      if (conflicts > 0) {
        conflicts -= 1;
        // 他の書き手が先に書いた状況を再現（版が進む）
        cur = { ...cur, version: cur.version + 1 };
        const e = new Error('cas conflict');
        e.code = 'cas_conflict';
        throw e;
      }
      if (exists && expectedVersion !== cur.version) {
        const e = new Error('cas conflict');
        e.code = 'cas_conflict';
        throw e;
      }
      cur = { ...normalizeRolloutState(next), version: cur.version + 1 };
      return true;
    },
  };
}

const running = {
  stage: ROLLOUT_STAGE.SCALE, dailyLimit: 500, batchSize: 500,
  armedFor: DAY, alwaysArmed: false, version: 7,
  lastRunDay: DAY, dayGrantedCount: 100, batchSeq: 1, lastRunCount: 100,
};

test('【重要】競合が無ければ停止が確定する', async () => {
  const store = fakeStore({ state: running });
  const r = await pauseWithRetry({ store, campaignId: CAMPAIGN, nowMs: NOW, note: 'auto-stop: too_many_records:400>200' });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(store.state.stage, ROLLOUT_STAGE.PAUSED);
  assert.equal(store.state.armedFor, null, '武装が残っている');
});

test('【重要】CAS 競合したら読み直してやり直し、確定できたら成功', async () => {
  const store = fakeStore({ state: running, conflictTimes: 1 });
  const r = await pauseWithRetry({ store, campaignId: CAMPAIGN, nowMs: NOW, note: 'auto-stop: x' });
  assert.equal(r.ok, true, `止められていない: ${r.code}`);
  assert.equal(r.attempts, 2, 'やり直していない');
  assert.equal(store.calls.load, 2, '読み直さずに再保存している（古い state で上書きする危険）');
  assert.equal(store.state.stage, ROLLOUT_STAGE.PAUSED);
});

test('【重要】ずっと競合するなら「止めた」と偽らない（fail closed）', async () => {
  const store = fakeStore({ state: running, conflictTimes: 99 });
  const r = await pauseWithRetry({ store, campaignId: CAMPAIGN, nowMs: NOW });
  assert.equal(r.ok, false, '止まっていないのに成功と言っている');
  assert.equal(r.code, 'cas_conflict');
  assert.equal(r.attempts, PAUSE_MAX_ATTEMPTS, '無限に粘っている / 1 回で諦めている');
  assert.notEqual(store.state.stage, ROLLOUT_STAGE.PAUSED);
  assert.equal(describePauseResult(r).paused, false);
});

test('【重要】新しい state を古い値で上書きしない', async () => {
  const store = fakeStore({ state: running });
  // 停止しようとする直前に、別の書き手が 1 日上限を変えた
  store.bumpExternally({ dailyLimit: 1000, note: 'operator changed' });
  const r = await pauseWithRetry({ store, campaignId: CAMPAIGN, nowMs: NOW, note: 'auto-stop: y' });
  assert.equal(r.ok, true);
  assert.equal(store.state.dailyLimit, 1000, '他の書き手の変更を古い値で潰している');
  assert.equal(store.state.stage, ROLLOUT_STAGE.PAUSED);
});

test('【重要】停止しても付与の記録は動かさない（batchSeq / 日次集計 / lastRunCount）', async () => {
  const store = fakeStore({ state: running });
  await pauseWithRetry({ store, campaignId: CAMPAIGN, nowMs: NOW, note: 'auto-stop: z' });
  assert.equal(store.state.batchSeq, 1);
  assert.equal(store.state.dayGrantedCount, 100);
  assert.equal(store.state.lastRunCount, 100);
  assert.equal(store.state.lastRunDay, DAY);
  assert.equal(store.state.totalGranted, running.totalGranted ?? 0);
});

test('すでに止まっていれば書き足さない（二重に書かない）', async () => {
  const store = fakeStore({ state: { ...running, stage: ROLLOUT_STAGE.PAUSED } });
  const r = await pauseWithRetry({ store, campaignId: CAMPAIGN, nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyPaused, true);
  assert.equal(store.calls.save, 0, '止まっているのに書いている');
});

test('緊急停止中も「止まっている」として扱う', async () => {
  const store = fakeStore({ state: { ...running, killed: true } });
  const r = await pauseWithRetry({ store, campaignId: CAMPAIGN, nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyPaused, true);
  assert.equal(store.state.killed, true, '緊急停止を解除している');
});

test('読み込めないときも「止めた」と言わない', async () => {
  const store = {
    async load() { const e = new Error('down'); e.code = 'unreadable'; throw e; },
    async save() { throw new Error('should not be called'); },
  };
  const r = await pauseWithRetry({ store, campaignId: CAMPAIGN, nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(describePauseResult(r).code, 'unreadable');
});

test('store が渡されていなければ fail closed', async () => {
  const r = await pauseWithRetry({ campaignId: CAMPAIGN, nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.code, PAUSE_CONFLICT);
});

test('報告に PII も secret も混ぜない', async () => {
  const store = fakeStore({ state: running, conflictTimes: 99 });
  const r = await pauseWithRetry({ store, campaignId: CAMPAIGN, nowMs: NOW });
  const dump = JSON.stringify(describePauseResult(r));
  assert.equal(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(dump), false);
  assert.equal(/rec[A-Za-z0-9]{14}/.test(dump), false);
});
