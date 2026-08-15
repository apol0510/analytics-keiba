/**
 * rolloutStore.test.mjs — 展開状態の保存（CAS・キルスイッチ）
 *   node --test src/lib/marketing/rolloutStore.test.mjs
 *
 * 守る性質:
 *   - 状態が無ければ**既定（停止）**を返す
 *   - 読んで書くまでの間に別実行が入ったら **CAS で弾く**
 *   - 緊急停止は競合しても通る（止める操作は通したい）
 *   - 鍵は自分の名前空間の外へ出ない / PII を入れない
 *   - Redis が読めないときは例外（**動かさない**）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRolloutStore, rolloutKey, isSafeCampaignId, isRolloutEnabled,
  RolloutStoreError, ROLLOUT_STORE_FAIL, ROLLOUT_ROOT,
} from './rolloutStore.js';
import { ROLLOUT_STAGE, defaultRolloutState } from './rolloutPlan.js';

const CAMPAIGN = 'light-trial-to-premium-sequence';
const NOW = Date.parse('2026-08-16T00:00:00Z');

/** 偽 Redis（CAS の意味を保つ） */
function fakeRedis(store = new Map()) {
  return async (args) => {
    const op = String(args[0]).toUpperCase();
    if (op === 'GET') return store.get(args[1]) ?? null;
    if (op === 'SET') { store.set(args[1], String(args[2])); return 'OK'; }
    if (op === 'DEL') { store.delete(args[1]); return 1; }
    if (op === 'EVAL') {
      const key = args[3]; const json = args[4]; const expected = String(args[5] ?? '');
      const cur = store.get(key);
      if (cur) {
        const m = /"version":(\d+)/.exec(cur);
        if (!m || m[1] !== expected) return 'CONFLICT';
      } else if (expected !== '') return 'MISSING';
      store.set(key, json);
      return 'OK';
    }
    return null;
  };
}

test('状態が無ければ既定（停止）を返す', async () => {
  const s = createRolloutStore({ cmd: fakeRedis() });
  const r = await s.load(CAMPAIGN);
  assert.equal(r.exists, false);
  assert.equal(r.state.stage, ROLLOUT_STAGE.PAUSED);
  assert.equal(r.state.killed, false);
});

test('保存して読み直せる（version が上がる）', async () => {
  const store = new Map();
  const s = createRolloutStore({ cmd: fakeRedis(store) });
  const first = await s.save({
    campaignId: CAMPAIGN,
    state: { ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, dailyLimit: 250 },
    expectedVersion: null,
  });
  assert.equal(first.ok, true);
  assert.equal(first.state.version, 1);
  const loaded = await s.load(CAMPAIGN);
  assert.equal(loaded.exists, true);
  assert.equal(loaded.state.stage, ROLLOUT_STAGE.STEADY);
  assert.equal(loaded.state.dailyLimit, 250);
  assert.equal(loaded.state.version, 1);
});

test('【重要】読んで書くまでの間に別実行が入ったら CAS で弾く', async () => {
  const store = new Map();
  const a = createRolloutStore({ cmd: fakeRedis(store) });
  const b = createRolloutStore({ cmd: fakeRedis(store) });
  await a.save({ campaignId: CAMPAIGN, state: defaultRolloutState(), expectedVersion: null });

  const readA = await a.load(CAMPAIGN);
  const readB = await b.load(CAMPAIGN);
  // A が先に書く
  await a.save({ campaignId: CAMPAIGN, state: { ...readA.state, dailyLimit: 100 }, expectedVersion: readA.state.version });
  // B は古い版で書こうとする → 弾かれる
  await assert.rejects(
    () => b.save({ campaignId: CAMPAIGN, state: { ...readB.state, dailyLimit: 999 }, expectedVersion: readB.state.version }),
    (e) => e instanceof RolloutStoreError && e.code === ROLLOUT_STORE_FAIL.CAS_CONFLICT,
  );
  const after = await a.load(CAMPAIGN);
  assert.equal(after.state.dailyLimit, 100, '後勝ちで上書きされている');
});

test('新規作成のつもりで既存を上書きしない', async () => {
  const store = new Map();
  const s = createRolloutStore({ cmd: fakeRedis(store) });
  await s.save({ campaignId: CAMPAIGN, state: defaultRolloutState(), expectedVersion: null });
  await assert.rejects(
    () => s.save({ campaignId: CAMPAIGN, state: defaultRolloutState(), expectedVersion: null }),
    (e) => e.code === ROLLOUT_STORE_FAIL.CAS_CONFLICT,
  );
});

test('【重要】緊急停止は競合しても通る', async () => {
  const store = new Map();
  const s = createRolloutStore({ cmd: fakeRedis(store) });
  await s.save({
    campaignId: CAMPAIGN,
    state: { ...defaultRolloutState(), stage: ROLLOUT_STAGE.SCALE }, expectedVersion: null,
  });
  const r = await s.kill({ campaignId: CAMPAIGN, nowMs: NOW, note: '苦情率が上がったため' });
  assert.equal(r.ok, true);
  assert.equal(r.state.killed, true);
  assert.equal(r.state.stage, ROLLOUT_STAGE.SCALE, '停止で段階まで書き換えている');
  assert.equal(r.state.note, '苦情率が上がったため');
});

test('停止の解除は killed を落とすだけ（段階は上げない）', async () => {
  const store = new Map();
  const s = createRolloutStore({ cmd: fakeRedis(store) });
  await s.save({
    campaignId: CAMPAIGN,
    state: { ...defaultRolloutState(), stage: ROLLOUT_STAGE.CANARY, killed: true }, expectedVersion: null,
  });
  const r = await s.resume({ campaignId: CAMPAIGN, nowMs: NOW });
  assert.equal(r.state.killed, false);
  assert.equal(r.state.stage, ROLLOUT_STAGE.CANARY);
});

test('【重要】壊れた JSON は例外（動かさない）', async () => {
  const store = new Map();
  store.set(rolloutKey.state(CAMPAIGN), '{壊れている');
  const s = createRolloutStore({ cmd: fakeRedis(store) });
  await assert.rejects(() => s.load(CAMPAIGN),
    (e) => e instanceof RolloutStoreError && e.code === ROLLOUT_STORE_FAIL.DATA_CORRUPT);
});

test('【重要】Redis へ届かないときは例外（既定で動かさない）', async () => {
  const s = createRolloutStore({ cmd: async () => { throw new Error('boom'); } });
  await assert.rejects(() => s.load(CAMPAIGN), (e) => e instanceof RolloutStoreError);
  const s2 = createRolloutStore({ cmd: async () => undefined });
  await assert.rejects(() => s2.load(CAMPAIGN),
    (e) => e.code === ROLLOUT_STORE_FAIL.UNKNOWN_RESULT);
});

test('【重要】鍵は自分の名前空間の外へ出さない', () => {
  assert.match(rolloutKey.state(CAMPAIGN), new RegExp(`^${ROLLOUT_ROOT}state:`));
  const s = createRolloutStore({ cmd: async () => 'OK' });
  assert.throws(() => s.assertKey('ak:marketing-automation:lock:x'), /rollout_store/);
  assert.throws(() => s.assertKey('ak:marketing-dispatch:lock:x'), /rollout_store/);
  assert.throws(() => s.assertKey('payemail:x'), /rollout_store/);
});

test('【重要】鍵に PII を入れない（campaignId の形を制限する）', async () => {
  assert.equal(isSafeCampaignId(CAMPAIGN), true);
  for (const bad of ['a@example.com', 'Camp Aign', '', null, undefined, 'x'.repeat(200), "c';DEL"]) {
    assert.equal(isSafeCampaignId(bad), false, `${String(bad)} を通している`);
  }
  const s = createRolloutStore({ cmd: fakeRedis() });
  await assert.rejects(() => s.load('a@example.com'),
    (e) => e.code === ROLLOUT_STORE_FAIL.BAD_CAMPAIGN_ID);
});

test('保存する値に PII を入れない（段階・件数・日付だけ）', async () => {
  const store = new Map();
  const s = createRolloutStore({ cmd: fakeRedis(store) });
  await s.save({
    campaignId: CAMPAIGN,
    state: { ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, totalGranted: 110 },
    expectedVersion: null,
  });
  const raw = store.get(rolloutKey.state(CAMPAIGN));
  assert.equal(raw.includes('@'), false, 'アドレスらしき文字が入っている');
  assert.equal(/rec[A-Za-z0-9]{14}/.test(raw), false, 'recordId が入っている');
});

test('【重要】機能そのものの許可は env（既定 OFF）', () => {
  assert.equal(isRolloutEnabled({}), false);
  assert.equal(isRolloutEnabled({ MARKETING_ROLLOUT_ENABLED: 'false' }), false);
  assert.equal(isRolloutEnabled({ MARKETING_ROLLOUT_ENABLED: '1' }), false, "'true' 以外は無効");
  assert.equal(isRolloutEnabled({ MARKETING_ROLLOUT_ENABLED: 'true' }), true);
  assert.equal(isRolloutEnabled(null), false);
});

test('campaign ごとに独立した状態を持つ', async () => {
  const store = new Map();
  const s = createRolloutStore({ cmd: fakeRedis(store) });
  await s.save({ campaignId: 'campaign-a', state: { ...defaultRolloutState(), dailyLimit: 10 }, expectedVersion: null });
  await s.save({ campaignId: 'campaign-b', state: { ...defaultRolloutState(), dailyLimit: 500 }, expectedVersion: null });
  assert.equal((await s.load('campaign-a')).state.dailyLimit, 10);
  assert.equal((await s.load('campaign-b')).state.dailyLimit, 500);
});
