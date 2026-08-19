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
  /**
   * 予約台帳を**読めていない**（gate off / 読み取り失敗 / 打ち切り）。
   * ⚠️ `NO_RESERVATION`（読めた結果 0 件）と**混同しない**。
   */
  UNKNOWN: 'unknown',
});

export const REDEEM_STATE_LABEL = Object.freeze({
  waiting: '入金確認待ち（クーポン利用予約あり）',
  needs_redeem: '⚠️ 要修復: 昇格済みだがクーポンが未使用のまま',
  complete: '完了（クーポン使用済み）',
  anomaly: '🚨 異常: クーポンだけ使用済みで、入金確認・昇格が未確定',
  revoked: 'クーポン予約取消',
  no_reservation: 'クーポン利用予約なし',
  unknown: '確認できない（予約台帳を読めていません）',
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
  unknown: '予約台帳を読めていないため、利用状態を確定できません。'
    + '「予約なし」「対応不要」と判断せず、台帳を読める状態に戻してから確認してください。'
    + 'この状態では redeem も修復も実行しません（読めないまま書かない）。',
});

/**
 * Customers 側が「**この申込の**入金確認・昇格まで確定している」か。
 *
 * `confirm-bank-payment` は 1 回の PATCH で
 * プラン / PlanType / Status='active' / 有効期限 / PaidAt / PaymentEmailSent を確定させ、
 * **同時に `Requested*` をクリアする**（`bankPaymentFlow.js` の冪等性）。
 *
 * ⚠️ **「有効な会員である」だけでは確定と言えない。**
 *    Premium Plus を買うのは**既に active な三連複会員**なので、
 *    プランと Status だけを見ると申込した瞬間から「確定済み」に見え、
 *    利用予約（issued）が**常に `needs_redeem`＝要修復に化ける**
 *    （＝ admin で「利用予約（入金確認待ち）」が一度も出ない）。
 *    未処理の申込が残っているあいだ（`RequestedPlan` が空でない）は**未確定**とみなす。
 */
export function isCustomerSettled(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const plan = String(f['プラン'] ?? '').trim();
  const status = String(f['Status'] ?? '').trim().toLowerCase();
  if (plan === '' || status !== 'active') return false;
  // 承認待ちの申込が残っている = この申込の入金確認はまだ済んでいない
  return String(f['RequestedPlan'] ?? '').trim() === '';
}

function reservationStatus(reservation) {
  if (!reservation || !isReservationRow(reservation)) return null;
  const f = (reservation && reservation.fields) || {};
  return String(f.Status || '').trim().toLowerCase();
}

/**
 * Customers と予約行を突き合わせて状態を 1 つに決める。
 *
 * ⚠️ **`ledgerAvailable === false` は「予約が無い」ではない。**
 *    台帳を読めていない（gate off / 読み取り失敗 / 打ち切り）ときに
 *    `reservation: null` をそのまま流すと `no_reservation`＝「利用予約なし・対応不要」と
 *    断定してしまう。読めていないなら `UNKNOWN` を返し、判断させない。
 *
 * @param {{ fields: object|null, reservation: object|null, ledgerAvailable?: boolean }} input
 * @returns {{ state: string, label: string, repair: string, ledgerAvailable: boolean,
 *             customerSettled: boolean, needsRepair: boolean }}
 */
export function resolveRedeemState({ fields, reservation, ledgerAvailable = true } = {}) {
  const settled = isCustomerSettled(fields);
  // 台帳が読めていないなら**予約の有無を判定しない**（0 件と断定しない）
  if (ledgerAvailable !== true) {
    return {
      state: REDEEM_STATE.UNKNOWN,
      label: REDEEM_STATE_LABEL[REDEEM_STATE.UNKNOWN],
      repair: REDEEM_STATE_REPAIR[REDEEM_STATE.UNKNOWN],
      ledgerAvailable: false,
      customerSettled: settled,
      // 「要修復」とも「対応不要」とも言えない。確認できないことだけを返す
      needsRepair: false,
    };
  }
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
    ledgerAvailable: true,
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
 * ⚠️ **予約台帳を読めていない回も redeem しない**（`ledgerAvailable !== true`）。
 *    読めないまま「予約が無い」と決めつけて進めると、実在する予約を素通りさせる。
 *
 * @param {{ fields: object|null, reservation: object|null, customerUpdateOk?: boolean,
 *           ledgerAvailable?: boolean }} input
 * @returns {{ action: string, reason: string }}
 */
export function planRedeemAfterConfirm({
  fields, reservation, customerUpdateOk = true, ledgerAvailable = true,
} = {}) {
  // Customers の更新に失敗した回は redeem しない（先に redeem しない・巻き戻しもしない）
  if (customerUpdateOk !== true) return { action: REDEEM_ACTION.NONE, reason: 'customer_update_failed' };

  const view = resolveRedeemState({ fields, reservation, ledgerAvailable });
  // 台帳が読めていない回は**何もしない**（確認できないまま書かない）
  if (view.state === REDEEM_STATE.UNKNOWN) {
    return { action: REDEEM_ACTION.NONE, reason: 'ledger_unavailable' };
  }
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
    .map((e) => ({
      ...e,
      // ledgerAvailable が未指定なら既定 true（読めている）。false の行は UNKNOWN になり
      // needsRepair=false なので、**確認できない会員を修復対象へ混ぜない**
      view: resolveRedeemState({
        fields: e.fields, reservation: e.reservation, ledgerAvailable: e.ledgerAvailable,
      }),
    }))
    .filter((e) => e.view.needsRepair);
}
