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
import { resolveRedeemState } from './couponRedeemReconcile.js';
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
  /** 要修復（昇格済みだが未 redeem / redeemed なのに未昇格）*/
  NEEDS_REPAIR: 'needs_repair',
  /** 取得していない */
  NONE: 'none',
  /**
   * **確認できない**（予約台帳を読めていない）。
   * ⚠️ `HELD`（所持中・予約 0 件）や `NONE` と**混同しない**。
   *    「読めた結果 0 件」と「読めていない」は別の事実。
   */
  UNKNOWN: 'unknown',
});

export const COUPON_LIFECYCLE_LABEL = Object.freeze({
  held: 'クーポン所持中',
  reserved: 'クーポン利用予約（入金確認待ち）',
  redeemed: 'クーポン使用済み',
  revoked: 'クーポン予約取消',
  needs_repair: '⚠️ 要修復（入金確認と使用済みが食い違っています）',
  none: 'クーポン未取得',
  unknown: '確認できない（予約台帳を読めていません）',
});

/**
 * 予約台帳を読めなかった理由（**admin にそのまま出す**）。
 * ⚠️ どれも「予約 0 件」ではない。理由を出さないと運営者が復旧できない。
 */
export const LEDGER_UNAVAILABLE = Object.freeze({
  /** 台帳そのものが有効化されていない */
  GATE_OFF: 'gate_off',
  /** Airtable の読み取りに失敗した */
  READ_FAILED: 'read_failed',
  /** ページ上限に達し、全件を読み切れていない */
  PAGE_LIMIT: 'page_limit',
  /** 呼び出し側が台帳を渡していない（配線漏れ）*/
  NOT_PROVIDED: 'not_provided',
});

export const LEDGER_UNAVAILABLE_NOTE = Object.freeze({
  gate_off: '予約台帳（PromotionalOffers）が有効化されていないため、'
    + 'クーポンの利用予約・使用済みを確認できません（COMEBACK_OFFER_TABLE_READY が未設定）。',
  read_failed: '予約台帳の読み取りに失敗したため、クーポンの利用状態を確認できません。'
    + '時間をおいて再読込してください。',
  page_limit: '予約台帳を全件読み切れなかったため、クーポンの利用状態を確認できません。'
    + '件数を確定できない状態で「予約なし」と判断しないでください。',
  not_provided: '予約台帳を読み込んでいないため、クーポンの利用状態を確認できません。',
  unknown: '予約台帳を確認できませんでした。',
});

/** 理由に対応する説明文（未知の理由でも「確認できない」ことは伝える） */
export function describeLedgerUnavailable(reason) {
  return LEDGER_UNAVAILABLE_NOTE[String(reason || '')] || LEDGER_UNAVAILABLE_NOTE.unknown;
}

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
 * ## 「確認できない」と「0 件」を混同しない（**この関数の要**）
 *
 * `offerRows` は **読めた結果**だけを渡すこと。読めなかったときは `null` を渡すか
 * `ledgerAvailable: false` を明示する。呼び出し側で `rows || []` と潰すと、
 * gate off / 読み取り失敗 / 打ち切りの会員が「クーポン所持中・予約 0 件」と
 * **断定表示**され、実在する利用予約・使用済みが見えなくなる。
 *
 * 台帳を読めていないときは `state='unknown'` を返し、`reservationCount` も
 * **0 ではなく null** にする（件数を確定できていないため）。
 * `claimed`（Customers 側の取得の事実）だけは読めているのでそのまま返す。
 *
 * @param {{ fields: object|null, offerRows?: object[]|null, customerRecordId: string,
 *           ledgerAvailable?: boolean, ledgerReason?: string }} input
 */
export function describeCouponLifecycle({
  fields, offerRows, customerRecordId, ledgerAvailable, ledgerReason,
} = {}) {
  const held = readReopenCoupon(fields);
  // 台帳を読めたかは呼び出し側が明示する。未指定なら `offerRows` が配列かどうかで決める
  // （null / undefined = 確認できない）。**既定を「読めた」にしない**
  const available = ledgerAvailable === undefined
    ? Array.isArray(offerRows)
    : ledgerAvailable === true;

  if (!available) {
    const reason = ledgerReason
      || (offerRows === undefined ? LEDGER_UNAVAILABLE.NOT_PROVIDED : '');
    const redeemView = resolveRedeemState({ fields, reservation: null, ledgerAvailable: false });
    return {
      state: COUPON_LIFECYCLE.UNKNOWN,
      label: COUPON_LIFECYCLE_LABEL[COUPON_LIFECYCLE.UNKNOWN],
      /** 台帳を読めたか。false のあいだ state / reservationCount を信用しない */
      ledgerAvailable: false,
      ledgerReason: reason || 'unknown',
      ledgerNote: describeLedgerUnavailable(reason),
      // Customers 側の「取得した」という事実だけは読めている（台帳とは別の列）
      claimed: held.claimed === true,
      claimedAtIso: held.claimedAtIso,
      /** ⚠️ 0 ではなく null。件数を確定できていない */
      reservationCount: null,
      reservationCountText: '確認できない',
      redeemState: redeemView.state,
      redeemLabel: redeemView.label,
      repair: redeemView.repair,
      needsRepair: false,
    };
  }

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
  // ── 入金確認と redeem の食い違いを拾う（要修復 / 異常）────────────
  // ⚠️ 自動で直さない。運営者が判別できるように**状態と修復方針を出すだけ**。
  const latest = mine.find((r) => statusOf(r) === OFFER_STATUS.ISSUED)
    || mine.find((r) => statusOf(r) === OFFER_STATUS.REDEEMED)
    || mine[0] || null;
  const redeemView = resolveRedeemState({ fields, reservation: latest, ledgerAvailable: true });
  if (redeemView.needsRepair) state = COUPON_LIFECYCLE.NEEDS_REPAIR;

  return {
    state,
    label: COUPON_LIFECYCLE_LABEL[state],
    /** 台帳を読めた（＝ reservationCount は確定値）*/
    ledgerAvailable: true,
    ledgerReason: '',
    ledgerNote: '',
    claimed: held.claimed === true,
    claimedAtIso: held.claimedAtIso,
    reservationCount: mine.length,
    reservationCountText: String(mine.length),
    /** 入金確認と redeem の突き合わせ（waiting / needs_redeem / complete / anomaly）*/
    redeemState: redeemView.state,
    redeemLabel: redeemView.label,
    /** 運営者に出す修復方針（Airtable を直接見に行かせない）*/
    repair: redeemView.needsRepair ? redeemView.repair : '',
    needsRepair: redeemView.needsRepair,
  };
}
