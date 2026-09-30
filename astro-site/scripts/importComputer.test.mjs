/**
 * importComputer.test.mjs — computer JSON 取得（listing + text）の認証/失敗伝播契約テスト
 * （node:test / 新規依存なし / 全 mock fetch・実通信なし）
 *   node --test scripts/importComputer.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchComputerForDate, fetchComputerListingForDate, planComputerPrune, PRUNE_LIMIT_PER_DATE } from './importComputer.js';
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

// ── prune（shared から消えた computer を local からも消す・2026-09-30）──
test('9. listing 404 → listed:false（prune しない）/ 200 で当日 0 件 → listed:true', async () => {
  const c404 = clientWith(() => mkRes(404, 'nf'));
  assert.deepEqual(await fetchComputerListingForDate(CAT, DATE, c404), { listed: false, files: [] });
  const cOther = clientWith((url) => (pathOf(url) === dir ? mkRes(200, [listing[2]]) : mkRes(404, 'nf')));
  assert.deepEqual(await fetchComputerListingForDate(CAT, DATE, cOther), { listed: true, files: [] });
});

test('10. 9/21 再現: shared は阪神だけ → local の中山だけ消す（他日付・他ファイルは触らない）', () => {
  const d = '2026-09-21';
  const stale = planComputerPrune({ date: d, listed: true, sharedNames: [`${d}-HAN.json`], localNames: [`${d}-HAN.json`, `${d}-NAK.json`, '2026-09-20-NAK.json', 'README.md'] });
  assert.deepEqual(stale, [`${d}-NAK.json`]);
});

test('11. 一覧を取得できていなければ何も消さない', () => {
  assert.deepEqual(planComputerPrune({ date: DATE, listed: false, sharedNames: [], localNames: [`${DATE}-TOK.json`] }), []);
});

test('12. shared に当日 0 件（一覧は取得済み）→ 当日の local は消す（上限内）', () => {
  assert.deepEqual(planComputerPrune({ date: DATE, listed: true, sharedNames: [], localNames: [`${DATE}-TOK.json`, `${DATE}-KYO.json`] }), [`${DATE}-KYO.json`, `${DATE}-TOK.json`]);
});

test('13. 上限を超える prune は消さずに FAIL', () => {
  const many = Array.from({ length: PRUNE_LIMIT_PER_DATE + 1 }, (_, i) => `${DATE}-V${i}.json`);
  assert.throws(() => planComputerPrune({ date: DATE, listed: true, sharedNames: [], localNames: many }), /上限/);
});
