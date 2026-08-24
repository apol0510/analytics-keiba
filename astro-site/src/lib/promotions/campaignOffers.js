/**
 * campaignOffers.js — 「この会員にどのキャンペーン割引を出すか」の単一源（純粋・I/O なし）
 *
 * ## 確定した中身（2026-08-24 MK）
 *
 * | いまのご契約 | ご案内する割引 |
 * |---|---|
 * | 無料 | Light 月額 **500円OFF** / Premium 年額 **5,000円OFF** / Premium 買い切り **10,000円OFF** |
 * | Light | Premium 年額 **5,000円OFF** / Premium 買い切り **10,000円OFF** |
 * | Premium（三連複なし）| Premium Sanrenpuku **5,000円OFF** |
 * | 三連複あり | なし（最上位のため） |
 *
 * ⚠️ **Premium 月額は対象外**（MK 判断）。毎月続くので割引の影響が大きい。
 * ⚠️ **すでに持っているものは勧めない。** Light の方に Light 割引を出さない、
 *    Premium の方に Premium 割引を出さない。持っている人に売り込むと不信になる。
 * ⚠️ どれも権限を付与しない（`OFFER_KIND.PURCHASE`）。**割って買えるだけ**。
 * ⚠️ 期限は付与時に決まる（14 日）。ここは日付を持たない。
 */

import { PROMOTION_OFFERS, OFFER_KIND, resolveOffer } from './promotionOfferCatalog.js';

/** キャンペーンの offerId（**この 4 つだけ**。増やすときはカタログとここを両方直す） */
export const CAMPAIGN_OFFER_IDS = Object.freeze({
  LIGHT_MONTHLY: 'campaign-light-monthly-500off',
  PREMIUM_ANNUAL: 'campaign-premium-annual-5000off',
  PREMIUM_LIFETIME: 'campaign-premium-lifetime-10000off',
  SANRENPUKU_MONTHLY: 'campaign-sanrenpuku-monthly-5000off',
});

/** キャンペーン割引の利用期限（日）。再募集クーポンと同じ 14 日（MK 確定） */
export const CAMPAIGN_OFFER_DAYS = 14;

const IDS = new Set(Object.values(CAMPAIGN_OFFER_IDS));

/** その offerId がこのキャンペーンのものか（他の offer と混ぜないための判定） */
export function isCampaignOffer(offerId) {
  return IDS.has(String(offerId || ''));
}

/** キャンペーン割引の定義だけを返す（カタログの並び順を保つ） */
export function listCampaignOffers() {
  return PROMOTION_OFFERS.filter((o) => IDS.has(o.offerId) && o.enabled !== false);
}

/**
 * いまのご契約から、案内してよい割引の offerId を決める。
 *
 * @param {{ canViewPremium?: boolean, canViewSanrenpuku?: boolean,
 *           canViewLight?: boolean, canLogin?: boolean }} entitlements
 *   `resolveEntitlements()` の戻り値
 * @returns {string[]} offerId（案内する順）
 */
export function resolveCampaignOfferIdsFor(entitlements) {
  const e = entitlements || {};
  // 三連複を見られる方は最上位。売るものが無い
  if (e.canViewSanrenpuku === true) return [];
  // Premium を見られる方には三連複だけを案内する
  if (e.canViewPremium === true) return [CAMPAIGN_OFFER_IDS.SANRENPUKU_MONTHLY];

  const out = [];
  // Light をお持ちでない方には Light も案内する（持っている方には出さない）
  if (e.canViewLight !== true) out.push(CAMPAIGN_OFFER_IDS.LIGHT_MONTHLY);
  out.push(CAMPAIGN_OFFER_IDS.PREMIUM_ANNUAL, CAMPAIGN_OFFER_IDS.PREMIUM_LIFETIME);
  return out;
}

/**
 * 画面・メールに出す形まで解いて返す（文言と金額は**ここが作る**）。
 * ⚠️ 画面側で「◯◯円OFF」を組み立てないこと。
 */
export function describeCampaignOffersFor(entitlements) {
  return resolveCampaignOfferIdsFor(entitlements)
    .map((id) => resolveOffer(id))
    .filter((r) => r && r.ok)
    .map((r) => r.offer)
    // 念のため：付与（権限を渡す）が混ざっていないことを構造で保証する
    .filter((o) => o.kind === OFFER_KIND.PURCHASE);
}

/** 案内の 1 行（例: 「Premium 年額 5,000円OFF（¥49,800 → ¥44,800）」） */
export function describeCampaignOfferLine(offer) {
  const o = offer || {};
  const yen = (n) => `¥${Number(n).toLocaleString('ja-JP')}`;
  if (!Number.isFinite(o.regularPrice) || !Number.isFinite(o.offerPrice)) return String(o.name || '');
  return `${o.name}（${yen(o.regularPrice)} → ${yen(o.offerPrice)}）`;
}
