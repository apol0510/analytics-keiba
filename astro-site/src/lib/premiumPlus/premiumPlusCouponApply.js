/**
 * premiumPlusCouponApply.js — 申込へクーポンを適用したときの**価格の単一源**（純粋・I/O なし）
 *
 * ## クライアントの言い値で価格を決めない
 *
 * 申込画面から送ってよいのは **`couponId`（どれを選んだかという意思表示）だけ**。
 * `discount` / `offerPrice` / `finalPrice` を送られても**読まない**。
 * 会員は `ak_session` から解決した 1 件だけを使い、ここで次を再検証してから価格を決める:
 *
 *   1. 本人が本当に所持しているか（Customers のクーポン 3 列）
 *   2. その商品に使えるか（Premium Plus 以外には使えない）
 *   3. 現在利用可能か
 *   4. 未使用か
 *   5. 有効期限内か（**期限が確定してから**効く検査）
 *
 * ## 二重適用が構造的に起きない
 *
 * 価格は **「正本の通常価格から 1 回だけ引いた確定値」**で、
 * **入力価格から引き算しない**。同じクーポンを何度「適用」しても 58,000円のままで、
 * 48,000円にはならない。再読込・戻る・再送でも同じ値になる。
 *
 * ## クーポンは購入可否を変えない
 *
 * 販売停止中（`salePaused`）は購入不可のまま。適用の可否と購入の可否は**別の軸**で、
 * この関数は価格を返すだけ。`salePaused` / `eligibility` / `override` / PHASE /
 * route / plan / payment を 1 バイトも変えない。
 */

import {
  PP_REOPEN_COUPON,
  readReopenCoupon,
  couponIdWithVersion,
  resolveCouponPrice,
  describeCouponDiscount,
  describeCouponPrice,
  describeCouponExpiry,
  formatYen,
  PP_REOPEN_COUPON_USABLE_NOTE,
} from './premiumPlusReopenCoupon.js';

/** 適用を断る理由（呼び出し側は握りつぶさずそのまま返す） */
export const COUPON_APPLY_REJECT = Object.freeze({
  /** 選択されたクーポンを本人が持っていない（他人のクーポン / 直打ち） */
  NOT_HELD: 'coupon_not_held',
  /** そんなクーポンは存在しない（未知の couponId） */
  UNKNOWN: 'coupon_unknown',
  /** この商品には使えない */
  WRONG_PRODUCT: 'coupon_wrong_product',
  /** 期限切れ（期限が確定してから効く） */
  EXPIRED: 'coupon_expired',
  /** 既に使用済み */
  ALREADY_USED: 'coupon_already_used',
});

/** クーポンを使える商品（いまは Premium Plus だけ） */
export const COUPON_PRODUCT = Object.freeze({ PREMIUM_PLUS: 'premium_plus' });

/**
 * 本人が「いま使えるクーポン」の一覧（0 件か 1 件）。
 *
 * **他会員のデータは構造的に入らない**（渡された 1 人分の fields からしか作らない）。
 * 未所持なら空配列 → 申込画面は選択欄ごと出さない。
 *
 * @param {{ fields: object|null, nowMs?: number, product?: string }} input
 */
export function listApplicableCoupons({
  fields, nowMs = Date.now(), product = COUPON_PRODUCT.PREMIUM_PLUS,
  /**
   * **実効クーポン定義**（`withReopenStart()` の戻り値）。再募集を開始していれば
   * 有効期限が確定した定義が渡る。省略時は基準定義（＝期限未確定＝期限で弾かない）。
   */
  def = PP_REOPEN_COUPON,
} = {}) {
  if (product !== COUPON_PRODUCT.PREMIUM_PLUS) return [];
  const held = readReopenCoupon(fields);
  if (held.claimed !== true) return [];
  // 未開始・期限切れはどちらも「使えない」（未開始を通さない）
  if (!isUsable(nowMs, def)) return [];
  if (isUsed(fields)) return [];

  const price = resolveCouponPrice(def);
  if (!price) return [];
  return [{
    couponId: couponIdWithVersion(),
    name: def.name,
    discountText: describeCouponDiscount(def),
    priceText: describeCouponPrice(def),
    expiryText: describeCouponExpiry(def),
    expiryDetermined: def.terms.expiresDetermined === true,
    usableNote: PP_REOPEN_COUPON_USABLE_NOTE,
    claimedAtIso: held.claimedAtIso,
    ...price,
  }];
}

/**
 * **いま使えるクーポンか**（＝その会員の再募集が開始済みで、期限内か）。
 *
 * ⚠️ 2026-08-22 変更: 期限が**未確定（＝その会員の再募集が未開始）なら使えない**。
 *    旧実装は「未確定なら期限切れではない」として**通していた**が、
 *    未開始の会員に 58,000円 の申込を作らせないため **fail closed** にする。
 */
function isUsable(nowMs, def = PP_REOPEN_COUPON) {
  const t = (def && def.terms) || {};
  if (t.expiresDetermined !== true || !t.expiresAt) return false;   // 未開始 = 使えない
  const ms = Date.parse(String(t.expiresAt));
  return Number.isFinite(ms) ? ms > nowMs : false;
}

/**
 * 既に使用済みか。
 * ⚠️ **「使用済みにするタイミング」は MK 未決定**なので、現時点で使用済みになる経路は無い。
 *    決まったら（入金確認時など）ここが読む値を足す。docs/progress.md 2-B を参照。
 */
function isUsed() {
  return false;
}

/**
 * 申込価格を決める（**サーバー側の唯一の入口**）。
 *
 * @param {{ fields: object|null, couponId?: unknown, nowMs?: number,
 *           product?: string }} input
 * @returns {{ regularPrice: number, discount: number, finalPrice: number,
 *             couponApplied: null|object, reason: string|null }}
 */
export function resolveOrderPricing({
  fields, couponId, nowMs = Date.now(), product = COUPON_PRODUCT.PREMIUM_PLUS,
  /** **実効クーポン定義**（`withReopenStart()` の戻り値）。期限判定にだけ効く */
  def = PP_REOPEN_COUPON,
} = {}) {
  const base = resolveCouponPrice(def);
  // 通常価格は常に正本から。クーポンが無くても・弾かれても、ここが基準
  const regularPrice = base ? base.regularPrice : null;
  const none = (reason = null) => ({
    regularPrice, discount: 0, finalPrice: regularPrice, couponApplied: null, reason,
  });

  const selected = String(couponId ?? '').trim();
  if (!selected) return none();                       // 未選択＝通常価格
  if (product !== COUPON_PRODUCT.PREMIUM_PLUS) return none(COUPON_APPLY_REJECT.WRONG_PRODUCT);

  // 実在するクーポンか（未知の couponId 直打ちを弾く）
  if (selected !== couponIdWithVersion()) return none(COUPON_APPLY_REJECT.UNKNOWN);

  // **本人が持っているか**を Airtable の値から再検証する（画面の申告は信じない）
  const held = readReopenCoupon(fields);
  if (held.claimed !== true) return none(COUPON_APPLY_REJECT.NOT_HELD);
  if (isUsed(fields)) return none(COUPON_APPLY_REJECT.ALREADY_USED);
  // 未開始（期限未確定）も期限切れも同じく使えない。**通常価格へ黙って落とさない**
  // （申込 Function 側が 409 で申込ごと止める）
  if (!isUsable(nowMs, def)) return none(COUPON_APPLY_REJECT.EXPIRED);

  // ⚠️ 入力価格から引かない。正本の通常価格から**1 回だけ**引いた確定値を返す
  return {
    regularPrice: base.regularPrice,
    discount: base.discountValue,
    finalPrice: base.offerPrice,
    couponApplied: {
      couponId: couponIdWithVersion(),
      name: def.name,
      discountType: base.discountType,
      discountValue: base.discountValue,
    },
    reason: null,
  };
}

/** 画面に出す内訳（**金額の文字列化もここ 1 か所**） */
export function describeOrderBreakdown(pricing) {
  const p = pricing || {};
  return {
    regularText: `通常価格 ${formatYen(p.regularPrice)}`,
    discountText: p.discount > 0 ? `クーポン割引 -${formatYen(p.discount)}` : '',
    finalText: `お支払い金額 ${formatYen(p.finalPrice)}`,
    applied: !!p.couponApplied,
  };
}
