/**
 * 2026-10-02 MK 確定の表示方針と解約導線を固定する guard。
 *
 * - 「最低利用期間なし」「いつでも解約可」「日割り返金なし」は制度として正しく記載するが、
 *   販売画面（/pricing/ のカード・見出し）と Stripe Checkout の追加文言では強調しない。
 *   正確な記載は FAQ・/refund/・/terms/・/legal/。
 * - Stripe の月額会員は退会フラグ（その場で閲覧停止・課金は止まらない）ではなく「お支払い管理」で解約する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isStripeSubscriber } from './stripeSubscriptionSync.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
const CANCEL_PROMO = /いつでも解約|最低利用期間|日割り/;

test('Stripe Checkout に AK 側の追加文言（custom_text）を付けない', () => {
  const code = stripComments(read('netlify/functions/stripe-create-checkout.js'));
  assert.equal(/custom_text/.test(code), false);
  assert.equal(CANCEL_PROMO.test(code), false);
});

test('/pricing/ は FAQ 以外で解約条件を販売コピーにしない', () => {
  const page = stripComments(read('src/pages/pricing.astro'));
  const beforeFaq = page.slice(0, page.indexOf('class="faq-section"'));
  assert.ok(beforeFaq.length > 1000, 'FAQ の位置を読み取れない');
  assert.equal(CANCEL_PROMO.test(beforeFaq), false, 'カード・見出しに解約条件の強調がある');
  // FAQ には通常の説明として正確に書かれている
  const faq = page.slice(page.indexOf('class="faq-section"'));
  assert.match(faq, /最低利用期間はなく、日割りでの返金は行っておりません/);
  assert.match(faq, /お支払い済みの期間の終わりまではご利用いただけます/);
});

test('アップグレード導線（マイページ・/premium-upgrade/）の特長に「いつでも解約」を並べない', () => {
  for (const p of ['src/pages/premium-upgrade.astro', 'src/pages/dashboard.astro']) {
    assert.equal(/<li>[^<]*いつでも解約/.test(read(p)), false, p);
  }
});

test('/refund/・/terms/・/legal/ は解約条件を正確に書く（次回更新停止・支払い済み期間末まで・最低利用期間なし・日割り返金なし）', () => {
  for (const p of ['src/pages/refund.astro', 'src/pages/terms.astro', 'src/pages/legal.astro']) {
    const s = read(p);
    assert.match(s, /no minimum contract period/i, p);
    assert.match(s, /already paid for/i, p);
    assert.match(s, /prorated refunds/i, p);
  }
});

test('Stripe 会員の判定', () => {
  assert.equal(isStripeSubscriber({ PaymentMethod: 'Stripe', StripeSubscriptionId: 'sub_1' }), true);
  assert.equal(isStripeSubscriber({ PaymentMethod: 'Bank Transfer', StripeSubscriptionId: 'sub_1' }), false);
  assert.equal(isStripeSubscriber({ PaymentMethod: 'Stripe' }), false);
  assert.equal(isStripeSubscriber(null), false);
});

test('退会処理は Stripe 会員に退会フラグを立てない（判定が書き込みより前にある）', () => {
  const code = stripComments(read('netlify/functions/process-withdrawal.js'));
  const guard = code.indexOf('isStripeSubscriber(customerRecord.fields)');
  const write = code.indexOf('await updateCustomerWithdrawalStatus(');
  assert.ok(guard > 0 && write > 0 && guard < write);
  const dash = read('src/pages/dashboard.astro');
  assert.ok(dash.indexOf('_sa.stripeBilling === true') < dash.indexOf("fetch('/.netlify/functions/process-withdrawal'"));
});

test('14 日返金保証は廃止（2026-10-02 MK 確定）。refund / terms / legal / pricing に残さない', () => {
  for (const p of ['src/pages/refund.astro', 'src/pages/terms.astro', 'src/pages/legal.astro', 'src/pages/pricing.astro', 'src/pages/privacy.astro']) {
    assert.equal(/14[- ]day|14 days|money-back|14日間/i.test(stripComments(read(p))), false, p);
  }
});

test('事業者情報は事業サイト analytics.tirol.link と一致（販売事業者名・連絡先）', () => {
  const legal = read('src/pages/legal.astro');
  assert.match(legal, /tirol data labo/);
  assert.match(legal, /analytics@tirol\.link/);
  assert.match(legal, /https:\/\/analytics\.tirol\.link\/tokushoho\//);
  for (const p of ['src/pages/refund.astro', 'src/pages/terms.astro', 'src/pages/privacy.astro', 'src/pages/legal.astro']) {
    assert.equal(/support@tirol\.link/.test(read(p)), false, `${p}: 旧連絡先`);
  }
});

