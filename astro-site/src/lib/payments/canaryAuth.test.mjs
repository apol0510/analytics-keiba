/**
 * canaryAuth.test.mjs — admin-canary 認可判定（純粋関数）の挙動テスト。
 *
 * exactly-one allowlist・完全一致・拒否理由に識別子を出さないことを固定する。
 * IO なし（secret/allowlist/recordId は全てダミー。実 ID・実メールは使わない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeCanaryRequest, parseAllowlist } from './canaryAuth.js';

const SECRET = 'dummy-secret';
const ONLY = 'recONLYALLOWED01';

test('secret 未設定 → 503', () => {
  const r = authorizeCanaryRequest({ configuredSecret: '', providedSecret: 'x', allowlistRaw: ONLY, recordId: ONLY });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});

test('secret 不一致 → 403 Forbidden', () => {
  const r = authorizeCanaryRequest({ configuredSecret: SECRET, providedSecret: 'wrong', allowlistRaw: ONLY, recordId: ONLY });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('allowlist 0 件（空 env）→ 403 exactly-one', () => {
  const r = authorizeCanaryRequest({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: '', recordId: ONLY });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error, /exactly one/);
});

test('allowlist 2 件以上 → 403 exactly-one', () => {
  const r = authorizeCanaryRequest({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: `${ONLY}, recSECOND000002`, recordId: ONLY });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error, /exactly one/);
});

test('allowlist 1 件（空要素混じり）はちょうど 1 件として扱う', () => {
  // trim + 空要素除去で 1 件になる
  assert.deepEqual(parseAllowlist(`  ${ONLY} , , `), [ONLY]);
  const r = authorizeCanaryRequest({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: `  ${ONLY} , , `, recordId: ONLY });
  assert.equal(r.ok, true);
  assert.equal(r.recordId, ONLY);
});

test('allowlist 1 件かつ recordId 完全一致 → ok（deps 生成へ進める）', () => {
  const r = authorizeCanaryRequest({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: ONLY, recordId: ONLY });
  assert.equal(r.ok, true);
  assert.equal(r.recordId, ONLY);
});

test('recordId 未指定 → 400', () => {
  const r = authorizeCanaryRequest({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: ONLY, recordId: undefined });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('allowlist 1 件だが recordId 不一致 → 403、拒否理由に呼び出し recordId をエコーしない', () => {
  const attacker = 'recATTACKER99999';
  const r = authorizeCanaryRequest({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: ONLY, recordId: attacker });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  // 応答に使う error 文字列へ、呼び出し側 recordId も許可 ID も出さない
  assert.ok(!r.error.includes(attacker), '拒否理由に呼び出し recordId が漏れている');
  assert.ok(!r.error.includes(ONLY), '拒否理由に許可 recordId が漏れている');
});

test('拒否結果オブジェクトに recordId フィールドが乗らない（識別子非露出）', () => {
  const r = authorizeCanaryRequest({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: ONLY, recordId: 'recMISMATCH00001' });
  assert.equal(r.ok, false);
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'recordId'), false);
});
