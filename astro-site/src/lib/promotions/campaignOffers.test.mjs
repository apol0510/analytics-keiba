/**
 * campaignOffers.test.mjs — 全会員向けキャンペーン割引の**中身と出し分け**を固定する
 *
 * ## 確定内容（2026-08-24 MK）
 *
 * > 無料の人は light 500円引きとプレミアム5000円引き / premium の方には sanrenpuku 5000円引き
 * > Premium 月額は対象外 / 買い切り ¥78,000 は 1万円引き / 期限は 14日間
 *
 * 金額は**お金そのもの**なので、1 円でも変わったらここで落とす。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CAMPAIGN_OFFER_IDS, CAMPAIGN_OFFER_DAYS, isCampaignOffer,
  listCampaignOffers, resolveCampaignOfferIdsFor, describeCampaignOffersFor,
  describeCampaignOfferLine,
} from './campaignOffers.js';
import { resolveOffer, OFFER_KIND, REGULAR_PRICE, DISCOUNT_TYPE } from './promotionOfferCatalog.js';
import { PROMO_TIER } from '../entitlements/promotionalGrants.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const offerOf = (id) => resolveOffer(id).offer;

// ── 金額（1 円でも変わったら落ちる）────────────────────────
test('割引額と価格が確定内容どおり', () => {
  const cases = [
    [CAMPAIGN_OFFER_IDS.LIGHT_MONTHLY, REGULAR_PRICE.light_monthly, 500, 4480],
    [CAMPAIGN_OFFER_IDS.PREMIUM_ANNUAL, REGULAR_PRICE.premium_annual, 5000, 44800],
    [CAMPAIGN_OFFER_IDS.PREMIUM_LIFETIME, REGULAR_PRICE.premium_lifetime, 10000, 68000],
    [CAMPAIGN_OFFER_IDS.SANRENPUKU_MONTHLY, REGULAR_PRICE.sanrenpuku_monthly, 5000, 14820],
  ];
  for (const [id, regular, discount, final] of cases) {
    const o = offerOf(id);
    assert.equal(o.regularPrice, regular, `${id}: 通常価格`);
    assert.equal(o.discountValue, discount, `${id}: 割引額`);
    assert.equal(o.offerPrice, final, `${id}: 割引後の価格`);
    assert.equal(o.discountType, DISCOUNT_TYPE.AMOUNT, `${id}: 固定額の値引きでない`);
    assert.equal(o.regularPrice - o.discountValue, o.offerPrice, `${id}: 計算が合っていない`);
  }
});

test('通常価格は正本の価格表と一致する（表示とズレない）', () => {
  assert.equal(REGULAR_PRICE.light_monthly, 4980);
  assert.equal(REGULAR_PRICE.premium_annual, 49800);
  assert.equal(REGULAR_PRICE.premium_lifetime, 78000);
  assert.equal(REGULAR_PRICE.sanrenpuku_monthly, 19820);
});

test('Premium 月額は対象外（MK 判断）', () => {
  const ids = listCampaignOffers().map((o) => o.offerId);
  for (const id of ids) {
    const o = offerOf(id);
    const isPremiumMonthly = o.targetTier === PROMO_TIER.PREMIUM && o.term === 'monthly';
    assert.ok(!isPremiumMonthly, `${id}: Premium 月額が混ざっている`);
  }
});

// ── 権限は渡さない ──────────────────────────────────────────
test('どれも権限を付与しない（割って買えるだけ）', () => {
  for (const o of listCampaignOffers()) {
    assert.equal(o.kind, OFFER_KIND.PURCHASE, `${o.offerId}: 付与になっている`);
    assert.equal(o.isFree, false);
    assert.ok(o.offerPrice > 0, '無料になっている');
  }
});

test('三連複は無料付与の経路に乗らない（付与できる tier に足さない）', () => {
  // ⚠️ 三連複を無料開放する運用は無い。付与判定に SANRENPUKU を足すと
  //    「気づかないうちに三連複を無料で配れる」状態になる。
  const src = read('../entitlements/promotionalGrants.js');
  const fn = src.slice(src.indexOf('function isTier('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /PROMO_TIER\.LIGHT/);
  assert.match(body, /PROMO_TIER\.PREMIUM/);
  assert.doesNotMatch(body, /SANRENPUKU/, '三連複を無料付与できてしまう');
  // 付与の一括処理も light / premium だけを回す
  const grants = read('../entitlements/promotionalGrants.js');
  assert.match(grants, /resolveTierGrant\(f, PROMO_TIER\.LIGHT, now\)/);
  assert.ok(!/resolveTierGrant\(f, PROMO_TIER\.SANRENPUKU/.test(grants));
});

test('申込プラン名が商品ごとに正しい（別商品の申込を作らせない）', () => {
  assert.equal(offerOf(CAMPAIGN_OFFER_IDS.LIGHT_MONTHLY).planName, 'Light');
  assert.equal(offerOf(CAMPAIGN_OFFER_IDS.PREMIUM_ANNUAL).planName, 'Premium Annual');
  assert.equal(offerOf(CAMPAIGN_OFFER_IDS.PREMIUM_LIFETIME).planName, 'Premium Lifetime');
  assert.equal(offerOf(CAMPAIGN_OFFER_IDS.SANRENPUKU_MONTHLY).planName, 'Premium Sanrenpuku');
  // PlanType は既存 bank flow の語彙
  assert.equal(offerOf(CAMPAIGN_OFFER_IDS.SANRENPUKU_MONTHLY).planType, 'Monthly');
  assert.equal(offerOf(CAMPAIGN_OFFER_IDS.PREMIUM_LIFETIME).planType, 'Lifetime');
});

// ── 出し分け ────────────────────────────────────────────────
test('無料の方には Light と Premium（年額・買い切り）を案内する', () => {
  assert.deepEqual(resolveCampaignOfferIdsFor({}), [
    CAMPAIGN_OFFER_IDS.LIGHT_MONTHLY,
    CAMPAIGN_OFFER_IDS.PREMIUM_ANNUAL,
    CAMPAIGN_OFFER_IDS.PREMIUM_LIFETIME,
  ]);
});

test('Premium の方には三連複だけを案内する', () => {
  assert.deepEqual(resolveCampaignOfferIdsFor({ canViewPremium: true }), [
    CAMPAIGN_OFFER_IDS.SANRENPUKU_MONTHLY,
  ]);
});

test('すでに持っているものは勧めない', () => {
  // Light をお持ちの方に Light 割引を出さない
  const light = resolveCampaignOfferIdsFor({ canViewLight: true });
  assert.ok(!light.includes(CAMPAIGN_OFFER_IDS.LIGHT_MONTHLY), 'Light 会員に Light を売っている');
  assert.ok(light.includes(CAMPAIGN_OFFER_IDS.PREMIUM_ANNUAL), 'Light 会員へ上位の案内が無い');

  // Premium の方に Premium 割引を出さない
  const premium = resolveCampaignOfferIdsFor({ canViewPremium: true });
  assert.ok(!premium.includes(CAMPAIGN_OFFER_IDS.PREMIUM_ANNUAL));
  assert.ok(!premium.includes(CAMPAIGN_OFFER_IDS.PREMIUM_LIFETIME));
});

test('三連複をお持ちの方には何も案内しない（最上位）', () => {
  assert.deepEqual(resolveCampaignOfferIdsFor({ canViewPremium: true, canViewSanrenpuku: true }), []);
});

test('判定材料が無いときは無料の方と同じ扱い（案内が消えない）', () => {
  for (const e of [null, undefined, {}]) {
    assert.ok(resolveCampaignOfferIdsFor(e).length > 0);
  }
});

// ── 期限・文言 ──────────────────────────────────────────────
test('期限は 14 日（再募集クーポンと同じ）', () => {
  assert.equal(CAMPAIGN_OFFER_DAYS, 14);
});

test('案内の 1 行に金額を必ず含める（画面で組み立てない）', () => {
  const lines = describeCampaignOffersFor({}).map(describeCampaignOfferLine);
  assert.equal(lines.length, 3);
  for (const l of lines) {
    assert.match(l, /¥[\d,]+ → ¥[\d,]+/, `金額が入っていない: ${l}`);
    assert.match(l, /円OFF/);
  }
  assert.ok(lines.some((l) => l.includes('¥4,980 → ¥4,480')));
});

// ── 他の offer と混ぜない ────────────────────────────────────
test('キャンペーンの offer だけを見分けられる', () => {
  assert.equal(isCampaignOffer(CAMPAIGN_OFFER_IDS.PREMIUM_ANNUAL), true);
  // 既存のカムバック offer は含めない
  assert.equal(isCampaignOffer('premium-annual-half'), false);
  assert.equal(isCampaignOffer('light-30d-free'), false);
  assert.equal(isCampaignOffer(''), false);
  assert.equal(listCampaignOffers().length, 4);
});
