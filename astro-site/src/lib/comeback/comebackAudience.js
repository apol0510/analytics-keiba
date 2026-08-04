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
import {
  resolveCurrentFreeGrant, resolveFreeGrantHistory, formatFreeGrantSummary,
  matchesFreeGrantNow, matchesFreeGrantHistory,
} from '../entitlements/freeGrantStatus.js';
import {
  resolveGrantEligibility, formatGrantEligibility, matchesGrantEligibility,
} from '../entitlements/grantEligibility.js';
import { classifyComebackSegment, SEGMENT } from '../entitlements/comebackAudience.js';
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
 * `allowWithdrawn` は**選んでいる特典がカムバックの Light 30 日無料のときだけ** true。
 * 判断の単一源は `comebackWithdrawnPolicy.isWithdrawnGrantAllowed` で、ここは受け取るだけ。
 * 既定 false なので、指定しなければ従来どおり退会者は「付与不可」と表示される。
 *
 * @param {{ fields: object, nowMs: number, blacklistEmails?: Set<string>, history?: object,
 *           allowWithdrawn?: boolean }} input
 */
export function resolveComebackCustomer({ fields, nowMs, blacklistEmails, history, allowWithdrawn, duplicateEmail } = {}) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const grantOptions = { allowWithdrawn: allowWithdrawn === true, duplicateEmail: duplicateEmail === true };

  const marketing = resolveCustomerMarketing({ fields: f, nowMs: now, blacklistEmails, history });
  const grants = resolvePromotionalGrants(f, now);
  const grantable = checkGrantable(f, grantOptions);
  const offerable = checkOfferable(f);
  const state = describeCustomerState(f, now);

  return {
    marketing,
    grants,
    /** 対象区分（期限切れ / 退会 / 休眠 / 現有効会員 / 不明）。単一源は entitlements/comebackAudience.js */
    segment: classifyComebackSegment({ fields: f, nowMs: now }),
    /**
     * 今回の無料付与（**この操作をいま実行できるか**）。
     * 現在状態（freeGrant）・履歴（grantHistoryCodes）とは別項目。
     */
    eligibility: (() => {
      const e = resolveGrantEligibility(f, now, grantOptions);
      return { ...e, text: formatGrantEligibility(e) };
    })(),
    /** 無料付与できるか（停止・退会・データ不備は付与しても使えないので false） */
    grantable: grantable.ok,
    grantBlockedReason: grantable.reason,
    /** 割引オファーを発行できるか（退会者にも発行可。支払い時に既存フローが復帰させる） */
    offerable: offerable.ok,
    offerBlockedReason: offerable.reason,
    stateText: state.text,
    paidText: state.paid,
    effectiveTier: state.effectiveTier,
    // ── 無料付与（「いま」と「これまで」を分けて持つ）──
    //   判定は freeGrantStatus.js が単一源。画面・検索・集計で同じ値を使う
    freeGrant: formatFreeGrantSummary(f, now),
    currentGrantCodes: resolveCurrentFreeGrant(f, now).codes,
    grantHistoryCodes: resolveFreeGrantHistory(f, now).codes,
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
/**
 * 複数選択に対応した一致判定。
 * **同じ項目内は OR / 未選択は条件なし**。旧形式（単一文字列）もそのまま動く。
 */
function pick(value, selection) {
  const sel = selection === undefined || selection === null ? []
    : (Array.isArray(selection) ? selection : [selection])
      .map((x) => String(x ?? '').trim()).filter((x) => x && x !== 'all');
  if (sel.length === 0) return true;
  return sel.includes(String(value ?? '').trim());
}

/**
 * 「カムバック候補すべて」に含める区分（**現有効会員を含めない**）。
 * 画面のプリセットと同じ内訳。
 */
export const CB_CANDIDATE_SEGMENTS = Object.freeze([SEGMENT.EXPIRED, SEGMENT.WITHDRAWN, SEGMENT.DORMANT]);

/**
 * 対象区分の一致判定。
 * 画面の「対象区分」は**区分**（退会済み・休眠）と**契約状態**（期限切れ・契約なし）が
 * 混ざっているため、**どちらかに当たれば通す**。片方だけで判定すると
 * 「退会済み」を選んでも 0 件になる。
 */
function matchesContractSelection(c, selection) {
  const sel = selection === undefined || selection === null ? []
    : (Array.isArray(selection) ? selection : [selection])
      .map((x) => String(x ?? '').trim()).filter((x) => x && x !== 'all');
  if (sel.length === 0) return true;
  const want = new Set();
  for (const v of sel) {
    if (v === 'candidates') { for (const s of CB_CANDIDATE_SEGMENTS) want.add(s); continue; }
    if (v === 'active') { want.add(SEGMENT.ACTIVE_MEMBER); want.add('active'); continue; }
    want.add(v);
  }
  return want.has(String(c.segment ?? '')) || want.has(String(c.marketing?.contract ?? ''));
}

export function matchesComebackFilter(c, filter = {}) {
  if (!c) return false;
  const f = filter || {};
  if (!matchesContractSelection(c, f.contract)) return false;
  if (!matchesMarketingFilter(c.marketing, { plan: f.plan, history: f.history })) {
    return false;
  }
  if (!pick(c.marketing.withdrawn === true ? 'yes' : 'no', f.withdrawn)) return false;
  // ── 無料付与: 「いま」と「これまで」は**別々の条件**（混ぜない）──
  if (!matchesFreeGrantNow(c.currentGrantCodes, f.currentGrant)) return false;
  if (!matchesFreeGrantHistory(c.grantHistoryCodes, f.grantHistory)) return false;
  {
    // 旧「現在の特典」フィルター（後方互換）。1 顧客が複数の状態に当たりうるため OR で見る
    const promoSel = f.promo === undefined || f.promo === null ? []
      : (Array.isArray(f.promo) ? f.promo : [f.promo])
        .map((x) => String(x ?? '').trim()).filter((x) => x && x !== CB_PROMO_FILTER.ALL);
    if (promoSel.length > 0) {
      const hasAny = c.promoLight || c.promoPremium;
      const hit = promoSel.some((p) => {
        if (p === CB_PROMO_FILTER.NONE) return !hasAny;
        if (p === CB_PROMO_FILTER.ANY) return !!hasAny;
        if (p === CB_PROMO_FILTER.LIGHT) return !!c.promoLight;
        if (p === CB_PROMO_FILTER.LIGHT_LIFETIME) return !!c.promoLightLifetime;
        if (p === CB_PROMO_FILTER.PREMIUM) return !!c.promoPremium;
        if (p === CB_PROMO_FILTER.PREMIUM_ENDED) return !!c.promoPremiumEnded;
        if (p === CB_PROMO_FILTER.INCONSISTENT) return !!c.promoInconsistent;
        return false;
      });
      if (!hit) return false;
    }
  }
  // 「今回の無料付与」。要確認（review）を付与不可と混ぜない
  if (!matchesGrantEligibility(c.eligibility ? c.eligibility.status : null, f.grantable)) return false;
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
