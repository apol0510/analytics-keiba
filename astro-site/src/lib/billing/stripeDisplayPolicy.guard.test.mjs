/**
 * 2026-10-02 MK 確定の表示方針と解約導線を固定する guard。
 *
 * - 「最低利用期間なし」「いつでも解約可」「日割り返金なし」は制度として正しく記載するが、
 *   販売画面（/pricing/ のカード・見出し）と Stripe Checkout の追加文言では強調しない。
 *   正確な記載は FAQ・/refund/・/terms/・/legal/。
 * - 2026-10-07 MK 確定: Stripe 月額会員の退会は**即時**（期間末解約・予約停止・解約取消は廃止）。
 *   退会はマイページ「アカウント管理」の「退会する」→ 確認画面 → 確定（stripe-withdraw）。ポータルでは解約させない。
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
  assert.match(faq, /現在の利用期限を待たずにすぐにご利用いただけなくなり/);
  assert.match(faq, /残りの期間のご利用を希望される場合は、退会せずにそのままご利用ください/);
  assert.equal(/お支払い済みの期間の終わり/.test(page), false, '期間末解約の文言が残っている');
});

test('アップグレード導線（マイページ・/premium-upgrade/）の特長に「いつでも解約」を並べない', () => {
  for (const p of ['src/pages/premium-upgrade.astro', 'src/pages/dashboard.astro']) {
    assert.equal(/<li>[^<]*いつでも解約/.test(read(p)), false, p);
  }
});

test('/refund/・/terms/・/legal/ は退会条件を正確に書く（即時に利用終了・残り期間は使えない・取消不可・最低利用期間なし・日割り返金なし）', () => {
  for (const p of ['src/pages/refund.astro', 'src/pages/terms.astro', 'src/pages/legal.astro']) {
    const s = stripComments(read(p));
    assert.match(s, /no minimum contract period/i, p);
    assert.match(s, /immediately/i, p);
    assert.match(s, /remaining days/i, p);
    assert.match(s, /cannot be undone/i, p);
    assert.match(s, /prorated refunds/i, p);
    // 期間末解約（支払い済み期間の終わりまで使える）の記載を残さない
    assert.equal(/until the end of the (billing )?period/i.test(s), false, `${p}: 期間末解約の記載`);
    assert.equal(/already paid for/i.test(s), false, `${p}: 期間末解約の記載`);
  }
});

test('Stripe 会員の判定', () => {
  assert.equal(isStripeSubscriber({ PaymentMethod: 'Stripe', StripeSubscriptionId: 'sub_1' }), true);
  assert.equal(isStripeSubscriber({ PaymentMethod: 'Bank Transfer', StripeSubscriptionId: 'sub_1' }), false);
  assert.equal(isStripeSubscriber({ PaymentMethod: 'Stripe' }), false);
  assert.equal(isStripeSubscriber(null), false);
});

test('メールアドレスだけの退会処理（process-withdrawal）は Stripe 会員に退会フラグを立てず購読も操作しない', () => {
  const code = stripComments(read('netlify/functions/process-withdrawal.js'));
  const guard = code.indexOf('isStripeSubscriber(customerRecord.fields)');
  const write = code.indexOf('await updateCustomerWithdrawalStatus(');
  assert.ok(guard > 0 && write > 0 && guard < write);
  const dash = read('src/pages/dashboard.astro');
  assert.ok(dash.indexOf('_sa.stripeBilling === true') < dash.indexOf("fetch('/.netlify/functions/process-withdrawal'"));
  assert.equal(/subscriptions\.(cancel|del|update)/.test(code), false, 'process-withdrawal から購読を操作しない');
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

