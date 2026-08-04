/**
 * promotionOfferCatalog.js — 顧客へ提示する「特典」の定義カタログ（純粋・I/O なし）
 *
 * ── 2 種類を 1 つのカタログで扱うが、効果は正反対 ─────────────────────
 *   kind='entitlement_grant'（無料）… 管理者の承認で **その場で閲覧権を付与する**
 *   kind='purchase_offer'（割引）  … **権利を 1 ミリも与えない**。その顧客専用の
 *                                     「購入条件」を発行するだけ。支払い完了後に
 *                                     既存の入金確認フローが Premium へ昇格させる
 *
 * ⚠️ 割引 offer を作っただけで `プラン=Premium` / `PaymentConfirmed=true` にしない。
 *    キャンペーン都合で決済フィールドを偽装しない（本ファイルは金額しか持たない）。
 *
 * ── ハードコードした「30日無料」だけの実装にしない ───────────────────
 * 各 offer は duration / durationUnit / isLifetime / regularPrice / offerPrice /
 * discountType / discountValue / isFree をデータとして持つ。コード側に個別分岐を
 * 増やさず、`resolveOffer()` が正規化した 1 つの形へ落とす。
 * 任意期間・任意価格は `custom` 系 offer に管理者入力を渡して組み立てる（範囲検証あり）。
 *
 * ── 通常価格の正本 ───────────────────────────────────────────────
 * 表示の正本は `/pricing/`（`src/pages/pricing.astro`）。ここの `REGULAR_PRICE` は
 * その値の写しで、`promotionOfferCatalog.guard.test.mjs` が pricing.astro の
 * `openBankModal(...)` 実引数と突き合わせて**ズレたら落ちる**ようにしてある。
 */

import { PROMO_TIER, MAX_GRANT_DAYS } from '../entitlements/promotionalGrants.js';

/** offer の種類 */
export const OFFER_KIND = Object.freeze({
  /** 無料付与（promotional grant を作る） */
  GRANT: 'entitlement_grant',
  /** 割引購入条件（promotional offer を作る。権限は付与しない） */
  PURCHASE: 'purchase_offer',
});

/**
 * 課金サイクル。既存 Airtable `PlanType`（Monthly / Annual / Lifetime）と 1:1 で対応させる。
 * `days` は無料付与専用（購入条件には使わない）。
 */
export const BILLING_TERM = Object.freeze({
  DAYS: 'days',
  MONTHLY: 'monthly',
  ANNUAL: 'annual',
  LIFETIME: 'lifetime',
});

/** BILLING_TERM → Airtable `RequestedPlanType`（既存 bank flow の語彙） */
export const TERM_TO_PLAN_TYPE = Object.freeze({
  monthly: 'Monthly',
  annual: 'Annual',
  lifetime: 'Lifetime',
});

/** BILLING_TERM → 既存 pricing の申込プラン名（`RequestedPlan`） */
export const TERM_TO_PLAN_NAME = Object.freeze({
  monthly: 'Premium Monthly',
  annual: 'Premium Annual',
  lifetime: 'Premium Lifetime',
});

export const DISCOUNT_TYPE = Object.freeze({
  NONE: 'none',
  /** 割引率（%） */
  PERCENT: 'percent',
  /** 固定額の値引き（円） */
  AMOUNT: 'amount',
  /** 管理者が決めた特別価格（円） */
  FIXED_PRICE: 'fixed_price',
  /** 無料 */
  FREE: 'free',
});

/**
 * 通常価格（円・税込表示）。正本は `/pricing/`。
 * ⚠️ 変更したら pricing.astro と**両方**直す（guard テストが突き合わせる）。
 */
export const REGULAR_PRICE = Object.freeze({
  light_monthly: 4980,
  premium_monthly: 18000,
  premium_annual: 49800,
  premium_lifetime: 78000,
});

/** 割引価格の下限（円）。これ未満は「実質無料」なので isFree の offer を使う */
export const MIN_OFFER_PRICE = 1000;

/** 管理者が入力できる任意日数の範囲 */
export const CUSTOM_DAYS_RANGE = Object.freeze({ min: 1, max: MAX_GRANT_DAYS });

/**
 * カタログ。**offer を増やすときはここだけ**を編集する。
 *
 * 共通フィールド:
 *   offerId / name / description / kind / targetTier / term /
 *   duration（日数。term='days' のときだけ意味を持つ）/ isLifetime /
 *   regularPrice / offerPrice / discountType / discountValue / isFree /
 *   requiresCustomDays / requiresCustomPrice / enabled / version
 */
export const PROMOTION_OFFERS = Object.freeze([
  // ── Light（メイン買い目のみ閲覧できる独立プラン。カムバックのベース特典）──
  {
    offerId: 'light-lifetime-free',
    name: 'Light 永久無料',
    description: 'Light プランを期限なしで無料開放する。今回のカムバック施策のベース特典。',
    kind: OFFER_KIND.GRANT,
    targetTier: PROMO_TIER.LIGHT,
    term: BILLING_TERM.LIFETIME,
    duration: null,
    isLifetime: true,
    regularPrice: REGULAR_PRICE.light_monthly,
    offerPrice: 0,
    discountType: DISCOUNT_TYPE.FREE,
    discountValue: 100,
    isFree: true,
    version: 1,
    enabled: true,
  },
  {
    offerId: 'light-30d-free',
    name: 'Light 30日無料',
    description: 'Light プランを 30 日間無料開放する。',
    kind: OFFER_KIND.GRANT,
    targetTier: PROMO_TIER.LIGHT,
    term: BILLING_TERM.DAYS,
    duration: 30,
    isLifetime: false,
    regularPrice: REGULAR_PRICE.light_monthly,
    offerPrice: 0,
    discountType: DISCOUNT_TYPE.FREE,
    discountValue: 100,
    isFree: true,
    version: 1,
    enabled: true,
    /**
     * カムバック施策としての宣言（`entitlements/comebackPolicy.js` が読む唯一の入力）。
     * **この block を書くだけ**で、管理画面の対象区分・退会者への可否・付与・
     * ログイン権限・案内メールの引き継ぎがすべて揃う。コード修正は要らない。
     */
    comeback: {
      audienceSegments: ['expired', 'withdrawn'],
      allowWithdrawn: true,
      grantTier: 'light',
      durationDays: 30,
      campaignId: 'comeback-light-30d-granted',
      campaignVersion: 2,
      requiresSuccessfulGrant: true,
      restoresPaidContract: false,
      preserveWithdrawalRequested: true,
      allowedEntitlements: ['light'],
      forbiddenEntitlements: ['premium', 'sanrenpuku', 'purchase'],
    },
  },
  {
    offerId: 'light-90d-free',
    name: 'Light 90日無料',
    description: 'Light プランを 90 日間無料開放する。',
    kind: OFFER_KIND.GRANT,
    targetTier: PROMO_TIER.LIGHT,
    term: BILLING_TERM.DAYS,
    duration: 90,
    isLifetime: false,
    regularPrice: REGULAR_PRICE.light_monthly,
    offerPrice: 0,
    discountType: DISCOUNT_TYPE.FREE,
    discountValue: 100,
    isFree: true,
    version: 1,
    enabled: true,
  },
  {
    offerId: 'light-custom-free',
    name: 'Light 任意期限 無料',
    description: '管理者が指定した日数だけ Light を無料開放する。',
    kind: OFFER_KIND.GRANT,
    targetTier: PROMO_TIER.LIGHT,
    term: BILLING_TERM.DAYS,
    duration: null,
    isLifetime: false,
    regularPrice: REGULAR_PRICE.light_monthly,
    offerPrice: 0,
    discountType: DISCOUNT_TYPE.FREE,
    discountValue: 100,
    isFree: true,
    requiresCustomDays: true,
    version: 1,
    enabled: true,
  },

  // ── Premium（Light の上に追加で乗る上位オファー）: 無料付与 ──
  {
    offerId: 'premium-30d-free',
    name: 'Premium 30日無料',
    description: 'Premium を 30 日間無料開放する。終了後は他に有効な権利（Light 等）が残る。',
    kind: OFFER_KIND.GRANT,
    targetTier: PROMO_TIER.PREMIUM,
    term: BILLING_TERM.DAYS,
    duration: 30,
    isLifetime: false,
    regularPrice: REGULAR_PRICE.premium_monthly,
    offerPrice: 0,
    discountType: DISCOUNT_TYPE.FREE,
    discountValue: 100,
    isFree: true,
    version: 1,
    enabled: true,
  },
  {
    offerId: 'premium-custom-days-free',
    name: 'Premium 任意期間 無料',
    description: '管理者が指定した日数だけ Premium を無料開放する。',
    kind: OFFER_KIND.GRANT,
    targetTier: PROMO_TIER.PREMIUM,
    term: BILLING_TERM.DAYS,
    duration: null,
    isLifetime: false,
    regularPrice: REGULAR_PRICE.premium_monthly,
    offerPrice: 0,
    discountType: DISCOUNT_TYPE.FREE,
    discountValue: 100,
    isFree: true,
    requiresCustomDays: true,
    version: 1,
    enabled: true,
  },
  {
    offerId: 'premium-annual-free',
    name: 'Premium 年間 無料（365日）',
    description: 'Premium を 365 日間無料開放する。課金は発生しない（年額契約とは別物）。',
    kind: OFFER_KIND.GRANT,
    targetTier: PROMO_TIER.PREMIUM,
    term: BILLING_TERM.DAYS,
    duration: 365,
    isLifetime: false,
    regularPrice: REGULAR_PRICE.premium_annual,
    offerPrice: 0,
    discountType: DISCOUNT_TYPE.FREE,
    discountValue: 100,
    isFree: true,
    version: 1,
    enabled: true,
  },
  {
    offerId: 'premium-lifetime-free',
    name: 'Premium 買い切り相当 無料（無期限）',
    description: 'Premium を無期限で無料開放する。⚠️ 事実上の永久 Premium。慎重に使うこと。',
    kind: OFFER_KIND.GRANT,
    targetTier: PROMO_TIER.PREMIUM,
    term: BILLING_TERM.LIFETIME,
    duration: null,
    isLifetime: true,
    regularPrice: REGULAR_PRICE.premium_lifetime,
    offerPrice: 0,
    discountType: DISCOUNT_TYPE.FREE,
    discountValue: 100,
    isFree: true,
    version: 1,
    enabled: true,
  },

  // ── Premium: 割引購入条件（権限は付与しない）──
  {
    offerId: 'premium-30d-half',
    name: 'Premium 30日 50%OFF',
    description: '通常 ¥18,000/30日 を半額で購入できる、その顧客専用のオファー。',
    kind: OFFER_KIND.PURCHASE,
    targetTier: PROMO_TIER.PREMIUM,
    term: BILLING_TERM.MONTHLY,
    duration: null,
    isLifetime: false,
    regularPrice: REGULAR_PRICE.premium_monthly,
    offerPrice: null, // discountType から算出
    discountType: DISCOUNT_TYPE.PERCENT,
    discountValue: 50,
    isFree: false,
    version: 1,
    enabled: true,
  },
  {
    offerId: 'premium-annual-half',
    name: 'Premium 年額 50%OFF',
    description: '通常 ¥49,800/年 を半額で購入できる、その顧客専用のオファー。',
    kind: OFFER_KIND.PURCHASE,
    targetTier: PROMO_TIER.PREMIUM,
    term: BILLING_TERM.ANNUAL,
    duration: null,
    isLifetime: false,
    regularPrice: REGULAR_PRICE.premium_annual,
    offerPrice: null,
    discountType: DISCOUNT_TYPE.PERCENT,
    discountValue: 50,
    isFree: false,
    version: 1,
    enabled: true,
  },
  {
    offerId: 'premium-annual-custom',
    name: 'Premium 年額 任意価格',
    description: '管理者が指定した価格で年額 Premium を購入できるオファー。',
    kind: OFFER_KIND.PURCHASE,
    targetTier: PROMO_TIER.PREMIUM,
    term: BILLING_TERM.ANNUAL,
    duration: null,
    isLifetime: false,
    regularPrice: REGULAR_PRICE.premium_annual,
    offerPrice: null,
    discountType: DISCOUNT_TYPE.FIXED_PRICE,
    discountValue: null,
    isFree: false,
    requiresCustomPrice: true,
    version: 1,
    enabled: true,
  },
  {
    offerId: 'premium-lifetime-half',
    name: 'Premium 買い切り 50%OFF',
    description: '通常 ¥78,000 の買い切り Premium（PlanType=Lifetime）を半額で購入できるオファー。',
    kind: OFFER_KIND.PURCHASE,
    targetTier: PROMO_TIER.PREMIUM,
    term: BILLING_TERM.LIFETIME,
    duration: null,
    isLifetime: false, // ← 購入条件であって無料付与ではない（権利は支払い後）
    regularPrice: REGULAR_PRICE.premium_lifetime,
    offerPrice: null,
    discountType: DISCOUNT_TYPE.PERCENT,
    discountValue: 50,
    isFree: false,
    version: 1,
    enabled: true,
  },
  {
    offerId: 'premium-lifetime-custom',
    name: 'Premium 買い切り 任意価格',
    description: '管理者が指定した価格で買い切り Premium を購入できるオファー。',
    kind: OFFER_KIND.PURCHASE,
    targetTier: PROMO_TIER.PREMIUM,
    term: BILLING_TERM.LIFETIME,
    duration: null,
    isLifetime: false,
    regularPrice: REGULAR_PRICE.premium_lifetime,
    offerPrice: null,
    discountType: DISCOUNT_TYPE.FIXED_PRICE,
    discountValue: null,
    isFree: false,
    requiresCustomPrice: true,
    version: 1,
    enabled: true,
  },
]);

const BY_ID = new Map(PROMOTION_OFFERS.map((o) => [o.offerId, o]));

/** offerId → 定義（未知 / 無効なら null。fail closed） */
export function getOfferDefinition(offerId, { includeDisabled = false } = {}) {
  const id = String(offerId ?? '').trim();
  if (!id) return null;
  const o = BY_ID.get(id);
  if (!o) return null;
  if (!includeDisabled && o.enabled !== true) return null;
  return o;
}

/** 一覧（管理画面のセレクト用。ティアで絞れる） */
export function listOffers({ tier, kind } = {}) {
  return PROMOTION_OFFERS
    .filter((o) => o.enabled === true)
    .filter((o) => !tier || o.targetTier === tier)
    .filter((o) => !kind || o.kind === kind)
    .map((o) => ({
      offerId: o.offerId,
      name: o.name,
      description: o.description,
      kind: o.kind,
      targetTier: o.targetTier,
      term: o.term,
      duration: o.duration,
      isLifetime: o.isLifetime,
      isFree: o.isFree,
      regularPrice: o.regularPrice,
      discountType: o.discountType,
      discountValue: o.discountValue,
      requiresCustomDays: o.requiresCustomDays === true,
      requiresCustomPrice: o.requiresCustomPrice === true,
      /** カムバック施策の宣言（解釈は `entitlements/comebackPolicy.js`） */
      comeback: o.comeback || null,
      version: o.version,
    }));
}

/** 割引後の価格を求める（円・1 円未満切り上げはしない＝10 円単位に丸めない素の値） */
export function computeOfferPrice({ regularPrice, discountType, discountValue, customPrice }) {
  const base = Number(regularPrice);
  if (!Number.isFinite(base) || base < 0) return null;
  switch (discountType) {
    case DISCOUNT_TYPE.FREE:
      return 0;
    case DISCOUNT_TYPE.PERCENT: {
      const pct = Number(discountValue);
      if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return null;
      // 円未満を切り捨てる（請求額は整数円）
      return Math.floor(base * (100 - pct) / 100);
    }
    case DISCOUNT_TYPE.AMOUNT: {
      const off = Number(discountValue);
      if (!Number.isFinite(off) || off <= 0 || off >= base) return null;
      return base - off;
    }
    case DISCOUNT_TYPE.FIXED_PRICE: {
      const p = Number(customPrice ?? discountValue);
      if (!Number.isInteger(p)) return null;
      return p;
    }
    case DISCOUNT_TYPE.NONE:
      return base;
    default:
      return null;
  }
}

/**
 * offer 定義 + 管理者入力 → **正規化した 1 つの offer**（呼び出し側はこれだけを見る）。
 *
 * ここで全部検証する（fail closed）:
 *   - 任意日数は 1〜MAX_GRANT_DAYS の整数
 *   - 任意価格は整数かつ MIN_OFFER_PRICE 以上・通常価格未満（値上げ・0 円を防ぐ）
 *   - 割引 offer は必ず offerPrice > 0（無料にしたいなら GRANT の offer を使う）
 *
 * @param {string} offerId
 * @param {{ customDays?: number, customPrice?: number }} [input]
 * @returns {{ ok: true, offer: object }|{ ok: false, error: string }}
 */
export function resolveOffer(offerId, input = {}) {
  const def = getOfferDefinition(offerId);
  if (!def) return { ok: false, error: 'unknown_offer' };

  let duration = def.duration;
  if (def.requiresCustomDays) {
    const d = Number(input.customDays);
    if (!Number.isInteger(d) || d < CUSTOM_DAYS_RANGE.min || d > CUSTOM_DAYS_RANGE.max) {
      return { ok: false, error: 'invalid_custom_days' };
    }
    duration = d;
  }

  let offerPrice;
  if (def.kind === OFFER_KIND.GRANT) {
    offerPrice = 0; // 無料付与に価格は無い
  } else {
    if (def.requiresCustomPrice) {
      const p = Number(input.customPrice);
      if (!Number.isInteger(p)) return { ok: false, error: 'invalid_custom_price' };
      if (p < MIN_OFFER_PRICE) return { ok: false, error: 'price_too_low' };
      if (p >= def.regularPrice) return { ok: false, error: 'price_not_discounted' };
      offerPrice = p;
    } else {
      const computed = computeOfferPrice({
        regularPrice: def.regularPrice,
        discountType: def.discountType,
        discountValue: def.discountValue,
      });
      if (computed === null) return { ok: false, error: 'invalid_discount' };
      offerPrice = computed;
    }
    // 割引 offer が 0 円になってはいけない（無料は GRANT 側の責務）
    if (!Number.isInteger(offerPrice) || offerPrice < MIN_OFFER_PRICE) {
      return { ok: false, error: 'price_too_low' };
    }
    if (offerPrice >= def.regularPrice) return { ok: false, error: 'price_not_discounted' };
  }

  const discountAmount = def.kind === OFFER_KIND.PURCHASE ? def.regularPrice - offerPrice : def.regularPrice;
  const discountPercent = def.regularPrice > 0
    ? Math.round((discountAmount / def.regularPrice) * 100) : 0;

  return {
    ok: true,
    offer: {
      offerId: def.offerId,
      version: def.version,
      name: def.name,
      description: def.description,
      kind: def.kind,
      targetTier: def.targetTier,
      term: def.term,
      /** 無料付与の日数（term='days' のときのみ）。無期限なら null */
      duration,
      durationUnit: def.term === BILLING_TERM.DAYS ? 'days' : def.term,
      isLifetime: def.isLifetime === true,
      isFree: def.kind === OFFER_KIND.GRANT,
      regularPrice: def.regularPrice,
      offerPrice,
      discountType: def.discountType,
      discountValue: def.discountValue,
      discountAmount,
      discountPercent,
      /** 購入条件のときだけ意味を持つ（既存 bank flow の語彙） */
      planType: def.kind === OFFER_KIND.PURCHASE ? (TERM_TO_PLAN_TYPE[def.term] || null) : null,
      planName: def.kind === OFFER_KIND.PURCHASE ? (TERM_TO_PLAN_NAME[def.term] || null) : null,
      /**
       * カムバック施策の宣言（あれば）。判定は `entitlements/comebackPolicy.js` に集約し、
       * ここでは**定義をそのまま渡すだけ**（解釈しない）。
       */
      comeback: def.comeback || null,
    },
  };
}

/** 管理画面・メール本文で使う短い説明（金額と期間を必ず含める） */
export function describeOffer(offer) {
  if (!offer) return '';
  const tier = offer.targetTier === PROMO_TIER.LIGHT ? 'Light' : 'Premium';
  if (offer.kind === OFFER_KIND.GRANT) {
    return offer.isLifetime ? `${tier} 永久無料` : `${tier} ${offer.duration}日間 無料`;
  }
  const term = offer.term === BILLING_TERM.LIFETIME ? '買い切り'
    : (offer.term === BILLING_TERM.ANNUAL ? '年額' : '30日');
  const off = offer.discountPercent > 0 ? `（${offer.discountPercent}%OFF）` : '';
  return `${tier} ${term} ¥${offer.regularPrice.toLocaleString('en-US')} → ¥${offer.offerPrice.toLocaleString('en-US')}${off}`;
}

export default PROMOTION_OFFERS;
