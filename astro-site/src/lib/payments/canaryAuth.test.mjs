/**
 * canaryAuth.test.mjs — admin-canary 認可判定（純粋関数）の挙動テスト。
 *
 * exactly-one allowlist・完全一致・拒否理由に識別子を出さないことを固定する。
 * IO なし（secret/allowlist/recordId は全てダミー。実 ID・実メールは使わない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeCanaryRequest,
  authorizeCanaryAccess,
  matchCanaryRecordId,
  parseAllowlist,
} from './canaryAuth.js';

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

// ── 第 1 段: authorizeCanaryAccess（secret + allowlist・body に非依存）──────────
test('access: secret 未設定 → 503（body を一切見ない）', () => {
  const r = authorizeCanaryAccess({ configuredSecret: '', providedSecret: 'x', allowlistRaw: ONLY });
  assert.deepEqual(r, { ok: false, status: 503, error: 'canary secret not configured' });
});

test('access: secret 不一致 → 403', () => {
  const r = authorizeCanaryAccess({ configuredSecret: SECRET, providedSecret: 'wrong', allowlistRaw: ONLY });
  assert.equal(r.status, 403);
});

test('access: allowlist 0 件 → 403 exactly-one', () => {
  const r = authorizeCanaryAccess({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: '' });
  assert.equal(r.status, 403);
  assert.match(r.error, /exactly one/);
});

test('access: allowlist 2 件以上 → 403 exactly-one', () => {
  const r = authorizeCanaryAccess({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: `${ONLY}, recSECOND000002` });
  assert.equal(r.status, 403);
  assert.match(r.error, /exactly one/);
});

test('access: 認証成功 + exactly-one → ok（allowedRecordId を返す・recordId を要求しない）', () => {
  const r = authorizeCanaryAccess({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: ONLY });
  assert.equal(r.ok, true);
  assert.equal(r.allowedRecordId, ONLY);
});

// ── 第 2 段: matchCanaryRecordId ─────────────────────────────────────────────
test('match: recordId 未指定 → 400', () => {
  assert.equal(matchCanaryRecordId(ONLY, undefined).status, 400);
});

test('match: 完全一致 → ok', () => {
  assert.deepEqual(matchCanaryRecordId(ONLY, ONLY), { ok: true, recordId: ONLY });
});

test('match: 不一致 → 403・recordId 非エコー', () => {
  const attacker = 'recATTACKER99999';
  const r = matchCanaryRecordId(ONLY, attacker);
  assert.equal(r.status, 403);
  assert.ok(!r.error.includes(attacker) && !r.error.includes(ONLY), '拒否理由に recordId が漏れている');
  assert.equal(Object.prototype.hasOwnProperty.call(r, 'recordId'), false);
});

// ── Function 制御フロー再現: 未認証は body を parse しない（secret-first）────────
// handler と同一順序（access → 認証 OK のときだけ body parse → match）を再現し、
// 「未認証 or allowlist 不正 + 不正 JSON」は 400 ではなく認証段の status を返すことを固定。
function runCanaryFlow({ configuredSecret, providedSecret, allowlistRaw, rawBody }) {
  const access = authorizeCanaryAccess({ configuredSecret, providedSecret, allowlistRaw });
  if (!access.ok) return { status: access.status, error: access.error, bodyParsed: false };
  let body;
  try { body = JSON.parse(rawBody || '{}'); } catch { return { status: 400, error: 'Invalid JSON', bodyParsed: true }; }
  const match = matchCanaryRecordId(access.allowedRecordId, body.recordId);
  if (!match.ok) return { status: match.status, error: match.error, bodyParsed: true };
  return { status: 200, recordId: match.recordId, bodyParsed: true };
}

const BAD_JSON = '{not valid json';

test('flow: secret 未設定 + 不正 JSON → 503（body を parse しない）', () => {
  const r = runCanaryFlow({ configuredSecret: '', providedSecret: 'x', allowlistRaw: ONLY, rawBody: BAD_JSON });
  assert.equal(r.status, 503);
  assert.equal(r.bodyParsed, false);
});

test('flow: secret 不一致 + 不正 JSON → 403（body を parse しない）', () => {
  const r = runCanaryFlow({ configuredSecret: SECRET, providedSecret: 'wrong', allowlistRaw: ONLY, rawBody: BAD_JSON });
  assert.equal(r.status, 403);
  assert.equal(r.bodyParsed, false);
});

test('flow: allowlist 0 件 + 不正 JSON → 403（body を parse しない）', () => {
  const r = runCanaryFlow({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: '', rawBody: BAD_JSON });
  assert.equal(r.status, 403);
  assert.equal(r.bodyParsed, false);
});

test('flow: allowlist 複数 + 不正 JSON → 403（body を parse しない）', () => {
  const r = runCanaryFlow({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: `${ONLY}, recSECOND000002`, rawBody: BAD_JSON });
  assert.equal(r.status, 403);
  assert.equal(r.bodyParsed, false);
});

test('flow: 認証成功 + exactly-one + 不正 JSON → 400（このときだけ 400）', () => {
  const r = runCanaryFlow({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: ONLY, rawBody: BAD_JSON });
  assert.equal(r.status, 400);
  assert.equal(r.bodyParsed, true);
});

test('flow: 認証成功 + recordId 一致 → 200（deps 生成へ進む）', () => {
  const r = runCanaryFlow({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: ONLY, rawBody: JSON.stringify({ recordId: ONLY }) });
  assert.equal(r.status, 200);
  assert.equal(r.recordId, ONLY);
});

test('flow: 認証成功 + recordId 不一致 → 403・recordId 非エコー', () => {
  const attacker = 'recATTACKER99999';
  const r = runCanaryFlow({ configuredSecret: SECRET, providedSecret: SECRET, allowlistRaw: ONLY, rawBody: JSON.stringify({ recordId: attacker }) });
  assert.equal(r.status, 403);
  assert.ok(!r.error.includes(attacker) && !r.error.includes(ONLY));
});
