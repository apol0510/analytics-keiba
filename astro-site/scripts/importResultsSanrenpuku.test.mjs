/**
 * importResultsSanrenpuku.test.mjs — 失敗伝播契約の単体テスト（node:test / 新規依存なし）
 *
 * runImport() へ依存注入し、実ファイル書込み・実 GitHub 取得をせずに契約を検証する。
 *   node --test scripts/importResultsSanrenpuku.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runImport } from './importResultsSanrenpuku.js';
import { SharedFetchError, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';

const SECRET = 'ghp_THIS_IS_A_TEST_SECRET_TOKEN_should_never_leak';
const ENV_OK = { KEIBA_DATA_SHARED_TOKEN: SECRET };

const T_FUN = { date: '2026-05-08', venueSlug: 'funabashi', venueCode: 'FUN', venue: '船橋' };
const T_OOI = { date: '2026-05-08', venueSlug: 'ooi', venueCode: 'OOI', venue: '大井' };

const okData = () => ({ hitRaces: 1, totalRaces: 12, totalPayout: 1000, recoveryRate: 50, totalBetPoints: 9 });

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
