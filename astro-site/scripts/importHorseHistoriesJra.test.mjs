/**
 * importHorseHistoriesJra.test.mjs — horseHistories 取得（listing + entry 本文）の
 * 認証/blob 切替/失敗伝播 契約テスト
 *   （node:test / 新規依存なし / 全 mock fetch・実通信なし）
 *   node --test scripts/importHorseHistoriesJra.test.mjs
 *
 * ≤1MB は Contents API（/contents/）, >1MB は git blobs API（/git/blobs/, base64）で
 * 取得されることを、両 URL を mock して検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchHorseHistoriesForDate } from './importHorseHistoriesJra.js';
import { createSharedClient, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';

const SECRET = 'ghp_THIS_IS_A_TEST_SECRET_TOKEN_should_never_leak';
const ENV_OK = { KEIBA_DATA_SHARED_TOKEN: SECRET };
const noSleep = async () => {};

const SMALL = 500;
const LARGE = 2 * 1024 * 1024; // > 1MB → blobs API へ

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
function isBlobUrl(url) {
  return url.includes('/git/blobs/');
}
function contentsPathOf(url) {
  const m = decodeURIComponent(url).match(/contents\/(.+?)(\?ref=|$)/);
  return m ? m[1] : '';
}
function b64(obj) {
  return Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64');
}
function blobRes(obj) {
  // GitHub git blobs API 形（base64）
  return mkRes(200, { sha: 'x', encoding: 'base64', content: b64(obj), size: LARGE });
}
function clientWith(responder, { env = ENV_OK, retries = 2 } = {}) {
  return createSharedClient({ fetchImpl: mkFetch(responder), env, sleepImpl: noSleep, retries });
}

const DATE = '2026-05-24', Y = '2026', M = '05';
const dir = `jra/horseHistories/${Y}/${M}`;
const tokJson = { source: 'jra-official', date: DATE, venueCode: 'TOK', horses: { '1': {} } };
const kyoJson = { source: 'jra-official', date: DATE, venueCode: 'KYO', horses: { '2': {} } };

function entry(venue, size, sha) {
  const name = `${DATE}-${venue}.json`;
  return { name, path: `${dir}/${name}`, sha, size, type: 'file' };
}

// 1. 小ファイル(≤1MB) → Contents API path、blobs は呼ばれない
test('1. 小ファイルは Contents API で取得し blobs を呼ばない', async () => {
  const fetchImpl = mkFetch((url) => {
    if (isBlobUrl(url)) return mkRes(500, 'blobs should NOT be called');
    const p = contentsPathOf(url);
    if (p === dir) return mkRes(200, [entry('TOK', SMALL, 'a')]);
    if (p === `${dir}/${DATE}-TOK.json`) return mkRes(200, JSON.stringify(tokJson));
    return mkRes(404, 'nf');
  });
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  const out = await fetchHorseHistoriesForDate(DATE, ['TOK'], client);
  const tok = out.find((o) => o.venue === 'TOK');
  assert.equal(tok.found, true);
  assert.deepEqual(tok.json, tokJson);
  assert.equal(fetchImpl.calls.some((c) => isBlobUrl(c.url)), false, 'blobs API は呼ばれない');
});

// 2. 大ファイル(>1MB) → blobs API path + base64 decode → 正しい JSON
test('2. 大ファイルは git blobs API（base64）で取得し decode できる', async () => {
  const fetchImpl = mkFetch((url) => {
    if (isBlobUrl(url)) {
      assert.ok(url.includes('/git/blobs/shaKYO'), 'entry.sha でブロブ取得');
      return blobRes(kyoJson);
    }
    const p = contentsPathOf(url);
    if (p === dir) return mkRes(200, [entry('KYO', LARGE, 'shaKYO')]);
    return mkRes(404, 'nf'); // 大ファイルは Contents raw 経由では取らない
  });
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  const out = await fetchHorseHistoriesForDate(DATE, ['KYO'], client);
  const kyo = out.find((o) => o.venue === 'KYO');
  assert.equal(kyo.found, true);
  assert.deepEqual(kyo.json, kyoJson);
  assert.equal(fetchImpl.calls.some((c) => isBlobUrl(c.url)), true, 'blobs API が呼ばれる');
});

// 3. mixed directory（小+大）両方取得
test('3. 小・大が混在しても全て取得できる', async () => {
  const fetchImpl = mkFetch((url) => {
    if (isBlobUrl(url)) return blobRes(kyoJson); // KYO（大）
    const p = contentsPathOf(url);
    if (p === dir) return mkRes(200, [entry('TOK', SMALL, 'a'), entry('KYO', LARGE, 'shaKYO')]);
    if (p === `${dir}/${DATE}-TOK.json`) return mkRes(200, JSON.stringify(tokJson));
    return mkRes(404, 'nf');
  });
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  const out = await fetchHorseHistoriesForDate(DATE, ['TOK', 'KYO'], client);
  assert.equal(out.filter((o) => o.found).length, 2);
  assert.deepEqual(out.find((o) => o.venue === 'TOK').json, tokJson);
  assert.deepEqual(out.find((o) => o.venue === 'KYO').json, kyoJson);
  // TOK は Contents、KYO は blobs
  assert.equal(fetchImpl.calls.filter((c) => isBlobUrl(c.url)).length, 1);
});

// 3ب. 一覧に無い venue は found:false（skip 扱い・fatal ではない）
test('3b. 一覧に無い venue は found:false（skip）', async () => {
  const client = clientWith((url) => {
    const p = contentsPathOf(url);
    if (p === dir) return mkRes(200, [entry('TOK', SMALL, 'a')]);
    if (p === `${dir}/${DATE}-TOK.json`) return mkRes(200, JSON.stringify(tokJson));
    return mkRes(404, 'nf');
  });
  const out = await fetchHorseHistoriesForDate(DATE, ['TOK', 'NII'], client);
  assert.equal(out.find((o) => o.venue === 'TOK').found, true);
  assert.equal(out.find((o) => o.venue === 'NII').found, false);
});

// 4. blob invalid response（encoding!==base64 → INVALID_RESPONSE）
test('4. blob の encoding が base64 でなければ INVALID_RESPONSE', async () => {
  const client = clientWith((url) => {
    if (isBlobUrl(url)) return mkRes(200, { encoding: 'utf-8', content: 'plain', size: LARGE });
    const p = contentsPathOf(url);
    if (p === dir) return mkRes(200, [entry('KYO', LARGE, 'shaKYO')]);
    return mkRes(404, 'nf');
  });
  await assert.rejects(
    fetchHorseHistoriesForDate(DATE, ['KYO'], client),
    (e) => e.code === SHARED_FETCH_CODES.INVALID_RESPONSE,
  );
});

// 5. 一覧済み entry の 404 は fatal（required:true）
test('5. 一覧済みファイルの本文 404 は fatal（NOT_FOUND）', async () => {
  const client = clientWith((url) => {
    const p = contentsPathOf(url);
    if (p === dir) return mkRes(200, [entry('TOK', SMALL, 'a')]);
    return mkRes(404, 'nf'); // 一覧後にファイル本文が消えた
  });
  await assert.rejects(
    fetchHorseHistoriesForDate(DATE, ['TOK'], client),
    (e) => e.code === SHARED_FETCH_CODES.NOT_FOUND,
  );
});

// 5b. 月ディレクトリ自体の 404（optional）→ null（全 venue skip）
test('5b. 月ディレクトリ未投入(404)は null（silent skip）', async () => {
  const client = clientWith(() => mkRes(404, 'nf'));
  assert.equal(await fetchHorseHistoriesForDate(DATE, ['TOK', 'KYO'], client), null);
});

// 6. token 未設定 → fetch 前に TOKEN_MISSING（fetch 未実行）
test('6. token 未設定は TOKEN_MISSING（fetch 未実行）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, [entry('TOK', SMALL, 'a')]));
  const client = createSharedClient({ fetchImpl, env: {}, sleepImpl: noSleep });
  await assert.rejects(
    fetchHorseHistoriesForDate(DATE, ['TOK'], client),
    (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

// 7. 認証異常は fatal・匿名 fallback なし（raw.githubusercontent を一切叩かない）
test('7. listing 401 は fatal・匿名 raw fallback なし', async () => {
  const fetchImpl = mkFetch(() => mkRes(401, 'bad'));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  await assert.rejects(
    fetchHorseHistoriesForDate(DATE, ['TOK'], client),
    (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED,
  );
  assert.equal(
    fetchImpl.calls.some((c) => /raw\.githubusercontent\.com/.test(c.url)),
    false,
    '匿名 raw.githubusercontent への fallback はしない',
  );
});

// 7b. 通信異常も fatal（partial write なし: 取得関数は何も書かない）
test('7b. listing 500 は retry 後 fatal', async () => {
  const client = clientWith(() => mkRes(500, 'e'), { retries: 1 });
  await assert.rejects(
    fetchHorseHistoriesForDate(DATE, ['TOK'], client),
    (e) => e.code === SHARED_FETCH_CODES.SERVER_ERROR,
  );
});

// 8. token・Bearer が error message/stack へ漏れない
test('8. secret（token / Bearer）が error へ漏れない', async () => {
  const client = clientWith(() => mkRes(401, 'bad'));
  await assert.rejects(fetchHorseHistoriesForDate(DATE, ['TOK'], client), (e) => {
    const hay = `${e.message}\n${e.stack}`;
    return !hay.includes(SECRET) && !/Bearer\s/i.test(hay);
  });
});
