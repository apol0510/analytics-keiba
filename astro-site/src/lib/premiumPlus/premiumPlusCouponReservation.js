/**
 * premiumPlusCouponReservation.js — クーポンの「利用予約 → 使用済み」の単一源（純粋・I/O なし）
 *
 * ## 確定した流れ（2026-08-19 MK）
 *
 * ```
 * 取得済み → 申込画面で 10,000円OFF を選択 → 58,000円を銀行振込
 *   → **振込完了報告が正常受理された時点**で PromotionalOffers に Status='issued'（利用予約）
 *   → MK が PaymentConfirmed を確認し confirm-bank-payment が正常完了した時点で
 *     Status='redeemed' / RedeemedAt を確定
 * ```
 *
 * - **選択しただけでは issued にも redeemed にもしない**
 * - **振込完了報告が正常受理される前に予約を作らない**
 *
 * ## ExpiresAt は「クーポン本体の利用期限」
 *
 * 予約用の 24h / 48h といった別 TTL は**作らない**。`ExpiresAt` にはクーポンの期限を入れる。
 *
 * ⚠️ **期限判定は「振込完了報告の受理時」に固定する。**
 *    期限内に報告が受理されていれば、その後 MK の入金確認が期限をまたいでも
 *    **確認待ち時間を理由に失効させない**。
 *    そのため redeem では `now > ExpiresAt` を見ず、台帳に残した
 *    `StartsAt`（＝報告受理時刻）と `ExpiresAt` を突き合わせて
 *    「**報告時点で期限内だったか**」を再現・検証する。
 *
 * ## 期限が未確定のあいだは予約を作れない（fail closed）
 *
 * クーポン本体の有効期限は**まだ未確定**。仮の日付・14日・90日を勝手に入れない。
 * `expiresDetermined !== true` のあいだ `buildReservationFields()` は **null** を返し、
 * 本番に予約行を作れる状態へ**有効化しない**。
 *
 * ## 既存 schema だけで表現する（追加なし）
 *
 * `PromotionalOffers` の既存列のみを使う:
 *   `Source` … 予約行の目印（通常の販促 offer と混ぜないため）
 *   `Status` … issued（予約）/ redeemed（使用済み）/ revoked（予約取消）
 *   `OfferKey` … 冪等キー。同じ申込で再送しても 1 行のまま
 *   `StartsAt` … **振込完了報告の受理時刻**（期限判定の基準）
 *   `ExpiresAt` … クーポン本体の利用期限
 */

import { createHash } from 'node:crypto';
import { RESERVATION_SOURCE as RESERVATION_SOURCE_VALUE, isReservationRow } from '../promotions/couponReservationSource.js';
import { OFFER_STATUS, assertOnlyOfferFields } from '../promotions/promotionalOffer.js';
import {
  PP_REOPEN_COUPON, couponIdWithVersion, resolveCouponPrice, readReopenCoupon,
} from './premiumPlusReopenCoupon.js';

/**
 * 予約行の目印（`Source` 列）と判定は **promotions 側**が持つ。
 * 販促（marketing）からも読む必要があり、そちらは Premium Plus の販売判定モジュールを
 * import できない（販売と販促の分離）。ここでは再エクスポートするだけ。
 */
export { RESERVATION_SOURCE, isReservationRow } from '../promotions/couponReservationSource.js';

/** クーポンのライフサイクル状態（admin 表示用） */
export const COUPON_LIFECYCLE = Object.freeze({
  /** 取得しただけ（申込していない） */
  HELD: 'held',
  /** 利用予約（振込完了報告を受理済み・入金確認待ち） */
  RESERVED: 'reserved',
  /** 使用済み（入金確認が完了した） */
  REDEEMED: 'redeemed',
  /** 予約取消（入金確認前の取消・誤申告訂正） */
  REVOKED: 'revoked',
  /** 取得していない */
  NONE: 'none',
});

export const COUPON_LIFECYCLE_LABEL = Object.freeze({
  held: 'クーポン所持中',
  reserved: 'クーポン利用予約（入金確認待ち）',
  redeemed: 'クーポン使用済み',
  revoked: 'クーポン予約取消',
  none: 'クーポン未取得',
});

/**
 * 予約を作れる状態か（**fail closed**）。
 * クーポン本体の有効期限が確定していなければ false。
 * ⚠️ 期限を勝手に補完して true にしないこと。
 */
export function isReservationEnabled(env, def = PP_REOPEN_COUPON) {
  const terms = (def && def.terms) || {};
  if (terms.expiresDetermined !== true || !terms.expiresAt) return false;
  // 台帳への書き込み自体の既存 gate も要る
  return !!env && env.COMEBACK_OFFER_TABLE_READY === '1';
}

/** 予約の冪等キー。同じ会員・同じクーポン・同じ申込なら常に同じ値 */
export function computeReservationKey({ customerRecordId, applicationId }) {
  const rec = String(customerRecordId || '').trim();
  const app = String(applicationId || '').trim();
  if (!rec || !app) return null;
  return createHash('sha256')
    .update(`ak-pp-coupon-reservation|${couponIdWithVersion()}|${rec}|${app}`, 'utf8')
    .digest('hex').slice(0, 32);
}

/** 既に有効な予約（issued）があるか。**同一クーポンで複数の申込を作らせない** */
export function findActiveReservation({ records, customerRecordId }) {
  for (const rec of records || []) {
    if (!isReservationRow(rec)) continue;
    const f = (rec && rec.fields) || {};
    if (String(f.CustomerRecordId || '') !== String(customerRecordId)) continue;
    if (String(f.OfferId || '') !== couponIdWithVersion()) continue;
    if (String(f.Status || '').trim().toLowerCase() !== OFFER_STATUS.ISSUED) continue;
    return rec;
  }
  return null;
}

/** 予約を断る理由 */
export const RESERVATION_REJECT = Object.freeze({
  /** クーポン本体の期限が未確定（＝本番で予約を作れない） */
  EXPIRY_UNDETERMINED: 'coupon_expiry_undetermined',
  /** 取得していない */
  NOT_HELD: 'coupon_not_held',
  /** 期限切れ（**新規利用**は不可） */
  EXPIRED: 'coupon_expired',
  /** 既に予約がある（入金確認待ち） */
  ALREADY_RESERVED: 'coupon_already_reserved',
  /** 既に使用済み */
  ALREADY_REDEEMED: 'coupon_already_redeemed',
});

/**
 * 「いま新しく利用予約を作ってよいか」を決める。
 *
 * @param {{ fields: object|null, offerRows?: object[], customerRecordId: string,
 *           nowMs: number, env?: object }} input
 */
export function resolveReservationDecision({
  fields, offerRows = [], customerRecordId, nowMs, env,
} = {}) {
  const terms = PP_REOPEN_COUPON.terms || {};
  // 期限が未確定なら本番で予約を作らない（fail closed）
  if (terms.expiresDetermined !== true || !terms.expiresAt) {
    return { ok: false, reason: RESERVATION_REJECT.EXPIRY_UNDETERMINED };
  }
  if (readReopenCoupon(fields).claimed !== true) {
    return { ok: false, reason: RESERVATION_REJECT.NOT_HELD };
  }
  // **新規利用**は期限内だけ（既存予約の redeem とは別判定）
  const expiresMs = Date.parse(String(terms.expiresAt));
  if (Number.isFinite(expiresMs) && expiresMs <= nowMs) {
    return { ok: false, reason: RESERVATION_REJECT.EXPIRED };
  }
  if (findActiveReservation({ records: offerRows, customerRecordId })) {
    return { ok: false, reason: RESERVATION_REJECT.ALREADY_RESERVED };
  }
  if (hasRedeemedReservation({ records: offerRows, customerRecordId })) {
    return { ok: false, reason: RESERVATION_REJECT.ALREADY_REDEEMED };
  }
  if (!isReservationEnabled(env)) {
    return { ok: false, reason: RESERVATION_REJECT.EXPIRY_UNDETERMINED };
  }
  return { ok: true, reason: null };
}

function hasRedeemedReservation({ records, customerRecordId }) {
  return (records || []).some((rec) => {
    if (!isReservationRow(rec)) return false;
    const f = (rec && rec.fields) || {};
    return String(f.CustomerRecordId || '') === String(customerRecordId)
      && String(f.Status || '').trim().toLowerCase() === OFFER_STATUS.REDEEMED;
  });
}

/**
 * 利用予約の 1 行を組み立てる（**振込完了報告が正常受理された時点でだけ呼ぶ**）。
 *
 * @returns {{ fields: object, offerKey: string }|null}
 *   期限未確定・情報不足なら **null**（呼び出し側は行を作らない＝ fail closed）
 */
export function buildReservationFields({
  customerRecordId, email, applicationId, nowMs, def = PP_REOPEN_COUPON,
}) {
  const terms = (def && def.terms) || {};
  if (terms.expiresDetermined !== true || !terms.expiresAt) return null;  // fail closed
  const price = resolveCouponPrice(def);
  if (!price) return null;
  const rec = String(customerRecordId || '').trim();
  const mail = String(email || '').trim().toLowerCase();
  if (!rec || !mail || !Number.isFinite(nowMs)) return null;
  const offerKey = computeReservationKey({ customerRecordId: rec, applicationId });
  if (!offerKey) return null;

  const fields = {
    OfferKey: offerKey,
    CustomerRecordId: rec,
    Email: mail,
    OfferId: couponIdWithVersion(),
    OfferVersion: def.version,
    RegularPrice: price.regularPrice,
    OfferPrice: price.offerPrice,
    DiscountType: price.discountType,
    DiscountValue: String(price.discountValue),
    // ⚠️ StartsAt = **振込完了報告の受理時刻**。期限判定はこの時刻で固定する
    StartsAt: new Date(nowMs).toISOString(),
    // ⚠️ ExpiresAt = **クーポン本体の利用期限**（予約 TTL ではない）
    ExpiresAt: new Date(Date.parse(String(terms.expiresAt))).toISOString(),
    Status: OFFER_STATUS.ISSUED,
    Source: RESERVATION_SOURCE_VALUE,
    OperationId: String(applicationId || ''),
  };
  if (!assertOnlyOfferFields(fields)) return null;
  return { fields, offerKey };
}

/**
 * 報告受理時に期限内だったか（**台帳から再現する**）。
 * `StartsAt <= ExpiresAt` で判定し、**現在時刻は見ない**。
 */
export function wasReportedWithinExpiry(record) {
  const f = (record && record.fields) || {};
  const started = Date.parse(String(f.StartsAt || ''));
  const expires = Date.parse(String(f.ExpiresAt || ''));
  if (!Number.isFinite(started) || !Number.isFinite(expires)) return false;
  return started <= expires;
}

/**
 * 使用済みにする更新（**入金確認が正常完了した時点でだけ呼ぶ**）。
 *
 * ⚠️ **現在時刻と ExpiresAt を比べない。** 期限内に報告が受理されていれば、
 *    MK の確認が期限をまたいでも失効させない（確認待ち時間で顧客を損させない）。
 *
 * @returns {{ fields: object }|{ skipped: string }}
 */
export function buildReservationRedeemFields({ record, nowMs }) {
  const f = (record && record.fields) || {};
  if (!isReservationRow(record)) return { skipped: 'not_a_reservation' };
  const status = String(f.Status || '').trim().toLowerCase();
  // 一方向遷移。再実行しても二重 redeem しない
  if (status === OFFER_STATUS.REDEEMED) return { skipped: 'already_redeemed' };
  if (status === OFFER_STATUS.REVOKED) return { skipped: 'revoked' };
  if (status !== OFFER_STATUS.ISSUED) return { skipped: `not_issued:${status || 'unknown'}` };
  // 報告受理時に期限内だったかだけを見る
  if (!wasReportedWithinExpiry(record)) return { skipped: 'reported_after_expiry' };
  if (!Number.isFinite(nowMs)) return { skipped: 'invalid_now' };

  const fields = { Status: OFFER_STATUS.REDEEMED, RedeemedAt: new Date(nowMs).toISOString() };
  return assertOnlyOfferFields(fields) ? { fields } : { skipped: 'field_allow_list_violation' };
}

/**
 * 予約の取消（**入金確認前の取消・誤申告訂正**）。
 *
 * ⚠️ 予約行だけを revoked にする。**Customers 側の「クーポン取得済み」は消さない**ので、
 *    取り消したあとも同じクーポンで申し込み直せる。
 */
export function buildReservationRevokeFields({ record, nowMs, reason }) {
  const f = (record && record.fields) || {};
  if (!isReservationRow(record)) return { skipped: 'not_a_reservation' };
  const status = String(f.Status || '').trim().toLowerCase();
  if (status === OFFER_STATUS.REDEEMED) return { skipped: 'already_redeemed' };
  if (status === OFFER_STATUS.REVOKED) return { skipped: 'already_revoked' };
  const fields = {
    Status: OFFER_STATUS.REVOKED,
    Notes: `reservation revoked ${new Date(nowMs).toISOString()}`
      + `${reason ? ` / ${String(reason).slice(0, 120)}` : ''}`,
  };
  return assertOnlyOfferFields(fields) ? { fields } : { skipped: 'field_allow_list_violation' };
}

/**
 * admin 表示用のライフサイクル状態（**通常の販促 offer とは混ぜない**）。
 *
 * @param {{ fields: object|null, offerRows?: object[], customerRecordId: string }} input
 */
export function describeCouponLifecycle({ fields, offerRows = [], customerRecordId } = {}) {
  const held = readReopenCoupon(fields);
  const mine = (offerRows || []).filter((rec) => isReservationRow(rec)
    && String(((rec && rec.fields) || {}).CustomerRecordId || '') === String(customerRecordId));
  const statusOf = (rec) => String(((rec && rec.fields) || {}).Status || '').trim().toLowerCase();

  let state = held.claimed ? COUPON_LIFECYCLE.HELD : COUPON_LIFECYCLE.NONE;
  if (mine.some((r) => statusOf(r) === OFFER_STATUS.REDEEMED)) state = COUPON_LIFECYCLE.REDEEMED;
  else if (mine.some((r) => statusOf(r) === OFFER_STATUS.ISSUED)) state = COUPON_LIFECYCLE.RESERVED;
  else if (mine.length && mine.every((r) => statusOf(r) === OFFER_STATUS.REVOKED)) {
    // 予約は取り消されたが、取得の事実は残っている
    state = held.claimed ? COUPON_LIFECYCLE.REVOKED : COUPON_LIFECYCLE.NONE;
  }
  return {
    state,
    label: COUPON_LIFECYCLE_LABEL[state],
    claimed: held.claimed === true,
    claimedAtIso: held.claimedAtIso,
    reservationCount: mine.length,
  };
}
