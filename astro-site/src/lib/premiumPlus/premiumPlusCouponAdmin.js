/**
 * premiumPlusCouponAdmin.js — Premium Plus クーポンの**管理者操作の binding**（純粋・I/O なし）
 *
 * ## 共通基盤の上の薄い層（2026-08-20 MK 方針）
 *
 * **クーポンは Premium Plus 専用ではない。** 操作の種類・排他規則・状態遷移・監査の書式・
 * fail closed の条件は**すべて共通層 `src/lib/coupons/couponPlatform.js`** にある。
 * このファイルが持つのは **Premium Plus 固有の 2 点だけ**:
 *
 *   1. 保有状態の**置き場所**（Customers の `PremiumPlusReopenCoupon*` 3 列）
 *   2. その 3 列の allow-list / 禁止フィールド
 *
 * ⚠️ **2 商品目を足すときにこのファイルをコピーしない。**
 *    新しい商品は「クーポン定義を `couponCatalog.js` へ 1 件足す」＋
 *    「保有状態の binding を 1 つ書く」だけでよい（判定は共通層が担う）。
 *
 * ## 4 操作（共通層の `COUPON_OPERATION` と 1:1）
 *
 * | 操作 | 何を書くか | 何を書かないか |
 * |---|---|---|
 * | **付与** `grant` | Customers のクーポン 3 列 | 資格 / 停止 / 会員権 / 決済 / 予約台帳 |
 * | **予約取消** `revokeReservation` | 予約行の `Status` / `Notes` のみ | Customers は 1 バイトも触らない |
 * | **誤取得訂正** `correct` | Customers のクーポン 3 列 | 予約台帳 |
 * | **再発行** `reissue` | Customers のクーポン 3 列 | 予約台帳 |
 *
 * ## 監査（誰が・いつ・なぜ・何を）
 *
 * `Source` 列に共通層の書式で 1 行書く。**訂正でも履歴を消さない**
 * （`prev=` に元の取得日時、`from=` に元の取得元）。
 *
 * ⚠️ **限界**: Customers に残るのは**直近 1 回の操作だけ**。
 *    積み上げ式の完全な履歴は `coupons/couponOperationHistory.js` の設計どおり
 *    **専用テーブルが要る**（本番未作成・MK 判断待ち）。
 *
 * ## 顧客の取得経路と混ざらない
 *
 * `admin-*` の値は**管理者操作でしか書かれない**。顧客側 `normalizeCouponSource` の
 * allow-list は `pause-notice` / `coupon-page` のみなので、クライアントが
 * `source: 'admin-grant'` を送っても管理者操作を騙れない。
 */

import {
  PP_REOPEN_COUPON,
  PP_REOPEN_COUPON_FIELDS,
  PP_REOPEN_COUPON_FORBIDDEN_FIELDS,
  assertOnlyCouponFields,
  couponIdWithVersion,
  isReopenCouponEnabled,
  readReopenCoupon,
  resolveCouponCycleStartIso,
  isCurrentCycleReservation,
} from './premiumPlusReopenCoupon.js';
import { COUPON_LIFECYCLE, describeCouponLifecycle } from './premiumPlusCouponReservation.js';
import { OFFER_STATUS } from '../promotions/promotionalOffer.js';
import { isReservationRow } from '../promotions/couponReservationSource.js';
import {
  COUPON_OPERATION,
  COUPON_OPERATION_LABEL,
  COUPON_OPERATION_SOURCE,
  COUPON_REJECT,
  COUPON_REJECT_TEXT,
  PRODUCT_KEY,
  describeCouponAudit as describeAudit,
  describeCouponHistory as describeHistory,
  describeCouponOperationAvailability,
  encodeCouponAudit as encodeAudit,
  parseCouponAudit as parseAudit,
  resolveCouponOperationPlan,
} from '../coupons/couponPlatform.js';

/**
 * 管理者操作の種類。**共通層の語彙をそのまま使う**（Premium Plus 専用の値を作らない）。
 */
export const PP_COUPON_ADMIN_ACTION = Object.freeze({
  GRANT: COUPON_OPERATION.GRANT,
  REVOKE_RESERVATION: COUPON_OPERATION.REVOKE_RESERVATION,
  /**
   * 使い終わったクーポンを締めて、もう一度渡せるようにする。
   * ⚠️ 使用済みの予約行はそのまま残る（過去の利用実績は消えない）。
   */
  CLOSE_USED: COUPON_OPERATION.CLOSE_USED,
  /**
   * 利用予約を使用済みにする。
   * ⚠️ Premium Plus は単品購入で Customers に申込内容を書かないため、
   *    入金確認 Function からは自動で確定できない。**この操作が唯一の完了手段**。
   */
  REDEEM_RESERVATION: COUPON_OPERATION.REDEEM_RESERVATION,
  CORRECT: COUPON_OPERATION.CORRECT,
  REISSUE: COUPON_OPERATION.REISSUE,
});

export const PP_COUPON_ADMIN_ACTION_LABEL = COUPON_OPERATION_LABEL;

/** `Source` 列に書く管理者操作の印（共通層の値） */
export const PP_COUPON_ADMIN_SOURCE = Object.freeze({
  grant: COUPON_OPERATION_SOURCE.grant,
  correct: COUPON_OPERATION_SOURCE.correct,
  reissue: COUPON_OPERATION_SOURCE.reissue,
});

/** 操作を断る理由（共通層の値。呼び出し側は握りつぶさずそのまま返す） */
export const PP_COUPON_ADMIN_REJECT = COUPON_REJECT;
export const PP_COUPON_ADMIN_REJECT_TEXT = COUPON_REJECT_TEXT;

/** 監査行の組み立て（共通層。書式は全商品で同じ） */
export const encodeCouponAudit = encodeAudit;
/** 監査行の読み取り（共通層。顧客取得も管理者操作も同じ関数で読む） */
export const parseCouponAudit = parseAudit;
/** 監査を日本語 1 行に（共通層） */
export const describeCouponAudit = describeAudit;

/**
 * **過去に一度でもこのクーポンを持っていたか**（付与と再発行を排他にするための判定）。
 *
 * 判定そのものは**共通層**（`describeCouponHistory` in couponPlatform）。
 * ここは Premium Plus の 3 列を共通の保有形へ読み替えるだけ。
 *
 * 誤取得訂正は `ClaimedAt` を空にする一方、`Source` に
 * `admin-correct|…|prev=<元の取得日時>` を残すので、**訂正後も履歴ありと判定できる**。
 *
 * @returns {{ had: boolean, prevClaimedAtIso: string, evidence: string }}
 */
export function describeCouponHistory(fields) {
  return describeHistory(readReopenCoupon(fields));
}

/**
 * その会員の予約行だけを取り出す（**他会員の行は一切見ない**）。
 *
 * ⚠️ `cycleStartIso` を渡すと **いま持っている 1 枚**に属する行だけになる。
 *    過去に受け取って使い終わった行を混ぜると、一度使った会員には二度と渡せない。
 */
export function ownReservations({ offerRows, customerRecordId, cycleStartIso = '' }) {
  return (offerRows || []).filter((rec) => isReservationRow(rec)
    && String(((rec && rec.fields) || {}).CustomerRecordId || '') === String(customerRecordId)
    && isCurrentCycleReservation(rec, cycleStartIso));
}

const statusOf = (rec) => String(((rec && rec.fields) || {}).Status || '').trim().toLowerCase();

/**
 * Premium Plus クーポンの **binding**（保有状態をどこに読み書きするか）。
 *
 * ⚠️ ここが**唯一の商品固有部分**。2 商品目は同じ形の binding を 1 つ書くだけでよい。
 * ⚠️ この 3 列は Premium Plus の再募集クーポン専用。**別商品で再利用しない**
 *    （1 会員が複数クーポンを持てないため。共通の保有テーブルは未作成）。
 */
export const PP_COUPON_BINDING = Object.freeze({
  couponId: PP_REOPEN_COUPON.couponId,
  version: PP_REOPEN_COUPON.version,
  productKey: PRODUCT_KEY.PREMIUM_PLUS,

  readHolding: (fields) => readReopenCoupon(fields),

  isStorageEnabled: (env) => isReopenCouponEnabled(env),

  /**
   * 取得を書く（付与 / 再発行）。3 列以外が混ざれば **null**（fail closed）。
   * ⚠️ `operationId` を必ず監査へ載せる（**部分成功の回復に使う**）。
   */
  buildClaimFields: ({
    kind, actor, atIso, reason, prevClaimedAtIso, prevSource, operationId,
  }) => guardFields({
    [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: atIso,
    [PP_REOPEN_COUPON_FIELDS.COUPON_ID]: couponIdWithVersion(),
    [PP_REOPEN_COUPON_FIELDS.SOURCE]: encodeCouponAudit({
      kind, actor, atIso, reason, prevClaimedAtIso, prevSource, operationId,
    }),
  }),

  /** 取得を消す（誤取得訂正）。**履歴は `Source` に畳んで残す** */
  buildClearFields: ({
    kind, actor, atIso, reason, prevClaimedAtIso, prevSource, operationId,
  }) => guardFields({
    // 取得判定は ClaimedAt の有無だけなので、これで未取得になる
    [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: null,
    // ⚠️ 履歴を消さない。元の取得日時・取得元を監査行へ畳んで残す
    [PP_REOPEN_COUPON_FIELDS.SOURCE]: encodeCouponAudit({
      kind, actor, atIso, reason, prevClaimedAtIso, prevSource, operationId,
    }),
  }),
});

/**
 * 予約行から共通層の `ReservationView` を作る（**どの台帳から来たかを共通層に見せない**）。
 */
export function describeReservationView({
  offerRows, ledgerAvailable, customerRecordId, cycleStartIso = '',
}) {
  if (ledgerAvailable !== true) {
    return { available: false, hasIssued: false, hasRedeemed: false, issuedRecordId: null, count: null };
  }
  const mine = ownReservations({ offerRows, customerRecordId, cycleStartIso });
  const issued = mine.find((r) => statusOf(r) === OFFER_STATUS.ISSUED) || null;
  return {
    available: true,
    hasIssued: !!issued,
    hasRedeemed: mine.some((r) => statusOf(r) === OFFER_STATUS.REDEEMED),
    issuedRecordId: issued ? issued.id : null,
    // 予約取消の冪等キーに使う**安定 ID**（レコード ID より意味が安定している）
    issuedOfferKey: issued ? String((issued.fields || {}).OfferKey || '') : null,
    count: mine.length,
  };
}

/**
 * 操作の可否を決める（**サーバー側の唯一の判定**）。
 *
 * 判定本体は**共通層** `resolveCouponOperationPlan`。ここは Premium Plus の
 * 保有状態・予約状態を共通の形へ読み替えて渡すだけ。
 *
 * URL 直打ち・API 直叩きでも必ずここを通す。画面がボタンを出したかは判定材料にしない。
 *
 * ⚠️ **台帳を読めていないときは全操作を断る**（fail closed）。使用済みかどうかを
 *    確認できないまま取得状態を書き換えると、使用済みクーポンを再利用可能にしてしまう。
 *
 * @param {{ action: string, fields: object|null, offerRows: object[]|null,
 *           ledgerAvailable: boolean, env?: object, actor?: string, reason?: string,
 *           nowMs: number, customerRecordId: string }} input
 */
export function resolveCouponAdminPlanFor({
  action, fields, offerRows, ledgerAvailable, env, actor, reason, nowMs, customerRecordId,
} = {}) {
  const plan = resolveCouponOperationPlan({
    operation: action,
    holding: PP_COUPON_BINDING.readHolding(fields),
    reservations: describeReservationView({
      offerRows, ledgerAvailable, customerRecordId,
      cycleStartIso: resolveCouponCycleStartIso(fields),
    }),
    binding: PP_COUPON_BINDING,
    customerRecordId,
    env, actor, reason, nowMs,
  });
  if (!plan.ok) return plan;
  // 呼び出し側（Function）の既存の形に合わせる（target 名だけ読み替える）
  return plan.target === 'holding'
    ? { ...plan, action: plan.operation, target: 'customer' }
    : { ...plan, action: plan.operation };
}

/**
 * 書き込み直前の最終防衛（クーポン 3 列以外が 1 つでも混ざれば **null**）。
 * 資格 / 停止 / 会員権 / 決済 を巻き添えで書いていないことを構造的に確認する。
 */
function guardFields(fields) {
  if (!assertOnlyCouponFields(fields)) return null;
  for (const k of PP_REOPEN_COUPON_FORBIDDEN_FIELDS) if (k in fields) return null;
  return fields;
}

/**
 * 操作前後の状態を 1 つの形にまとめる（**画面に「操作前 → 操作後」を出すため**）。
 * 判定は既存の単一源 `describeCouponLifecycle` に任せる（別ロジックを作らない）。
 */
export function describeCouponAdminState({ fields, offerRows, ledgerAvailable, customerRecordId }) {
  const life = describeCouponLifecycle({
    fields, offerRows: ledgerAvailable ? offerRows : null,
    ledgerAvailable, customerRecordId,
  });
  const held = readReopenCoupon(fields);
  const audit = parseCouponAudit(held.source);
  return {
    lifecycle: life.state,
    lifecycleLabel: life.label,
    ledgerAvailable: life.ledgerAvailable,
    claimed: held.claimed,
    claimedAtIso: held.claimedAtIso,
    couponId: held.couponId,
    reservationCount: life.reservationCount,
    /** 直近 1 回の操作（誰が・いつ・なぜ）。顧客取得ならその旨 */
    audit,
    auditText: describeCouponAudit(audit),
  };
}

/**
 * いまこの会員に対して実行できる操作（**画面のボタン活性はこれだけで決める**）。
 * ⚠️ 画面がボタンを出したかどうかはサーバーの判定材料にしない。
 *    ここは表示用で、実際の可否は `resolveCouponAdminPlanFor` が再判定する。
 */
export function describeCouponAdminActions({
  fields, offerRows, ledgerAvailable, env, customerRecordId,
}) {
  const state = describeCouponAdminState({ fields, offerRows, ledgerAvailable, customerRecordId });
  // 可否の判定は**共通層**。ここは Premium Plus の保有・予約を共通の形へ読み替えるだけ。
  const view = describeCouponOperationAvailability({
    holding: PP_COUPON_BINDING.readHolding(fields),
    reservations: describeReservationView({
      offerRows, ledgerAvailable, customerRecordId,
      cycleStartIso: resolveCouponCycleStartIso(fields),
    }),
    binding: PP_COUPON_BINDING,
    env,
  });
  return {
    state,
    actions: view.actions,
    storageReady: view.storageReady === true,
    /** 過去に一度でも持っていたか（付与 / 再発行のどちらを使うかの根拠）*/
    history: view.history,
    /** 使用済みは操作できない、を画面で必ず伝える（確認できないときは null）*/
    redeemed: view.redeemed,
    lifecycleIsUnknown: state.lifecycle === COUPON_LIFECYCLE.UNKNOWN,
  };
}
