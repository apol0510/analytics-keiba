/**
 * couponRedeemReconcile.js — 入金確認と redeem の**部分成功**を検出・収束させる（純粋・I/O なし）
 *
 * ## なぜ必要か
 *
 * 入金確認は **Customers**（昇格・有効期限・PaymentConfirmed）を書き、
 * redeem は **PromotionalOffers**（issued → redeemed）を書く。**別テーブル**なので、
 * 片方だけ成功する状態が必ず起こりうる。放置すると
 * 「代金は受け取ったのにクーポンが未使用のまま」「クーポンだけ消費されたのに昇格していない」
 * が誰にも気づかれない。
 *
 * ## 順序（確定）
 *
 * ```
 * Customers の入金確認・昇格が成功 → その後で PromotionalOffers を issued → redeemed
 * ```
 *
 * - **redeem を先に行わない**
 * - **Customers 更新が失敗したら redeem しない**
 * - Customers 成功後に redeem が失敗しても、**成功済みの Customers を巻き戻さない**
 *   （代金は受け取っており、会員権を取り上げるほうが有害）。
 *   `NEEDS_REDEEM` として検出し、再実行 / reconciliation で収束させる。
 */

import { OFFER_STATUS } from '../promotions/promotionalOffer.js';
import { isReservationRow } from '../promotions/couponReservationSource.js';

/** Customers と予約行の突き合わせ結果 */
export const REDEEM_STATE = Object.freeze({
  /** Customers 未確定 + 予約 issued … 通常の入金確認待ち */
  WAITING: 'waiting',
  /** Customers 確定 + 予約 issued … redeem 未完了（**修復対象**）*/
  NEEDS_REDEEM: 'needs_redeem',
  /** Customers 確定 + 予約 redeemed … 正常完了 */
  COMPLETE: 'complete',
  /** Customers 未確定 + 予約 redeemed … **異常**（自動修復しない）*/
  ANOMALY: 'anomaly',
  /** 予約が取り消されている */
  REVOKED: 'revoked',
  /** 予約が無い */
  NO_RESERVATION: 'no_reservation',
});

export const REDEEM_STATE_LABEL = Object.freeze({
  waiting: '入金確認待ち（クーポン利用予約あり）',
  needs_redeem: '⚠️ 要修復: 昇格済みだがクーポンが未使用のまま',
  complete: '完了（クーポン使用済み）',
  anomaly: '🚨 異常: クーポンだけ使用済みで、入金確認・昇格が未確定',
  revoked: 'クーポン予約取消',
  no_reservation: 'クーポン利用予約なし',
});

/** 運営者に出す修復方針（**自動で直さない**ものは手順を示す） */
export const REDEEM_STATE_REPAIR = Object.freeze({
  waiting: 'そのままお待ちください。入金を確認したら PaymentConfirmed にチェックします。',
  needs_redeem: '入金確認をもう一度実行してください。'
    + '昇格は既に完了しているため二重にはならず、クーポンの使用済み化だけが再試行されます。',
  complete: '対応は不要です。',
  anomaly: '⚠️ 自動修復しません。入金の有無を確認したうえで、'
    + '入金済みなら通常どおり PaymentConfirmed で昇格させてください。'
    + '入金が無いなら、クーポンの予約行を取り消して（予約取消）お客様へご連絡ください。'
    + '**クーポンの使用済みを勝手に戻したり、確認なしに昇格させたりしないこと。**',
  revoked: '対応は不要です。必要なら同じクーポンで再度お申し込みいただけます。',
  no_reservation: '対応は不要です。',
});

/**
 * Customers 側が「入金確認・昇格まで確定している」か。
 *
 * `confirm-bank-payment` は 1 回の PATCH で
 * プラン / PlanType / Status='active' / 有効期限 / PaidAt / PaymentEmailSent を確定させる。
 * その結果が乗っているかだけを見る（判定材料を増やさない）。
 */
export function isCustomerSettled(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const plan = String(f['プラン'] ?? '').trim();
  const status = String(f['Status'] ?? '').trim().toLowerCase();
  return plan !== '' && status === 'active';
}

function reservationStatus(reservation) {
  if (!reservation || !isReservationRow(reservation)) return null;
  const f = (reservation && reservation.fields) || {};
  return String(f.Status || '').trim().toLowerCase();
}

/**
 * Customers と予約行を突き合わせて状態を 1 つに決める。
 *
 * @param {{ fields: object|null, reservation: object|null }} input
 * @returns {{ state: string, label: string, repair: string,
 *             customerSettled: boolean, needsRepair: boolean }}
 */
export function resolveRedeemState({ fields, reservation } = {}) {
  const settled = isCustomerSettled(fields);
  const status = reservationStatus(reservation);

  let state = REDEEM_STATE.NO_RESERVATION;
  if (status === OFFER_STATUS.REVOKED) state = REDEEM_STATE.REVOKED;
  else if (status === OFFER_STATUS.ISSUED) {
    state = settled ? REDEEM_STATE.NEEDS_REDEEM : REDEEM_STATE.WAITING;
  } else if (status === OFFER_STATUS.REDEEMED) {
    state = settled ? REDEEM_STATE.COMPLETE : REDEEM_STATE.ANOMALY;
  }
  return {
    state,
    label: REDEEM_STATE_LABEL[state],
    repair: REDEEM_STATE_REPAIR[state],
    customerSettled: settled,
    // 運営者が拾うべき状態（要修復 / 異常）
    needsRepair: state === REDEEM_STATE.NEEDS_REDEEM || state === REDEEM_STATE.ANOMALY,
  };
}

/** confirm の実行計画（**順序を構造で守る**） */
export const REDEEM_ACTION = Object.freeze({
  /** 何もしない */
  NONE: 'none',
  /** 予約を redeemed にするだけ（Customers は触らない） */
  REDEEM_ONLY: 'redeem_only',
});

/**
 * 入金確認のあとに何をするかを決める。
 *
 * ⚠️ **Customers が確定していなければ絶対に redeem しない**（順序をここで守る）。
 * ⚠️ 既に redeemed / revoked なら何もしない（**二重 redeem を構造的に防ぐ**）。
 * ⚠️ Customers 側の再更新は**この計画に含めない**。再実行しても
 *    二重昇格・有効期限の再延長・二重メールが起きないのは、
 *    既存の `confirm-bank-payment` の冪等性（`Requested*` クリア）が担保している。
 *
 * @param {{ fields: object|null, reservation: object|null, customerUpdateOk?: boolean }} input
 * @returns {{ action: string, reason: string }}
 */
export function planRedeemAfterConfirm({ fields, reservation, customerUpdateOk = true } = {}) {
  // Customers の更新に失敗した回は redeem しない（先に redeem しない・巻き戻しもしない）
  if (customerUpdateOk !== true) return { action: REDEEM_ACTION.NONE, reason: 'customer_update_failed' };

  const view = resolveRedeemState({ fields, reservation });
  if (view.state === REDEEM_STATE.NEEDS_REDEEM) {
    // 昇格済み + 予約 issued → **redeem だけ**を再試行する
    return { action: REDEEM_ACTION.REDEEM_ONLY, reason: 'settled_pending_redeem' };
  }
  if (view.state === REDEEM_STATE.WAITING) {
    return { action: REDEEM_ACTION.NONE, reason: 'customer_not_settled' };
  }
  if (view.state === REDEEM_STATE.ANOMALY) {
    // 勝手に昇格させない・redeemed を戻さない。運営者へ出すだけ
    return { action: REDEEM_ACTION.NONE, reason: 'anomaly_requires_operator' };
  }
  return { action: REDEEM_ACTION.NONE, reason: view.state };
}

/**
 * 修復が必要な会員だけを抜き出す（reconciliation の入口）。
 * **他会員には触れない**: 渡された行の突き合わせ結果を返すだけ。
 */
export function listRepairTargets(entries) {
  return (entries || [])
    .map((e) => ({ ...e, view: resolveRedeemState({ fields: e.fields, reservation: e.reservation }) }))
    .filter((e) => e.view.needsRepair);
}
