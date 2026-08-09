/**
 * checkJraResultsForImport.test.mjs
 *   node --test scripts/checkJraResultsForImport.test.mjs
 *
 * 守りたい契約（偽の false を作らないこと）:
 *   - shared の per-venue 構造で results を判定する（統合 daily ファイル前提にしない）
 *   - 開催日 / 非開催日 / 当日未完了 / shared未投入 / 一時403 / auth失敗 / schema不一致 を区別
 *   - 一時エラーは deferred（exit 2）。「results 無し」に丸めない
 *   - token/認証/権限/schema は fail-closed（throw → exit 1）
 *   - EXPECTED_VENUES は実在会場数＝workflow の再取込判定にそのまま使える
 *   - 同一 run で同じ月ディレクトリ一覧を二度取らない／非開催日はファイル GET を撃たない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkJraResultsForImport,
  formatOutput,
  decideExitCode,
  MIN_RACES_PER_VENUE,
  EXIT_OK,
  EXIT_DEFERRED,
} from './checkJraResultsForImport.mjs';
import { createSharedClient, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';

const SECRET = 'ghp_MOCK_TOKEN_checkJraResultsForImport_test';
const ENV_OK = { KEIBA_DATA_SHARED_TOKEN: SECRET };
const QUIET = { error: () => {} };
const DATE = '2026-08-08';

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
const entries = (names) => names.map((n) => ({ name: n, path: `d/${n}`, sha: 's', size: 1, type: 'file' }));
const isListing = (url) => !/\.json\?ref=/.test(url);
const races = (n) => ({ races: Array.from({ length: n }, (_, i) => ({ raceNumber: i + 1 })) });

function mkClient(dirs, files = {}) {
  const fetchImpl = mkFetch((url) => {
    if (isListing(url)) {
      for (const [key, names] of Object.entries(dirs)) {
        if (url.includes(key)) return mkRes(200, entries(names));
      }
      return mkRes(404, 'Not Found');
    }
    for (const [key, body] of Object.entries(files)) {
      if (url.includes(key)) return mkRes(200, body);
    }
    return mkRes(404, 'Not Found');
  });
  const c = createSharedClient({ fetchImpl, env: ENV_OK, sleepImpl: noSleep });
  c.__fetch = fetchImpl;
  return c;
}
const run = (opts) =>
  checkJraResultsForImport({ argv: ['--date', DATE], env: ENV_OK, resolveToken: () => {}, logger: QUIET, ...opts });

const RESULTS_DIR = 'jra/results/2026/08';
const PRED_DIR = 'jra/predictions/computer/2026/08';

// ---------------------------------------------------------------- 開催日

test('1. JRA 3場開催日: 実在会場を列挙し FOUND=true / EXPECTED_VENUES=3', async () => {
  const client = mkClient(
    {
      [RESULTS_DIR]: [`${DATE}-CHU.json`, `${DATE}-NII.json`, `${DATE}-SAP.json`],
      [PRED_DIR]: [`${DATE}-CHU.json`, `${DATE}-NII.json`, `${DATE}-SAP.json`],
    },
    { '-CHU.json': races(12), '-NII.json': races(12), '-SAP.json': races(12) },
  );
  const r = await run({ client });
  assert.equal(r.found, true);
  assert.equal(r.state, 'complete');
  assert.deepEqual(r.resultVenues, ['CHU', 'NII', 'SAP']);
  assert.equal(r.expectedVenues, 3);
  assert.equal(r.totalRaces, 36);
  assert.equal(decideExitCode(r), EXIT_OK);
});

test('2. 旧実装が false を返していたケースで新実装は true（統合ファイルは存在しない）', async () => {
  const client = mkClient(
    { [RESULTS_DIR]: [`${DATE}-CHU.json`], [PRED_DIR]: [] },
    { '-CHU.json': races(12) },
  );
  const r = await run({ client });
  assert.equal(r.found, true, 'per-venue が実在するなら FOUND=true');
  // 統合ファイル（YYYY-MM-DD.json）へは一切アクセスしない
  assert.ok(!client.__fetch.calls.some((c) => /\/2026-08-08\.json\?ref=/.test(c.url)));
});

// ---------------------------------------------------------------- 非開催 / 未投入 / 未完了

test('3. 非開催日: results も予想も無ければ no_race / FOUND=false', async () => {
  const client = mkClient({ [RESULTS_DIR]: [], [PRED_DIR]: [] });
  const r = await run({ client });
  assert.equal(r.found, false);
  assert.equal(r.state, 'no_race');
  assert.equal(r.expectedVenues, 0);
  assert.equal(decideExitCode(r), EXIT_OK);
});

test('4. shared 未投入: 予想はあるが results が無い → not_posted / FOUND=false', async () => {
  const client = mkClient({ [RESULTS_DIR]: [], [PRED_DIR]: [`${DATE}-CHU.json`, `${DATE}-NII.json`] });
  const r = await run({ client });
  assert.equal(r.found, false);
  assert.equal(r.state, 'not_posted', '非開催と区別する');
  assert.equal(decideExitCode(r), EXIT_OK);
});

test('5. 当日未完了: 一部会場のレース数が閾値未満 → partial（ただし取込対象）', async () => {
  const client = mkClient(
    { [RESULTS_DIR]: [`${DATE}-CHU.json`, `${DATE}-NII.json`], [PRED_DIR]: [`${DATE}-CHU.json`] },
    { '-CHU.json': races(12), '-NII.json': races(4) },
  );
  const r = await run({ client });
  assert.equal(r.state, 'partial');
  assert.equal(r.found, true, '未完了でも取込対象（後続 run で会場数比較により追いつく）');
  assert.equal(r.expectedVenues, 2);
  assert.equal(r.totalRaces, 16);
});

test('6. 空 races の会場はカウントしない', async () => {
  const client = mkClient(
    { [RESULTS_DIR]: [`${DATE}-CHU.json`, `${DATE}-NII.json`], [PRED_DIR]: [] },
    { '-CHU.json': races(12), '-NII.json': races(0) },
  );
  const r = await run({ client });
  assert.deepEqual(r.resultVenues, ['CHU']);
  assert.equal(r.expectedVenues, 1);
});

// ---------------------------------------------------------------- import 要否（workflow 契約）

test('7. results存在 + import未反映 → EXPECTED_VENUES(3) > archived(0) で再取込が成立する', async () => {
  const client = mkClient(
    { [RESULTS_DIR]: [`${DATE}-CHU.json`, `${DATE}-NII.json`, `${DATE}-SAP.json`], [PRED_DIR]: [] },
    { '-CHU.json': races(12), '-NII.json': races(12), '-SAP.json': races(12) },
  );
  const r = await run({ client });
  const archivedVenues = 0;
  assert.equal(r.found, true);
  assert.ok(archivedVenues < r.expectedVenues, 'workflow は has_missing=true と判定できる');
});

test('8. results存在 + import済み（会場数一致）→ 再取込不要と判定できる', async () => {
  const client = mkClient(
    { [RESULTS_DIR]: [`${DATE}-CHU.json`, `${DATE}-NII.json`, `${DATE}-SAP.json`], [PRED_DIR]: [] },
    { '-CHU.json': races(12), '-NII.json': races(12), '-SAP.json': races(12) },
  );
  const r = await run({ client });
  const archivedVenues = 3;
  assert.equal(r.expectedVenues, 3);
  assert.ok(archivedVenues >= r.expectedVenues, 'workflow は has_missing=false と判定できる');
});

// ---------------------------------------------------------------- 異常系

test('9. rate limit は deferred（「results 無し」に丸めない）', async () => {
  const client = createSharedClient({
    fetchImpl: mkFetch(() => mkRes(403, 'rate limit', { 'x-ratelimit-remaining': '0' })),
    env: ENV_OK, sleepImpl: noSleep,
  });
  const r = await run({ client });
  assert.equal(r.deferred, true);
  assert.equal(r.state, 'deferred');
  assert.equal(r.found, false);
  assert.equal(decideExitCode(r), EXIT_DEFERRED, 'exit 2＝呼び出し側は取込を見送るが失敗にしない');
});

test('10. TIMEOUT / SERVER_ERROR も deferred', async () => {
  const client = createSharedClient({
    fetchImpl: mkFetch(() => mkRes(503, 'unavailable')),
    env: ENV_OK, sleepImpl: noSleep,
  });
  assert.equal(decideExitCode(await run({ client })), EXIT_DEFERRED);
});

test('11. 会場ファイル取得中の一時エラーも deferred（partial を確定させない）', async () => {
  const client = mkClient(
    { [RESULTS_DIR]: [`${DATE}-CHU.json`, `${DATE}-NII.json`], [PRED_DIR]: [] },
    { '-CHU.json': races(12) },
  );
  // NII だけ 429 を返すよう差し替え
  const base = client.__fetch;
  const client2 = createSharedClient({
    fetchImpl: mkFetch((url) => {
      if (/-NII\.json/.test(url)) return mkRes(429, 'slow down');
      if (isListing(url)) return mkRes(200, entries([`${DATE}-CHU.json`, `${DATE}-NII.json`]));
      return mkRes(200, races(12));
    }),
    env: ENV_OK, sleepImpl: noSleep,
  });
  const r = await checkJraResultsForImport({ argv: ['--date', DATE], env: ENV_OK, resolveToken: () => {}, logger: QUIET, client: client2 });
  assert.equal(r.deferred, true);
  assert.equal(r.found, false, '途中結果を確定値として返さない');
  assert.ok(base);
});

test('12. auth 失敗は fail-closed（throw → exit 1）', async () => {
  const client = createSharedClient({
    fetchImpl: mkFetch(() => mkRes(401, 'Bad credentials')),
    env: ENV_OK, sleepImpl: noSleep,
  });
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.AUTH_FAILED);
});

test('13. 権限不足(403 非rate-limit)も fail-closed', async () => {
  const client = createSharedClient({
    fetchImpl: mkFetch(() => mkRes(403, 'Resource not accessible', { 'x-ratelimit-remaining': '4999' })),
    env: ENV_OK, sleepImpl: noSleep,
  });
  await assert.rejects(run({ client }), (e) => e.code === SHARED_FETCH_CODES.FORBIDDEN);
});

test('14. token 未設定は HTTP 到達前に fail-closed', async () => {
  const fetchImpl = mkFetch(() => mkRes(200, entries([])));
  const client = createSharedClient({ fetchImpl, env: {}, sleepImpl: noSleep });
  await assert.rejects(
    checkJraResultsForImport({ argv: ['--date', DATE], env: {}, client, logger: QUIET }),
    (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('15. schema 不一致（races が配列でない）は deferred にせず fail-closed', async () => {
  const client = mkClient(
    { [RESULTS_DIR]: [`${DATE}-CHU.json`], [PRED_DIR]: [] },
    { '-CHU.json': { note: 'races がない' } },
  );
  await assert.rejects(
    run({ client }),
    (e) => e.name === 'ArchiveCoverageSchemaError' && e.sharedPath === `${RESULTS_DIR}/${DATE}-CHU.json`,
  );
});

test('16. --date 不正は即エラー（誤った日付で判定しない）', async () => {
  const client = mkClient({ [RESULTS_DIR]: [], [PRED_DIR]: [] });
  await assert.rejects(checkJraResultsForImport({ argv: [], env: ENV_OK, resolveToken: () => {}, client, logger: QUIET }));
  await assert.rejects(checkJraResultsForImport({ argv: ['--date', '20260808'], env: ENV_OK, resolveToken: () => {}, client, logger: QUIET }));
});

// ---------------------------------------------------------------- GET 最小化 / 出力契約

test('17. 非開催日はファイル GET を撃たず、一覧は各1回のみ', async () => {
  const client = mkClient({ [RESULTS_DIR]: [], [PRED_DIR]: [] });
  await run({ client });
  const listings = client.__fetch.calls.filter((c) => isListing(c.url)).map((c) => c.url);
  const fileGets = client.__fetch.calls.filter((c) => !isListing(c.url));
  assert.equal(fileGets.length, 0);
  assert.equal(listings.length, 2);
  assert.equal(new Set(listings).size, 2, '同じディレクトリを二度取らない');
});

test('18. 開催日は 一覧2 + 実在会場数 の GET で収まる', async () => {
  const client = mkClient(
    { [RESULTS_DIR]: [`${DATE}-CHU.json`, `${DATE}-NII.json`, `${DATE}-SAP.json`], [PRED_DIR]: [] },
    { '-CHU.json': races(12), '-NII.json': races(12), '-SAP.json': races(12) },
  );
  await run({ client });
  assert.equal(client.__fetch.calls.length, 2 + 3);
});

test('19. 出力は機械可読で token を含まない', async () => {
  const client = mkClient(
    { [RESULTS_DIR]: [`${DATE}-CHU.json`], [PRED_DIR]: [] },
    { '-CHU.json': races(12) },
  );
  const out = formatOutput(await run({ client }));
  assert.match(out, /^FOUND=true$/m);
  assert.match(out, /^STATE=complete$/m);
  assert.match(out, /^RESULT_VENUES=CHU$/m);
  assert.match(out, /^EXPECTED_VENUES=1$/m);
  assert.match(out, /^TOTAL_RACES=12$/m);
  assert.match(out, /^DEFERRED=false$/m);
  assert.doesNotMatch(out, new RegExp(SECRET));
});

test('20. 未知の会場コードは出力に残す（黙って捨てない）', async () => {
  const client = mkClient(
    { [RESULTS_DIR]: [`${DATE}-HAK.json`, `${DATE}-CHU.json`], [PRED_DIR]: [] },
    { '-CHU.json': races(12) },
  );
  const r = await run({ client });
  assert.deepEqual(r.unknownVenueCodes, ['HAK']);
  assert.deepEqual(r.resultVenues, ['CHU'], '未知コードは会場数に混ぜない');
  assert.match(formatOutput(r), /^UNKNOWN_VENUE_CODES=HAK$/m);
});

test('21. MIN_RACES_PER_VENUE 境界: ちょうど閾値なら complete', async () => {
  const client = mkClient(
    { [RESULTS_DIR]: [`${DATE}-CHU.json`], [PRED_DIR]: [] },
    { '-CHU.json': races(MIN_RACES_PER_VENUE) },
  );
  assert.equal((await run({ client })).state, 'complete');
});
