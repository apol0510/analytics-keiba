/**
 * importHorseStatsNankan.test.mjs — horseStats 取得の認証/失敗伝播契約テスト
 * （node:test / 新規依存なし / 全 mock fetch・実通信なし）
 *   node --test scripts/importHorseStatsNankan.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSharedRaw, buildSharedPath } from './importHorseStatsNankan.js';
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
function clientWith(responder, { env = ENV_OK, retries = 1 } = {}) {
  return createSharedClient({ fetchImpl: mkFetch(responder), env, sleepImpl: noSleep, retries });
}

const REF = 'main';
const PATH = buildSharedPath('2026-06-16', 'KAW', 1); // nankan/horseStats/2026/06/2026-06-16-KAW-R01.json

// 1. 200 → 本文を返す
test('1. 200 は本文を返す', async () => {
  const payload = { dataType: 'horseStats', horses: [] };
  const client = clientWith(() => mkRes(200, payload));
  const body = await fetchSharedRaw(PATH, REF, client);
  assert.deepEqual(JSON.parse(body), payload);
});

// 2. 404 optional → null（skip）
test('2. 404 は null（optional skip）', async () => {
  const client = clientWith(() => mkRes(404, 'nf'));
  const body = await fetchSharedRaw(PATH, REF, client);
  assert.equal(body, null);
});

// 3. 401 は fatal（匿名 raw fallback なし）
test('3. 401 は AUTH_FAILED で throw（raw fallback なし）', async () => {
  const client = clientWith(() => mkRes(401, 'bad'));
  await assert.rejects(fetchSharedRaw(PATH, REF, client), (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED);
});

// 4. 403 forbidden は fatal
test('4. 403 は FORBIDDEN で throw', async () => {
  const client = clientWith(() => mkRes(403, 'forbidden', { 'x-ratelimit-remaining': '10' }));
  await assert.rejects(fetchSharedRaw(PATH, REF, client), (e) => e.code === SHARED_FETCH_CODES.FORBIDDEN);
});

// 5. 500 は retry 後 fatal
test('5. 500 は SERVER_ERROR で throw', async () => {
  const client = clientWith(() => mkRes(500, 'err'));
  await assert.rejects(fetchSharedRaw(PATH, REF, client), (e) => e.code === SHARED_FETCH_CODES.SERVER_ERROR);
});

// 6. token 未設定 → 取得前に TOKEN_MISSING（fetch 呼ばない）
test('6. token 未設定は TOKEN_MISSING（fetch 未実行）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { horses: [] }));
  const client = createSharedClient({ fetchImpl, env: {}, sleepImpl: noSleep });
  await assert.rejects(fetchSharedRaw(PATH, REF, client), (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING);
  assert.equal(fetchImpl.calls.length, 0);
});

// 7. token / Authorization が error に漏れない
test('7. token・Bearer が error へ漏れない', async () => {
  const client = clientWith(() => mkRes(401, 'bad'));
  await assert.rejects(fetchSharedRaw(PATH, REF, client), (e) => {
    const hay = `${e.message}\n${e.stack}`;
    assert.ok(!hay.includes(SECRET));
    assert.ok(!/Bearer\s/i.test(hay));
    return true;
  });
});
