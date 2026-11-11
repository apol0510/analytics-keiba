/**
 * 特別価格（2026-11-11 MK）の表と判定。金額は MK 指示の表と 1 円も違わないこと・商品価格（amountYen）を変えていないこと。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBSCRIPTION_CAMPAIGN, campaignDiscountYen, campaignPriceFor, decideCampaignForCheckout,
  paddleCampaignDiscount, isActiveCampaignId, hadCardSubscriptionInFields,
} from './subscriptionCampaign.js';
import { SUBSCRIPTION_PLANS, subscriptionPlanById } from './paypal/paypalSubscriptionCore.js';

test('MK 指示の価格表どおり（通常 → 特別）・商品の通常価格は変えていない', () => {
  const want = { premium: [4980, 3980], 'premium-jra': [2980, 2480], 'premium-nankan': [2980, 2480], 'premium-annual': [49800, 44800] };
  for (const [id, [regular, special]] of Object.entries(want)) {
    const p = campaignPriceFor(subscriptionPlanById(id));
    assert.equal(p.regularYen, regular, id);
    assert.equal(p.specialYen, special, id);
    assert.equal(p.discountYen, regular - special, id);
  }
  assert.deepEqual(
    Object.fromEntries(SUBSCRIPTION_PLANS.map((p) => [p.id, p.amountYen])),
    { premium: 4980, 'premium-jra': 2980, 'premium-nankan': 2980, 'premium-annual': 49800, 'premium-annual-light': 44820 },
    '購読の単価（更新額）は通常料金のまま',
  );
});

test('Light 乗り換え特典（毎年 ¥44,820）には重ねない', () => {
  assert.equal(campaignDiscountYen('premium-annual-light'), 0);
  assert.equal(campaignPriceFor(subscriptionPlanById('premium-annual-light')).specialYen, null);
  assert.equal(paddleCampaignDiscount({ planId: 'premium-annual-light', campaignId: SUBSCRIPTION_CAMPAIGN.id }), null);
});

test('判定: 過去のカード定期課金なし → 付ける／あり・不明 → 付けない', () => {
  const plan = subscriptionPlanById('premium');
  assert.deepEqual(decideCampaignForCheckout({ planId: 'premium', plan, fields: {}, hadCardSubscription: false }),
    { applied: true, campaignId: 'special-2026-11', discountYen: 1000, firstYen: 3980, regularYen: 4980 });
  assert.equal(decideCampaignForCheckout({ planId: 'premium', plan, hadCardSubscription: true }).reason, 'previous_subscription');
  assert.equal(decideCampaignForCheckout({ planId: 'premium', plan, hadCardSubscription: null }).reason, 'history_unknown');
  assert.equal(decideCampaignForCheckout({ planId: 'premium', plan, hadCardSubscription: undefined }).applied, false);
  assert.equal(decideCampaignForCheckout({ planId: 'premium', plan, fields: { StripeSubscriptionId: 'sub_1X' }, hadCardSubscription: false }).applied, false);
  for (const m of ['Paddle', 'paypal', 'Stripe']) assert.equal(hadCardSubscriptionInFields({ PaymentMethod: m }), true, m);
  assert.equal(hadCardSubscriptionInFields({ PaymentMethod: '銀行振込' }), false, '銀行振込だけの元会員は新規カード契約として扱う');
  const closed = { ...SUBSCRIPTION_CAMPAIGN, open: false };
  assert.equal(decideCampaignForCheckout({ planId: 'premium', plan, hadCardSubscription: false, campaign: closed }).reason, 'closed');
  assert.equal(campaignPriceFor(plan, closed).specialYen, null, '閉じたら表示も通常価格');
});

test('Paddle の値引きは一回限り（recur:false）・定額・受付中の ID だけ', () => {
  assert.deepEqual(paddleCampaignDiscount({ planId: 'premium-annual', campaignId: 'special-2026-11' }),
    { description: '特別価格 5,000円OFF', type: 'flat', amount: '5000', recur: false });
  assert.equal(paddleCampaignDiscount({ planId: 'premium', campaignId: 'other' }), null);
  assert.equal(paddleCampaignDiscount({ planId: 'premium', campaignId: '' }), null);
  assert.equal(isActiveCampaignId('special-2026-11', { ...SUBSCRIPTION_CAMPAIGN, open: false }), false);
});
