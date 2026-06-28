/**
 * importFeatureScores.test.mjs — featureScores remote 取得の認証/失敗伝播契約テスト
 * （node:test / 新規依存なし / 全 mock fetch・実通信なし）
 *   node --test scripts/importFeatureScores.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRemoteFeatureScores } from './importFeatureScores.js';
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

const PATH = 'jra/featureScores/2026/05/2026-05-24-TOK.json';

// 1. 200 → 本文を返す（匿名 raw を踏まない）
test('1. 200 は本文を返す', async () => {
  const payload = { engine: 'jra-v1', category: 'jra', races: { 1: {} } };
  const client = clientWith(() => mkRes(200, payload));
  const body = await fetchRemoteFeatureScores(PATH, client);
  assert.deepEqual(JSON.parse(body), payload);
});

// 2. 404 optional → null（skip）
test('2. 404 は null（optional skip）', async () => {
  const client = clientWith(() => mkRes(404, 'nf'));
  const body = await fetchRemoteFeatureScores(PATH, client);
  assert.equal(body, null);
});

// 3. 401 は fatal（匿名 fallback なし・partial write なし）
test('3. 401 は AUTH_FAILED で throw（匿名 fallback なし）', async () => {
  const client = clientWith(() => mkRes(401, 'bad'));
  await assert.rejects(fetchRemoteFeatureScores(PATH, client), (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED);
});

// 4. timeout は retry 後 fatal
test('4. timeout は TIMEOUT で throw', async () => {
  const client = clientWith(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  await assert.rejects(fetchRemoteFeatureScores(PATH, client), (e) => e.code === SHARED_FETCH_CODES.TIMEOUT);
});

// 5. token 未設定 → 取得前に TOKEN_MISSING（fetch 呼ばない）
test('5. token 未設定は TOKEN_MISSING（fetch 未実行）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { races: {} }));
  const client = createSharedClient({ fetchImpl, env: {}, sleepImpl: noSleep });
  await assert.rejects(fetchRemoteFeatureScores(PATH, client), (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING);
  assert.equal(fetchImpl.calls.length, 0);
});

// 6. token / Authorization が error に漏れない
test('6. token・Bearer が error へ漏れない', async () => {
  const client = clientWith(() => mkRes(401, 'bad'));
  await assert.rejects(fetchRemoteFeatureScores(PATH, client), (e) => {
    const hay = `${e.message}\n${e.stack}`;
    assert.ok(!hay.includes(SECRET));
    assert.ok(!/Bearer\s/i.test(hay));
    return true;
  });
});
