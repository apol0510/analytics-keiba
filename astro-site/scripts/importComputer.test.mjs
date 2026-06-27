/**
 * importComputer.test.mjs — computer JSON 取得（listing + text）の認証/失敗伝播契約テスト
 * （node:test / 新規依存なし / 全 mock fetch・実通信なし）
 *   node --test scripts/importComputer.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchComputerForDate } from './importComputer.js';
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
  const m = decodeURIComponent(url).match(/contents\/(.+?)(\?ref=|$)/);
  return m ? m[1] : '';
}
function clientWith(responder, { env = ENV_OK, retries = 2 } = {}) {
  return createSharedClient({ fetchImpl: mkFetch(responder), env, sleepImpl: noSleep, retries });
}

const CAT = 'jra', DATE = '2026-05-31', Y = '2026', M = '05';
const dir = `${CAT}/predictions/computer/${Y}/${M}`;
const listing = [
  { name: `${DATE}-TOK.json`, path: `${dir}/${DATE}-TOK.json`, sha: 'a', size: 100, type: 'file' },
  { name: `${DATE}-KYO.json`, path: `${dir}/${DATE}-KYO.json`, sha: 'b', size: 100, type: 'file' },
  { name: `2026-05-30-TOK.json`, path: `${dir}/2026-05-30-TOK.json`, sha: 'c', size: 100, type: 'file' }, // 別日
];

// 1. listing 200 → 該当日ファイルのみ text 取得
test('1. listing 200 → 当日ファイルのみ content(text) 取得', async () => {
  const client = clientWith((url) => {
    const p = pathOf(url);
    if (p === dir) return mkRes(200, listing);
    if (p === `${dir}/${DATE}-TOK.json`) return mkRes(200, '{"computer":"TOK"}');
    if (p === `${dir}/${DATE}-KYO.json`) return mkRes(200, '{"computer":"KYO"}');
    return mkRes(404, 'nf');
  });
  const out = await fetchComputerForDate(CAT, DATE, client);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((o) => o.name).sort(), [`${DATE}-KYO.json`, `${DATE}-TOK.json`]);
  assert.equal(out.find((o) => o.name === `${DATE}-TOK.json`).content, '{"computer":"TOK"}');
});

// 2. listing 404 → [] （optional）
test('2. listing 404 → [] （未投入）', async () => {
  const client = clientWith(() => mkRes(404, 'nf'));
  assert.deepEqual(await fetchComputerForDate(CAT, DATE, client), []);
});

// 3. listing 401 → fatal
test('3. listing 401 は fatal', async () => {
  const client = clientWith(() => mkRes(401, 'bad'));
  await assert.rejects(fetchComputerForDate(CAT, DATE, client), (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED);
});

// 4. listing 403 → fatal
test('4. listing 403 は fatal', async () => {
  const client = clientWith(() => mkRes(403, 'f', { 'x-ratelimit-remaining': '9' }));
  await assert.rejects(fetchComputerForDate(CAT, DATE, client), (e) => e.code === SHARED_FETCH_CODES.FORBIDDEN);
});

// 5. listing 500 → retry 後 fatal
test('5. listing 500 は fatal', async () => {
  const client = clientWith(() => mkRes(500, 'e'), { retries: 1 });
  await assert.rejects(fetchComputerForDate(CAT, DATE, client), (e) => e.code === SHARED_FETCH_CODES.SERVER_ERROR);
});

// 6. file が required 404（一覧後に消失）→ fatal
test('6. 一覧に存在したファイルの 404 は fatal', async () => {
  const client = clientWith((url) => {
    const p = pathOf(url);
    if (p === dir) return mkRes(200, [listing[0]]);
    return mkRes(404, 'nf'); // ファイル本文が消えた
  });
  await assert.rejects(fetchComputerForDate(CAT, DATE, client), (e) => e.code === SHARED_FETCH_CODES.NOT_FOUND);
});

// 7. token 未設定 → 取得前に TOKEN_MISSING（fetch 未実行）
test('7. token 未設定は TOKEN_MISSING（fetch 未実行）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, listing));
  const client = createSharedClient({ fetchImpl, env: {}, sleepImpl: noSleep });
  await assert.rejects(fetchComputerForDate(CAT, DATE, client), (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING);
  assert.equal(fetchImpl.calls.length, 0);
});

// 8. token・Bearer が error へ漏れない
test('8. token・Bearer が error へ漏れない', async () => {
  const client = clientWith(() => mkRes(401, 'bad'));
  await assert.rejects(fetchComputerForDate(CAT, DATE, client), (e) => {
    const hay = `${e.message}\n${e.stack}`;
    return !hay.includes(SECRET) && !/Bearer\s/i.test(hay);
  });
});
