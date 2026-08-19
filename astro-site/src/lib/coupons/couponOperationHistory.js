/**
 * couponOperationHistory.js — クーポン操作の **append-only 履歴**（純粋・I/O なし）
 *
 * ## 状態: **設計のみ。本番テーブルは未作成で、書き込みは行わない（fail closed）**
 *
 * 既存 schema では**直近 1 回の操作しか残せない**（Customers の 1 列に畳むため）。
 * 完全な履歴には**本番 schema 変更**が要る。
 * ⚠️ **テーブルは MK の指示があるまで作らない。** このモジュールは
 *    「作るならこの形」を固定し、`isCouponHistoryEnabled(env)` が false のあいだ
 *    `buildHistoryRecord()` の結果を**誰も書かない**ことをテストで守るためにある。
 *
 * ## なぜ Premium Plus 専用テーブルにしないか（2026-08-20 MK 確定）
 *
 * クーポンは**今後ほかの商品でも使う**。商品ごとに履歴テーブルを増やすと、
 * admin も集計も商品の数だけ分岐が増える。**1 テーブルに商品識別子を持たせる**。
 *
 * ## なぜ `PromotionalOffers` に混ぜないか
 *
 * あの台帳は「価格の入った購入条件」で、`offerFilterModel.js` / `customerTimeline.js` /
 * `recommendedActions.js` が `Status` / `ExpiresAt` / `OfferPrice` で顧客を分類している。
 * 価格の無い監査行を混ぜると**嘘の分類**が生まれる（利用予約行を `Source` で
 * 除外しているのと同じ理由）。**別テーブルにする。**
 *
 * ## append-only の意味
 *
 * - 1 操作 = 1 行。**既存行を更新しない・削除しない**
 * - 訂正も「訂正した」という行を**足す**（前の行を消さない）
 * - 冪等キー `OperationId` で**同じ操作を二重に積まない**
 */

/** テーブル名（**まだ本番に存在しない**） */
export const COUPON_HISTORY_TABLE = 'CouponOperationHistory';

/**
 * 書き込みが有効か。**本番テーブルを作り、env を立てるまで false**（fail closed）。
 * 既存の gate（`COMEBACK_OFFER_TABLE_READY` 等）と同じ考え方で**別に**持つ。
 */
export function isCouponHistoryEnabled(env) {
  return !!env && env.COUPON_HISTORY_TABLE_READY === '1';
}

/**
 * 1 行のフィールド（**商品に依存しない**）。
 *
 * | 列 | 型 | 意味 |
 * |---|---|---|
 * | `OperationId` | single line text | 冪等キー。同じ操作は 1 行のまま |
 * | `OccurredAt` | dateTime | 操作時刻（ISO・UTC）|
 * | `CustomerRecordId` | single line text | **どの会員か**（他会員と混ざらない鍵）|
 * | `Email` | email | 参照用（正本は CustomerRecordId）|
 * | `ProductKey` | single line text | **どの商品か**（`PRODUCT_KEY`）|
 * | `CouponId` | single line text | どのクーポンか |
 * | `CouponVersion` | number | クーポン定義の版 |
 * | `OperationType` | single line text | `COUPON_OPERATION` の値 |
 * | `Actor` | single line text | 実行者（管理者名 / `customer`）|
 * | `Reason` | long text | 操作理由 |
 * | `BeforeState` | single line text | 操作前のライフサイクル状態 |
 * | `AfterState` | single line text | 操作後のライフサイクル状態 |
 * | `Detail` | long text | 監査行（`admin-grant\|by=…` の生値）・補足 |
 *
 * ⚠️ **課金・権限の列は 1 つも持たない**（履歴が権利の根拠になってはいけない）。
 */
export const COUPON_HISTORY_FIELDS = Object.freeze([
  'OperationId', 'OccurredAt', 'CustomerRecordId', 'Email',
  'ProductKey', 'CouponId', 'CouponVersion',
  'OperationType', 'Actor', 'Reason', 'BeforeState', 'AfterState', 'Detail',
]);

/** 履歴に**絶対に現れてはいけない**名前（Customers 側の課金・権限フィールド） */
export const COUPON_HISTORY_FORBIDDEN_FIELDS = Object.freeze([
  'プラン', 'Plan', 'PlanType', 'Status', '有効期限', 'ValidUntil',
  'PaidAt', 'PaymentConfirmed', 'PaymentEmailSent', 'LifetimeSanrenpuku',
  'RequestedPlan', 'RequestedPlanType', 'RequestedAmount', 'SessionVersion',
  'PremiumPlusEligibility', 'PremiumPlusSalePaused',
]);

const ALLOW = new Set(COUPON_HISTORY_FIELDS);

/** fields が履歴の許可列だけか（書き込み直前の最終防衛） */
export function assertOnlyHistoryFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  if (keys.length === 0) return false;
  return keys.every((k) => ALLOW.has(k));
}

/**
 * 冪等キー。同じ会員・同じクーポン・同じ操作・同じ時刻なら常に同じ値。
 * ⚠️ 乱数を使わない（再実行で二重に積まないため）。
 */
export function computeOperationId({ customerRecordId, couponId, version, operationType, atIso }) {
  const parts = [customerRecordId, couponId, version, operationType, atIso]
    .map((v) => String(v ?? '').trim());
  if (parts.some((v) => !v)) return null;
  return parts.join('|').slice(0, 255);
}

/**
 * 履歴 1 行を組み立てる（**書き込みはしない**）。
 *
 * @returns {{ fields: object, operationId: string }|null}
 *   情報不足・許可外フィールドなら **null**（呼び出し側は行を作らない＝ fail closed）
 */
export function buildHistoryRecord({
  customerRecordId, email, productKey, couponId, version,
  operationType, actor, reason, beforeState, afterState, detail, atIso,
} = {}) {
  const operationId = computeOperationId({
    customerRecordId, couponId, version, operationType, atIso,
  });
  if (!operationId) return null;
  const fields = {
    OperationId: operationId,
    OccurredAt: String(atIso),
    CustomerRecordId: String(customerRecordId),
    Email: String(email || ''),
    ProductKey: String(productKey || ''),
    CouponId: String(couponId),
    CouponVersion: Number(version),
    OperationType: String(operationType),
    Actor: String(actor || ''),
    Reason: String(reason || ''),
    BeforeState: String(beforeState || ''),
    AfterState: String(afterState || ''),
    Detail: String(detail || ''),
  };
  if (!assertOnlyHistoryFields(fields)) return null;
  for (const k of COUPON_HISTORY_FORBIDDEN_FIELDS) if (k in fields) return null;
  return { fields, operationId };
}

/**
 * 既存行と突き合わせて**積んでよいか**を決める（二重履歴の防止）。
 * @param {{ record: object, existing: object[] }} input
 */
export function planHistoryAppend({ record, existing = [], env } = {}) {
  if (!record) return { append: false, reason: 'no_record' };
  // テーブルが無い / 未有効のあいだは**何もしない**（fail closed）
  if (!isCouponHistoryEnabled(env)) return { append: false, reason: 'history_disabled' };
  const dup = (existing || []).some((r) => String(((r && r.fields) || {}).OperationId || '')
    === record.operationId);
  if (dup) return { append: false, reason: 'already_recorded' };
  return { append: true, reason: 'ok' };
}

/** 会員 1 人ぶんの履歴を新しい順に並べる（**他会員の行は混ぜない**） */
export function listHistoryForCustomer({ rows, customerRecordId }) {
  return (rows || [])
    .filter((r) => String(((r && r.fields) || {}).CustomerRecordId || '') === String(customerRecordId))
    .sort((a, b) => Date.parse(String(b.fields.OccurredAt || '')) - Date.parse(String(a.fields.OccurredAt || '')));
}
