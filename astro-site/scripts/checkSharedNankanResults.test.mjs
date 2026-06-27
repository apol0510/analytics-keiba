/**
 * checkSharedNankanResults.test.mjs — 認証付き results 確認 script の単体テスト
 * （node:test / 新規依存なし / 全 mock fetch・実 GitHub 通信なし）
 *   node --test scripts/checkSharedNankanResults.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSharedNankanResults } from './checkSharedNankanResults.mjs';
import { createSharedClient, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';

const SECRET = 'ghp_THIS_IS_A_TEST_SECRET_TOKEN_should_never_leak';
const ENV_OK = { KEIBA_DATA_SHARED_TOKEN: SECRET };
const ARGV = ['--date', '2026-05-08', '--venues', 'OOI,FUN,KAW,URA'];

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
  const fn = async (url, init) => { calls.push({ url, init }); return responder(url, init, calls.length - 1); };
  fn.calls = calls;
  return fn;
}
const noSleep = async () => {};
const silentLogger = { log() {}, warn() {}, error() {} };

/** venue code を URL から取り出す（…2026-05-08-OOI.json） */
function codeOf(url) {
  const m = decodeURIComponent(url).match(/2026-05-08-([A-Z]+)\.json/);
  return m ? m[1] : null;
}
function clientWith(responder, { retries = 2 } = {}) {
  return createSharedClient({ fetchImpl: mkFetch(responder), env: ENV_OK, sleepImpl: noSleep, retries });
}
function run(overrides = {}) {
  return checkSharedNankanResults({ argv: ARGV, env: ENV_OK, logger: silentLogger, ...overrides });
}

// 200 + 404 混在 → 200 の会場だけ返す
test('1. 200/404 混在 → 存在会場のみ・race数合計', async () => {
  const client = clientWith((url) => {
    const code = codeOf(url);
    if (code === 'OOI') return mkRes(200, { races: [1, 2, 3] });
    if (code === 'FUN') return mkRes(200, { races: [1, 2, 3, 4, 5] });
    return mkRes(404, 'Not Found'); // KAW/URA 未投入
  });
  const { foundCodes, totalRaces } = await run({ client });
  assert.deepEqual(foundCodes, ['OOI', 'FUN']);
  assert.equal(totalRaces, 8);
});

// 全404 → 正常な空（throw しない）
test('2. 全 404 → 正常な空（foundCodes=[] / totalRaces=0、throw しない）', async () => {
  const client = clientWith(() => mkRes(404, 'Not Found'));
  const { foundCodes, totalRaces } = await run({ client });
  assert.deepEqual(foundCodes, []);
  assert.equal(totalRaces, 0);
});

// 401 → fatal
test('3. 401 は fatal（throw・partial を返さない）', async () => {
  const client = clientWith((url) => (codeOf(url) === 'OOI' ? mkRes(401, 'Bad credentials') : mkRes(200, { races: [1] })));
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED);
});

// 403 → fatal
test('4. 403 は fatal', async () => {
  const client = clientWith(() => mkRes(403, 'Forbidden', { 'x-ratelimit-remaining': '50' }));
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.FORBIDDEN);
});

// rate limit → retry 後 fatal
test('5. rate limit(403 remaining:0) は retry 後 fatal', async () => {
  const fetchImpl = mkFetch(() => mkRes(403, 'rate limit', { 'x-ratelimit-remaining': '0' }));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep, retries: 2 });
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.RATE_LIMITED);
});

// 500 → retry 後 fatal
test('6. 500 は retry 後 fatal', async () => {
  const client = clientWith(() => mkRes(500, 'err'));
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.SERVER_ERROR);
});

// timeout → retry 後 fatal
test('7. timeout は retry 後 fatal', async () => {
  const fetchImpl = mkFetch(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep, retries: 2 });
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.TIMEOUT);
});

// token 未設定 → 取得前に fatal
test('8. token 未設定は取得前に TOKEN_MISSING（fetch 呼ばない）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { races: [] }));
  const client = createSharedClient({ fetchImpl, env: {}, sleepImpl: noSleep });
  await assert.rejects(run({ env: {}, client }), (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING);
  assert.equal(fetchImpl.calls.length, 0);
});

// token 非ログ
test('9. token / Authorization / Bearer がログ・エラーへ漏れない', async () => {
  const logs = [];
  const logger = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
  let thrown;
  const client = clientWith(() => mkRes(401, 'Bad credentials'));
  await run({ client, logger }).catch((e) => { thrown = e; });
  const hay = `${logs.join('\n')}\n${thrown?.message}\n${thrown?.stack}`;
  assert.ok(!hay.includes(SECRET));
  assert.ok(!/Bearer\s/i.test(hay));
  assert.ok(!/Authorization/i.test(hay));
});

// partial を返さない（後半 fatal なら前半成功も破棄）
test('10. 途中 fatal なら partial result を返さず throw', async () => {
  const client = clientWith((url) => {
    const code = codeOf(url);
    if (code === 'OOI') return mkRes(200, { races: [1, 2] });
    if (code === 'FUN') return mkRes(500, 'err');
    return mkRes(200, { races: [1] });
  });
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.SERVER_ERROR);
});
