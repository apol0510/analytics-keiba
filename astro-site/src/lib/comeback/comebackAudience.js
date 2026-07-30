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
import { checkGrantable, describeCustomerState, CB_SKIP } from './comebackGrantPlan.js';

/** 特典の保有状態（絞り込み用） */
export const CB_PROMO_FILTER = Object.freeze({
  ALL: 'all',
  NONE: 'none',
  ANY: 'any',
  LIGHT: 'light_lifetime',
  TRIAL_ACTIVE: 'trial_active',
  TRIAL_EXPIRED: 'trial_expired',
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
  const state = describeCustomerState(f, now);

  return {
    marketing,
    grants,
    /** 特典を付与できるか（停止・退会・データ不備は付与しても使えないので false） */
    grantable: grantable.ok,
    grantBlockedReason: grantable.reason,
    stateText: state.text,
    paidText: state.paid,
    promoText: describeGrantState(grants),
    promoLight: grants.lightLifetime.active,
    promoTrialActive: grants.premiumTrial.active,
    promoTrialExpired: grants.premiumTrial.expired,
    promoInconsistent: grants.lightLifetime.inconsistent || grants.premiumTrial.inconsistent,
    grantSource: grants.source,
    grantOperationIds: [grants.lightLifetime.operationId, grants.premiumTrial.operationId].filter(Boolean),
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
    if (f.promo === CB_PROMO_FILTER.NONE && (c.promoLight || c.promoTrialActive)) return false;
    if (f.promo === CB_PROMO_FILTER.ANY && !(c.promoLight || c.promoTrialActive)) return false;
    if (f.promo === CB_PROMO_FILTER.LIGHT && !c.promoLight) return false;
    if (f.promo === CB_PROMO_FILTER.TRIAL_ACTIVE && !c.promoTrialActive) return false;
    if (f.promo === CB_PROMO_FILTER.TRIAL_EXPIRED && !c.promoTrialExpired) return false;
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
    promo: { none: 0, light: 0, trialActive: 0, trialExpired: 0, inconsistent: 0 },
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
    if (c.promoLight) counts.promo.light += 1;
    if (c.promoTrialActive) counts.promo.trialActive += 1;
    if (c.promoTrialExpired) counts.promo.trialExpired += 1;
    if (c.promoInconsistent) counts.promo.inconsistent += 1;
    if (!c.promoLight && !c.promoTrialActive) counts.promo.none += 1;
  }
  return counts;
}

export default resolveComebackCustomer;
