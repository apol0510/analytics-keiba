/**
 * legacyPaymentRoutes.guard.test.mjs — 廃止した legacy 決済経路の「無効化」を実ファイル検査で固定する。
 *
 * 対象（2026-07-22 に 410 Gone 化）:
 * - netlify/functions/send-payment-confirmation.js
 * - netlify/functions/paypal-webhook.js
 * - src/pages/admin/send-payment-confirmation.astro（操作 UI を持たない案内ページ）
 *
 * 復活すると何が起きるか:
 * どちらの Function も「自前で SendGrid を叩く + Status を active にする」が
 * `PaymentEmailSent` を立てないため、Airtable Automation A2 と合わせて**確認メールが 2 通**届く。
 * さらに v2 の状態機械（PaymentEmailStatus）を経由しないため、二重送信防止も効かない。
 * feature flag による 403 では legacy 期間中の誤操作を防げないため **恒久 410** で固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const SEND_CONFIRM = readFileSync(here('../../../netlify/functions/send-payment-confirmation.js'), 'utf8');
const PAYPAL = readFileSync(here('../../../netlify/functions/paypal-webhook.js'), 'utf8');
const ADMIN_PAGE = readFileSync(here('../../pages/admin/send-payment-confirmation.astro'), 'utf8');

/** コメント / JSDoc を除いた実コード（説明文の語句で誤検知しないため）。 */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const LEGACY_FUNCTIONS = [
  ['send-payment-confirmation.js', SEND_CONFIRM],
  ['paypal-webhook.js', PAYPAL],
];

test('guard: legacy Function は 410 を返す', () => {
  for (const [name, src] of LEGACY_FUNCTIONS) {
    const code = stripComments(src);
    assert.ok(/statusCode:\s*410/.test(code), `${name} が 410 を返していない`);
    assert.ok(!/statusCode:\s*(200|201|202)/.test(code), `${name} に成功ステータスの経路が残っている`);
  }
});

test('guard: legacy Function は SendGrid へ送信しない', () => {
  for (const [name, src] of LEGACY_FUNCTIONS) {
    const code = stripComments(src);
    assert.ok(!/api\.sendgrid\.com/.test(code), `${name} に SendGrid API 呼び出しが残っている`);
    assert.ok(!/SENDGRID_API_KEY/.test(code), `${name} が SENDGRID_API_KEY を参照している`);
    assert.ok(!/@sendgrid\/mail/.test(code), `${name} が SendGrid SDK を使っている`);
  }
});

test('guard: legacy Function は Airtable へ書き込まない', () => {
  for (const [name, src] of LEGACY_FUNCTIONS) {
    const code = stripComments(src);
    assert.ok(!/api\.airtable\.com/.test(code), `${name} に Airtable API 呼び出しが残っている`);
    assert.ok(!/AIRTABLE_API_KEY|AIRTABLE_BASE_ID/.test(code), `${name} が Airtable env を参照している`);
    assert.ok(!/require\(['"]airtable['"]\)|from\s+['"]airtable['"]/.test(code), `${name} が airtable SDK を使っている`);
    assert.ok(!/method:\s*['"](POST|PATCH|PUT|DELETE)['"]/.test(code), `${name} に書き込み HTTP メソッドが残っている`);
  }
});

test('guard: legacy Function は Status / プラン / 有効期限 を書かない', () => {
  for (const [name, src] of LEGACY_FUNCTIONS) {
    const code = stripComments(src);
    for (const field of ['有効期限', 'PlanType', 'PaymentEmailSent']) {
      assert.ok(!code.includes(field), `${name} が ${field} を書いている`);
    }
    assert.ok(!/['"]?Status['"]?\s*:\s*['"]active['"]/.test(code), `${name} が Status='active' を直書きしている`);
  }
});

test('guard: legacy Function は fetch を一切行わない（外部到達なし）', () => {
  for (const [name, src] of LEGACY_FUNCTIONS) {
    const code = stripComments(src);
    assert.ok(!/\bfetch\s*\(/.test(code), `${name} に fetch が残っている`);
  }
});

test('guard: 廃止理由と現行経路がコメントに残っている（次の担当者が復活させないため）', () => {
  for (const [name, src] of LEGACY_FUNCTIONS) {
    assert.ok(/410/.test(src), `${name} のコメントに 410 の記載がない`);
    assert.ok(/廃止|無効化/.test(src), `${name} のコメントに廃止の記載がない`);
  }
  assert.ok(/PaymentConfirmed/.test(SEND_CONFIRM), 'send-payment-confirmation.js に現行手順（PaymentConfirmed）の案内がない');
  assert.ok(/署名検証/.test(PAYPAL), 'paypal-webhook.js に復活条件（署名検証）の記載がない');
});

test('guard: 旧 admin 画面は legacy Function を呼ばない', () => {
  // 廃止理由の説明コメントに旧パスが出てくるのは許容する（実コードだけを検査する）。
  const code = stripComments(ADMIN_PAGE);
  assert.ok(
    !/\/\.netlify\/functions\/send-payment-confirmation(?!-auto)/.test(code),
    '旧 admin 画面が廃止済み Function を呼んでいる'
  );
  assert.ok(!/\bfetch\s*\(/.test(code), '旧 admin 画面に fetch が残っている');
  assert.ok(!/<form/i.test(code), '旧 admin 画面に送信フォームが残っている');
});

test('guard: 旧 admin 画面は廃止と現行手順を案内する', () => {
  assert.ok(/廃止/.test(ADMIN_PAGE), '旧 admin 画面に廃止の明示がない');
  assert.ok(/PaymentConfirmed/.test(ADMIN_PAGE), '旧 admin 画面に現行手順の案内がない');
  assert.ok(/noindex/.test(ADMIN_PAGE), '旧 admin 画面に noindex がない');
});
