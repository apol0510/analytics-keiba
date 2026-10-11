import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CARD_PRODUCTS, cardProductById, cardProductByAmount, decideCardPurchase, decideCardGrant,
} from './cardOneTime.js';
import { hasBannedPaymentWord } from './paymentDisplayNames.js';

const NOW = new Date('2026-10-11T03:00:00Z'); // 12:00 JST
const LIGHT_ACTIVE = { 'プラン': 'Light', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-10-30', PaymentMethod: 'Bank Transfer' };

test('商品: 銀行振込と同じ 3 商品・同じ金額（¥49,800 / ¥44,820 / ¥78,000）・金額は重複しない・月払いは無い', () => {
  assert.deepEqual(CARD_PRODUCTS.map((p) => [p.id, p.amountYen, p.planType]), [
    ['premium-annual', 49800, 'Annual'], ['premium-annual-light', 44820, 'Annual'], ['premium-lifetime', 78000, 'Lifetime'],
  ]);
  assert.equal(new Set(CARD_PRODUCTS.map((p) => p.amountYen)).size, CARD_PRODUCTS.length);
  assert.equal(CARD_PRODUCTS.some((p) => p.planType === 'Monthly'), false);
  const pricing = readFileSync(fileURLToPath(new URL('../../pages/pricing.astro', import.meta.url)), 'utf8');
  for (const p of CARD_PRODUCTS) {
    assert.match(pricing, new RegExp(`openBankModal\\('${p.bankProductName.replace(/[-]/g, '\\-')}', ${p.amountYen},`), p.id);
  }
  assert.equal(cardProductByAmount(78000).id, 'premium-lifetime');
  assert.equal(cardProductByAmount(4980), null);
});

test('決済会社へ出す名前は Analytics Premium で始まり、禁止語を含まない', () => {
  for (const p of CARD_PRODUCTS) {
    assert.match(p.displayName, /^Analytics Premium/);
    assert.equal(hasBannedPaymentWord(p.displayName), false, p.displayName);
  }
});

test('申込前: 不明商品・買い切り会員・生きている Stripe 月額・資格の無い会員価格は止める', () => {
  assert.equal(decideCardPurchase({ productId: 'x', now: NOW }).code, 'invalid_product');
  assert.equal(decideCardPurchase({ productId: 'premium-annual', fields: { 'プラン': 'Premium', PlanType: 'Lifetime' }, now: NOW }).code, 'already_lifetime');
  assert.equal(decideCardPurchase({
    productId: 'premium-annual', now: NOW,
    fields: { 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', PaymentMethod: 'Stripe', StripeSubscriptionId: 'sub_1', '有効期限': '2026-10-20' },
  }).code, 'stripe_subscription_active');
  assert.equal(decideCardPurchase({ productId: 'premium-annual-light', fields: null, now: NOW }).code, 'not_eligible');
  assert.equal(decideCardPurchase({ productId: 'premium-annual-light', fields: { 'プラン': 'Free' }, now: NOW }).code, 'not_eligible');
  assert.equal(decideCardPurchase({ productId: 'premium-annual-light', fields: LIGHT_ACTIVE, now: NOW }).ok, true);
  assert.equal(decideCardPurchase({ productId: 'premium-annual', fields: null, now: NOW }).ok, true);
  assert.equal(decideCardPurchase({ productId: 'premium-lifetime', fields: LIGHT_ACTIVE, now: NOW }).ok, true);
  // Stripe 月額でも期限切れ（終了済み）なら申込できる
  assert.equal(decideCardPurchase({
    productId: 'premium-annual', now: NOW,
    fields: { 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', PaymentMethod: 'Stripe', StripeSubscriptionId: 'sub_1', '有効期限': '2026-10-01' },
  }).ok, true);
});

test('反映: 年払いは支払日（JST）+1 年・Premium 両会場・退会フラグを戻す', () => {
  const r = decideCardGrant({ productId: 'premium-annual', fields: { 'プラン': 'Free' }, paidAt: NOW, provider: 'fincode' });
  assert.equal(r.action, 'grant');
  assert.equal(r.expiration, '2027-10-11');
  assert.deepEqual(
    { ...r.fields, PaidAt: undefined },
    { 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2027-10-11', PaidAt: undefined, PaymentMethod: 'fincode', VenueAccess: '', WithdrawalRequested: false, WithdrawalDate: null, WithdrawalReason: null },
  );
  // JST 00:30（UTC では前日）でも JST の暦日で数える
  assert.equal(decideCardGrant({ productId: 'premium-annual', fields: {}, paidAt: new Date('2026-10-10T15:30:00Z'), provider: 'fincode' }).expiration, '2027-10-11');
});

test('反映: Premium の残りがある人の年払いは残りの期限から 1 年（縮めない・残り日数を失わせない）', () => {
  const f = { 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2027-03-01' };
  assert.equal(decideCardGrant({ productId: 'premium-annual', fields: f, paidAt: NOW, provider: 'fincode' }).expiration, '2028-03-01');
  // Light の残りは Premium に持ち越さない（支払日から 1 年）
  assert.equal(decideCardGrant({ productId: 'premium-annual-light', fields: LIGHT_ACTIVE, paidAt: NOW, provider: 'fincode' }).expiration, '2027-10-11');
  // 期限切れの Premium は支払日から
  assert.equal(decideCardGrant({ productId: 'premium-annual', fields: { ...f, '有効期限': '2026-09-01' }, paidAt: NOW, provider: 'fincode' }).expiration, '2027-10-11');
});

test('反映: 買い切りは期限なし（2099-12-31）。買い切り会員への再反映は書かない（conflict）', () => {
  assert.equal(decideCardGrant({ productId: 'premium-lifetime', fields: LIGHT_ACTIVE, paidAt: NOW, provider: 'fincode' }).expiration, '2099-12-31');
  const c = decideCardGrant({ productId: 'premium-annual', fields: { 'プラン': 'Premium', PlanType: 'Lifetime' }, paidAt: NOW, provider: 'fincode' });
  assert.deepEqual(c, { action: 'conflict', reason: 'existing_lifetime' });
});

test('反映: 入力が壊れていれば書かない（fail closed）・同じ入力には同じ出力', () => {
  assert.equal(decideCardGrant({ productId: 'nope', paidAt: NOW, provider: 'fincode' }).action, 'invalid');
  assert.equal(decideCardGrant({ productId: 'premium-annual', paidAt: new Date('x'), provider: 'fincode' }).action, 'invalid');
  assert.equal(decideCardGrant({ productId: 'premium-annual', paidAt: NOW, provider: '' }).action, 'invalid');
  const a = decideCardGrant({ productId: 'premium-annual', fields: {}, paidAt: NOW, provider: 'fincode' });
  const b = decideCardGrant({ productId: 'premium-annual', fields: {}, paidAt: NOW, provider: 'fincode' });
  assert.deepEqual(a, b);
  assert.equal(cardProductById('premium-annual').amountYen, 49800);
});
