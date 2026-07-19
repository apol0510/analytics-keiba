/**
 * paymentEmailDeps.canary.guard.test.mjs — カナリア分離の「配線」を実ファイル検査で固定する。
 *
 * ロジックが正しくても、Function が誤って本番 deps を使ったり、deps 側が本番 Base へ
 * fallback する実装に戻ったら意味がないため、ソースを直接 grep して固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const DEPS = readFileSync(here('./paymentEmailDeps.js'), 'utf8');
const CANARY_FN = readFileSync(here('../../../netlify/functions/admin-canary-payment-email.js'), 'utf8');
const AUTH = readFileSync(here('./canaryAuth.js'), 'utf8');

test('guard: canaryTarget は専用 env のみを読む（本番 AIRTABLE_API_KEY / AIRTABLE_BASE_ID を読まない）', () => {
  const m = DEPS.match(/function canaryTarget\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'canaryTarget が見つからない');
  const body = m[0];
  assert.ok(body.includes('PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY'), '専用 API キー env を読んでいない');
  assert.ok(body.includes('PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID'), '専用 Base env を読んでいない');
  assert.ok(body.includes('PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID'), '専用 Table env を読んでいない');
  // 本番キー・本番 Base への fallback が無いこと（PAYMENT_EMAIL_CANARY_ 接頭辞を除いた素の参照を検出）
  assert.ok(!/process\.env\.AIRTABLE_API_KEY/.test(body),
    'canaryTarget が本番 AIRTABLE_API_KEY を参照している（本番キーへの fallback）');
  assert.ok(!/process\.env\.AIRTABLE_BASE_ID/.test(body),
    'canaryTarget が本番 AIRTABLE_BASE_ID を参照している（fallback の疑い）');
  assert.ok(!body.includes('CUSTOMERS'), 'canaryTarget が本番 Customers テーブルを参照している');
});

test('guard: canaryTarget は key / Base / Table 未設定で throw する（fail closed）', () => {
  const m = DEPS.match(/function canaryTarget\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(/if \(!key\) throw/.test(m[0]), '専用 API キー未設定時に throw していない');
  assert.ok(/if \(!base \|\| !table\) throw/.test(m[0]), 'Base/Table 未設定時に throw していない');
});

test('guard: 例外メッセージに key / Base / Table の値を埋め込まない', () => {
  const m = DEPS.match(/function canaryTarget\(\)\s*\{[\s\S]*?\n\}/);
  // throw new Error(`...${key|base|table}...`) のような値の埋め込みが無いこと
  assert.ok(!/throw new Error\(`[^`]*\$\{(key|base|table)\}/.test(m[0]),
    '例外メッセージに key/Base/Table の値を埋め込んでいる（ログ漏洩）');
});

test('guard: makeCanaryWorkerDeps は canaryTarget を使い、本番 deps と分離される', () => {
  assert.ok(DEPS.includes('export function makeCanaryWorkerDeps()'), 'makeCanaryWorkerDeps が無い');
  const m = DEPS.match(/export function makeCanaryWorkerDeps\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m && m[0].includes('canaryTarget()'), 'makeCanaryWorkerDeps が canaryTarget を使っていない');
});

test('guard: admin-canary は makeCanaryWorkerDeps を使い、本番 makeWorkerDeps を使わない', () => {
  assert.ok(CANARY_FN.includes('makeCanaryWorkerDeps'), 'カナリア Function が専用 deps を import/使用していない');
  assert.ok(!/\bmakeWorkerDeps\b/.test(CANARY_FN),
    'カナリア Function が本番 makeWorkerDeps を使っている（本番 Customers 混入リスク）');
});

test('guard: admin-canary はカナリア env 未設定なら 503 で fail closed する', () => {
  assert.ok(/catch\s*\{[\s\S]*?503/.test(CANARY_FN),
    'makeCanaryWorkerDeps の失敗を 503 で fail closed していない');
});

test('guard: admin-canary は 2 段の単一源 authorizeCanaryAccess / matchCanaryRecordId を使う', () => {
  assert.ok(CANARY_FN.includes('authorizeCanaryAccess'), '認証段の単一源を使っていない');
  assert.ok(CANARY_FN.includes('matchCanaryRecordId'), 'recordId 照合段の単一源を使っていない');
  assert.ok(CANARY_FN.includes('PAYMENT_EMAIL_CANARY_RECORD_IDS'), 'allowlist env を渡していない');
  assert.ok(CANARY_FN.includes('PAYMENT_CANARY_SECRET'), 'secret を渡していない');
});

test('guard: admin-canary は 認証 → body parse → recordId 照合 の順（secret-first）', () => {
  const iAccess = CANARY_FN.indexOf('authorizeCanaryAccess(');
  const iParse = CANARY_FN.indexOf('JSON.parse(');
  const iMatch = CANARY_FN.indexOf('matchCanaryRecordId(');
  assert.ok(iAccess >= 0 && iParse >= 0 && iMatch >= 0, '3 段のいずれかが無い');
  assert.ok(iAccess < iParse, '認証（authorizeCanaryAccess）が body parse より後にある（未認証で body を parse してしまう）');
  assert.ok(iParse < iMatch, 'recordId 照合が body parse より前にある');
});

test('guard: admin-canary は複数許容の includes 判定を持たない（exactly-one 化）', () => {
  assert.ok(!/allowlist\.includes\(/.test(CANARY_FN),
    '複数 ID を許容する includes 判定が残っている（exactly-one に反する）');
});

test('guard: exactly-one 強制と recordId 非エコーが単一源にある', () => {
  assert.ok(/allowlist\.length !== 1/.test(AUTH), 'exactly-one（length !== 1）の強制が無い');
  assert.ok(/recordId !== allowedRecordId/.test(AUTH), 'recordId の完全一致判定が無い');
  // 不一致の 403 応答文字列に recordId を埋め込んでいない
  assert.ok(!/error:\s*[`'"][^`'"]*\$\{?recordId/.test(AUTH),
    '拒否理由に recordId をエコーしている（識別子露出）');
});
