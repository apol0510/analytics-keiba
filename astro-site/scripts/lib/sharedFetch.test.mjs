/**
 * sharedFetch.test.mjs — contract test（node:test / 標準アサーション・新規依存なし）
 *
 * すべて mock fetch で実行し、GitHub へは実通信しない。
 *   node --test scripts/lib/sharedFetch.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSharedClient,
  resolveSharedToken,
  SharedFetchError,
  SHARED_FETCH_CODES,
  TOKEN_ENV_NAMES,
} from './sharedFetch.mjs';

const SECRET = 'ghp_THIS_IS_A_TEST_SECRET_TOKEN_should_never_leak';

/** 簡易レスポンスモック */
function mkRes(status, body, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** 呼び出しを記録する mock fetch を生成 */
function mkFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};
const baseEnv = { KEIBA_DATA_SHARED_TOKEN: SECRET };

function makeClient(overrides = {}) {
  return createSharedClient({
    fetchImpl: overrides.fetchImpl,
    env: overrides.env ?? baseEnv,
    sleepImpl: overrides.sleepImpl ?? noSleep,
    retries: overrides.retries ?? 2,
    ...overrides.rest,
  });
}

// 1. KEIBA_DATA_SHARED_TOKEN を最優先
test('1. KEIBA_DATA_SHARED_TOKEN を最優先で解決', () => {
  const { token, source } = resolveSharedToken({
    env: { KEIBA_DATA_SHARED_TOKEN: 'A', GITHUB_TOKEN_KEIBA_DATA_SHARED: 'B', GITHUB_TOKEN: 'C' },
  });
  assert.equal(token, 'A');
  assert.equal(source, 'KEIBA_DATA_SHARED_TOKEN');
});

// 2. 互換 token 名への fallback
test('2. 互換 token 名へ fallback（順序通り）', () => {
  assert.equal(resolveSharedToken({ env: { GITHUB_TOKEN_KEIBA_DATA_SHARED: 'B', GITHUB_TOKEN: 'C' } }).source, 'GITHUB_TOKEN_KEIBA_DATA_SHARED');
  assert.equal(resolveSharedToken({ env: { GITHUB_TOKEN: 'C' } }).source, 'GITHUB_TOKEN');
  assert.deepEqual(TOKEN_ENV_NAMES, ['KEIBA_DATA_SHARED_TOKEN', 'GITHUB_TOKEN_KEIBA_DATA_SHARED', 'GITHUB_TOKEN']);
});

// 3. token 全未設定で TOKEN_MISSING
test('3. token 全未設定で TOKEN_MISSING を throw（匿名 fallback しない）', async () => {
  assert.throws(() => resolveSharedToken({ env: {} }), (e) => e instanceof SharedFetchError && e.code === SHARED_FETCH_CODES.TOKEN_MISSING);
  // 空文字も未設定扱い
  assert.throws(() => resolveSharedToken({ env: { KEIBA_DATA_SHARED_TOKEN: '   ' } }), (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING);
  // client 経由でも fetch せず即失敗
  const fetchImpl = mkFetch(() => mkRes(200, { ok: true }));
  const client = makeClient({ fetchImpl, env: {} });
  await assert.rejects(client.fetchJson('x/y.json'), (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING);
  assert.equal(fetchImpl.calls.length, 0, 'token 未設定時は fetch を呼ばない');
});

// 4. Authorization が Bearer で付与される
test('4. Authorization: Bearer <token> が付与される', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { ok: true }));
  const client = makeClient({ fetchImpl });
  await client.fetchJson('nankan/results/2026/05/2026-05-08-FUN.json');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(fetchImpl.calls[0].init.headers.Accept, 'application/vnd.github.raw+json');
});

// 5. token が URL へ入らない
test('5. token が URL へ含まれない', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { ok: true }));
  const client = makeClient({ fetchImpl });
  await client.fetchJson('nankan/results/2026/05/2026-05-08-FUN.json', { ref: 'main' });
  const url = fetchImpl.calls[0].url;
  assert.ok(!url.includes(SECRET), 'URL に token が含まれてはならない');
  assert.ok(url.startsWith('https://api.github.com/repos/apol0510/keiba-data-shared/contents/'));
  assert.ok(url.includes('?ref=main'));
});

// 6. token が error message / stack へ入らない
test('6. token が error message・stack へ含まれない', async () => {
  const fetchImpl = mkFetch(() => mkRes(401, 'Bad credentials'));
  const client = makeClient({ fetchImpl });
  await assert.rejects(client.fetchJson('x/y.json'), (e) => {
    assert.ok(!String(e.message).includes(SECRET));
    assert.ok(!String(e.stack || '').includes(SECRET));
    return true;
  });
});

// 7. 200 JSON 成功
test('7. 200 で JSON を返す', async () => {
  const payload = { races: [{ raceNumber: 1 }] };
  const fetchImpl = mkFetch(() => mkRes(200, payload));
  const client = makeClient({ fetchImpl });
  const out = await client.fetchJson('nankan/results/2026/05/2026-05-08-FUN.json');
  assert.deepEqual(out, payload);
});

// 8. required=true の 404 で NOT_FOUND
test('8. required=true の 404 は NOT_FOUND を throw', async () => {
  const fetchImpl = mkFetch(() => mkRes(404, 'Not Found'));
  const client = makeClient({ fetchImpl });
  await assert.rejects(client.fetchJson('x/y.json', { required: true }), (e) => e.code === SHARED_FETCH_CODES.NOT_FOUND);
});

// 9. required=false の 404 で null
test('9. required=false の 404 は null', async () => {
  const fetchImpl = mkFetch(() => mkRes(404, 'Not Found'));
  const client = makeClient({ fetchImpl });
  assert.equal(await client.fetchJson('x/y.json', { required: false }), null);
  assert.equal(await client.fetchText('x/y.json', { required: false }), null);
});

// 10. 401 で AUTH_FAILED（404 と混同しない）
test('10. 401 は AUTH_FAILED（404 扱いしない）', async () => {
  const fetchImpl = mkFetch(() => mkRes(401, 'Bad credentials'));
  const client = makeClient({ fetchImpl });
  await assert.rejects(client.fetchJson('x/y.json', { required: false }), (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED);
});

// 11. 403（通常）で FORBIDDEN
test('11. 403（rate でない）は FORBIDDEN', async () => {
  const fetchImpl = mkFetch(() => mkRes(403, 'Forbidden', { 'x-ratelimit-remaining': '57' }));
  const client = makeClient({ fetchImpl });
  await assert.rejects(client.fetchJson('x/y.json', { required: false }), (e) => e.code === SHARED_FETCH_CODES.FORBIDDEN);
});

// 12. rate-limit 403 を RATE_LIMITED
test('12. 403 + x-ratelimit-remaining:0 は RATE_LIMITED（retry 後 失敗）', async () => {
  const fetchImpl = mkFetch(() => mkRes(403, 'rate limit exceeded', { 'x-ratelimit-remaining': '0' }));
  const client = makeClient({ fetchImpl, retries: 2 });
  await assert.rejects(client.fetchJson('x/y.json'), (e) => e.code === SHARED_FETCH_CODES.RATE_LIMITED);
  assert.equal(fetchImpl.calls.length, 3, '初回 + retry2 = 3 回');
});

// 13. 500 を規定回数 retry 後に失敗
test('13. 500 は retries 回 retry 後に SERVER_ERROR', async () => {
  const fetchImpl = mkFetch(() => mkRes(500, 'Internal Server Error'));
  const client = makeClient({ fetchImpl, retries: 2 });
  await assert.rejects(client.fetchJson('x/y.json'), (e) => e.code === SHARED_FETCH_CODES.SERVER_ERROR);
  assert.equal(fetchImpl.calls.length, 3);
});

// 14. timeout を retry 後に失敗
test('14. timeout(AbortError) は retry 後に TIMEOUT', async () => {
  const fetchImpl = mkFetch(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  const client = makeClient({ fetchImpl, retries: 2 });
  await assert.rejects(client.fetchJson('x/y.json'), (e) => e.code === SHARED_FETCH_CODES.TIMEOUT);
  assert.equal(fetchImpl.calls.length, 3);
});

// 15. JSON 破損で INVALID_JSON（retry しない）
test('15. 200 だが本文が壊れた JSON は INVALID_JSON（retry しない）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, '{ this is : not json'));
  const client = makeClient({ fetchImpl });
  await assert.rejects(client.fetchJson('x/y.json'), (e) => e.code === SHARED_FETCH_CODES.INVALID_JSON);
  assert.equal(fetchImpl.calls.length, 1, 'INVALID_JSON は retry しない');
});

// 16. list API 成功
test('16. listDirectory が name/path/sha/size/type を返す', async () => {
  const listing = [
    { name: '2026-05-08-FUN.json', path: 'nankan/results/2026/05/2026-05-08-FUN.json', sha: 'abc', size: 1234, type: 'file', extra: 'drop' },
    { name: '05', path: 'nankan/results/2026/05', sha: 'def', size: 0, type: 'dir' },
  ];
  const fetchImpl = mkFetch(() => mkRes(200, listing));
  const client = makeClient({ fetchImpl });
  const out = await client.listDirectory('nankan/results/2026/05');
  assert.equal(fetchImpl.calls[0].init.headers.Accept, 'application/vnd.github+json');
  assert.deepEqual(out, [
    { name: '2026-05-08-FUN.json', path: 'nankan/results/2026/05/2026-05-08-FUN.json', sha: 'abc', size: 1234, type: 'file' },
    { name: '05', path: 'nankan/results/2026/05', sha: 'def', size: 0, type: 'dir' },
  ]);
});

// 17. response 異常で INVALID_RESPONSE
test('17. listDirectory が配列でない応答は INVALID_RESPONSE', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { message: 'not an array' }));
  const client = makeClient({ fetchImpl });
  await assert.rejects(client.listDirectory('nankan/results'), (e) => e.code === SHARED_FETCH_CODES.INVALID_RESPONSE);
});

// 補助: 403 too large → FILE_TOO_LARGE（taxonomy 検証 / retry しない）
test('18. 403 "too large" は FILE_TOO_LARGE（retry しない）', async () => {
  const fetchImpl = mkFetch(() => mkRes(403, 'The requested blob is too large to fetch via the API; use the Git Data API.', {}));
  const client = makeClient({ fetchImpl });
  await assert.rejects(client.fetchJson('jra/horseHistories/2026/05/2026-05-31-TOK.json'), (e) => e.code === SHARED_FETCH_CODES.FILE_TOO_LARGE);
  assert.equal(fetchImpl.calls.length, 1);
});

// ───────── entry 取得（1MB 以下 = Contents API / 1MB 超 = blobs API） ─────────

const SMALL = { name: 'a.json', path: 'jra/horseHistories/a.json', sha: 'sha_small', size: 500, type: 'file' };
const BIG = { name: 'b.json', path: 'jra/horseHistories/b.json', sha: 'sha_big', size: 2 * 1024 * 1024, type: 'file' };
const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

function isContentsUrl(url) { return url.includes('/contents/'); }
function isBlobUrl(url) { return url.includes('/git/blobs/'); }

// 19. 1MB 以下 entry は Contents API（blobs API を呼ばない）
test('19. 小ファイル entry は Contents API で取得（blobs 未使用）', async () => {
  const fetchImpl = mkFetch((url) => (isContentsUrl(url) ? mkRes(200, '{"h":"small"}') : mkRes(500, 'should not call blobs')));
  const client = makeClient({ fetchImpl });
  const out = await client.fetchJsonFromEntry(SMALL);
  assert.deepEqual(out, { h: 'small' });
  assert.ok(fetchImpl.calls.every((c) => isContentsUrl(c.url)), 'blobs API は呼ばれない');
});

// 20. 1MB 超 entry は blobs API + base64 decode
test('20. 大ファイル entry は blobs API で base64 decode 取得', async () => {
  const fetchImpl = mkFetch((url) => {
    if (isBlobUrl(url)) return mkRes(200, { encoding: 'base64', content: b64('{"h":"big"}'), sha: 'sha_big' });
    return mkRes(500, 'contents must not be used for >1MB');
  });
  const client = makeClient({ fetchImpl });
  const out = await client.fetchJsonFromEntry(BIG);
  assert.deepEqual(out, { h: 'big' });
  assert.ok(fetchImpl.calls.some((c) => isBlobUrl(c.url)), 'blobs API が使われる');
  assert.ok(fetchImpl.calls[0].url.includes('sha_big'), 'sha で blob URL を構築');
  assert.ok(!fetchImpl.calls[0].url.includes(SECRET), 'token を URL へ含めない');
});

// 21. blobs encoding が base64 でない → INVALID_RESPONSE
test('21. blob encoding 非 base64 は INVALID_RESPONSE', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { encoding: 'utf-8', content: 'plain', sha: 'sha_big' }));
  const client = makeClient({ fetchImpl });
  await assert.rejects(client.fetchFileFromEntry(BIG), (e) => e.code === SHARED_FETCH_CODES.INVALID_RESPONSE);
});

// 22. blob content 欠落 → INVALID_RESPONSE
test('22. blob content 欠落は INVALID_RESPONSE', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { encoding: 'base64', sha: 'sha_big' }));
  const client = makeClient({ fetchImpl });
  await assert.rejects(client.fetchFileFromEntry(BIG), (e) => e.code === SHARED_FETCH_CODES.INVALID_RESPONSE);
});

// 23. blob 本文の base64 が壊れた JSON → INVALID_JSON
test('23. blob decode 後の本文が不正 JSON は INVALID_JSON', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { encoding: 'base64', content: b64('{ not json'), sha: 'sha_big' }));
  const client = makeClient({ fetchImpl });
  await assert.rejects(client.fetchJsonFromEntry(BIG), (e) => e.code === SHARED_FETCH_CODES.INVALID_JSON);
});

// 24. 一覧済み entry の 404（小）は required=true で fatal、required=false で null
test('24. 一覧済み entry 404: required=true fatal / required=false null', async () => {
  const fetchImpl = mkFetch(() => mkRes(404, 'Not Found'));
  const client = makeClient({ fetchImpl });
  await assert.rejects(client.fetchFileFromEntry(SMALL), (e) => e.code === SHARED_FETCH_CODES.NOT_FOUND);
  assert.equal(await client.fetchFileFromEntry(SMALL, { required: false }), null);
});

// 25. 大 entry の blobs 404: required=true fatal / required=false null
test('25. 大 entry blobs 404: required=true fatal / required=false null', async () => {
  const fetchImpl = mkFetch(() => mkRes(404, 'Not Found'));
  const client = makeClient({ fetchImpl });
  await assert.rejects(client.fetchFileFromEntry(BIG), (e) => e.code === SHARED_FETCH_CODES.NOT_FOUND);
  assert.equal(await client.fetchFileFromEntry(BIG, { required: false }), null);
});

// 26. 大 entry に sha が無い → INVALID_RESPONSE（blobs 不可）
test('26. 大 entry に sha 無しは INVALID_RESPONSE', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { encoding: 'base64', content: b64('{}') }));
  const client = makeClient({ fetchImpl });
  await assert.rejects(client.fetchFileFromEntry({ ...BIG, sha: '' }), (e) => e.code === SHARED_FETCH_CODES.INVALID_RESPONSE);
  assert.equal(fetchImpl.calls.length, 0, 'sha 無しは fetch せず即失敗');
});

// 27. entry 取得も token 未設定で TOKEN_MISSING（fetch 未実行）
test('27. entry 取得は token 未設定で TOKEN_MISSING（fetch 未実行）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { encoding: 'base64', content: b64('{}'), sha: 'x' }));
  const client = makeClient({ fetchImpl, env: {} });
  await assert.rejects(client.fetchFileFromEntry(BIG), (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING);
  assert.equal(fetchImpl.calls.length, 0);
});

// 28. blobs 5xx は retry 後 fatal / token・secret 非露出
test('28. blobs 5xx は retry 後 SERVER_ERROR、secret 非露出', async () => {
  const fetchImpl = mkFetch(() => mkRes(500, 'err'));
  const client = makeClient({ fetchImpl, retries: 2 });
  await assert.rejects(client.fetchFileFromEntry(BIG), (e) => {
    assert.equal(e.code, SHARED_FETCH_CODES.SERVER_ERROR);
    assert.ok(!String(e.message).includes(SECRET) && !String(e.stack || '').includes(SECRET));
    return true;
  });
  assert.equal(fetchImpl.calls.length, 3, '初回 + retry2');
});
