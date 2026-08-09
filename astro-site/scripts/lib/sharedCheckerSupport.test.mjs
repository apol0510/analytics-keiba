/**
 * sharedCheckerSupport.test.mjs
 *   node --test scripts/lib/sharedCheckerSupport.test.mjs
 *
 * 守りたい契約:
 *   - 一時エラー（rate limit / timeout / 5xx）は exit 2、運用者対応が要るものは exit 1
 *   - exit 2 も非ゼロ＝「成否だけ見る」既存呼び出し側の挙動は変わらない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT_TRANSIENT,
  isTransientSharedFetchError,
  exitWithSharedFetchError,
} from './sharedCheckerSupport.mjs';
import { SharedFetchError, SHARED_FETCH_CODES } from './sharedFetch.mjs';

function mkErr(code) {
  return new SharedFetchError(code, `mock ${code}`);
}
function captureExit(error) {
  const written = [];
  let code = null;
  exitWithSharedFetchError(error, { write: (s) => written.push(s), exit: (c) => { code = c; } });
  return { code, out: written.join('') };
}

// ----- 一時エラーの分類 -----

test('1. RATE_LIMITED / TIMEOUT / SERVER_ERROR は一時エラー', () => {
  for (const c of [SHARED_FETCH_CODES.RATE_LIMITED, SHARED_FETCH_CODES.TIMEOUT, SHARED_FETCH_CODES.SERVER_ERROR]) {
    assert.equal(isTransientSharedFetchError(mkErr(c)), true, c);
  }
});

test('2. TOKEN_MISSING / AUTH_FAILED / FORBIDDEN は一時エラーではない', () => {
  for (const c of [SHARED_FETCH_CODES.TOKEN_MISSING, SHARED_FETCH_CODES.AUTH_FAILED, SHARED_FETCH_CODES.FORBIDDEN]) {
    assert.equal(isTransientSharedFetchError(mkErr(c)), false, c);
  }
});

test('3. SharedFetchError でない例外は一時エラー扱いしない', () => {
  assert.equal(isTransientSharedFetchError(new Error('boom')), false);
  assert.equal(isTransientSharedFetchError(undefined), false);
});

// ----- exit code -----

test('4. 一時エラーは exit 2 で TRANSIENT を明示する', () => {
  const { code, out } = captureExit(mkErr(SHARED_FETCH_CODES.RATE_LIMITED));
  assert.equal(code, EXIT_TRANSIENT);
  assert.equal(code, 2);
  assert.match(out, /TRANSIENT/);
});

test('5. token/認証エラーは従来どおり exit 1（TRANSIENT を出さない）', () => {
  const { code, out } = captureExit(mkErr(SHARED_FETCH_CODES.TOKEN_MISSING));
  assert.equal(code, 1);
  assert.doesNotMatch(out, /TRANSIENT/);
});

test('6. exit 2 も非ゼロ＝成否だけ見る既存呼び出し側は挙動不変', () => {
  assert.notEqual(EXIT_TRANSIENT, 0);
});

test('7. message のみ出力し、スタックや余計な情報を出さない', () => {
  const { out } = captureExit(mkErr(SHARED_FETCH_CODES.AUTH_FAILED));
  assert.equal(out, 'mock AUTH_FAILED\n');
});
