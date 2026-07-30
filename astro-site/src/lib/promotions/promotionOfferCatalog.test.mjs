/**
 * promotionOfferCatalog.test.mjs — 特典カタログ（無料 / 割引）と価格計算
 *   node --test src/lib/promotions/promotionOfferCatalog.test.mjs
 *
 * 守る性質:
 *   - 「30日無料」だけのハードコードになっていない（期間・価格・割引率をデータで持つ）
 *   - 通常価格が `/pricing/` の実装と一致している（ズレたら落ちる）
 *   - 割引 offer は 0 円になれない（無料は grant 側の責務）
 *   - 任意価格は「値上げ」「安すぎ」を通さない
 *   - 無料付与の offer は価格を持たない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PROMOTION_OFFERS,
  OFFER_KIND,
  BILLING_TERM,
  DISCOUNT_TYPE,
  REGULAR_PRICE,
  MIN_OFFER_PRICE,
  TERM_TO_PLAN_TYPE,
  TERM_TO_PLAN_NAME,
  getOfferDefinition,
  listOffers,
  resolveOffer,
  computeOfferPrice,
  describeOffer,
} from './promotionOfferCatalog.js';
import { PROMO_TIER, MAX_GRANT_DAYS } from '../entitlements/promotionalGrants.js';

// ═══ カタログの形 ════════════════════════════════════════════════════

test('各 offer が必須フィールドを持つ（データ駆動であること）', () => {
  const ids = new Set();
  for (const o of PROMOTION_OFFERS) {
    for (const k of ['offerId', 'name', 'description', 'kind', 'targetTier', 'term',
      'isLifetime', 'regularPrice', 'discountType', 'isFree', 'version', 'enabled']) {
      assert.ok(o[k] !== undefined, `${o.offerId}: ${k} が無い`);
    }
    assert.equal(ids.has(o.offerId), false, `offerId 重複: ${o.offerId}`);
    ids.add(o.offerId);
    assert.ok(Object.values(OFFER_KIND).includes(o.kind));
    assert.ok(Object.values(BILLING_TERM).includes(o.term));
    assert.ok(Object.values(PROMO_TIER).includes(o.targetTier));
  }
});

test('要望された組み合わせがすべて作れる', () => {
  for (const id of [
    'light-lifetime-free', 'light-30d-free', 'light-90d-free', 'light-custom-free',
    'premium-30d-free', 'premium-custom-days-free', 'premium-annual-free', 'premium-lifetime-free',
    'premium-30d-half', 'premium-annual-half', 'premium-annual-custom',
    'premium-lifetime-half', 'premium-lifetime-custom',
  ]) {
    assert.ok(getOfferDefinition(id), `${id} が無い`);
  }
});

test('未知 offer は null（丸めない）', () => {
  assert.equal(getOfferDefinition('nope'), null);
  assert.equal(getOfferDefinition(''), null);
  assert.equal(resolveOffer('nope').ok, false);
});

test('listOffers はティア・種類で絞れる（UI の 3 つの選択肢）', () => {
  const light = listOffers({ tier: PROMO_TIER.LIGHT, kind: OFFER_KIND.GRANT });
  const premiumFree = listOffers({ tier: PROMO_TIER.PREMIUM, kind: OFFER_KIND.GRANT });
  const premiumPaid = listOffers({ tier: PROMO_TIER.PREMIUM, kind: OFFER_KIND.PURCHASE });
  assert.ok(light.length >= 4);
  assert.ok(premiumFree.length >= 4);
  assert.ok(premiumPaid.length >= 4);
  assert.equal(light.every((o) => o.targetTier === PROMO_TIER.LIGHT), true);
  assert.equal(premiumPaid.every((o) => o.kind === OFFER_KIND.PURCHASE), true);
});

// ═══ 通常価格が /pricing/ と一致する ═════════════════════════════════

test('通常価格が pricing.astro の実装と一致する（ズレたら落ちる）', () => {
  const page = readFileSync(
    fileURLToPath(new URL('../../pages/pricing.astro', import.meta.url)), 'utf8');
  const calls = [...page.matchAll(/openBankModal\('([^']+)',\s*(\d+),\s*'(\w+)'\)/g)]
    .map((m) => ({ plan: m[1], amount: Number(m[2]), term: m[3] }));
  assert.ok(calls.length >= 4, 'pricing.astro の申込ボタンを読み取れない（テストの前提が壊れた）');

  const find = (plan) => calls.find((c) => c.plan === plan);
  assert.equal(find('Light').amount, REGULAR_PRICE.light_monthly, 'Light の通常価格がズレている');
  assert.equal(find('Premium Monthly').amount, REGULAR_PRICE.premium_monthly, 'Premium 30日の通常価格がズレている');
  assert.equal(find('Premium Annual').amount, REGULAR_PRICE.premium_annual, 'Premium 年額の通常価格がズレている');
  assert.equal(find('Premium Lifetime').amount, REGULAR_PRICE.premium_lifetime, 'Premium 買い切りの通常価格がズレている');

  // 既存 bank flow の語彙（RequestedPlan / RequestedPlanType）とも一致していること
  assert.equal(TERM_TO_PLAN_NAME.annual, find('Premium Annual').plan);
  assert.equal(TERM_TO_PLAN_TYPE.annual.toLowerCase(), find('Premium Annual').term);
  assert.equal(TERM_TO_PLAN_TYPE.lifetime.toLowerCase(), find('Premium Lifetime').term);
  assert.equal(TERM_TO_PLAN_TYPE.monthly.toLowerCase(), find('Premium Monthly').term);
});

// ═══ 無料付与 ════════════════════════════════════════════════════════

test('無料付与は価格を持たず、期間はデータから来る', () => {
  const lifetime = resolveOffer('light-lifetime-free').offer;
  assert.equal(lifetime.isFree, true);
  assert.equal(lifetime.offerPrice, 0);
  assert.equal(lifetime.isLifetime, true);
  assert.equal(lifetime.duration, null);

  const d90 = resolveOffer('light-90d-free').offer;
  assert.equal(d90.duration, 90);
  assert.equal(d90.isLifetime, false);

  const d30 = resolveOffer('premium-30d-free').offer;
  assert.equal(d30.duration, 30);
  assert.equal(d30.targetTier, PROMO_TIER.PREMIUM);

  const annual = resolveOffer('premium-annual-free').offer;
  assert.equal(annual.duration, 365);
});

test('任意日数は範囲内の整数だけ受け付ける', () => {
  assert.equal(resolveOffer('light-custom-free', { customDays: 45 }).offer.duration, 45);
  assert.equal(resolveOffer('premium-custom-days-free', { customDays: 7 }).offer.duration, 7);
  for (const bad of [0, -1, 1.5, MAX_GRANT_DAYS + 1, undefined, 'x']) {
    const r = resolveOffer('light-custom-free', { customDays: bad });
    assert.equal(r.ok, false, `${bad} を受け付けてしまう`);
    assert.equal(r.error, 'invalid_custom_days');
  }
});

// ═══ 割引購入 ════════════════════════════════════════════════════════

test('50%OFF は通常価格の半額（30日 / 年額 / 買い切り）', () => {
  const m = resolveOffer('premium-30d-half').offer;
  assert.equal(m.regularPrice, 18000);
  assert.equal(m.offerPrice, 9000);
  assert.equal(m.discountPercent, 50);
  assert.equal(m.planType, 'Monthly');

  const a = resolveOffer('premium-annual-half').offer;
  assert.equal(a.offerPrice, 24900);
  assert.equal(a.planType, 'Annual');
  assert.equal(a.planName, 'Premium Annual');

  const l = resolveOffer('premium-lifetime-half').offer;
  assert.equal(l.offerPrice, 39000);
  assert.equal(l.planType, 'Lifetime');
});

test('任意価格は「値上げ」「安すぎ」を通さない', () => {
  assert.equal(resolveOffer('premium-annual-custom', { customPrice: 30000 }).offer.offerPrice, 30000);
  // 通常価格以上は割引ではない
  assert.equal(resolveOffer('premium-annual-custom', { customPrice: 49800 }).error, 'price_not_discounted');
  assert.equal(resolveOffer('premium-annual-custom', { customPrice: 60000 }).error, 'price_not_discounted');
  // 下限未満（実質無料は grant 側の責務）
  assert.equal(resolveOffer('premium-annual-custom', { customPrice: 0 }).error, 'price_too_low');
  assert.equal(resolveOffer('premium-annual-custom', { customPrice: MIN_OFFER_PRICE - 1 }).error, 'price_too_low');
  // 整数以外
  for (const bad of [1234.5, undefined, 'x', null]) {
    assert.equal(resolveOffer('premium-annual-custom', { customPrice: bad }).ok, false);
  }
});

test('割引 offer は無料になれない（無料は grant 側）', () => {
  for (const o of PROMOTION_OFFERS.filter((x) => x.kind === OFFER_KIND.PURCHASE)) {
    const r = resolveOffer(o.offerId, { customPrice: 20000 });
    if (!r.ok) continue;
    assert.ok(r.offer.offerPrice >= MIN_OFFER_PRICE, `${o.offerId} が安すぎる`);
    assert.equal(r.offer.isFree, false);
  }
});

test('割引 offer は権限の期間を持たない（isLifetime=false）', () => {
  // 「買い切り 50%OFF」は購入条件であって無料の無期限権利ではない
  const l = resolveOffer('premium-lifetime-half').offer;
  assert.equal(l.isLifetime, false, '割引 offer が無料の無期限権利として扱われている');
  assert.equal(l.kind, OFFER_KIND.PURCHASE);
});

test('computeOfferPrice は不正な割引を null にする', () => {
  assert.equal(computeOfferPrice({ regularPrice: 10000, discountType: DISCOUNT_TYPE.PERCENT, discountValue: 50 }), 5000);
  assert.equal(computeOfferPrice({ regularPrice: 10000, discountType: DISCOUNT_TYPE.AMOUNT, discountValue: 3000 }), 7000);
  assert.equal(computeOfferPrice({ regularPrice: 10000, discountType: DISCOUNT_TYPE.FREE }), 0);
  for (const bad of [0, 100, 120, -5]) {
    assert.equal(computeOfferPrice({ regularPrice: 10000, discountType: DISCOUNT_TYPE.PERCENT, discountValue: bad }), null);
  }
  assert.equal(computeOfferPrice({ regularPrice: 10000, discountType: DISCOUNT_TYPE.AMOUNT, discountValue: 10000 }), null);
});

test('describeOffer は金額と期間を必ず含む', () => {
  assert.equal(describeOffer(resolveOffer('light-lifetime-free').offer), 'Light 永久無料');
  assert.equal(describeOffer(resolveOffer('premium-30d-free').offer), 'Premium 30日間 無料');
  const d = describeOffer(resolveOffer('premium-annual-half').offer);
  assert.match(d, /¥49,800/);
  assert.match(d, /¥24,900/);
  assert.match(d, /50%OFF/);
});
