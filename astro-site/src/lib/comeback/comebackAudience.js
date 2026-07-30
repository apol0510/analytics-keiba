/**
 * comebackAudience.js — カムバック特典タブの顧客一覧・絞り込み（純粋・I/O なし）
 *
 * 契約状態・プラン・退会・送信履歴の判定は **既存の単一源をそのまま再利用**する
 * （`marketing/customerMarketingAudience.js`）。ここで再実装しない。
 * このモジュールが足すのは「特典の状態」と「特典を付与できるか」だけ。
 *
 * ⚠️ マーケティング（メール）と特典（権限）は別機能。母集団の作り方が似ていても
 *    **判定を混ぜない**: 送信可否（unsubscribe / bounce）は特典付与の条件にしない。
 *    配信停止した顧客にも特典は付けられる（メールを送らないだけ）。
 */

import { resolveCustomerMarketing, matchesMarketingFilter } from '../marketing/customerMarketingAudience.js';
import { resolvePromotionalGrants, describeGrantState } from '../entitlements/promotionalGrants.js';
import { checkGrantable, checkOfferable, describeCustomerState, CB_SKIP } from './comebackGrantPlan.js';

/** 特典の保有状態（絞り込み用） */
export const CB_PROMO_FILTER = Object.freeze({
  ALL: 'all',
  NONE: 'none',
  ANY: 'any',
  /** Light 無料権利あり（期限付き・無期限を問わない） */
  LIGHT: 'light',
  /** Light 永久無料 */
  LIGHT_LIFETIME: 'light_lifetime',
  /** Premium 無料権利あり */
  PREMIUM: 'premium',
  /** Premium 無料権利が終了した */
  PREMIUM_ENDED: 'premium_ended',
  INCONSISTENT: 'inconsistent',
});

/** 付与可否（絞り込み用） */
export const CB_GRANTABLE_FILTER = Object.freeze({
  ALL: 'all',
  GRANTABLE: 'grantable',
  BLOCKED: 'blocked',
});

/**
 * 1 顧客の「カムバック特典タブ」表示行を作る（read-only）。
 *
 * @param {{ fields: object, nowMs: number, blacklistEmails?: Set<string>, history?: object }} input
 */
export function resolveComebackCustomer({ fields, nowMs, blacklistEmails, history } = {}) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  const marketing = resolveCustomerMarketing({ fields: f, nowMs: now, blacklistEmails, history });
  const grants = resolvePromotionalGrants(f, now);
  const grantable = checkGrantable(f);
  const offerable = checkOfferable(f);
  const state = describeCustomerState(f, now);

  return {
    marketing,
    grants,
    /** 無料付与できるか（停止・退会・データ不備は付与しても使えないので false） */
    grantable: grantable.ok,
    grantBlockedReason: grantable.reason,
    /** 割引オファーを発行できるか（退会者にも発行可。支払い時に既存フローが復帰させる） */
    offerable: offerable.ok,
    offerBlockedReason: offerable.reason,
    stateText: state.text,
    paidText: state.paid,
    effectiveTier: state.effectiveTier,
    promoText: describeGrantState(grants),
    promoLight: grants.light.active,
    promoLightLifetime: grants.light.lifetime,
    promoPremium: grants.premium.active,
    promoPremiumEnded: grants.premium.expired,
    promoInconsistent: grants.inconsistent,
    grantSource: grants.source,
    grantOperationIds: [grants.light.operationId, grants.premium.operationId].filter(Boolean),
  };
}

/**
 * 絞り込み（すべて AND / 未指定は素通し）。
 * 契約・プラン・送信履歴は既存の marketing フィルタへ委譲する。
 *
 * @param {object} c resolveComebackCustomer の戻り値
 * @param {{ contract?, plan?, history?, withdrawn?, promo?, grantable? }} filter
 */
export function matchesComebackFilter(c, filter = {}) {
  if (!c) return false;
  const f = filter || {};
  if (!matchesMarketingFilter(c.marketing, { contract: f.contract, plan: f.plan, history: f.history })) {
    return false;
  }
  if (f.withdrawn && f.withdrawn !== 'all') {
    const yes = c.marketing.withdrawn === true;
    if (f.withdrawn === 'yes' && !yes) return false;
    if (f.withdrawn === 'no' && yes) return false;
  }
  if (f.promo && f.promo !== CB_PROMO_FILTER.ALL) {
    const hasAny = c.promoLight || c.promoPremium;
    if (f.promo === CB_PROMO_FILTER.NONE && hasAny) return false;
    if (f.promo === CB_PROMO_FILTER.ANY && !hasAny) return false;
    if (f.promo === CB_PROMO_FILTER.LIGHT && !c.promoLight) return false;
    if (f.promo === CB_PROMO_FILTER.LIGHT_LIFETIME && !c.promoLightLifetime) return false;
    if (f.promo === CB_PROMO_FILTER.PREMIUM && !c.promoPremium) return false;
    if (f.promo === CB_PROMO_FILTER.PREMIUM_ENDED && !c.promoPremiumEnded) return false;
    if (f.promo === CB_PROMO_FILTER.INCONSISTENT && !c.promoInconsistent) return false;
  }
  if (f.grantable && f.grantable !== CB_GRANTABLE_FILTER.ALL) {
    if (f.grantable === CB_GRANTABLE_FILTER.GRANTABLE && !c.grantable) return false;
    if (f.grantable === CB_GRANTABLE_FILTER.BLOCKED && c.grantable) return false;
  }
  return true;
}

/** 一覧全体のサマリ（PII を含まない件数だけ） */
export function summarizeComeback(list) {
  const counts = {
    total: 0,
    contract: {},
    plan: {},
    withdrawn: 0,
    grantable: 0,
    blocked: {},
    offerable: 0,
    promo: { none: 0, light: 0, lightLifetime: 0, premium: 0, premiumEnded: 0, inconsistent: 0 },
  };
  for (const c of list || []) {
    counts.total += 1;
    const m = c.marketing;
    counts.contract[m.contract] = (counts.contract[m.contract] || 0) + 1;
    counts.plan[m.plan] = (counts.plan[m.plan] || 0) + 1;
    if (m.withdrawn) counts.withdrawn += 1;
    if (c.grantable) counts.grantable += 1;
    else counts.blocked[c.grantBlockedReason || CB_SKIP.DATA_INCOMPLETE] =
      (counts.blocked[c.grantBlockedReason || CB_SKIP.DATA_INCOMPLETE] || 0) + 1;
    if (c.offerable) counts.offerable += 1;
    if (c.promoLight) counts.promo.light += 1;
    if (c.promoLightLifetime) counts.promo.lightLifetime += 1;
    if (c.promoPremium) counts.promo.premium += 1;
    if (c.promoPremiumEnded) counts.promo.premiumEnded += 1;
    if (c.promoInconsistent) counts.promo.inconsistent += 1;
    if (!c.promoLight && !c.promoPremium) counts.promo.none += 1;
  }
  return counts;
}

export default resolveComebackCustomer;
