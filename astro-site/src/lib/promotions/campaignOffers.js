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

// ── 開催期間 ────────────────────────────────────────────────
//
// ⚠️ **期間外は 1 円も割り引かない**（fail closed）。
//    「案内は出ているのに割引が乗らない」より、「割引が乗るのに案内が無い」より、
//    **期間を 1 か所で持って両方を同じ値から出す**のが唯一の安全な形。
//
// 開始日は MK 確定（2026-08-24 開始・14 日間）。終わらせるときは `ENDS_AT` を過去にする。
export const CAMPAIGN_WINDOW = Object.freeze({
  startsAtIso: '2026-08-24T00:00:00+09:00',
  /** 開始 + 14 日（JST の 24日 0:00 から 9月7日 0:00 まで） */
  endsAtIso: '2026-09-07T00:00:00+09:00',
});

/** いまキャンペーン期間内か。日付が壊れていたら false（＝割り引かない） */
export function isCampaignActive(nowMs = Date.now()) {
  const s = Date.parse(CAMPAIGN_WINDOW.startsAtIso);
  const e = Date.parse(CAMPAIGN_WINDOW.endsAtIso);
  if (!Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(nowMs)) return false;
  return nowMs >= s && nowMs < e;
}

/** 期限の表示（画面・メールで同じ文字列を使う） */
export function describeCampaignDeadline() {
  const e = new Date(Date.parse(CAMPAIGN_WINDOW.endsAtIso) - 1);
  const jst = new Date(e.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}年${jst.getUTCMonth() + 1}月${jst.getUTCDate()}日まで`;
}

/**
 * 申込に割引を乗せてよいかを決める（**サーバーの唯一の判定**）。
 *
 * ⚠️ クライアントが送ってきた金額は判定材料にしない。
 *    申込プラン（`planName` / `planType`）と**会員の実データ**だけで決める。
 * ⚠️ 該当しないときは `applied: false` を返し、呼び出し側は通常価格のまま進む。
 *
 * @param {{ planName?: string, planType?: string,
 *           entitlements?: object, nowMs?: number }} input
 * @returns {{ applied: boolean, reason: string,
 *             offerId?: string, name?: string,
 *             regularPrice?: number, finalPrice?: number, discount?: number }}
 */
export function resolveCampaignPricing({
  planName, planType, entitlements, nowMs = Date.now(),
  /** 運営の停止スイッチ・個別除外（`campaignControl.js` の判定結果）*/
  allowed,
} = {}) {
  const no = (reason) => ({ applied: false, reason });
  // ⚠️ 運営が止めている / 対象外 / 確認できない → **1 円も割り引かない**
  if (allowed && allowed.allowed !== true) return no(allowed.reason || 'blocked');
  if (!isCampaignActive(nowMs)) return no('outside_window');

  const name = String(planName || '').trim();
  const type = String(planType || '').trim();
  if (!name) return no('no_plan');

  // この会員に案内してよい割引だけを候補にする（持っているものは勧めない）
  const eligibleIds = new Set(resolveCampaignOfferIdsFor(entitlements));
  if (!eligibleIds.size) return no('not_eligible');

  // ⚠️ 突き合わせは**申込 Function の語彙**（`RequestedPlan` / `RequestedPlanType`）で行う。
  //    あちらは productName を 'Premium' + 'Annual' のように 2 つへ分解するため、
  //    表示用の 'Premium Annual' と比べると**永久に一致しない**（実際に一致しなかった）。
  const hit = describeCampaignOffersFor(entitlements).find((o) => {
    if (!eligibleIds.has(o.offerId)) return false;
    if (String(o.applyPlanName || '') !== name) return false;
    // PlanType も一致させる（年額の割引で買い切りを買わせない）
    return !type || String(o.applyPlanType || '') === type;
  });
  if (!hit) return no('no_match');
  if (!Number.isFinite(hit.offerPrice) || hit.offerPrice <= 0) return no('invalid_price');

  return {
    applied: true,
    reason: '',
    offerId: hit.offerId,
    name: hit.name,
    regularPrice: hit.regularPrice,
    finalPrice: hit.offerPrice,
    discount: hit.regularPrice - hit.offerPrice,
  };
}

// ── 画面に出す形 ────────────────────────────────────────────
//
// ⚠️ 申込先は**商品ごとに違う**。Light / Premium は /pricing/、三連複は専用ページ。
//    ここで 1 か所に持ち、画面側でパスを組み立てない。
const APPLY_HREF = Object.freeze({
  [CAMPAIGN_OFFER_IDS.LIGHT_MONTHLY]: '/pricing/',
  [CAMPAIGN_OFFER_IDS.PREMIUM_ANNUAL]: '/pricing/',
  [CAMPAIGN_OFFER_IDS.PREMIUM_LIFETIME]: '/pricing/',
  [CAMPAIGN_OFFER_IDS.SANRENPUKU_MONTHLY]: '/premium-sanrenpuku/',
});

const yen = (n) => `¥${Number(n).toLocaleString('ja-JP')}`;

/**
 * マイページ・お知らせに出す形まで解いて返す（**文言と金額はここが作る**）。
 *
 * @returns {{ active: boolean, deadlineText: string, signature: string,
 *             offers: Array<{offerId,name,regularPriceText,offerPriceText,discountText,applyHref}> }}
 */
export function describeCampaignForMember({ entitlements, nowMs = Date.now(), allowed } = {}) {
  // ⚠️ 案内と適用は**同じ条件**で決める。案内だけ出て割引が乗らないと行き違いになる。
  const blocked = !!allowed && allowed.allowed !== true;
  const active = !blocked && isCampaignActive(nowMs);
  const offers = active
    ? describeCampaignOffersFor(entitlements).map((o) => ({
      offerId: o.offerId,
      name: o.name,
      regularPriceText: yen(o.regularPrice),
      offerPriceText: yen(o.offerPrice),
      discountText: `${Number(o.discountValue).toLocaleString('ja-JP')}円OFF`,
      applyHref: APPLY_HREF[o.offerId] || '/pricing/',
    }))
    : [];
  return {
    active,
    deadlineText: describeCampaignDeadline(),
    /**
     * お知らせの「新しさ」。開催期間と対象の組み合わせから決まるので、
     * **同じキャンペーンでは一度見たら出続けない**。
     */
    signature: offers.length
      ? `campaign:${CAMPAIGN_WINDOW.startsAtIso}:${offers.map((o) => o.offerId).join(',')}`
      : '',
    offers,
  };
}
