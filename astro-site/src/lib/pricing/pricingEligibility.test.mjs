/**
 * pricingEligibility.test.mjs — 会員向け価格の資格は「課金契約」だけから決まる
 *   node --test src/lib/pricing/pricingEligibility.test.mjs
 *
 * 守る性質:
 *   - 無料特典（promotional grant）は **価格資格を 1 ミリも与えない**
 *   - 有料 Light / Premium 契約は従来どおり会員向け価格が使える
 *   - 実際の請求額に効く経路（申込フォーム）でサーバー側が課金契約を再判定する
 *   - 特別価格が要るなら PromotionalOffer（別テーブル・別経路）で明示的に与える
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  PRICING_TIER,
  resolvePaidPricingTier,
  resolvePaidPricingTierFromFields,
  isMemberOnlyCampaignProduct,
  checkMemberOnlyPricing,
} from './pricingEligibility.js';
import { PLAN_TIER_BY_CANONICAL } from './planTiers.js';
import { PROMO_FIELDS } from '../entitlements/promotionalGrants.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { buildGrantFields } from '../entitlements/promotionalGrants.js';
import { buildOfferRecord } from '../promotions/promotionalOffer.js';
import { resolveOffer } from '../promotions/promotionOfferCatalog.js';

const NOW = Date.parse('2026-08-01T03:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const L = PROMO_FIELDS.light;
const P = PROMO_FIELDS.premium;
const iso = (ms) => new Date(ms).toISOString();

const PAID_LIGHT = { Email: 'l@example.com', 'プラン': 'Light', Status: 'active', '有効期限': '2099-01-01' };
const PAID_PREMIUM = { Email: 'p@example.com', 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2099-01-01' };
const EXPIRED_PREMIUM = { Email: 'e@example.com', 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2026-01-01' };
const FREE = { Email: 'f@example.com', 'プラン': 'Free', Status: 'active' };

const GRANT_LIGHT = { [L.LIFETIME]: true };
const GRANT_PREMIUM = { [P.UNTIL]: iso(NOW + 30 * DAY) };

const tierOf = (fields) => resolvePaidPricingTierFromFields(fields, NOW);

// ══ 1. 価格資格は課金契約のみ ═══════════════════════════════════════

test('価格 tier: 有料契約だけが会員向け価格の資格を持つ', () => {
  assert.equal(tierOf(PAID_LIGHT), PRICING_TIER.LIGHT, '有料 Light に価格資格が無い');
  assert.equal(tierOf(PAID_PREMIUM), PRICING_TIER.PREMIUM, '有料 Premium に価格資格が無い');
  assert.equal(tierOf(FREE), PRICING_TIER.NONE);
  assert.equal(tierOf(EXPIRED_PREMIUM), PRICING_TIER.NONE, '期限切れに価格資格が残っている');
});

test('🔒 promo Light: Light は閲覧できるが、Light 会員向け価格の資格は無い', () => {
  const fields = { ...EXPIRED_PREMIUM, ...GRANT_LIGHT };
  const e = resolveEntitlements(fromAirtableFields(fields), NOW);
  // 閲覧はできる
  assert.equal(e.canViewLight, true);
  assert.equal(e.effectiveTier, 'light');
  // 価格資格は無い
  assert.equal(resolvePaidPricingTier(e), PRICING_TIER.NONE, '無料 Light 特典で会員価格が使える');
  assert.equal(tierOf(fields), PRICING_TIER.NONE);
});

test('🔒 promo Premium: Premium は閲覧できるが、価格資格・販売資格は無い', () => {
  const fields = { ...EXPIRED_PREMIUM, ...GRANT_PREMIUM };
  const e = resolveEntitlements(fromAirtableFields(fields), NOW);
  assert.equal(e.canViewPremium, true);
  assert.equal(resolvePaidPricingTier(e), PRICING_TIER.NONE, '無料 Premium 特典で会員価格が使える');
  // 既に固定済みの性質だが、価格と一緒に崩れやすいのでここでも押さえる
  assert.equal(e.paidPremiumActive, false);
  assert.equal(e.canPurchaseSanrenpuku, false);
});

test('有料契約 + 無料特典: 有料側の価格資格は維持される', () => {
  assert.equal(tierOf({ ...PAID_LIGHT, ...GRANT_LIGHT, ...GRANT_PREMIUM }), PRICING_TIER.LIGHT);
  assert.equal(tierOf({ ...PAID_PREMIUM, ...GRANT_LIGHT, ...GRANT_PREMIUM }), PRICING_TIER.PREMIUM);
});

test('ログインできない状態（退会 / 停止）は価格資格なし', () => {
  assert.equal(tierOf({ ...PAID_LIGHT, WithdrawalRequested: true }), PRICING_TIER.NONE);
  assert.equal(tierOf({ ...PAID_LIGHT, Status: 'suspended' }), PRICING_TIER.NONE);
  assert.equal(tierOf({ ...PAID_LIGHT, ...GRANT_LIGHT, WithdrawalRequested: true }), PRICING_TIER.NONE);
});

test('価格 tier は planTiers と同じ尺度（CSS の data-plan-tier と揃う）', () => {
  assert.equal(PRICING_TIER.LIGHT, PLAN_TIER_BY_CANONICAL.light);
  assert.equal(PRICING_TIER.PREMIUM, PLAN_TIER_BY_CANONICAL.premium);
  assert.equal(PRICING_TIER.NONE, 0);
});

// ══ 2. 申込（実際の請求額に効く経路）のサーバー側再判定 ═══════════════

test('会員限定価格の商品名を判別する', () => {
  assert.equal(isMemberOnlyCampaignProduct('Premium Annual - Campaign (¥44,820/年)'), true);
  assert.equal(isMemberOnlyCampaignProduct('Premium Annual (¥49,800/年)'), false);
  assert.equal(isMemberOnlyCampaignProduct('Light (¥4,980/30日)'), false);
  assert.equal(isMemberOnlyCampaignProduct(''), false);
  assert.equal(isMemberOnlyCampaignProduct(null), false);
});

test('🔒 promo Light だけの顧客が会員限定価格で申し込むと警告が出る（拒否はしない）', () => {
  const r = checkMemberOnlyPricing({
    productName: 'Premium Annual - Campaign (¥44,820/年)',
    fields: { ...EXPIRED_PREMIUM, ...GRANT_LIGHT },
    nowMs: NOW,
  });
  assert.equal(r.memberOnly, true);
  assert.equal(r.eligible, false, '無料特典で会員限定価格の資格が通っている');
  assert.equal(r.tier, PRICING_TIER.NONE);
  assert.ok(r.warning && r.warning.includes('確認できません'));
});

test('有料 Light 顧客の会員限定価格は従来どおり通る（警告なし）', () => {
  const r = checkMemberOnlyPricing({
    productName: 'Premium Annual - Campaign (¥44,820/年)', fields: PAID_LIGHT, nowMs: NOW,
  });
  assert.equal(r.eligible, true);
  assert.equal(r.warning, null);
});

test('通常価格の申込は再判定の対象外（既存挙動に影響しない）', () => {
  for (const fields of [PAID_LIGHT, FREE, { ...EXPIRED_PREMIUM, ...GRANT_LIGHT }, null]) {
    const r = checkMemberOnlyPricing({ productName: 'Premium Annual (¥49,800/年)', fields, nowMs: NOW });
    assert.equal(r.memberOnly, false);
    assert.equal(r.eligible, true);
    assert.equal(r.warning, null);
  }
});

test('レコードが見つからない会員限定価格の申込は資格なし扱い', () => {
  const r = checkMemberOnlyPricing({
    productName: 'Premium Annual - Campaign (¥44,820/年)', fields: null, nowMs: NOW,
  });
  assert.equal(r.eligible, false);
});

// ══ 3. 実装の固定（guard）═════════════════════════════════════════

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const pricingPage = read('../../pages/pricing.astro');
const bankFn = read('../../../netlify/functions/bank-transfer-application.js');
const verifyFlow = read('../../lib/auth/verifyMagicLinkFlow.js');

test('guard: pricing.astro はサーバー算出 pricingTier を優先し、特典由来を除外する', () => {
  assert.ok(pricingPage.includes('up.pricingTier'), 'サーバー算出の価格 tier を使っていない');
  assert.ok(/entitlementSource === 'promotional_grant'/.test(pricingPage),
    '無料特典の顧客を出し分けから除外していない');
  // pricingTier があるならプラン名からの推測はしない（return する）
  assert.ok(/typeof up\.pricingTier === 'number'[\s\S]{0,300}return;/.test(pricingPage),
    'pricingTier があるのにプラン名から tier を推測している');
});

test('guard: 会員限定価格はサーバー側で課金契約を再判定する', () => {
  assert.ok(bankFn.includes('checkMemberOnlyPricing'), '申込 Function が再判定していない');
  assert.ok(bankFn.includes('memberPricingWarning'), '管理者への警告が無い');
  // 判定結果で申込を拒否しない（振込済みの人を締め出さない）
  assert.equal(/memberPricingWarning[\s\S]{0,200}statusCode:\s*4\d\d/.test(bankFn), false,
    '会員限定価格の判定で申込を拒否している');
  // 課金・権限フィールドを書かない
  for (const f of ['PaymentConfirmed: true', 'PaidAt', 'LifetimeSanrenpuku', "'プラン'"]) {
    assert.equal(bankFn.includes(f), false, `${f} を書いている`);
  }
});

test('guard: ログイン応答の pricingTier は課金契約だけから算出される', () => {
  assert.ok(verifyFlow.includes('resolvePaidPricingTierFromFields'), '単一源を経由していない');
  assert.equal(verifyFlow.includes('effectiveTier'), false, '閲覧権の tier を価格に流用している');
});

// ══ 4. 特別価格は PromotionalOffer だけが与える ═══════════════════════

test('無料特典だけでは請求額に関わる値が 1 つも生まれない', () => {
  const fields = { ...EXPIRED_PREMIUM, ...GRANT_LIGHT, ...GRANT_PREMIUM };
  // 付与で書かれるのは特典 15 列だけ。金額・請求・契約の語彙が 1 つも無い
  const granted = buildGrantFields({
    tier: 'light', lifetime: true, fields: {}, now: NOW, operationId: 'op-1',
  });
  const keys = Object.keys(granted.fields);
  for (const banned of ['RequestedAmount', 'RequestedPlan', 'RequestedPlanType', 'PaymentMethod',
    'OfferPrice', 'RegularPrice', 'プラン', '有効期限', 'PaidAt', 'PaymentConfirmed']) {
    assert.equal(keys.includes(banned), false, `特典付与が ${banned} を書いている`);
  }
  // 価格資格も上がらない
  assert.equal(tierOf(fields), PRICING_TIER.NONE);
});

test('promo Light + PromotionalOffer: 価格は offer 台帳の値だけで、価格資格は上がらない', () => {
  const offer = resolveOffer('premium-annual-half').offer;
  const rec = buildOfferRecord({
    offer,
    customer: { recordId: 'recX', email: 'l@example.com' },
    nowMs: NOW, operationId: 'op-2', source: 'comeback', secret: 'x'.repeat(32),
  });
  // offer は自分の価格を持つ（通常価格ではない）
  assert.equal(rec.fields.OfferPrice, 24900);
  assert.equal(rec.fields.RegularPrice, 49800);
  assert.ok(rec.fields.OfferPrice < rec.fields.RegularPrice);

  // offer 行は Customers の課金・特典フィールドを 1 つも含まない
  for (const banned of ['プラン', '有効期限', 'PaidAt', 'PaymentConfirmed', 'RequestedPlan',
    'RequestedAmount', 'LightGrantLifetime', 'PremiumGrantUntil']) {
    assert.equal(banned in rec.fields, false, `offer 行に ${banned} が含まれる`);
  }

  // offer を発行しても、その顧客の閲覧権・価格資格は変わらない
  const fields = { ...EXPIRED_PREMIUM, ...GRANT_LIGHT };
  assert.equal(tierOf(fields), PRICING_TIER.NONE, 'offer 発行で会員価格の資格が付いた');
  const e = resolveEntitlements(fromAirtableFields(fields), NOW);
  assert.equal(e.canViewPremium, false, 'offer 発行で Premium が開いた');
  assert.equal(e.effectiveTier, 'light');
});
