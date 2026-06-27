/**
 * importResultsJra.test.mjs — JRA results 取得の認証/失敗伝播契約テスト
 * （node:test / 新規依存なし / 全 mock fetch・実通信なし）
 *   node --test scripts/importResultsJra.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSharedResults, fetchAndMergeVenueResults } from './importResultsJra.js';
import { createSharedClient, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';

const SECRET = 'ghp_THIS_IS_A_TEST_SECRET_TOKEN_should_never_leak';
const ENV_OK = { KEIBA_DATA_SHARED_TOKEN: SECRET };
const noSleep = async () => {};

function mkRes(status, body, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    headers: { get: (n) => (n.toLowerCase() in lower ? lower[n.toLowerCase()] : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
function mkFetch(responder) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return responder(url, init); };
  fn.calls = calls;
  return fn;
}
function pathOf(url) {
  const m = decodeURIComponent(url).match(/contents\/(.+?)\?ref=/);
  return m ? m[1] : '';
}
function clientWith(responder, { env = ENV_OK, retries = 2 } = {}) {
  return createSharedClient({ fetchImpl: mkFetch(responder), env, sleepImpl: noSleep, retries });
}

const DATE = '2026-05-31', Y = '2026', M = '05';
const unifiedPath = `jra/results/${Y}/${M}/${DATE}.json`;
const venuePath = (c) => `jra/results/${Y}/${M}/${DATE}-${c}.json`;

test('1. 統合ファイル 200 を返す', async () => {
  const payload = { date: DATE, venue: '東京', races: [{ raceNumber: 1 }] };
  const client = clientWith((url) => (pathOf(url) === unifiedPath ? mkRes(200, payload) : mkRes(404, 'nf')));
  assert.deepEqual(await fetchSharedResults(DATE, 'jra', client), payload);
});

test('2. 統合 404 → 会場別マージ（TOK のみ存在・各 race に venue 注入）', async () => {
  const client = clientWith((url) => {
    if (pathOf(url) === venuePath('TOK')) return mkRes(200, { venue: '東京', races: [{ n: 1 }, { n: 2 }] });
    return mkRes(404, 'nf');
  });
  const out = await fetchSharedResults(DATE, 'jra', client);
  assert.equal(out.totalRaces, 2);
  assert.deepEqual(out.venues, ['東京']);
  assert.ok(out.races.every((r) => r.venue === '東京'), '各 race に venue 注入');
});

test('3. 全 404 は throw（silent success しない）', async () => {
  const client = clientWith(() => mkRes(404, 'nf'));
  await assert.rejects(fetchSharedResults(DATE, 'jra', client), /結果データが見つかりません/);
});

test('4. 会場 401 は fatal', async () => {
  const client = clientWith((url) => (pathOf(url) === venuePath('TOK') ? mkRes(401, 'bad') : mkRes(200, { races: [{ n: 1 }] })));
  await assert.rejects(fetchAndMergeVenueResults(DATE, Y, M, client), (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED);
});

test('5. 会場 403 は fatal', async () => {
  const client = clientWith(() => mkRes(403, 'f', { 'x-ratelimit-remaining': '9' }));
  await assert.rejects(fetchAndMergeVenueResults(DATE, Y, M, client), (e) => e.code === SHARED_FETCH_CODES.FORBIDDEN);
});

test('6. rate limit は fatal', async () => {
  const client = clientWith(() => mkRes(403, 'rate', { 'x-ratelimit-remaining': '0' }), { retries: 1 });
  await assert.rejects(fetchAndMergeVenueResults(DATE, Y, M, client), (e) => e.code === SHARED_FETCH_CODES.RATE_LIMITED);
});

test('7. 500 は fatal', async () => {
  const client = clientWith(() => mkRes(500, 'e'), { retries: 1 });
  await assert.rejects(fetchAndMergeVenueResults(DATE, Y, M, client), (e) => e.code === SHARED_FETCH_CODES.SERVER_ERROR);
});

test('8. timeout は fatal', async () => {
  const client = clientWith(() => { const e = new Error('a'); e.name = 'AbortError'; throw e; }, { retries: 1 });
  await assert.rejects(fetchAndMergeVenueResults(DATE, Y, M, client), (e) => e.code === SHARED_FETCH_CODES.TIMEOUT);
});

test('9. token 未設定は TOKEN_MISSING（fetch 未実行）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { races: [] }));
  const client = createSharedClient({ fetchImpl, env: {}, sleepImpl: noSleep });
  await assert.rejects(fetchSharedResults(DATE, 'jra', client), (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING);
  assert.equal(fetchImpl.calls.length, 0);
});

test('10. token・Bearer が error へ漏れない', async () => {
  const client = clientWith(() => mkRes(401, 'bad'));
  await assert.rejects(fetchAndMergeVenueResults(DATE, Y, M, client), (e) => {
    const hay = `${e.message}\n${e.stack}`;
    return !hay.includes(SECRET) && !/Bearer\s/i.test(hay);
  });
});

test('11. 一部 200 + 一部 404 → 存在会場のみマージ', async () => {
  const client = clientWith((url) => {
    const p = pathOf(url);
    if (p === venuePath('TOK')) return mkRes(200, { venue: '東京', races: [{ n: 1 }] });
    if (p === venuePath('KYO')) return mkRes(200, { venue: '京都', races: [{ n: 1 }, { n: 2 }] });
    return mkRes(404, 'nf');
  });
  const out = await fetchAndMergeVenueResults(DATE, Y, M, client);
  assert.equal(out.totalRaces, 3);
  assert.deepEqual(out.venues, ['東京', '京都']);
});
