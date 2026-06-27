/**
 * importResults.test.mjs — 南関 results 取得の認証/失敗伝播契約テスト
 * （node:test / 新規依存なし / 全 mock fetch・実通信なし）
 *   node --test scripts/importResults.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSharedResults, fetchAndMergeVenueResults } from './importResults.js';
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
/** Contents API URL から shared path を取り出す */
function pathOf(url) {
  const m = decodeURIComponent(url).match(/contents\/(.+?)\?ref=/);
  return m ? m[1] : '';
}
function clientWith(responder, { env = ENV_OK, retries = 2 } = {}) {
  return createSharedClient({ fetchImpl: mkFetch(responder), env, sleepImpl: noSleep, retries });
}

const DATE = '2026-05-08';
const Y = '2026', M = '05';
const unifiedPath = `nankan/results/${Y}/${M}/${DATE}.json`;
const venuePath = (c) => `nankan/results/${Y}/${M}/${DATE}-${c}.json`;

// 1. 統合ファイル 200 → そのまま返す
test('1. 統合ファイル 200 を返す', async () => {
  const payload = { date: DATE, venue: '大井', races: [{ raceNumber: 1 }, { raceNumber: 2 }] };
  const client = clientWith((url) => (pathOf(url) === unifiedPath ? mkRes(200, payload) : mkRes(404, 'nf')));
  const out = await fetchSharedResults(DATE, 'nankan', client);
  assert.deepEqual(out, payload);
});

// 2. 統合 404 → 会場別マージ（OOI のみ存在）
test('2. 統合 404 → 会場別マージ（存在会場のみ）', async () => {
  const client = clientWith((url) => {
    const p = pathOf(url);
    if (p === venuePath('OOI')) return mkRes(200, { venue: '大井', races: [{ n: 1 }, { n: 2 }, { n: 3 }] });
    return mkRes(404, 'nf');
  });
  const out = await fetchSharedResults(DATE, 'nankan', client);
  assert.equal(out.totalRaces, 3);
  assert.deepEqual(out.venues, ['大井']);
});

// 3. 統合 404 + 全会場 404 → 「結果データが見つかりません」throw
test('3. 全 404 は throw（silent success しない）', async () => {
  const client = clientWith(() => mkRes(404, 'nf'));
  await assert.rejects(fetchSharedResults(DATE, 'nankan', client), /結果データが見つかりません/);
});

// 4. 会場別取得中の 401 は fatal（skip しない）
test('4. 会場 401 は fatal（throw・partial 破棄）', async () => {
  const client = clientWith((url) => (pathOf(url) === venuePath('OOI') ? mkRes(401, 'bad') : mkRes(200, { races: [{ n: 1 }] })));
  await assert.rejects(fetchAndMergeVenueResults(DATE, Y, M, client), (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED);
});

// 5. 403 は fatal
test('5. 会場 403 は fatal', async () => {
  const client = clientWith(() => mkRes(403, 'forbidden', { 'x-ratelimit-remaining': '10' }));
  await assert.rejects(fetchAndMergeVenueResults(DATE, Y, M, client), (e) => e.code === SHARED_FETCH_CODES.FORBIDDEN);
});

// 6. rate limit は retry 後 fatal
test('6. rate limit は fatal', async () => {
  const client = clientWith(() => mkRes(403, 'rate', { 'x-ratelimit-remaining': '0' }), { retries: 1 });
  await assert.rejects(fetchAndMergeVenueResults(DATE, Y, M, client), (e) => e.code === SHARED_FETCH_CODES.RATE_LIMITED);
});

// 7. 500 は retry 後 fatal
test('7. 500 は fatal', async () => {
  const client = clientWith(() => mkRes(500, 'err'), { retries: 1 });
  await assert.rejects(fetchAndMergeVenueResults(DATE, Y, M, client), (e) => e.code === SHARED_FETCH_CODES.SERVER_ERROR);
});

// 8. timeout は retry 後 fatal
test('8. timeout は fatal', async () => {
  const client = clientWith(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, { retries: 1 });
  await assert.rejects(fetchAndMergeVenueResults(DATE, Y, M, client), (e) => e.code === SHARED_FETCH_CODES.TIMEOUT);
});

// 9. token 未設定 → 取得前に TOKEN_MISSING（fetch 呼ばない）
test('9. token 未設定は TOKEN_MISSING（fetch 未実行）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { races: [] }));
  const client = createSharedClient({ fetchImpl, env: {}, sleepImpl: noSleep });
  await assert.rejects(fetchSharedResults(DATE, 'nankan', client), (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING);
  assert.equal(fetchImpl.calls.length, 0);
});

// 10. token / Authorization が error に漏れない
test('10. token・Bearer が error へ漏れない', async () => {
  const client = clientWith(() => mkRes(401, 'bad'));
  await assert.rejects(fetchAndMergeVenueResults(DATE, Y, M, client), (e) => {
    const hay = `${e.message}\n${e.stack}`;
    assert.ok(!hay.includes(SECRET));
    assert.ok(!/Bearer\s/i.test(hay));
    return true;
  });
});

// 11. partial: 一部会場 200 / 一部 404 → 存在分のみマージ（404 は optional skip）
test('11. 一部 200 + 一部 404 → 存在会場のみマージ', async () => {
  const client = clientWith((url) => {
    const p = pathOf(url);
    if (p === venuePath('OOI')) return mkRes(200, { venue: '大井', races: [{ n: 1 }, { n: 2 }] });
    if (p === venuePath('KAW')) return mkRes(200, { venue: '川崎', races: [{ n: 1 }] });
    return mkRes(404, 'nf'); // FUN/URA 未投入
  });
  const out = await fetchAndMergeVenueResults(DATE, Y, M, client);
  assert.equal(out.totalRaces, 3);
  assert.deepEqual(out.venues, ['大井', '川崎']);
});
