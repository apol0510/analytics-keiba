/**
 * premiumPlusCouponAccess.js — 「クーポンを**取得できるか / 使えるか**」の単一源（純粋・I/O なし）
 *
 * ## この機能の目的（**ここを取り違えない**）
 *
 * > **Premium Plus を買おうとした → いまは売っていない → 代わりにクーポンをどうぞ**
 *
 * クーポンは「**買えなかった人への埋め合わせ**」として配る。
 * したがって**配る相手は「いま購入できない会員」**であって、購入できる会員ではない。
 *
 * ⚠️ 2026-08-22 に一度、取得条件を「その会員の再募集が開始済み」にしてしまい、
 *    再募集の開始＝販売再開なので **「買える人だけが取得できる」＝目的と正反対**の
 *    実装になった。同じ間違いを繰り返さないこと。
 *
 * ## 2 つの軸を分ける
 *
 * | 軸 | 条件 | 意味 |
 * |---|---|---|
 * | **取得できる（配る）** | Plus の対象会員 ＋ **いま販売を停止している** ＋ 未取得 | 買えないから渡す |
 * | **使える（割引が乗る）** | 取得済み ＋ **その会員の再募集が開始済みで期限内** | 買えるようになったら使う |
 *
 * 販売可否そのもの（`salePaused` / 資格 / PHASE / route）は従来どおり
 * `premiumPlusRelease.js` が決める。ここはその結果を**受け取るだけ**で、購入可否を変えない。
 *
 * ⚠️ **未開始のうちは「使えない」**（`buildReservationFields()` も fail closed）。
 *    未開始の会員に 58,000円 の申込を作らせないため。取得はできるが、使えるのは再募集後。
 * ⚠️ **既に取得済みのクーポンは、この判定で消えない**（保有は Airtable の 3 列が正本）。
 */

import { withReopenStart } from './premiumPlusReopenStart.js';
import { readReopenCoupon, resolveCouponExpiry } from './premiumPlusReopenCoupon.js';

/** 断る理由（呼び出し側は握りつぶさずそのまま返す） */
export const COUPON_ACCESS_REJECT = Object.freeze({
  /** Plus の対象会員ではない → **存在を知らせない**（404） */
  NOT_ELIGIBLE: 'not_eligible',
  /**
   * いま購入できる状態なので配る必要がない（409）。
   * ⚠️ クーポンは「買えなかった人への埋め合わせ」。買える人には出さない。
   */
  NOT_PAUSED: 'plus_on_sale',
  /** 保存先が本番で有効化されていない（503。「取得した」と言わない） */
  STORAGE_UNAVAILABLE: 'coupon_storage_unavailable',
  /** 取得済みだが、この会員の再募集がまだ開始されていない（＝まだ使えない） */
  NOT_STARTED: 'reopen_not_started',
  /** 取得済みだが期限を過ぎている */
  EXPIRED: 'coupon_expired',
  /** 開始状態を読めていない（未開始と断定しない） */
  STATE_UNAVAILABLE: 'reopen_state_unavailable',
});

export const COUPON_ACCESS_NOTE = Object.freeze({
  not_eligible: '',
  plus_on_sale: 'ただいま Premium Plus をご購入いただけます。',
  coupon_storage_unavailable: 'ただいま取得を受け付けられません。時間をおいてもう一度お試しください。',
  reopen_not_started: '募集再開時にご利用いただけます。',
  coupon_expired: 'クーポンのご利用期限を過ぎています。',
  reopen_state_unavailable: 'ただいまご利用状況を確認できません。時間をおいてご確認ください。',
});

export function describeCouponAccessReject(reason) {
  return COUPON_ACCESS_NOTE[String(reason || '')] ?? '';
}

/**
 * 会員 1 人ぶんのクーポン利用可否を解く。
 *
 * @param {{
 *   audience?: boolean,      Plus の対象会員か（`plusAudience.isPlusAudience`）
 *   salePaused?: boolean,    **いま販売を停止しているか**（`plusRelease.salePaused`）
 *   reopen?: { available?: boolean, startsAtIso?: unknown },
 *   fields?: object|null,    Airtable Customers の fields（保有の判定に使う）
 *   nowMs?: number,
 *   storageReady?: boolean,  取得を保存できるか（`isReopenCouponEnabled(env)`）
 * }} input
 * @returns {{ audienceOk: boolean, salePaused: boolean, claimed: boolean, claimedAtIso: string,
 *             stateKnown: boolean, started: boolean, startsAtIso: string,
 *             expiresAtIso: string, withinExpiry: boolean,
 *             canClaim: boolean, canUse: boolean, visible: boolean,
 *             reason: string|null, note: string }}
 */
export function resolveCouponAccess({
  audience, salePaused, reopen, fields, nowMs = Date.now(), storageReady = false,
} = {}) {
  const held = readReopenCoupon(fields);
  const r = reopen || {};
  const stateKnown = r.available === true;
  const def = stateKnown ? withReopenStart(r.startsAtIso) : null;
  const expiry = def ? resolveCouponExpiry(def) : { expiresAtIso: null, determined: false };
  const started = expiry.determined === true && !!expiry.expiresAtIso;
  const expiresMs = started ? Date.parse(String(expiry.expiresAtIso)) : NaN;
  const withinExpiry = started && Number.isFinite(expiresMs) && expiresMs > Number(nowMs);

  const base = {
    audienceOk: audience === true,
    salePaused: salePaused === true,
    claimed: held.claimed === true,
    claimedAtIso: held.claimedAtIso || '',
    stateKnown,
    started,
    startsAtIso: started ? String(def.terms.reopenStartsAt || '') : '',
    expiresAtIso: started ? String(expiry.expiresAtIso) : '',
    withinExpiry,
  };
  const out = (over) => ({
    ...base, canClaim: false, canUse: false, visible: base.claimed, reason: null, note: '', ...over,
  });
  const deny = (reason, over = {}) => out({
    reason, note: describeCouponAccessReject(reason), ...over,
  });

  // Plus の対象でない相手には存在も知らせない
  if (audience !== true) return deny(COUPON_ACCESS_REJECT.NOT_ELIGIBLE, { visible: false });

  // ── 取得済み: 「使えるか」だけを見る（保有は消さない）──────────────
  if (base.claimed) {
    if (!stateKnown) return deny(COUPON_ACCESS_REJECT.STATE_UNAVAILABLE, { visible: true });
    if (!started) return deny(COUPON_ACCESS_REJECT.NOT_STARTED, { visible: true });
    if (!withinExpiry) return deny(COUPON_ACCESS_REJECT.EXPIRED, { visible: true });
    return out({ canUse: true, visible: true });
  }

  // ── 未取得: 「買えないから配る」──────────────────────────────
  // ⚠️ 再募集の開始状態は**取得の条件にしない**（開始＝販売再開なので、
  //    条件にすると「買える人だけ取得できる」という目的と正反対の実装になる）。
  if (salePaused !== true) return deny(COUPON_ACCESS_REJECT.NOT_PAUSED, { visible: false });
  if (storageReady !== true) return deny(COUPON_ACCESS_REJECT.STORAGE_UNAVAILABLE, { visible: false });
  return out({ canClaim: true, visible: true });
}

/**
 * 取得を受け付けてよいか（**サーバー側の唯一の判定**）。
 *
 * URL 直打ち・API 直接呼び出し・古いタブでも必ずここを通す。
 * 画面が CTA を出していたかどうかは判定材料にしない。
 *
 * @param {ReturnType<typeof resolveCouponAccess>} access
 * @returns {{ ok: true, alreadyClaimed: boolean } | { ok: false, reason: string }}
 */
export function resolveClaimDecision(access) {
  const a = access || {};
  // 既に持っているなら**何も書かない**で成功を返す（冪等・二重取得なし）
  if (a.claimed === true) return { ok: true, alreadyClaimed: true };
  if (a.canClaim === true) return { ok: true, alreadyClaimed: false };
  return { ok: false, reason: a.reason || COUPON_ACCESS_REJECT.NOT_ELIGIBLE };
}

/** 断り方（HTTP ステータス）。**存在秘匿は 404、それ以外は理由を返す** */
export function claimRejectStatus(reason) {
  switch (String(reason || '')) {
    case COUPON_ACCESS_REJECT.NOT_ELIGIBLE: return 404;
    case COUPON_ACCESS_REJECT.NOT_PAUSED:
    case COUPON_ACCESS_REJECT.NOT_STARTED:
    case COUPON_ACCESS_REJECT.EXPIRED: return 409;
    default: return 503;
  }
}
