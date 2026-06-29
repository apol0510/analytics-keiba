/**
 * importResultsSanrenpuku.test.mjs — 失敗伝播契約の単体テスト（node:test / 新規依存なし）
 *
 * runImport() へ依存注入し、実ファイル書込み・実 GitHub 取得をせずに契約を検証する。
 *   node --test scripts/importResultsSanrenpuku.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { runImport, mergeSanrenpukuDayData } from './importResultsSanrenpuku.js';
import { SharedFetchError, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';

const SECRET = 'ghp_THIS_IS_A_TEST_SECRET_TOKEN_should_never_leak';
const ENV_OK = { KEIBA_DATA_SHARED_TOKEN: SECRET };

const T_FUN = { date: '2026-05-08', venueSlug: 'funabashi', venueCode: 'FUN', venue: '船橋' };
const T_OOI = { date: '2026-05-08', venueSlug: 'ooi', venueCode: 'OOI', venue: '大井' };

const okData = (venue = '船橋', venueCode = 'FUN') => ({ venue, venueCode, hitRaces: 1, totalRaces: 12, totalPayout: 1000, recoveryRate: 50, totalBetPoints: 9, races: [] });

function makeLogger() {
  const lines = [];
  const push = (level) => (...a) => lines.push(`[${level}] ${a.join(' ')}`);
  return { log: push('log'), warn: push('warn'), error: push('error'), lines, text: () => lines.join('\n') };
}

/** writeArchive 呼び出しを記録 */
function makeWrite() {
  const calls = [];
  const fn = (arch) => calls.push(arch);
  fn.calls = calls;
  return fn;
}

function baseDeps(overrides = {}) {
  return {
    argv: overrides.argv ?? [],
    env: overrides.env ?? ENV_OK,
    readArchive: overrides.readArchive ?? (() => ({})),
    writeArchive: overrides.writeArchive ?? makeWrite(),
    resolveTargetsFn: overrides.resolveTargetsFn ?? (() => [T_FUN]),
    processDayFn: overrides.processDayFn,
    logger: overrides.logger ?? makeLogger(),
  };
}

function sfErr(code) {
  return new SharedFetchError(code, `${code} occurred`, { status: null, path: 'nankan/results/2026/05/2026-05-08-FUN.json', ref: 'main' });
}

// 1. token 未設定で開始前に失敗（fetch/read/write へ進まない）
test('1. token 未設定で TOKEN_MISSING・read/process/write 未実行', async () => {
  const write = makeWrite();
  let readCalled = 0;
  let processCalled = 0;
  await assert.rejects(
    runImport(baseDeps({
      env: {},
      readArchive: () => { readCalled++; return {}; },
      processDayFn: () => { processCalled++; return okData(); },
      writeArchive: write,
    })),
    (e) => e.code === SHARED_FETCH_CODES.TOKEN_MISSING,
  );
  assert.equal(readCalled, 0, 'token 未設定なら archive を読まない');
  assert.equal(processCalled, 0, 'token 未設定なら取得処理しない');
  assert.equal(write.calls.length, 0, 'token 未設定なら書き込まない');
});

// 2. 401 で fatal（書込みなし）
test('2. AUTH_FAILED(401) は fatal（writeArchive されない）', async () => {
  const write = makeWrite();
  await assert.rejects(
    runImport(baseDeps({ processDayFn: () => { throw sfErr(SHARED_FETCH_CODES.AUTH_FAILED); }, writeArchive: write })),
    /Failed to import required shared results/,
  );
  assert.equal(write.calls.length, 0);
});

// 3. 403 で fatal
test('3. FORBIDDEN(403) は fatal（writeArchive されない）', async () => {
  const write = makeWrite();
  await assert.rejects(
    runImport(baseDeps({ processDayFn: () => { throw sfErr(SHARED_FETCH_CODES.FORBIDDEN); }, writeArchive: write })),
    /Failed to import required shared results/,
  );
  assert.equal(write.calls.length, 0);
});

// 4. required 404 で fatal（単一指定 = optional でない）
test('4. 必須 NOT_FOUND(404) は fatal（writeArchive されない）', async () => {
  const write = makeWrite();
  await assert.rejects(
    runImport(baseDeps({ processDayFn: () => { throw sfErr(SHARED_FETCH_CODES.NOT_FOUND); }, writeArchive: write })),
    (e) => /Failed to import/.test(e.message) && e.message.includes('NOT_FOUND'),
  );
  assert.equal(write.calls.length, 0);
});

// 5. 500（retry 枯渇後）で fatal
test('5. SERVER_ERROR(5xx) は fatal（writeArchive されない）', async () => {
  const write = makeWrite();
  await assert.rejects(
    runImport(baseDeps({ processDayFn: () => { throw sfErr(SHARED_FETCH_CODES.SERVER_ERROR); }, writeArchive: write })),
    /Failed to import required shared results/,
  );
  assert.equal(write.calls.length, 0);
});

// 6. 1 会場成功 + 1 会場 fatal で archive 未書込み（partial success 防止）
test('6. 1 会場成功 + 1 会場 fatal は writeArchive されない', async () => {
  const write = makeWrite();
  const processDayFn = (t) => {
    if (t.venueCode === 'FUN') return okData();
    throw sfErr(SHARED_FETCH_CODES.SERVER_ERROR);
  };
  await assert.rejects(
    runImport(baseDeps({ resolveTargetsFn: () => [T_FUN, T_OOI], processDayFn, writeArchive: write })),
    /Failed to import required shared results/,
  );
  assert.equal(write.calls.length, 0, 'fatal が 1 件でもあれば部分成功でも書き込まない');
});

// 7. 全会場成功時のみ書込み
test('7. 全会場成功で writeArchive が 1 回呼ばれ written:true', async () => {
  const write = makeWrite();
  const res = await runImport(baseDeps({ resolveTargetsFn: () => [T_FUN, T_OOI], processDayFn: () => okData(), writeArchive: write }));
  assert.equal(write.calls.length, 1);
  assert.deepEqual(res, { written: true, updated: 2, total: 2 });
  // 書き込まれた arch に両会場の日付が入っている
  assert.ok(write.calls[0]['2026']?.['05']?.['08']);
});

// 8. optional 404（--batch）は skip され、他会場成功で書込み
test('8. --batch の optional 404 は skip（fatal でない）→ 書込み', async () => {
  const write = makeWrite();
  const logger = makeLogger();
  const processDayFn = (t, opts) => {
    assert.equal(opts.optionalNotFound, true, 'batch では optionalNotFound=true が渡る');
    return t.venueCode === 'OOI' ? null : okData(); // OOI は未投入(null)
  };
  const res = await runImport(baseDeps({ argv: ['--batch'], resolveTargetsFn: () => [T_FUN, T_OOI], processDayFn, writeArchive: write, logger }));
  assert.equal(write.calls.length, 1);
  assert.equal(res.updated, 1);
  assert.ok(logger.text().includes('skip'), 'optional 404 は skip ログを出す');
});

// 9. fatal 要約に date・venue・code が含まれる
test('9. fatal 要約に date/venueCode/code を含む', async () => {
  await assert.rejects(
    runImport(baseDeps({ processDayFn: () => { throw sfErr(SHARED_FETCH_CODES.RATE_LIMITED); } })),
    (e) => {
      assert.ok(e.message.includes('2026-05-08'), 'date');
      assert.ok(e.message.includes('FUN'), 'venueCode');
      assert.ok(e.message.includes('RATE_LIMITED'), 'code');
      return true;
    },
  );
});

// 10. token・Authorization・token付きURL がログ/エラーに含まれない
test('10. token/Authorization/Bearer/URL がログ・エラーへ漏れない', async () => {
  const logger = makeLogger();
  let thrown;
  await runImport(baseDeps({
    processDayFn: () => { throw sfErr(SHARED_FETCH_CODES.AUTH_FAILED); },
    logger,
  })).catch((e) => { thrown = e; });
  const haystack = `${logger.text()}\n${thrown?.message}\n${thrown?.stack}`;
  assert.ok(!haystack.includes(SECRET), 'token 値が漏れない');
  assert.ok(!/Bearer\s/i.test(haystack), 'Authorization Bearer が漏れない');
  assert.ok(!haystack.includes('raw.githubusercontent.com'), '匿名 raw URL が出ない');
  assert.ok(!/Authorization/i.test(haystack), 'Authorization 文字列が出ない');
});

// ── mergeSanrenpukuDayData テスト（T1〜T26） ──────────────────────────

function makeOOI(overrides = {}) {
  return {
    date: '2026-06-29', venue: '大井', venueCode: 'OOI',
    totalRaces: 12, hitRaces: 2, totalPayout: 5000,
    totalBetPoints: 12, recoveryRate: 41,
    generatedAt: '2026-06-29T12:00:00Z',
    races: Array.from({ length: 12 }, (_, i) => ({
      raceNumber: i + 1, venue: '大井', venueCode: 'OOI',
      isHit: i < 2, payout: i < 2 ? 2500 : 0,
      betPoints: 1, raceName: `大井${i + 1}R`,
    })),
    ...overrides,
  };
}

function makeFUN(overrides = {}) {
  return {
    date: '2026-06-29', venue: '船橋', venueCode: 'FUN',
    totalRaces: 12, hitRaces: 1, totalPayout: 3000,
    totalBetPoints: 12, recoveryRate: 25,
    generatedAt: '2026-06-29T13:00:00Z',
    races: Array.from({ length: 12 }, (_, i) => ({
      raceNumber: i + 1, venue: '船橋', venueCode: 'FUN',
      isHit: i === 0, payout: i === 0 ? 3000 : 0,
      betPoints: 1, raceName: `船橋${i + 1}R`,
    })),
    ...overrides,
  };
}

test('T1: existing=null + OOI → 12R', () => {
  const r = mergeSanrenpukuDayData(null, makeOOI());
  assert.equal(r.races.length, 12); assert.equal(r.venue, '大井');
});

test('T2: existing=null + FUN → 12R', () => {
  const r = mergeSanrenpukuDayData(null, makeFUN());
  assert.equal(r.races.length, 12); assert.equal(r.venue, '船橋');
});

test('T3: OOI → FUN → 24R', () => {
  const r = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeOOI()), makeFUN());
  assert.equal(r.races.length, 24);
});

test('T4: FUN → OOI → 24R', () => {
  const r = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeFUN()), makeOOI());
  assert.equal(r.races.length, 24);
});

test('T5: OOI → OOI → 12R（重複なし）', () => {
  const r = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeOOI()), makeOOI());
  assert.equal(r.races.length, 12);
});

test('T6: FUN → FUN → 12R', () => {
  const r = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeFUN()), makeFUN());
  assert.equal(r.races.length, 12);
});

test('T7: OOI+FUN後にOOI再import → 24R', () => {
  const base = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeOOI()), makeFUN());
  assert.equal(mergeSanrenpukuDayData(base, makeOOI()).races.length, 24);
});

test('T8: OOI+FUN後にFUN再import → 24R', () => {
  const base = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeOOI()), makeFUN());
  assert.equal(mergeSanrenpukuDayData(base, makeFUN()).races.length, 24);
});

test('T9: OOI更新時にFUN保持', () => {
  const base = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeOOI()), makeFUN());
  const r = mergeSanrenpukuDayData(base, makeOOI({ hitRaces: 3 }));
  assert.equal(r.races.filter(x => x.venueCode === 'FUN').length, 12);
});

test('T10: FUN更新時にOOI保持', () => {
  const base = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeOOI()), makeFUN());
  const r = mergeSanrenpukuDayData(base, makeFUN({ hitRaces: 2 }));
  assert.equal(r.races.filter(x => x.venueCode === 'OOI').length, 12);
});

test('T11: 大井1Rと船橋1Rが共存', () => {
  const r = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeOOI()), makeFUN());
  assert.ok(r.races.find(x => x.venueCode === 'OOI' && Number(x.raceNumber) === 1));
  assert.ok(r.races.find(x => x.venueCode === 'FUN' && Number(x.raceNumber) === 1));
});

test('T12: venueCode+raceNumber重複なし', () => {
  const r = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeOOI()), makeFUN());
  const keys = r.races.map(x => `${x.venueCode}-${x.raceNumber}`);
  assert.equal(new Set(keys).size, r.races.length);
});

test('T13: venues配列に大井・船橋', () => {
  const r = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeOOI()), makeFUN());
  assert.equal(r.venues.length, 2);
  assert.ok(r.venues.includes('大井'));
  assert.ok(r.venues.includes('船橋'));
});

test('T14: venue文字列に大井・船橋', () => {
  const r = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeOOI()), makeFUN());
  assert.ok(r.venue.includes('大井') && r.venue.includes('船橋'));
});

test('T15: totalRaces=24', () => {
  const r = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeOOI()), makeFUN());
  assert.equal(r.totalRaces, 24);
});

test('T16: hitRaces=3（OOI:2+FUN:1）', () => {
  const r = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeOOI()), makeFUN());
  assert.equal(r.hitRaces, 3);
});

test('T17: totalPayout=8000（5000+3000）', () => {
  const r = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeOOI()), makeFUN());
  assert.equal(r.totalPayout, 8000);
});

test('T18: incoming raceのvenue/venueCode補完', () => {
  const ooi = makeOOI();
  ooi.races = ooi.races.map(({ venue, venueCode, ...rest }) => rest);
  const r = mergeSanrenpukuDayData(null, ooi);
  assert.ok(r.races[0].venue);
  assert.ok(r.races[0].venueCode);
});

test('T19: raceのvenueCode補完（venue名→コード）', () => {
  const ooi = makeOOI();
  ooi.races = ooi.races.map(({ venueCode, ...rest }) => rest);
  const r = mergeSanrenpukuDayData(null, ooi);
  assert.equal(r.races[0].venueCode, 'OOI');
});

test('T20: venueCode欠損・venue名不明で例外', () => {
  assert.throws(
    () => mergeSanrenpukuDayData(null, { date: '2026-06-29', venue: '不明会場', venueCode: '', totalRaces: 1, races: [{ raceNumber: 1 }] }),
    /cannot resolve venueCode/
  );
});

test('T21: 旧単一会場schema互換', () => {
  const legacy = makeOOI();
  delete legacy.venueCode; delete legacy.venues;
  legacy.races.forEach(r => delete r.venueCode);
  assert.equal(mergeSanrenpukuDayData(null, legacy).totalRaces, 12);
});

test('T22: import順序によらず同等', () => {
  const of = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeOOI()), makeFUN());
  const fo = mergeSanrenpukuDayData(mergeSanrenpukuDayData(null, makeFUN()), makeOOI());
  assert.equal(of.totalRaces, fo.totalRaces);
  assert.equal(of.hitRaces, fo.hitRaces);
});

test('T23: 別日付も正常動作', () => {
  assert.ok(mergeSanrenpukuDayData(null, makeOOI({ date: '2026-06-28' })));
});

test('T24: nankan.astroに「昨日の的中結果」なし', () => {
  const src = readFileSync(new URL('../src/pages/premium-prediction/nankan.astro', import.meta.url), 'utf-8');
  assert.ok(!src.includes('昨日の的中結果'));
});

test('T25: nankan.astroに「の的中結果」パターンあり', () => {
  const src = readFileSync(new URL('../src/pages/premium-prediction/nankan.astro', import.meta.url), 'utf-8');
  assert.ok(src.includes('の的中結果'));
});

test('T26: nankan.astroに「直近の的中結果」パターンあり', () => {
  const src = readFileSync(new URL('../src/pages/premium-prediction/nankan.astro', import.meta.url), 'utf-8');
  assert.ok(src.includes('直近の的中結果'));
});

test('T27: legacy archive OOI (races に venueCode/venue なし) + FUN → 24R, venues に大井と船橋', () => {
  // 旧コードで生成された archive の状態を再現（dayData.venue="大井" のみ、races に venue/venueCode なし）
  const legacyArchiveDay = {
    date: '2026-06-29',
    venue: '大井',
    totalRaces: 12,
    hitRaces: 10,
    totalPayout: 22410,
    races: Array.from({ length: 12 }, (_, i) => ({
      raceNumber: i + 1,
      isHit: i < 10,
      payout: i < 10 ? 2241 : 0,
    })),
  };
  const result = mergeSanrenpukuDayData(legacyArchiveDay, makeFUN());
  assert.strictEqual(result.totalRaces, 24, 'T27: totalRaces=24');
  assert.ok(Array.isArray(result.venues) && result.venues.includes('大井'), 'T27: venues に大井');
  assert.ok(Array.isArray(result.venues) && result.venues.includes('船橋'), 'T27: venues に船橋');
  assert.ok(result.venue.includes('大井') && result.venue.includes('船橋'), 'T27: venue に両会場');
  assert.strictEqual(result.races.filter(r => r.venueCode === 'OOI').length, 12, 'T27: OOI 12R 保持');
  assert.strictEqual(result.races.filter(r => r.venueCode === 'FUN').length, 12, 'T27: FUN 12R 追加');
});
