/**
 * premiumPlusCouponAccess.js — 「クーポンを**取得できるか / 使えるか**」の単一源（純粋・I/O なし）
 *
 * ## 2 つの軸を分ける（2026-08-22 の不整合修正）
 *
 * | 軸 | 何が決めるか | 使う判定 |
 * |---|---|---|
 * | **クーポンを取得・使用できるか** | Plus の対象会員 ＋ **その会員の再募集が開始済みで期限内** | このモジュール |
 * | **いま購入できるか** | `salePaused` / 資格 / PHASE / route（**従来どおり**）| `premiumPlusRelease.js` |
 *
 * ⚠️ **`salePaused` はクーポン取得資格の必須条件にしない。**
 *
 * 旧実装は「取得 CTA は `salePaused === true` の間だけ」だった。ところが 2026-08-22 に
 * 「この会員の再募集を開始する」が**販売停止の解除を含む 1 操作**になったため、
 *
 * ```
 * 再募集を開始 → 販売停止が解除される → 取得 CTA が消える
 * ```
 *
 * という矛盾が起きた（＝再募集を開始した会員がクーポンを取得できない）。
 * 「販売再開の前に先に取得させる」は通常運用にしないと決まったので、
 * **取得資格を停止フラグから切り離す**。
 *
 * ## 取得できる条件（すべて満たすこと）
 *
 * 1. **Plus の対象会員**（`plusAudience.isPlusAudience`＝停止を外したら商品ページを見られる人）
 * 2. **その会員の再募集が開始済み**（`reopenStartsAt` が確定している）
 * 3. **その会員の期限内**（`reopenStartsAt + 14 日`）
 * 4. まだ取得していない
 * 5. 取得の記録を本番に保存できる（gate が有効）
 *
 * ⚠️ **未開始の会員は取得も使用もできない**（fail closed）。
 * ⚠️ 販売停止中でも、開始済み・期限内なら**取得できる**（購入はできないまま）。
 * ⚠️ 既に取得済みのクーポンは**この判定で消えない**（保有は Airtable の 3 列が正本）。
 */

import { withReopenStart } from './premiumPlusReopenStart.js';
import { readReopenCoupon, resolveCouponExpiry } from './premiumPlusReopenCoupon.js';

/** 断る理由（呼び出し側は握りつぶさずそのまま返す） */
export const COUPON_ACCESS_REJECT = Object.freeze({
  /** Plus の対象会員ではない → **存在を知らせない**（404） */
  NOT_ELIGIBLE: 'not_eligible',
  /** 開始状態を読めていない → 何も断定しない（503・fail closed） */
  STATE_UNAVAILABLE: 'reopen_state_unavailable',
  /** この会員の再募集がまだ開始されていない（409） */
  NOT_STARTED: 'reopen_not_started',
  /** この会員の期限を過ぎている（409） */
  EXPIRED: 'coupon_expired',
  /** 保存先が本番で有効化されていない（503。「取得した」と言わない） */
  STORAGE_UNAVAILABLE: 'coupon_storage_unavailable',
});

export const COUPON_ACCESS_NOTE = Object.freeze({
  not_eligible: '',
  reopen_state_unavailable: '再募集の状態を確認できないため、クーポンの取得を受け付けられません。'
    + '時間をおいてもう一度お試しください。',
  reopen_not_started: '募集再開のご案内をお待ちください。ご案内後にクーポンを取得いただけます。',
  coupon_expired: 'クーポンのご利用期限を過ぎています。',
  coupon_storage_unavailable: 'ただいま取得を受け付けられません。時間をおいてもう一度お試しください。',
});

export function describeCouponAccessReject(reason) {
  return COUPON_ACCESS_NOTE[String(reason || '')] ?? '';
}

/**
 * 会員 1 人ぶんのクーポン利用可否を解く。
 *
 * @param {{
 *   audience?: boolean,      Plus の対象会員か（`plusAudience.isPlusAudience`）
 *   reopen?: { available?: boolean, startsAtIso?: unknown },
 *   fields?: object|null,    Airtable Customers の fields（保有の判定に使う）
 *   nowMs?: number,
 *   storageReady?: boolean,  取得を保存できるか（`isReopenCouponEnabled(env)`）
 * }} input
 * @returns {{ audienceOk: boolean, stateKnown: boolean, started: boolean,
 *             startsAtIso: string, expiresAtIso: string, withinExpiry: boolean,
 *             claimed: boolean, claimedAtIso: string,
 *             canClaim: boolean, canUse: boolean, visible: boolean,
 *             reason: string|null, note: string }}
 */
export function resolveCouponAccess({
  audience, reopen, fields, nowMs = Date.now(), storageReady = false,
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
    stateKnown,
    started,
    startsAtIso: started ? String(def.terms.reopenStartsAt || '') : '',
    expiresAtIso: started ? String(expiry.expiresAtIso) : '',
    withinExpiry,
    claimed: held.claimed === true,
    claimedAtIso: held.claimedAtIso || '',
  };

  const deny = (reason) => ({
    ...base,
    canClaim: false,
    // ⚠️ **取得済みのクーポンは消さない**。使えるかどうか（canUse）だけが変わる
    canUse: false,
    visible: base.claimed === true,
    reason,
    note: describeCouponAccessReject(reason),
  });

  // Plus の対象でない相手には存在も知らせない
  if (audience !== true) return { ...deny(COUPON_ACCESS_REJECT.NOT_ELIGIBLE), visible: false };
  // 状態を読めていないなら何も断定しない（未開始と決めつけない）
  if (!stateKnown) return deny(COUPON_ACCESS_REJECT.STATE_UNAVAILABLE);
  if (!started) return deny(COUPON_ACCESS_REJECT.NOT_STARTED);
  if (!withinExpiry) return deny(COUPON_ACCESS_REJECT.EXPIRED);

  // ここから先は「開始済み・期限内」
  if (base.claimed) {
    return {
      ...base, canClaim: false, canUse: true, visible: true, reason: null, note: '',
    };
  }
  if (storageReady !== true) return deny(COUPON_ACCESS_REJECT.STORAGE_UNAVAILABLE);
  return {
    ...base, canClaim: true, canUse: false, visible: true, reason: null, note: '',
  };
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
    case COUPON_ACCESS_REJECT.NOT_STARTED:
    case COUPON_ACCESS_REJECT.EXPIRED: return 409;
    default: return 503;
  }
}
