/**
 * paymentConfirmationEmail.guard.test.mjs — 入金確認メールの**配線**を実ファイル検査で固定する。
 *
 * 本文 builder が正しくても、deps 側が独自に文字列を組み立てたり、worker が
 * パーソナライズ値を渡さなくなったら、またログイン導線の無いメールに戻る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const DEPS = readFileSync(here('./paymentEmailDeps.js'), 'utf8');
const WORKER = readFileSync(here('./paymentEmailWorker.js'), 'utf8');
const TPL = readFileSync(here('./paymentConfirmationEmail.js'), 'utf8');

const stripComments = (src) => src.replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, '');

test('guard: deps は本文 builder を import して使う（文字列を直書きしない）', () => {
  assert.ok(/from '\.\/paymentConfirmationEmail\.js'/.test(DEPS), '本文 builder を import していない');
  const code = stripComments(DEPS);
  assert.ok(/buildPaymentConfirmationEmail\(/.test(code), 'builder を呼んでいない');
  assert.ok(!/ご入金を確認いたしました。ご利用を開始いただけます/.test(code),
    '旧・導線なし本文が復活している');
});

test('guard: sendMail は subject / content を builder の戻り値から取る', () => {
  const m = stripComments(DEPS).match(/async function sendMail\([\s\S]*?\n\}/);
  assert.ok(m, 'sendMail が見つからない');
  assert.ok(/subject:\s*mail\.subject/.test(m[0]), 'subject を builder から取っていない');
  assert.ok(/value:\s*mail\.html/.test(m[0]), 'HTML を builder から取っていない');
  assert.ok(/value:\s*mail\.text/.test(m[0]), 'text 版を送っていない');
  assert.ok(!/'<p>/.test(m[0]), 'sendMail 内に HTML 直書きが残っている');
});

test('guard: サイト URL は env（MAGIC_LINK_BASE_URL）由来で渡す', () => {
  const m = stripComments(DEPS).match(/async function sendMail\([\s\S]*?\n\}/);
  assert.ok(/siteBase:\s*process\.env\.MAGIC_LINK_BASE_URL/.test(m[0]),
    'サイト URL を env から渡していない（別ドメインに固定される恐れ）');
});

test('guard: worker はパーソナライズ値を sendMail へ渡す', () => {
  const code = stripComments(WORKER);
  const m = code.match(/deps\.sendMail\(\{[\s\S]*?\}\)/);
  assert.ok(m, 'sendMail 呼び出しが見つからない');
  for (const key of ['fullName', 'plan', 'planType', 'expiration']) {
    assert.ok(new RegExp(`${key}:`).test(m[0]), `${key} を渡していない`);
  }
  assert.ok(/to: email/.test(m[0]) && /idempotencyKey/.test(m[0]), '既存の必須引数が失われている');
});

test('guard: worker はパーソナライズ値のために追加の Airtable 読み取りをしない', () => {
  const code = stripComments(WORKER);
  // getRecord は lease 前の 1 回 + write-ahead read-back の 1 回のみ
  const count = (code.match(/deps\.getRecord\(/g) || []).length;
  assert.equal(count, 2, `getRecord の呼び出し回数が想定外（${count} 回）`);
});

test('guard: worker のログに氏名 / プランを出さない', () => {
  const logLines = stripComments(WORKER).split('\n').filter((l) => /deps\.log\(|console\./.test(l));
  for (const line of logLines) {
    assert.ok(!/氏名|fullName|プラン|planType/.test(line), `ログに PII 相当を出している: ${line.trim()}`);
  }
});

test('guard: 本文テンプレートは本番 URL のみを既定にする', () => {
  assert.ok(/DEFAULT_SITE_BASE = 'https:\/\/analytics\.keiba\.link'/.test(TPL),
    '既定サイト URL が本番 URL でない');
  // 禁止 URL の検査は**実コードのみ**（JSDoc は「使ってはいけない」と書くため除外）
  const code = stripComments(TPL);
  assert.ok(!/analytics\.keiba\.jp/.test(code), '存在しないドメインが書かれている');
  assert.ok(!/netlify\.app/.test(code), 'Netlify サブドメインが書かれている');
});

test('guard: 本文テンプレートは差し込み値をエスケープする', () => {
  assert.ok(/export function escapeHtml/.test(TPL), 'エスケープ関数が無い');
  // 宛名・プランは必ずエスケープ経由
  assert.ok(/escapeHtml\(name\)/.test(TPL), '氏名がエスケープされていない');
  assert.ok(/escapeHtml\(p\)/.test(TPL), 'プランがエスケープされていない');
});
