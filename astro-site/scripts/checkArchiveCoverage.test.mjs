/**
 * checkArchiveCoverage.test.mjs
 *   node --test scripts/checkArchiveCoverage.test.mjs
 *
 * 守りたい契約（偽の緑を作らないこと）:
 *   - shared の per-venue 構造を正しく読む（統合 daily ファイル前提にしない）
 *   - archive済み / 未開催 / 未投入 / 一時取得失敗 / 認証失敗 / schema不一致 を区別する
 *   - 実データ欠落は必ず非ゼロ exit（EXIT_DATA_GAP=3）
 *   - 一時エラーは deferred（exit 2）。run を落とさないが緑とも言わない
 *   - 同一 run で同じ月ディレクトリ一覧を二度取らない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkArchiveCoverage,
  decideExitCode,
  formatOutput,
  venuesFromNames,
  getDateRange,
  loadArchivedDates,
  classifyFatal,
  ArchiveCoverageSchemaError,
  EXIT_OK,
  EXIT_FATAL,
  EXIT_DEFERRED,
  EXIT_DATA_GAP,
} from './checkArchiveCoverage.mjs';
import { createSharedClient, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';

const SECRET = 'ghp_MOCK_TOKEN_checkArchiveCoverage_test';
const ENV_OK = { KEIBA_DATA_SHARED_TOKEN: SECRET };
const QUIET = { error: () => {} };
const NOW = new Date('2026-08-08T12:00:00+09:00');

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
  const fn = async (url, init) => { calls.push({ url, init }); return responder(url); };
  fn.calls = calls;
  return fn;
}
const noSleep = async () => {};
function entries(names) {
  return names.map((n) => ({ name: n, path: `d/${n}`, sha: 's', size: 1, type: 'file' }));
}
const isListing = (url) => !/\.json\?ref=/.test(url);
const races = (n) => ({ races: Array.from({ length: n }, (_, i) => ({ raceNumber: i + 1 })) });

/**
 * @param {Record<string,string[]>} dirs  dir 部分文字列 → その月のファイル名一覧
 * @param {Record<string,object>} files   ファイル名部分文字列 → JSON body
 */
function mkClient(dirs, files = {}) {
  const fetchImpl = mkFetch((url) => {
    if (isListing(url)) {
      for (const [key, names] of Object.entries(dirs)) {
        if (url.includes(encodeURIComponent(key).replace(/%2F/g, '/'))) return mkRes(200, entries(names));
      }
      return mkRes(404, 'Not Found');
    }
    for (const [key, body] of Object.entries(files)) {
      if (url.includes(key)) return mkRes(200, body);
    }
    return mkRes(404, 'Not Found');
  });
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  client.__fetch = fetchImpl;
  return client;
}

function run(opts) {
  return checkArchiveCoverage({
    env: ENV_OK,
    resolveToken: () => {},
    now: NOW,
    logger: QUIET,
    ...opts,
  });
}

// ---------------------------------------------------------------- 基本ヘルパー

test('1. venuesFromNames: 対象日の会場だけ拾い、他日付や未知コードを混ぜない', () => {
  const names = [
    '2026-08-08-CHU.json', '2026-08-08-NII.json', '2026-08-08-SAP.json',
    '2026-08-07-CHU.json', '2026-08-08-HAK.json', '2026-08-08.json', 'README.md',
  ];
  const r = venuesFromNames(names, '2026-08-08', ['TOK', 'KYO', 'HAN', 'NAK', 'CHU', 'KOK', 'NII', 'FKS', 'SAP', 'HKD']);
  assert.deepEqual(r.found, ['CHU', 'NII', 'SAP']);
  assert.deepEqual(r.unknown, ['HAK'], '未知コードは黙って捨てず可視化する');
});

test('2. getDateRange: 既定では当日を含めず、前日までを古い→新しい順に返す', () => {
  assert.deepEqual(getDateRange(3, NOW), ['2026-08-05', '2026-08-06', '2026-08-07']);
});

test('2b. getDateRange: --include-today 相当（endOffset=0）では当日を含む', () => {
  assert.deepEqual(getDateRange(3, NOW, 0), ['2026-08-06', '2026-08-07', '2026-08-08']);
});

test('2c. 当日は既定で監視対象外（レース前の「予想あり・結果なし」を誤アラートしない）', async () => {
  const client = mkClient({
    'jra/results/2026/08': [],
    'jra/predictions/computer/2026/08': ['2026-08-08-CHU.json', '2026-08-08-NII.json'],
  });
  const r = await run({ argv: ['--category', 'jra', '--days', '1'], client, archivedDates: new Set() });
  assert.deepEqual(r.rows.map((x) => x.date), ['2026-08-07'], '当日 2026-08-08 は入らない');
  assert.deepEqual(r.noResults, [], '当日の予想だけで results_missing にしない');
  assert.equal(decideExitCode(r), EXIT_OK);
});

test('3. loadArchivedDates: ファイル不在は schema エラー（欠落判定を空振りさせない）', () => {
  assert.throws(() => loadArchivedDates('/nonexistent/archive.json'), ArchiveCoverageSchemaError);
});

// ---------------------------------------------------------------- 開催日 JRA 3場

test('4. 開催日 JRA 3場: archive 済みなら ok / exit 0', async () => {
  const client = mkClient(
    {
      'jra/results/2026/08': ['2026-08-08-CHU.json', '2026-08-08-NII.json', '2026-08-08-SAP.json'],
      'jra/predictions/computer/2026/08': ['2026-08-08-CHU.json', '2026-08-08-NII.json', '2026-08-08-SAP.json'],
    },
    { '-CHU.json': races(12), '-NII.json': races(12), '-SAP.json': races(12) },
  );
  const r = await run({ argv: ['--category', 'jra', '--days', '1', '--include-today'], client, archivedDates: new Set(['2026-08-08']) });
  assert.equal(r.rows[0].state, 'ok');
  assert.equal(r.rows[0].resultRaces, 36);
  assert.deepEqual(r.rows[0].resultVenues, ['CHU', 'NII', 'SAP']);
  assert.equal(decideExitCode(r), EXIT_OK);
});

test('5. archive 欠落: 実データがあるのに archive に無い → exit 3（Failure）', async () => {
  const client = mkClient(
    {
      'jra/results/2026/08': ['2026-08-08-CHU.json', '2026-08-08-NII.json', '2026-08-08-SAP.json'],
      'jra/predictions/computer/2026/08': ['2026-08-08-CHU.json'],
    },
    { '-CHU.json': races(12), '-NII.json': races(12), '-SAP.json': races(12) },
  );
  const r = await run({ argv: ['--category', 'jra', '--days', '1', '--include-today'], client, archivedDates: new Set() });
  assert.equal(r.rows[0].state, 'archive_missing');
  assert.deepEqual(r.archiveMissing, ['2026-08-08']);
  assert.equal(decideExitCode(r), EXIT_DATA_GAP, '欠落で 0 を返してはいけない');
});

test('6. 非開催日: results も prediction も無ければ no_race / exit 0', async () => {
  const client = mkClient({ 'jra/results/2026/08': [], 'jra/predictions/computer/2026/08': [] });
  const r = await run({ argv: ['--category', 'jra', '--days', '1', '--include-today'], client, archivedDates: new Set() });
  assert.equal(r.rows[0].state, 'no_race');
  assert.equal(decideExitCode(r), EXIT_OK);
});

test('7. shared 未投入: 予想はあるのに結果が無い → results_missing / exit 3', async () => {
  const client = mkClient({
    'jra/results/2026/08': [],
    'jra/predictions/computer/2026/08': ['2026-08-08-CHU.json'],
  });
  const r = await run({ argv: ['--category', 'jra', '--days', '1', '--include-today'], client, archivedDates: new Set() });
  assert.equal(r.rows[0].state, 'results_missing');
  assert.deepEqual(r.noResults, ['2026-08-08']);
  assert.equal(decideExitCode(r), EXIT_DATA_GAP);
});

test('8. 閾値未満は partial（欠落と断定しない）/ exit 0', async () => {
  const client = mkClient(
    { 'jra/results/2026/08': ['2026-08-08-CHU.json'], 'jra/predictions/computer/2026/08': [] },
    { '-CHU.json': races(3) },
  );
  const r = await run({ argv: ['--category', 'jra', '--days', '1', '--include-today'], client, archivedDates: new Set() });
  assert.equal(r.rows[0].state, 'partial');
  assert.equal(decideExitCode(r), EXIT_OK);
});

// ---------------------------------------------------------------- 南関

test('9. 南関開催日: per-venue を読み 12R で判定', async () => {
  const client = mkClient(
    { 'nankan/results/2026/08': ['2026-08-08-FUN.json'], 'nankan/predictions/2026/08': ['2026-08-08-FUN.json'] },
    { '-FUN.json': races(12) },
  );
  const r = await run({ argv: ['--category', 'nankan', '--days', '1', '--include-today'], client, archivedDates: new Set(['2026-08-08']) });
  assert.equal(r.rows[0].state, 'ok');
  assert.equal(r.rows[0].resultRaces, 12);
  assert.deepEqual(r.rows[0].resultVenues, ['FUN']);
});

test('10. 南関: 統合 results ファイルがある日も読める', async () => {
  const client = mkClient(
    { 'nankan/results/2026/08': ['2026-08-08.json'], 'nankan/predictions/2026/08': [] },
    { '2026-08-08.json': races(12) },
  );
  const r = await run({ argv: ['--category', 'nankan', '--days', '1', '--include-today'], client, archivedDates: new Set() });
  assert.equal(r.rows[0].resultRaces, 12);
  assert.deepEqual(r.rows[0].resultVenues, ['unified']);
  assert.equal(r.rows[0].state, 'archive_missing');
});

// ---------------------------------------------------------------- 異常系

test('11. rate limit は deferred / exit 2（run を落とさないが緑にもしない）', async () => {
  const fetchImpl = mkFetch(() => mkRes(403, 'rate limit', { 'x-ratelimit-remaining': '0' }));
  const client = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  const r = await run({ argv: ['--category', 'jra', '--days', '2', '--include-today'], client, archivedDates: new Set() });
  assert.deepEqual(r.deferred, ['2026-08-07', '2026-08-08']);
  assert.equal(r.archiveMissing.length, 0);
  assert.equal(decideExitCode(r), EXIT_DEFERRED);
});

test('12. TIMEOUT / SERVER_ERROR も deferred', async () => {
  const client = createSharedClient({
    fetchImpl: mkFetch(() => mkRes(503, 'unavailable')),
    env: ENV_OK,
    sleepImpl: noSleep,
  });
  const r = await run({ argv: ['--category', 'jra', '--days', '1', '--include-today'], client, archivedDates: new Set() });
  assert.equal(decideExitCode(r), EXIT_DEFERRED);
});

test('13. 認証失敗は deferred にせず throw（exit 1 相当）', async () => {
  const client = createSharedClient({
    fetchImpl: mkFetch(() => mkRes(401, 'Bad credentials')),
    env: ENV_OK,
    sleepImpl: noSleep,
  });
  await assert.rejects(
    run({ argv: ['--category', 'jra', '--days', '1', '--include-today'], client, archivedDates: new Set() }),
    (e) => classifyFatal(e) === 'auth',
  );
});

test('14. 権限不足(403 非rate-limit)も throw（exit 1 相当）', async () => {
  const client = createSharedClient({
    fetchImpl: mkFetch(() => mkRes(403, 'Resource not accessible', { 'x-ratelimit-remaining': '4999' })),
    env: ENV_OK,
    sleepImpl: noSleep,
  });
  await assert.rejects(
    run({ argv: ['--category', 'jra', '--days', '1', '--include-today'], client, archivedDates: new Set() }),
    (e) => classifyFatal(e) === 'forbidden',
  );
});

test('15. token 未設定は HTTP 到達前に fatal', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, entries([])));
  const client = createSharedClient({ fetchImpl, env: {}, sleepImpl: noSleep });
  await assert.rejects(
    checkArchiveCoverage({ argv: ['--category', 'jra', '--days', '1', '--include-today'], env: {}, client, now: NOW, logger: QUIET, archivedDates: new Set() }),
    (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('16. schema 不一致（races が配列でない）は deferred にせず fatal', async () => {
  const client = mkClient(
    { 'jra/results/2026/08': ['2026-08-08-CHU.json'], 'jra/predictions/computer/2026/08': [] },
    { '-CHU.json': { note: 'races がない' } },
  );
  await assert.rejects(
    run({ argv: ['--category', 'jra', '--days', '1', '--include-today'], client, archivedDates: new Set() }),
    (e) => classifyFatal(e) === 'schema' && e.sharedPath === 'jra/results/2026/08/2026-08-08-CHU.json',
  );
});

test('17. 404 は正常（未投入）であり fatal ではない', async () => {
  const client = mkClient({ 'jra/results/2026/08': [], 'jra/predictions/computer/2026/08': [] });
  const r = await run({ argv: ['--category', 'jra', '--days', '3', '--include-today'], client, archivedDates: new Set() });
  assert.equal(r.rows.length, 3);
  assert.ok(r.rows.every((x) => x.state === 'no_race'));
  assert.equal(decideExitCode(r), EXIT_OK);
});

// ---------------------------------------------------------------- GET 最小化

test('18. 同一 run で同じ月ディレクトリ一覧を二度取らない', async () => {
  const client = mkClient(
    { 'jra/results/2026/08': ['2026-08-08-CHU.json'], 'jra/predictions/computer/2026/08': [] },
    { '-CHU.json': races(12) },
  );
  await run({ argv: ['--category', 'jra', '--days', '7', '--include-today'], client, archivedDates: new Set(['2026-08-08']) });
  const listings = client.__fetch.calls.filter((c) => isListing(c.url)).map((c) => c.url);
  assert.equal(listings.length, 2, '7日ぶんでも results / predictions の一覧が各1回');
  assert.equal(new Set(listings).size, 2);
});

test('19. 非開催日にはファイル GET を撃たない', async () => {
  const client = mkClient({ 'jra/results/2026/08': [], 'jra/predictions/computer/2026/08': [] });
  await run({ argv: ['--category', 'jra', '--days', '7', '--include-today'], client, archivedDates: new Set() });
  const fileGets = client.__fetch.calls.filter((c) => !isListing(c.url));
  assert.equal(fileGets.length, 0);
});

// ---------------------------------------------------------------- 出力契約

test('20. 出力は機械可読で、欠落日と deferred を明示する', async () => {
  const client = mkClient(
    {
      'jra/results/2026/08': ['2026-08-08-CHU.json', '2026-08-08-NII.json'],
      'jra/predictions/computer/2026/08': [],
    },
    { '-CHU.json': races(12), '-NII.json': races(12) },
  );
  const r = await run({ argv: ['--category', 'jra', '--days', '1', '--include-today'], client, archivedDates: new Set() });
  const out = formatOutput(r);
  assert.match(out, /^DATE=2026-08-08 STATE=archive_missing RESULT_RACES=24 RESULT_VENUES=CHU,NII PREDICTION_VENUES= ARCHIVED=false$/m);
  assert.match(out, /^ARCHIVE_MISSING_DATES=2026-08-08$/m);
  assert.match(out, /^NO_RESULTS_DATES=$/m);
  assert.match(out, /^DEFERRED_DATES=$/m);
  assert.doesNotMatch(out, new RegExp(SECRET), 'token を出力しない');
});

test('21. exit code は 0/1/2/3 のみで、欠落時に 0 を返さない', () => {
  assert.equal(EXIT_OK, 0);
  assert.equal(EXIT_FATAL, 1);
  assert.equal(EXIT_DEFERRED, 2);
  assert.equal(EXIT_DATA_GAP, 3);
  assert.equal(decideExitCode({ archiveMissing: ['d'], noResults: [], deferred: ['x'] }), EXIT_DATA_GAP);
  assert.equal(decideExitCode({ archiveMissing: [], noResults: ['d'], deferred: [] }), EXIT_DATA_GAP);
  assert.equal(decideExitCode({ archiveMissing: [], noResults: [], deferred: ['d'] }), EXIT_DEFERRED);
  assert.equal(decideExitCode({ archiveMissing: [], noResults: [], deferred: [] }), EXIT_OK);
});

test('22. 未知の会場コードは出力に残す（黙って捨てない）', async () => {
  const client = mkClient(
    { 'jra/results/2026/08': ['2026-08-08-HAK.json', '2026-08-08-CHU.json'], 'jra/predictions/computer/2026/08': [] },
    { '-CHU.json': races(12) },
  );
  const r = await run({ argv: ['--category', 'jra', '--days', '1', '--include-today'], client, archivedDates: new Set(['2026-08-08']) });
  assert.deepEqual(r.unknownVenueCodes, ['HAK']);
  assert.match(formatOutput(r), /^UNKNOWN_VENUE_CODES=HAK$/m);
});
