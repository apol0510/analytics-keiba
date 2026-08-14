/**
 * adminBasicAuth.test.mjs — 管理画面 Basic 認証の判定を固定する
 *   node --test src/lib/auth/adminBasicAuth.test.mjs
 *
 * ここで守るのは 3 つ。
 *   1. **認証情報をソースへ書き戻さない**（この事故の再発）
 *   2. **env 未設定を「認証不要」と解釈しない**（管理画面が全世界へ開く）
 *   3. **壊れたヘッダで例外を投げない**（旧実装は atob で throw → 502 になった）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ADMIN_AUTH,
  safeEqual,
  readAdminCredentials,
  parseBasicAuthHeader,
  decideAdminAccess,
} from './adminBasicAuth.js';

const EDGE = readFileSync(new URL('../../../netlify/edge-functions/admin-auth.ts', import.meta.url), 'utf8');

/** テスト用の base64 復号（Deno の atob 相当） */
const dec = (b64) => Buffer.from(b64, 'base64').toString('utf8');
const enc = (u, p) => Buffer.from(`${u}:${p}`, 'utf8').toString('base64');

const ENV = { ADMIN_BASIC_AUTH_USER: 'test-user', ADMIN_BASIC_AUTH_PASSWORD: 'test-pass-1234' };
const authOf = (u, p) => `Basic ${enc(u, p)}`;

// ── 1. ソースへ認証情報を書き戻さない ────────────────────────────
test('【重要】edge function に認証情報のリテラルを置かない', () => {
  assert.ok(!/const\s+valid(Username|Password)\s*=\s*['"]/.test(EDGE),
    'ハードコードされた認証情報が復活している');
  // 「値を書かない」を機械的に担保する: env から読む以外の代入を許さない
  assert.match(EDGE, /ADMIN_BASIC_AUTH_USER/);
  assert.match(EDGE, /ADMIN_BASIC_AUTH_PASSWORD/);
  assert.match(EDGE, /decideAdminAccess/);
});

test('【重要】edge function が判定を自前実装していない（単一源へ委譲）', () => {
  assert.ok(!/===\s*validUsername/.test(EDGE), '判定を edge 側で再実装している');
  assert.match(EDGE, /from '\.\.\/\.\.\/src\/lib\/auth\/adminBasicAuth\.js'/);
});

test('認証情報をログへ出さない', () => {
  const logs = EDGE.match(/console\.(log|error|warn)\([^)]*\)/g) || [];
  for (const l of logs) {
    assert.ok(!/env\[|creds|password|user\b|decision\.(?!reason)/i.test(l),
      `ログに認証情報が混ざるおそれ: ${l}`);
  }
});

// ── 2. env 未設定は誰も通さない ─────────────────────────────────
test('【重要】env 未設定は fail closed（認証不要にしない）', () => {
  for (const env of [undefined, {}, { ADMIN_BASIC_AUTH_USER: 'u' }, { ADMIN_BASIC_AUTH_PASSWORD: 'p' }]) {
    const d = decideAdminAccess({ header: authOf('test-user', 'test-pass-1234'), env, decodeBase64: dec });
    assert.equal(d.allow, false, `env=${JSON.stringify(env)} で通った`);
    assert.equal(d.reason, ADMIN_AUTH.NOT_CONFIGURED);
  }
});

test('空文字・空白だけの env も未設定として扱う', () => {
  const d = decideAdminAccess({
    header: authOf('', ''), env: { ADMIN_BASIC_AUTH_USER: '  ', ADMIN_BASIC_AUTH_PASSWORD: '' }, decodeBase64: dec,
  });
  assert.equal(d.allow, false);
  assert.equal(d.reason, ADMIN_AUTH.NOT_CONFIGURED);
});

test('readAdminCredentials は両方揃ったときだけ configured', () => {
  assert.equal(readAdminCredentials(ENV).configured, true);
  assert.equal(readAdminCredentials({}).configured, false);
});

// ── 3. 壊れたヘッダで例外を投げない ────────────────────────────
test('【重要】壊れた Authorization ヘッダで throw しない（旧実装は 502 になった）', () => {
  const broken = [
    null, '', '   ', 'Basic', 'Basic ', 'Bearer abc', 'Basic !!!not-base64!!!',
    'Basic ' + Buffer.from('no-colon-here', 'utf8').toString('base64'),
    'Basic ' + 'A'.repeat(5000),
  ];
  for (const h of broken) {
    let d;
    assert.doesNotThrow(() => { d = decideAdminAccess({ header: h, env: ENV, decodeBase64: dec }); },
      `throw した: ${String(h).slice(0, 30)}`);
    assert.equal(d.allow, false);
  }
});

test('ヘッダ無しと不一致を区別する（本文の出し分けに使う）', () => {
  assert.equal(decideAdminAccess({ header: null, env: ENV, decodeBase64: dec }).reason, ADMIN_AUTH.NO_HEADER);
  assert.equal(decideAdminAccess({ header: authOf('x', 'y'), env: ENV, decodeBase64: dec }).reason, ADMIN_AUTH.MISMATCH);
});

test('scheme は大小を問わない', () => {
  const b64 = enc('test-user', 'test-pass-1234');
  for (const s of ['Basic', 'basic', 'BASIC']) {
    assert.equal(decideAdminAccess({ header: `${s} ${b64}`, env: ENV, decodeBase64: dec }).allow, true, s);
  }
});

// ── 判定そのもの ───────────────────────────────────────────────
test('正しい認証情報は通る', () => {
  const d = decideAdminAccess({ header: authOf('test-user', 'test-pass-1234'), env: ENV, decodeBase64: dec });
  assert.equal(d.allow, true);
  assert.equal(d.reason, ADMIN_AUTH.OK);
});

test('ユーザー名だけ / パスワードだけ合っていても通さない', () => {
  assert.equal(decideAdminAccess({ header: authOf('test-user', 'wrong'), env: ENV, decodeBase64: dec }).allow, false);
  assert.equal(decideAdminAccess({ header: authOf('wrong', 'test-pass-1234'), env: ENV, decodeBase64: dec }).allow, false);
});

test('パスワードに : を含められる', () => {
  const env = { ADMIN_BASIC_AUTH_USER: 'u', ADMIN_BASIC_AUTH_PASSWORD: 'a:b:c' };
  assert.equal(decideAdminAccess({ header: authOf('u', 'a:b:c'), env, decodeBase64: dec }).allow, true);
});

test('前後の空白を持つパスワードを勝手に trim しない', () => {
  const env = { ADMIN_BASIC_AUTH_USER: 'u', ADMIN_BASIC_AUTH_PASSWORD: ' pad ' };
  assert.equal(decideAdminAccess({ header: authOf('u', ' pad '), env, decodeBase64: dec }).allow, true);
  assert.equal(decideAdminAccess({ header: authOf('u', 'pad'), env, decodeBase64: dec }).allow, false);
});

test('復号が throw する環境でも 401 に倒れる', () => {
  const d = decideAdminAccess({
    header: 'Basic zzz', env: ENV,
    decodeBase64: () => { throw new Error('boom'); },
  });
  assert.equal(d.allow, false);
  assert.equal(d.reason, ADMIN_AUTH.MALFORMED);
});

test('戻り値に認証情報を載せない', () => {
  const d = decideAdminAccess({ header: authOf('test-user', 'test-pass-1234'), env: ENV, decodeBase64: dec });
  const s = JSON.stringify(d);
  assert.ok(!s.includes('test-pass-1234'), '戻り値にパスワードが含まれている');
  assert.ok(!s.includes('test-user'), '戻り値にユーザー名が含まれている');
});

// ── 定数時間比較 ──────────────────────────────────────────────
test('safeEqual の正しさ', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'ab'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(null, ''), true, '非文字列は空文字として扱う');
  assert.equal(safeEqual('a', null), false);
});

test('safeEqual は長さ不一致で早期 return しない', () => {
  // 実装を読んで固定する（時間計測はブレるのでソースで担保）
  const src = readFileSync(new URL('./adminBasicAuth.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function safeEqual'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(!/if \(s\.length !== t\.length\) return/.test(body), '長さで早期 return している');
  assert.match(body, /Math\.max\(s\.length, t\.length\)/);
});

test('parseBasicAuthHeader は user/password をそのまま返す（判定はしない）', () => {
  const p = parseBasicAuthHeader(authOf('u', 'p'), dec);
  assert.equal(p.ok, true);
  assert.equal(p.user, 'u');
  assert.equal(p.password, 'p');
});
