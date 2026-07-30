/**
 * offerIntakeEmail.test.mjs — 割引オファー申込の通知メール文面
 *   node --test src/lib/promotions/offerIntakeEmail.test.mjs
 *
 * 守る性質:
 *   1. 申込者宛は「受け付けた」だけ。**権限が付いたと誤解させない**
 *   2. 管理者宛は請求額と申告金額の**両方**を出し、差異があれば必ず警告する
 *   3. HTML を組むのでユーザー入力はエスケープする
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOfferAdminEmail, buildOfferUserEmail, BANK_ACCOUNT_TEXT } from './offerIntakeEmail.js';
import { resolveOfferApplication } from './offerIntake.js';

const NOW = Date.parse('2026-08-01T03:00:00.000Z');

function application(over = {}) {
  const r = resolveOfferApplication({
    offer: {
      offerKey: 'b'.repeat(32),
      email: 'taro@example.com',
      offerId: 'premium-annual-half',
      planName: 'Premium Annual',
      planType: 'Annual',
      term: 'annual',
      regularPrice: 49800,
      offerPrice: 24900,
      startsMs: NOW - 3 * 86400000,
      expiresMs: NOW + 11 * 86400000,
      customerRecordId: 'recCUST1',
    },
    form: {
      fullName: '山田 太郎',
      email: 'taro@example.com',
      transferDate: '2026-08-01',
      transferName: 'ヤマダ タロウ',
      transferAmount: '24900',
      paymentCompletedConfirm: true,
      ...over,
    },
    nowMs: NOW,
  });
  assert.equal(r.ok, true);
  return r;
}

test('管理者メール: 請求額と申告金額の両方が載る', () => {
  const { application: app, warnings } = application();
  const mail = buildOfferAdminEmail({ application: app, warnings, reportedAtText: '2026/08/01 12:00' });
  assert.ok(mail.subject.includes('taro@example.com'));
  assert.ok(mail.html.includes('¥24,900'));
  assert.ok(mail.html.includes('請求額'));
  assert.ok(mail.html.includes('申告された振込金額'));
  assert.ok(mail.html.includes('PaymentConfirmed'), '入金確認の手順が書かれていない');
  assert.ok(mail.html.includes('RequestedPlan=Premium'));
  assert.ok(mail.html.includes('RequestedPlanType=Annual'));
  assert.equal(mail.subject.includes('金額差異あり'), false);
});

test('管理者メール: 金額差異があれば件名と本文で警告する', () => {
  const { application: app, warnings } = application({ transferAmount: '1000' });
  const mail = buildOfferAdminEmail({ application: app, warnings, reportedAtText: '2026/08/01 12:00' });
  assert.ok(mail.subject.includes('金額差異あり'), '件名で気づけない');
  assert.ok(mail.html.includes('一致していません'));
  assert.ok(mail.html.includes('申告金額がオファー価格より少ない'));
  assert.ok(mail.html.includes('¥1,000'));
  assert.ok(mail.html.includes('¥24,900'));
});

test('管理者メール: この申込で権限が付いていないことを明記する', () => {
  const { application: app } = application();
  const html = buildOfferAdminEmail({ application: app }).html;
  assert.ok(/プラン \/ 有効期限 \/ Status は未変更/.test(html));
});

test('申込者メール: 「利用開始した」と読める表現を含まない', () => {
  const { application: app } = application();
  const mail = buildOfferUserEmail({ application: app, supportEmail: 'support@keiba.link' });
  assert.ok(mail.subject.includes('お申し込み受付'));
  for (const banned of ['ご利用開始いただけます', 'アクセスを開放', '閲覧できるようになりました',
    'ログインしてご覧ください', '有効期限']) {
    assert.equal(mail.html.includes(banned), false, `誤解させる表現が含まれる: ${banned}`);
  }
  assert.ok(mail.html.includes('まだご利用いただけません'), '未開放であることを伝えていない');
  assert.ok(mail.html.includes('support@keiba.link'));
  assert.ok(mail.html.includes('¥24,900'));
});

test('申込者メール: 振込先はモーダルと同じ口座', () => {
  const { application: app } = application();
  const html = buildOfferUserEmail({ application: app, supportEmail: 'support@keiba.link' }).html;
  assert.ok(BANK_ACCOUNT_TEXT.includes('5338892'));
  assert.ok(html.includes('5338892'));
  assert.ok(html.includes('三井住友銀行 洲本支店'));
});

test('ユーザー入力は HTML エスケープする', () => {
  const { application: app } = application({
    fullName: '<script>alert(1)</script>',
    transferName: '"><img src=x onerror=alert(1)>',
  });
  const admin = buildOfferAdminEmail({ application: app }).html;
  const user = buildOfferUserEmail({ application: app, supportEmail: 'support@keiba.link' }).html;
  for (const html of [admin, user]) {
    assert.equal(html.includes('<script>alert(1)</script>'), false);
    assert.equal(html.includes('<img src=x'), false);
    assert.ok(html.includes('&lt;script&gt;'));
  }
});

test('備考もエスケープされる（改行は保持）', () => {
  const { application: app } = application({ remarks: '名義が違います\n<b>太字</b>' });
  const html = buildOfferAdminEmail({ application: app }).html;
  assert.ok(html.includes('&lt;b&gt;太字&lt;/b&gt;'));
  assert.equal(html.includes('<b>太字</b>'), false);
});
