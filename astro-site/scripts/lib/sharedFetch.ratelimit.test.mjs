/**
 * sharedFetch.ratelimit.test.mjs — レート制限の bounded retry と deferred 境界
 *   node --test scripts/lib/sharedFetch.ratelimit.test.mjs
 *
 * 従来の backoff は 250ms/500ms で、secondary rate limit（概ね60秒）にも届かず
 * 「retry する意味がない retry」だった。回復時刻に従って待ち、
 * 上限を超える場合は待たずに deferred へ倒すことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSharedClient, SHARED_FETCH_CODES } from './sharedFetch.mjs';

const ENV = { KEIBA_DATA_SHARED_TOKEN: 'ghp_MOCK_ratelimit_test' };
const NOW = 1_800_000_000_000; // 固定時刻

function mkRes(status, body, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
  return { status, headers: { get: (n) => lower[n.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}
function mk(responder) {
  const slept = [];
  const calls = [];
  const client = createSharedClient({
    fetchImpl: async (url) => { calls.push(url); return responder(calls.length); },
    env: ENV,
    nowMsImpl: () => NOW,
    sleepImpl: async (ms) => { slept.push(ms); },
  });
  return { client, slept, calls };
}
const RL = (extra) => mkRes(403, 'rate limit', { 'x-ratelimit-remaining': '0', ...extra });

test('1. Retry-After に従って待ち、回復後に成功する', async () => {
  const { client, slept, calls } = mk((n) => (n === 1 ? RL({ 'retry-after': 60 }) : mkRes(200, { ok: true })));
  const r = await client.fetchJson('a/b.json', { ref: 'main', required: false });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(slept, [60_000], '250ms ではなく回復時刻ぶん待つ');
  assert.equal(calls.length, 2);
});

test('2. x-ratelimit-reset（epoch秒）からも待ち時間を計算する', async () => {
  const reset = Math.floor(NOW / 1000) + 45;
  const { client, slept } = mk((n) => (n === 1 ? RL({ 'x-ratelimit-reset': reset }) : mkRes(200, { ok: true })));
  await client.fetchJson('a/b.json', { ref: 'main', required: false });
  assert.deepEqual(slept, [45_000]);
});

test('3. 上限(90秒)を超える reset は待たずに RATE_LIMITED を投げる（deferred へ倒す）', async () => {
  const reset = Math.floor(NOW / 1000) + 3600; // primary の 60 分後
  const { client, slept, calls } = mk(() => RL({ 'x-ratelimit-reset': reset }));
  await assert.rejects(
    client.fetchJson('a/b.json', { ref: 'main', required: false }),
    (e) => e.code === SHARED_FETCH_CODES.RATE_LIMITED,
  );
  assert.deepEqual(slept, [], '長い reset を run 内で待たない');
  assert.equal(calls.length, 1, '無駄な再試行をしない');
});

test('4. 待ち時間情報が無い 403(rate) も即 deferred（当てずっぽうに叩き続けない）', async () => {
  const { client, slept, calls } = mk(() => RL({}));
  await assert.rejects(client.fetchJson('a/b.json', { ref: 'main', required: false }), (e) => e.code === SHARED_FETCH_CODES.RATE_LIMITED);
  assert.deepEqual(slept, []);
  assert.equal(calls.length, 1);
});

test('5. 429 も同じ扱い（Retry-After で待って回復）', async () => {
  const { client, slept } = mk((n) => (n === 1 ? mkRes(429, 'slow down', { 'retry-after': 30 }) : mkRes(200, { ok: true })));
  await client.fetchJson('a/b.json', { ref: 'main', required: false });
  assert.deepEqual(slept, [30_000]);
});

test('6. timeout / 5xx は従来どおり短い backoff で retry する', async () => {
  const { client, slept } = mk((n) => (n <= 2 ? mkRes(503, 'unavailable') : mkRes(200, { ok: true })));
  await client.fetchJson('a/b.json', { ref: 'main', required: false });
  assert.deepEqual(slept, [250, 500], 'レート制限以外は据え置き');
});

test('7. retry 上限に達したら RATE_LIMITED のまま throw（成功を装わない）', async () => {
  const { client, slept, calls } = mk(() => RL({ 'retry-after': 1 }));
  await assert.rejects(client.fetchJson('a/b.json', { ref: 'main', required: false }), (e) => e.code === SHARED_FETCH_CODES.RATE_LIMITED);
  assert.equal(calls.length, 3, 'retries=2 ＝ 最大3試行で打ち切る（bounded）');
  assert.deepEqual(slept, [1000, 1000]);
});

test('8. 401 は待たずに即 fail-closed', async () => {
  const { client, slept, calls } = mk(() => mkRes(401, 'Bad credentials'));
  await assert.rejects(client.fetchJson('a/b.json', { ref: 'main', required: false }), (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED);
  assert.deepEqual(slept, []);
  assert.equal(calls.length, 1);
});
