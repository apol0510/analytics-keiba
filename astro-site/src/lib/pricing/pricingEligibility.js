/**
 * pricingEligibility.js — 「会員向け価格を出してよいか」の単一源（純粋・I/O なし）
 *
 * ── 3 つを混同しない ─────────────────────────────────────────────
 *   A. promotional grant  無料で付与した**閲覧権**。価格資格は 1 ミリも増えない
 *   B. paid contract      通常購入した契約。**会員向け通常特価（乗り換え価格等）の唯一の根拠**
 *   C. promotional offer  その顧客専用の特別価格。`PromotionalOffers` で明示的に与える
 *
 * `/pricing/` の「Light 会員だけに出す乗り換え価格 ¥44,820」は **B 由来の価格資格**。
 * 無料 Light 特典（A）を持っているだけの顧客に自動で使わせない。
 * 無料特典の顧客へ特別価格を出したいときは **C（PromotionalOffer）で明示的に発行する**。
 *
 * ── なぜ閲覧権 tier と分けるのか ────────────────────────────────
 * `resolveEntitlements` の `effectiveTier` は「今どこまで見られるか」で、
 * 無料特典で上がる。これを価格の出し分けに流用すると
 * 「無料で Light を開放した顧客が、Light 契約者向けの割引で Premium を買える」
 * ことになり、A と B の分離が崩れる。価格資格はここで**課金契約だけ**から決める。
 */

import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { normalizePlan } from '../auth/planNormalization.js';
import { PLAN_TIER_BY_CANONICAL } from './planTiers.js';

/**
 * 失効後も Light 会員向けの乗り換え特典（¥44,820）を案内・適用する日数（2026-09-29 MK 確定）。
 *
 * 有効期限日 D（JST の暦日）に対し、**D+30 日の終わりまで**は Light 会員向け価格の資格を残す。
 * D+31 日以降は通常条件（会員向け価格なし）へ戻す。**無期限特典にはしない**。
 * 対象は**実際に Light を支払った人**（`PaidAt` がある有料 Light 契約）だけ。無料特典の Light は含めない。
 *
 * ⚠️ 表示（`/pricing/`）とサーバー側の購入条件（`checkMemberOnlyPricing`）は**どちらもこの値**を使う。
 */
export const LIGHT_SWITCH_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 価格の出し分けに使う tier（planTiers と同じ尺度。無料特典では上がらない） */
export const PRICING_TIER = Object.freeze({
  NONE: 0,
  LIGHT: PLAN_TIER_BY_CANONICAL.light,
  PREMIUM: PLAN_TIER_BY_CANONICAL.premium,
});

/**
 * 会員向け価格の出し分け tier を **課金契約だけ**から決める。
 *
 * - 有料 Premium 契約が有効 → premium
 * - 有料 Light 契約が有効   → light
 * - それ以外（無料 / 期限切れ / 退会 / 停止 / **無料特典のみ**）→ 0（出し分けなし＝通常価格）
 *
 * @param {object} entitlements `resolveEntitlements()` の戻り値
 * @returns {number}
 */
export function resolvePaidPricingTier(entitlements) {
  const e = entitlements || {};
  if (e.canLogin !== true) return PRICING_TIER.NONE;
  // ⚠️ canViewPremium / canViewLight（無料特典で true になる）を使わない
  if (e.paidPremiumActive === true) return PRICING_TIER.PREMIUM;
  if (e.paidLightActive === true) return PRICING_TIER.LIGHT;
  return PRICING_TIER.NONE;
}

/** 有効期限の終わり（ms）。'YYYY-MM-DD' は JST のその日の終わり。解釈できなければ null */
export function expiryEndMs(expiresAt) {
  if (expiresAt === undefined || expiresAt === null || expiresAt === '') return null;
  const s = String(expiresAt).trim();
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T23:59:59.999+09:00`) : Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 失効後 30 日以内の**有料** Light 会員か（乗り換え特典の猶予）。
 *
 * - プランが Light（旧 Standard 含む）で、`PaidAt` がある（実際に支払った）
 * - ログインできるアカウント（停止・テスト・強制ログアウト等ではない）で、入金待ち（pending）ではない
 * - 有効ではなく（期限切れ）、期限日の終わりから `LIGHT_SWITCH_GRACE_DAYS` 日以内（D+30 日の終わりまで）
 */
export function isWithinLightSwitchGrace(fields, nowMs = Date.now()) {
  const f = fields || {};
  if (normalizePlan(f['プラン'] ?? f.Plan) !== 'light') return false;
  if (!f.PaidAt || String(f.PaidAt).trim() === '') return false;
  const e = resolveEntitlements(fromAirtableFields(f), nowMs);
  if (e.canLogin !== true) return false;
  if (Array.isArray(e.reasons) && e.reasons.includes('PENDING')) return false;
  if (e.paidLightActive === true) return false; // まだ有効（猶予ではなく通常の Light 会員）
  const end = expiryEndMs(f['有効期限'] ?? f.ValidUntil ?? f.ExpiryDate ?? f.ExpirationDate);
  if (end === null) return false;
  // ⚠️ 期限日 D 当日は既存の判定で既に「期限切れ」になる時間帯がある（日付のみの値の解釈差）。
  //    D 当日を含めて「有効でない ∧ D の終わり + 30 日以内」を猶予とし、隙間を作らない。
  return nowMs <= end + LIGHT_SWITCH_GRACE_DAYS * DAY_MS;
}

/** Airtable の Customers fields から直接求める（サーバー側の入口） */
export function resolvePaidPricingTierFromFields(fields, nowMs = Date.now()) {
  const tier = resolvePaidPricingTier(resolveEntitlements(fromAirtableFields(fields || {}), nowMs));
  if (tier > PRICING_TIER.NONE) return tier;
  // 2026-09-29 MK 確定: 失効後 30 日以内の有料 Light 会員には Light 会員向け価格の資格を残す
  return isWithinLightSwitchGrace(fields, nowMs) ? PRICING_TIER.LIGHT : PRICING_TIER.NONE;
}

/**
 * 会員限定の特別価格（`/pricing/` の「乗り換え特典価格」）で申し込まれたか。
 *
 * 判定は申込フォームが送ってくる `productName` の `- Campaign` サフィックス。
 * この値は `pricing.astro` の `openBankModal('Premium Annual - Campaign', 44820, 'annual')`
 * が付けるもので、`bank-transfer-application` が既に同じ文字列を剥がしてプラン名にしている。
 *
 * @param {string} productName
 * @returns {boolean}
 */
export function isMemberOnlyCampaignProduct(productName) {
  return /-\s*Campaign\b/i.test(String(productName || ''));
}

/**
 * 会員限定価格の申込が、**課金契約に裏づけられているか**をサーバー側で再判定する。
 *
 * ⚠️ 判定が false でも申込を拒否しない。フォームは「振込完了の報告」であり、
 *    既に送金済みの人を締め出すと事故になる。代わりに管理者へ警告を出し、
 *    MK が入金確認（PaymentConfirmed）の前に判断できるようにする。
 *    ここでは Airtable を 1 バイトも書かない。
 *
 * @param {{ productName: string, fields: object|null, nowMs?: number }} input
 * @returns {{ memberOnly: boolean, eligible: boolean, tier: number, warning: string|null }}
 */
export function checkMemberOnlyPricing({ productName, fields, nowMs = Date.now() }) {
  const memberOnly = isMemberOnlyCampaignProduct(productName);
  if (!memberOnly) return { memberOnly: false, eligible: true, tier: PRICING_TIER.NONE, warning: null };

  // レコードが見つからない（新規）＝ 会員向け価格の資格は無い
  const tier = fields ? resolvePaidPricingTierFromFields(fields, nowMs) : PRICING_TIER.NONE;
  const eligible = tier >= PRICING_TIER.LIGHT;
  return {
    memberOnly: true,
    eligible,
    tier,
    warning: eligible ? null
      : '会員限定の乗り換え特典価格での申込ですが、有料 Light / Premium 契約が確認できません'
        + '（無料特典のみ・期限切れ・新規の可能性）。入金確認の前に金額と対象をご確認ください。',
  };
}
