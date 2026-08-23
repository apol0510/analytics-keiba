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
  /** 予約 issued … 入金確認待ち */
  WAITING: 'waiting',
  /** 予約 issued のまま長く残っている … 記録漏れの疑い（**修復対象**）*/
  NEEDS_REDEEM: 'needs_redeem',
  /** 予約 redeemed … 完了 */
  COMPLETE: 'complete',
  /**
   * 使われていない状態（**現在は発生しない**）。
   * 旧: 「Customers 未確定 + 予約 redeemed」。Premium Plus では入金確認の有無を
   * Customers から判定できないため、この推定はしない（値は後方互換のため残す）。
   */
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
  needs_redeem: '⚠️ 要確認: 利用予約が長く残ったままです',
  complete: '完了（クーポン使用済み）',
  anomaly: '🚨 異常: クーポンだけ使用済みで、入金確認・昇格が未確定',
  revoked: 'クーポン予約取消',
  no_reservation: 'クーポン利用予約なし',
  unknown: '確認できない（予約台帳を読めていません）',
});

/** 運営者に出す修復方針（**自動で直さない**ものは手順を示す） */
export const REDEEM_STATE_REPAIR = Object.freeze({
  waiting: '入金を確認したら「利用予約を使用済みにする」を実行してください。'
    + '（Premium Plus は単品購入で申込内容を顧客レコードに書かないため、'
    + '入金確認の Automation では自動的に使用済みになりません）',
  needs_redeem: '入金を確認できているなら「利用予約を使用済みにする」を、'
    + '入金が無いなら「利用予約を取り消す」を実行してください。'
    + '放置すると、この会員は同じクーポンで申し込み直せないままになります。',
  complete: '対応は不要です。',
  anomaly: '⚠️ 自動修復しません。入金の有無を確認してから対応してください。'
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
 * 判定は **`docs/BANK_TRANSFER_FLOW.md` / `payments/bankPaymentFlow.js` の正本**に合わせる。
 * 3 条件を**すべて**満たしたときだけ確定とみなす（**fail closed**）:
 *
 * | 条件 | 根拠 |
 * |---|---|
 * | `Status === 'active'`（かつプランが空でない）| `buildConfirmationFields()` が承認時に確定させる |
 * | `RequestedPlan` が**空** | 承認時に `Requested*` をクリアする（冪等性）|
 * | `PaymentConfirmed === true` | 承認済みの痕跡として**残る**（クリアしない）|
 *
 * ⚠️ **`Status='active'` だけでは絶対に確定と判定しない。**
 *    申込の時点で既存 active 会員は `Status='active'` のままであり、
 *    `buildApplicationFields()` は `RequestedPlan` を書き `PaymentConfirmed=false` を置く。
 *    プランと Status だけを見ると**申込した瞬間から「確定済み」に見え**、
 *    利用予約（issued）が**常に `needs_redeem`＝要修復に化ける**
 *    （＝ admin で「利用予約（入金確認待ち）」が一度も出ない）。
 *
 * ⚠️ `RequestedPlan` が空でも `PaymentConfirmed !== true` なら**確定としない**。
 *    入金確認を経ていない active（手動 active 化・旧データ等）を
 *    「この申込の入金確認が済んだ」と読み替えないため。
 *    その結果 `redeemed` の予約行と組み合わさると `anomaly` として運営者に出る
 *    （**自動修復しない**のが正しい扱い）。
 */
export function isCustomerSettled(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const plan = String(f['プラン'] ?? '').trim();
  const status = String(f['Status'] ?? '').trim().toLowerCase();
  if (plan === '' || status !== 'active') return false;
  // 承認待ちの申込が残っている = この申込の入金確認はまだ済んでいない
  if (String(f['RequestedPlan'] ?? '').trim() !== '') return false;
  // 承認済みの痕跡。confirm-bank-payment の認可と**同じ読み方**（厳密に true のみ）
  return f['PaymentConfirmed'] === true;
}

/**
 * 予約が長く `issued` のまま残っている日数のしきい値。
 *
 * クーポンの利用期間（14 日）と同じにする。これを超えて入金確認の記録が無いなら、
 * 「使用済みにし忘れた」か「入金が無かった」のどちらかで、**どちらも人の判断が要る**。
 */
export const RESERVATION_STALE_DAYS = 14;

/** 報告受理（`StartsAt`）から `RESERVATION_STALE_DAYS` 以上経った `issued` か */
export function isReservationStale(reservation, nowMs) {
  const f = (reservation && reservation.fields) || {};
  const started = Date.parse(String(f.StartsAt || ''));
  if (!Number.isFinite(started) || !Number.isFinite(nowMs)) return false;
  return nowMs - started >= RESERVATION_STALE_DAYS * 24 * 60 * 60 * 1000;
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
export function resolveRedeemState({
  fields, reservation, ledgerAvailable = true, nowMs = Date.now(),
} = {}) {
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

  // ── なぜ Customers の「確定」で判定しないか（2026-08-23 修正）────────────
  // Premium Plus は**単品購入で Customers を書き換えない**（`bank-transfer-application.js`
  // の Airtable 登録ブロックは Plus を除外している）。つまり `RequestedPlan` は書かれず、
  // 入金確認 Function も「申込フォーム未経由」として**昇格ごとスキップ**する。
  //
  // その状態で `isCustomerSettled()` を使うと、**既に有料会員である申込者は
  // 申し込んだ瞬間から「確定済み」に見え、予約ができた途端に「要修復」へ化ける**
  // （入金前なのに修復を促す誤警告）。逆に、使用済みにしても Customers は動かないので
  // 「異常」にも化ける。どちらもこの商品では**判定材料が存在しない**。
  //
  // したがって予約の状態は**予約行そのもの**から決め、完了の合図は
  // 管理画面の「利用予約を使用済みにする」操作にする。
  // 代わりに、**長く残りっぱなしの予約**という実データで拾える事実だけを修復対象にする。
  let state = REDEEM_STATE.NO_RESERVATION;
  if (status === OFFER_STATUS.REVOKED) state = REDEEM_STATE.REVOKED;
  else if (status === OFFER_STATUS.ISSUED) {
    state = isReservationStale(reservation, nowMs)
      ? REDEEM_STATE.NEEDS_REDEEM : REDEEM_STATE.WAITING;
  } else if (status === OFFER_STATUS.REDEEMED) {
    state = REDEEM_STATE.COMPLETE;
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

  // 台帳が読めていない回は**何もしない**（確認できないまま書かない）
  if (ledgerAvailable !== true) {
    return { action: REDEEM_ACTION.NONE, reason: 'ledger_unavailable' };
  }
  // ⚠️ ここは **Customers の入金確認から redeem を導ける商品**のための計画。
  //    Premium Plus は単品購入で Customers に申込内容を書かないため**この経路には乗らない**
  //    （入金確認 Function が「申込フォーム未経由」として昇格ごとスキップする）。
  //    Plus の完了は管理画面の「利用予約を使用済みにする」で確定させる。
  //    そのため表示用の `resolveRedeemState` とは判定を分け、ここでは Customers を直接見る。
  const settled = isCustomerSettled(fields);
  const status = reservationStatus(reservation);

  if (status === OFFER_STATUS.REDEEMED) {
    // 勝手に redeemed を戻さない。未確定なら運営者へ出すだけ
    return settled
      ? { action: REDEEM_ACTION.NONE, reason: REDEEM_STATE.COMPLETE }
      : { action: REDEEM_ACTION.NONE, reason: 'anomaly_requires_operator' };
  }
  if (status === OFFER_STATUS.ISSUED) {
    // 昇格済み + 予約 issued → **redeem だけ**を再試行する
    return settled
      ? { action: REDEEM_ACTION.REDEEM_ONLY, reason: 'settled_pending_redeem' }
      : { action: REDEEM_ACTION.NONE, reason: 'customer_not_settled' };
  }
  if (status === OFFER_STATUS.REVOKED) return { action: REDEEM_ACTION.NONE, reason: REDEEM_STATE.REVOKED };
  return { action: REDEEM_ACTION.NONE, reason: REDEEM_STATE.NO_RESERVATION };
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
