/**
 * exitDeferredOrFatal.test.mjs — import 系スクリプト共通の終端ハンドラ
 *   node --test scripts/lib/exitDeferredOrFatal.test.mjs
 *
 * 契約: 一時失敗は exit 75(EX_TEMPFAIL)、それ以外は fail-closed。
 *       exit 2（引数エラー）と衝突しない。75 も非ゼロなので既存呼び出し側は不変。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitDeferredOrFatal, EXIT_DEFERRED } from './sharedCheckerSupport.mjs';
import { SharedFetchError, SHARED_FETCH_CODES } from './sharedFetch.mjs';

function run(err, opts = {}) {
  const out = []; let code = null;
  exitDeferredOrFatal(err, { ...opts, io: { write: (s) => out.push(s), exit: (c) => { code = c; } } });
  return { code, out: out.join('') };
}
const sfe = (c, path = null) => Object.assign(new SharedFetchError(c, `mock ${c}`, { path }), {});

test('1. EXIT_DEFERRED は 75（引数エラーの 2 と衝突しない）', () => {
  assert.equal(EXIT_DEFERRED, 75);
  assert.notEqual(EXIT_DEFERRED, 2);
  assert.notEqual(EXIT_DEFERRED, 0);
});

test('2. RATE_LIMITED / TIMEOUT / SERVER_ERROR は exit 75', () => {
  for (const c of [SHARED_FETCH_CODES.RATE_LIMITED, SHARED_FETCH_CODES.TIMEOUT, SHARED_FETCH_CODES.SERVER_ERROR]) {
    const r = run(sfe(c));
    assert.equal(r.code, 75, c);
    assert.match(r.out, /DEFERRED/);
  }
});

test('3. TOKEN_MISSING / AUTH_FAILED / FORBIDDEN は fail-closed(1)', () => {
  for (const c of [SHARED_FETCH_CODES.TOKEN_MISSING, SHARED_FETCH_CODES.AUTH_FAILED, SHARED_FETCH_CODES.FORBIDDEN]) {
    const r = run(sfe(c));
    assert.equal(r.code, 1, c);
    assert.match(r.out, /FATAL/);
    assert.doesNotMatch(r.out, /DEFERRED/);
  }
});

test('4. INVALID_JSON（schema 破損）も fail-closed', () => {
  assert.equal(run(sfe(SHARED_FETCH_CODES.INVALID_JSON)).code, 1);
});

test('5. SharedFetchError 以外の例外も fail-closed', () => {
  const r = run(new Error('boom'));
  assert.equal(r.code, 1);
  assert.match(r.out, /boom/);
});

test('6. deferred では shared 内 path を出す（token は出さない）', () => {
  const r = run(sfe(SHARED_FETCH_CODES.RATE_LIMITED, 'nankan/results/2026/08/2026-08-10-URA.json'));
  assert.match(r.out, /path: nankan\/results/);
  assert.doesNotMatch(r.out, /ghp_|Bearer/);
});

test('7. label でどのスクリプト由来か分かる', () => {
  assert.match(run(sfe(SHARED_FETCH_CODES.RATE_LIMITED), { label: 'importResults.js' }).out, /importResults\.js/);
});

test('8. fatalCode を上書きできる（既存の exit 4/5 契約を壊さない）', () => {
  assert.equal(run(new Error('x'), { fatalCode: 4 }).code, 4);
});
