/**
 * paymentConfirmationEmail.test.mjs — 入金確認メール本文の単体テスト。
 *
 * 最重要は「**ログイン導線が必ず入っていること**」。2026-07-22 の事故（本文が
 * `<p>ご入金を確認いたしました。ご利用を開始いただけます。</p>` の 1 行だけで入口が無く、
 * 実顧客がログインリンクを 9 回発行して迷った）の再発防止として固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPaymentConfirmationEmail,
  buildGreeting,
  buildPeriodLabel,
  escapeHtml,
  DEFAULT_SITE_BASE,
  SUPPORT_ADDRESS,
  MAGIC_LINK_SUBJECT,
  MAGIC_LINK_TTL_MIN,
} from './paymentConfirmationEmail.js';

const BASE_INPUT = {
  fullName: '競馬 太郎',
  plan: 'Premium',
  planType: 'Annual',
  expiration: '2027-07-22',
};

test('ログイン URL が HTML と text の両方に含まれる（最重要）', () => {
  const m = buildPaymentConfirmationEmail(BASE_INPUT);
  assert.equal(m.loginUrl, `${DEFAULT_SITE_BASE}/login`);
  assert.ok(m.html.includes(`href="${DEFAULT_SITE_BASE}/login"`), 'HTML にログインリンクが無い');
  assert.ok(m.text.includes(`${DEFAULT_SITE_BASE}/login`), 'text にログイン URL が無い');
});

test('ボタンが開けない人向けに生 URL も本文に出す', () => {
  const m = buildPaymentConfirmationEmail(BASE_INPUT);
  // href だけでなく、目で読める形でも 1 回以上出ていること
  const occurrences = m.html.split(`${DEFAULT_SITE_BASE}/login`).length - 1;
  assert.ok(occurrences >= 2, `生 URL の表示が無い（出現 ${occurrences} 回）`);
});

test('マジックリンク方式の説明が入っている（別便 / 件名 / 有効時間 / 迷惑メール）', () => {
  const m = buildPaymentConfirmationEmail(BASE_INPUT);
  for (const src of [m.html, m.text]) {
    assert.ok(src.includes(MAGIC_LINK_SUBJECT), 'ログインリンクメールの件名が案内されていない');
    assert.ok(src.includes(`${MAGIC_LINK_TTL_MIN}分`), '有効時間が案内されていない');
    assert.ok(src.includes('別便'), '「別便で届く」旨が案内されていない');
    assert.ok(src.includes('迷惑メール'), '迷惑メールフォルダの案内が無い');
  }
});

test('「このメールにログインリンクは含まれない」と明記する（探して詰まるのを防ぐ）', () => {
  const m = buildPaymentConfirmationEmail(BASE_INPUT);
  assert.ok(/このメール（入金確認）にはログインリンクは含まれていません/.test(m.html));
  assert.ok(/このメール（入金確認）にログインリンクは含まれていません/.test(m.text));
});

test('ウェルカム文言と契約内容が入っている', () => {
  const m = buildPaymentConfirmationEmail(BASE_INPUT);
  assert.ok(m.html.includes('ようこそ'), 'ウェルカム文言が無い');
  assert.ok(m.html.includes('ご入金を確認いたしました'));
  assert.ok(m.html.includes('Premium'), 'プランが表示されていない');
  assert.ok(m.html.includes('2027-07-22'), '有効期限が表示されていない');
  assert.ok(m.subject.includes('ご入金を確認しました'));
});

test('氏名があれば「様」付き、無ければ お客様 で埋めない', () => {
  assert.equal(buildGreeting('競馬 太郎'), '競馬 太郎 様');
  for (const empty of ['', '   ', null, undefined]) {
    const g = buildGreeting(empty);
    assert.ok(!g.includes('お客様'), `空氏名で 'お客様' を埋めている: ${g}`);
    assert.ok(g.length > 0);
  }
});

test('氏名が空でも本文が壊れない', () => {
  const m = buildPaymentConfirmationEmail({ ...BASE_INPUT, fullName: '' });
  assert.ok(m.html.includes('ようこそ'));
  assert.ok(m.html.includes(`${DEFAULT_SITE_BASE}/login`));
  assert.ok(!m.html.includes('undefined'), 'undefined が本文へ漏れている');
  assert.ok(!m.text.includes('undefined'));
});

test('プラン / 期限が空でも undefined を出さない', () => {
  const m = buildPaymentConfirmationEmail({ fullName: '', plan: '', planType: '', expiration: '' });
  assert.ok(!m.html.includes('undefined'));
  assert.ok(!m.text.includes('undefined'));
  assert.ok(m.html.includes('ご購入のプラン'), 'プラン未設定時のフォールバックが無い');
  assert.ok(m.html.includes(`${DEFAULT_SITE_BASE}/login`), 'ログイン導線は常に入ること');
});

test('Lifetime は「永久アクセス」表示', () => {
  assert.equal(buildPeriodLabel({ planType: 'Lifetime', expiration: '2099-12-31' }), '永久アクセス');
  assert.equal(buildPeriodLabel({ planType: 'lifetime', expiration: '' }), '永久アクセス');
  assert.equal(buildPeriodLabel({ planType: 'Annual', expiration: '2027-07-22' }), '2027-07-22 まで');
  assert.equal(buildPeriodLabel({ planType: 'Annual', expiration: '' }), '');
});

test('差し込み値は HTML エスケープされる（Airtable 由来の外部入力）', () => {
  const m = buildPaymentConfirmationEmail({
    ...BASE_INPUT,
    fullName: '<script>alert(1)</script>',
    plan: 'Premium" onload="x',
  });
  assert.ok(!m.html.includes('<script>'), 'script タグが素通りしている');
  assert.ok(m.html.includes('&lt;script&gt;'));
  assert.ok(!/<[^>]*onload="x/.test(m.html), '属性が注入されている');
});

test('escapeHtml が主要文字を変換する', () => {
  assert.equal(escapeHtml('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('siteBase を渡すとその URL を使い、末尾スラッシュを正規化する', () => {
  const m = buildPaymentConfirmationEmail({ ...BASE_INPUT, siteBase: 'https://analytics.keiba.link/' });
  assert.equal(m.loginUrl, 'https://analytics.keiba.link/login');
  assert.ok(!m.html.includes('//login'), '二重スラッシュが生成されている');
});

test('禁止 URL を本文に含めない（analytics.keiba.jp / Netlify サブドメイン）', () => {
  const m = buildPaymentConfirmationEmail(BASE_INPUT);
  for (const src of [m.html, m.text]) {
    assert.ok(!/analytics\.keiba\.jp/.test(src), '存在しない analytics.keiba.jp を出している');
    assert.ok(!/netlify\.app/.test(src), 'Netlify サブドメインを本番案内に使っている');
  }
});

test('サポート窓口が案内されている', () => {
  const m = buildPaymentConfirmationEmail(BASE_INPUT);
  assert.ok(m.html.includes(SUPPORT_ADDRESS));
  assert.ok(m.text.includes(SUPPORT_ADDRESS));
});

test('text 版は HTML タグを含まない', () => {
  const m = buildPaymentConfirmationEmail(BASE_INPUT);
  assert.ok(!/<[a-z][^>]*>/i.test(m.text), 'text 版に HTML タグが混入している');
});
