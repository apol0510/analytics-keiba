/**
 * syncArchiveResults.test.mjs — shared 取得まわりの単体テスト
 * （node:test / mock client / 実 GitHub 通信なし / ファイル書込なし）
 *   node --test scripts/syncArchiveResults.test.mjs
 *
 * 守りたい契約:
 *   - 一時エラー（rate limit / timeout / 5xx）で run 全体を落とさない
 *     （2026-08-09: 14日中1日目の 403 で run が exit 1 になりメール通知が出ていた）
 *   - 認証・権限・token のエラーは従来どおり fatal（握り潰さない）
 *   - 月ディレクトリ一覧で、存在しない日への GET を撃たない（API 枠の節約）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSharedResults, processTrack } from './syncArchiveResults.js';
import { createSharedClient, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';

const SECRET = 'ghp_MOCK_TOKEN_syncArchiveResults_test';
const ENV_OK = { KEIBA_DATA_SHARED_TOKEN: SECRET };
const DATE = '2026-05-12';
const YEAR = '2026', MONTH = '05';

function mkRes(status, body, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    headers: { get: (n) => lower[n.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
function mkFetch(responder) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return responder(url, calls.length - 1); };
  fn.calls = calls;
  return fn;
}
const noSleep = async () => {};
function mkClient(responder) {
  return createSharedClient({ fetchImpl: mkFetch(responder), env: ENV_OK, sleepImpl: noSleep });
}
function mkEntries(names) {
  return names.map((n) => ({ name: n, path: `p/${n}`, sha: 's', size: 10, type: 'file' }));
}

// ----- checkSharedResults: 既存挙動（listingCache なし＝従来経路） -----

test('1. 統合ファイル 200 → totalRaces/venues を返す（per-venue 未呼び出し）', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, { races: Array(20).fill({ id: 'r' }), venue: '南関東' }));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  const result = await checkSharedResults(DATE, 'nankan', { client });
  assert.equal(result.totalRaces, 20);
  assert.deepEqual(result.venues, ['南関東']);
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fetchImpl.calls[0].url.includes(`nankan/results/${YEAR}/${MONTH}/${DATE}.json`));
});

test('2. 統合 races が空 → per-venue にフォールバック', async () => {
  const fetchImpl = mkFetch((url) => {
    if (!url.includes(`${DATE}-`)) return mkRes(200, { races: [], venue: 'unified' });
    if (url.includes('-OOI.json')) return mkRes(200, { races: Array(12).fill({ id: 'r' }) });
    if (url.includes('-FUN.json')) return mkRes(200, { races: Array(11).fill({ id: 'r' }) });
    return mkRes(404, 'Not Found');
  });
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  const result = await checkSharedResults(DATE, 'nankan', { client });
  assert.equal(result.totalRaces, 23);
  assert.deepEqual(result.venues, ['OOI', 'FUN']);
});

test('3. 全ファイル 404 → totalRaces=0, venues=[]', async () => {
  const result = await checkSharedResults(DATE, 'nankan', { client: mkClient(() => mkRes(404, 'Not Found')) });
  assert.equal(result.totalRaces, 0);
  assert.deepEqual(result.venues, []);
});

test('4. 401 は AUTH_FAILED fatal', async () => {
  await assert.rejects(
    checkSharedResults(DATE, 'nankan', { client: mkClient(() => mkRes(401, 'Bad credentials')) }),
    (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED,
  );
});

test('5. JRA: HAK が使用されない（HKD のみ）', async () => {
  const fetchImpl = mkFetch(() => mkRes(404, 'Not Found'));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  await checkSharedResults(DATE, 'jra', { client });
  const urls = fetchImpl.calls.map((c) => c.url);
  assert.ok(!urls.some((u) => u.includes('-HAK.json')), 'HAK が使用されてはいけない');
  assert.ok(urls.some((u) => u.includes('-HKD.json')), 'HKD は使用されるべき');
});

test('6. per-venue 途中で 401 → throw（partial 集計せず）', async () => {
  const fetchImpl = mkFetch((url) => {
    if (!url.includes(`${DATE}-`)) return mkRes(404, 'Not Found');
    if (url.includes('-OOI.json')) return mkRes(200, { races: [{ id: 'r' }] });
    return mkRes(401, 'Unauthorized');
  });
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  await assert.rejects(
    checkSharedResults(DATE, 'nankan', { client }),
    (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED,
  );
});

// ----- 月ディレクトリ一覧による GET 削減（listingCache 指定時） -----

test('7. listingCache あり: 一覧に無い日は per-venue GET を撃たない（一覧1回のみ）', async () => {
  const fetchImpl = mkFetch((url) => {
    if (url.includes(`jra/results/${YEAR}/${MONTH}?`)) return mkRes(200, mkEntries(['2026-05-31-TOK.json']));
    throw new Error(`予期しない GET: ${url}`);
  });
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  const result = await checkSharedResults(DATE, 'jra', { client, listingCache: new Map() });
  assert.equal(result.totalRaces, 0);
  assert.deepEqual(result.venues, []);
  assert.equal(fetchImpl.calls.length, 1, '従来 11 GET → 一覧 1 GET');
});

test('8. listingCache あり: 存在する会場だけ GET する', async () => {
  const fetchImpl = mkFetch((url) => {
    if (url.includes(`jra/results/${YEAR}/${MONTH}?`)) {
      return mkRes(200, mkEntries([`${DATE}-TOK.json`, `${DATE}-KYO.json`, `${DATE}-HAK.json`]));
    }
    if (url.includes('-TOK.json')) return mkRes(200, { races: Array(12).fill({ id: 'r' }) });
    if (url.includes('-KYO.json')) return mkRes(200, { races: Array(11).fill({ id: 'r' }) });
    throw new Error(`予期しない GET: ${url}`);
  });
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  const result = await checkSharedResults(DATE, 'jra', { client, listingCache: new Map() });
  assert.equal(result.totalRaces, 23);
  assert.deepEqual(result.venues, ['TOK', 'KYO']);
  assert.equal(fetchImpl.calls.length, 3);
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes('-HAK.json')), 'HAK を GET してはいけない');
});

test('9. listingCache は月ディレクトリごとに1回だけ一覧を取る', async () => {
  const fetchImpl = mkFetch((url) => {
    if (!url.endsWith('.json?ref=main')) return mkRes(200, mkEntries([]));
    return mkRes(404, 'Not Found');
  });
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  const cache = new Map();
  for (const d of ['2026-05-12', '2026-05-13', '2026-05-14']) {
    await checkSharedResults(d, 'jra', { client, listingCache: cache });
  }
  assert.equal(fetchImpl.calls.length, 1, '同月3日ぶんで一覧 GET は1回');
});

test('10. 一覧が 1000 件に達したら従来の per-venue GET へ落ちる（取りこぼし防止）', async () => {
  const many = Array.from({ length: 1000 }, (_, i) => `filler-${i}.json`);
  const fetchImpl = mkFetch((url) => {
    if (!url.endsWith('.json?ref=main')) return mkRes(200, mkEntries(many));
    if (url.includes('-TOK.json')) return mkRes(200, { races: Array(12).fill({ id: 'r' }) });
    return mkRes(404, 'Not Found');
  });
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  const result = await checkSharedResults(DATE, 'jra', { client, listingCache: new Map() });
  assert.equal(result.totalRaces, 12);
  assert.equal(fetchImpl.calls.length, 12, '一覧1 + 統合1 + 会場10');
});

// ----- 一時エラーの扱い（processTrack） -----

test('11. rate limit は run を落とさず、その日をスキップして継続する', async () => {
  const client = mkClient(() => mkRes(403, 'rate limit', { 'x-ratelimit-remaining': '0' }));
  const { summary } = await processTrack('jra', ['2026-05-12'], new Set(), false, { client });
  assert.equal(summary.transient.length, 1);
  assert.equal(summary.transient[0].code, SHARED_FETCH_CODES.RATE_LIMITED);
  assert.equal(summary.errors.length, 0, '一時エラーは errors に入れない（＝exit 1 にしない）');
});

test('12. 認証失敗は握り潰さず throw する（exit 1 のまま）', async () => {
  const client = mkClient(() => mkRes(401, 'Bad credentials'));
  await assert.rejects(
    processTrack('jra', ['2026-05-12'], new Set(), false, { client }),
    (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED,
  );
});

test('13. 一時エラーが3回連続したら走査を打ち切る（レート制限を悪化させない）', async () => {
  const fetchImpl = mkFetch(() => mkRes(429, 'slow down'));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  const dates = ['2026-05-10', '2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14'];
  const { summary } = await processTrack('jra', dates, new Set(), false, { client });
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.transient.length, 5, '残り日も transient として記録される');
  assert.equal(summary.transient[3].code, 'SKIPPED_AFTER_TRANSIENT');
  // 回復時刻の情報が無い 429 は sharedFetch が即 deferred へ倒すため、
  // 1 日あたり 1 リクエストで済む（従来は 250ms/500ms の無意味な再試行で 3 リクエスト）。
  assert.equal(fetchImpl.calls.length, 3, '3日ぶん × 各1リクエストで打ち切る（無駄な再試行をしない）');
});
