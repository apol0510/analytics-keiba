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

test('guard: canaryTarget は専用 env のみを読む（本番 AIRTABLE_BASE_ID を読まない）', () => {
  const m = DEPS.match(/function canaryTarget\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'canaryTarget が見つからない');
  const body = m[0];
  assert.ok(body.includes('PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID'), '専用 Base env を読んでいない');
  assert.ok(body.includes('PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID'), '専用 Table env を読んでいない');
  assert.ok(!body.includes('AIRTABLE_BASE_ID)') && !/process\.env\.AIRTABLE_BASE_ID/.test(body),
    'canaryTarget が本番 AIRTABLE_BASE_ID を参照している（fallback の疑い）');
  assert.ok(!body.includes('CUSTOMERS'), 'canaryTarget が本番 Customers テーブルを参照している');
});

test('guard: canaryTarget は未設定で throw する（fail closed）', () => {
  const m = DEPS.match(/function canaryTarget\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(/if \(!base \|\| !table\) throw/.test(m[0]), 'Base/Table 未設定時に throw していない');
});

test('guard: 例外メッセージに Base/Table の値を埋め込まない', () => {
  const m = DEPS.match(/function canaryTarget\(\)\s*\{[\s\S]*?\n\}/);
  // throw new Error(`...${base}...`) のような値の埋め込みが無いこと
  assert.ok(!/throw new Error\(`[^`]*\$\{(base|table)\}/.test(m[0]),
    '例外メッセージに Base/Table の値を埋め込んでいる（ログ漏洩）');
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

test('guard: admin-canary は allowlist と secret の多重ガードを保持する', () => {
  assert.ok(CANARY_FN.includes('PAYMENT_EMAIL_CANARY_RECORD_IDS'), 'allowlist env を読んでいない');
  assert.ok(CANARY_FN.includes('PAYMENT_CANARY_SECRET'), 'secret ガードが無い');
  assert.ok(CANARY_FN.includes('allowlist.includes(recordId)'), 'recordId の allowlist 照合が無い');
});
