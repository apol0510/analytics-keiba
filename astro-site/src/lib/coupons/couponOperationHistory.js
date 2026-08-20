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
 * 冪等キーは **`couponPlatform.computeCouponOperationId()` が作る**（再エクスポート）。
 *
 * ⚠️ **現在時刻を材料にしない。** 材料は
 *    `productKey` / `couponId` / `version` / `customerRecordId` / `operationType` / `anchor`。
 *    anchor は「その操作が書き換えようとしている状態」なので、
 *    **成功前の再送では同じ値**になり、成功後は操作自体が拒否される。
 *    → 「同じ操作を何度再送しても履歴は 1 件」を時計に依存せず担保する。
 */
export { computeCouponOperationId as computeOperationId } from './couponPlatform.js';

/**
 * 履歴 1 行を組み立てる（**書き込みはしない**）。
 *
 * @returns {{ fields: object, operationId: string }|null}
 *   情報不足・許可外フィールドなら **null**（呼び出し側は行を作らない＝ fail closed）
 */
export function buildHistoryRecord({
  customerRecordId, email, productKey, couponId, version,
  operationType, actor, reason, beforeState, afterState, detail, atIso,
  /** ⚠️ **安定した冪等キー**。呼び出し側（操作の計画）が作った値をそのまま使う */
  operationId,
} = {}) {
  if (!operationId) return null;   // 冪等キーが無ければ**積まない**（fail closed）
  if (!String(customerRecordId || '').trim() || !String(couponId || '').trim()) return null;
  if (!String(atIso || '').trim()) return null;
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
 * 履歴を積む前の判断（**二重履歴の防止**）。
 *
 * ## Airtable には unique 制約が無い
 *
 * 「検索して無ければ create」だけでは、**同時に 2 本走ると両方が「無い」を読む**ため
 * 2 行できる。そこで既存の primitive（`marketing/automationStore.js` の
 * `SET NX` ＋ **墓標**）と同じやり方で、**Redis に OperationId の墓標を立てた 1 本だけ**が
 * create する。新しい外部基盤は増やさない（`UPSTASH_REDIS_REST_*` は本番稼働中）。
 *
 * ```
 * ① 既存行を OperationId で検索  → 有れば何もしない（収束済み）
 * ② SET ak:coupon-history:mark:<opId> <token> NX EX 300 → 取れなければ何もしない
 *                                        （もう 1 本が書いている / 書き終えた）
 * ③ Airtable に 1 行 create
 * ```
 *
 * ⚠️ **墓標に TTL を付ける**。②の後に落ちると行が無いまま鍵が残るので、
 *    TTL 切れのあとに **repair が①で「行が無い」を見て積み直せる**ようにする
 *    （TTL 無しの永久墓標にすると、落ちた 1 回の履歴が永遠に欠ける）。
 * ⚠️ Redis が使えないときは **append しない**（fail closed）。
 *    状態変更は成功しているので `op=` から後で repair できる（下記）。
 *
 * @param {{ record: object|null, existing?: object[], env?: object,
 *           lock?: 'acquired'|'lost'|'unavailable' }} input
 */
export function planHistoryAppend({ record, existing = [], env, lock = 'acquired' } = {}) {
  if (!record) return { append: false, reason: 'no_record' };
  // テーブルが無い / 未有効のあいだは**何もしない**（fail closed）
  if (!isCouponHistoryEnabled(env)) return { append: false, reason: 'history_disabled' };
  // ① 既に積まれていれば何もしない（再送・repair 再実行が 1 件へ収束する）
  const dup = (existing || []).some((r) => String(((r && r.fields) || {}).OperationId || '')
    === record.operationId);
  if (dup) return { append: false, reason: 'already_recorded' };
  // ② 同時実行の勝者だけが書く
  if (lock === 'lost') return { append: false, reason: 'concurrent_writer' };
  if (lock !== 'acquired') return { append: false, reason: 'lock_unavailable' };
  return { append: true, reason: 'ok' };
}

/** Redis の墓標キー（**PII を含めない**。OperationId はハッシュ値） */
export const historyMarkKey = (operationId) => `ak:coupon-history:mark:${operationId}`;

/** 墓標の TTL（秒）。Function の最大実行時間より十分長く、かつ永久にはしない */
export const HISTORY_MARK_TTL_SEC = 300;

/**
 * 状態変更は成功したが**履歴だけ積めなかった**ものを見つける（部分成功の回復）。
 *
 * ## なぜ検出できるか
 *
 * 状態変更のときに監査文字列へ `op=<OperationId>` を残している
 * （`couponPlatform.encodeCouponAudit`）。その `op` が履歴に無ければ
 * 「**状態変更は済み・履歴だけ未記録**」と分かる。
 *
 * ⚠️ **成功済みの顧客状態を、履歴の失敗だけで巻き戻さない。**
 *    直し方は「履歴だけを積み直す」の一方向だけ。
 *
 * @param {{ audits: Array<{ customerRecordId: string, audit: object }>,
 *           rows: object[] }} input
 * @returns {Array<{ customerRecordId: string, operationId: string, audit: object }>}
 */
export function findHistoryRepairTargets({ audits = [], rows = [] } = {}) {
  const recorded = new Set((rows || [])
    .map((r) => String(((r && r.fields) || {}).OperationId || '')).filter(Boolean));
  return (audits || [])
    .filter((a) => a && a.audit && a.audit.operationId && !recorded.has(a.audit.operationId))
    .map((a) => ({
      customerRecordId: a.customerRecordId,
      operationId: a.audit.operationId,
      audit: a.audit,
    }));
}

/**
 * repair で積み直す 1 行を組み立てる。
 *
 * ⚠️ **同じ OperationId** を使うので、何度実行しても 1 件へ収束する。
 * ⚠️ 監査文字列に残っている値（実行者・時刻・理由）から**当時の行を再構成**する。
 *    新しい時刻で作り直さない（履歴が実際の操作時刻からズレる）。
 */
export function buildRepairRecord({
  customerRecordId, email, productKey, couponId, version, audit, beforeState, afterState,
} = {}) {
  const a = audit || {};
  if (!a.operationId) return null;
  return buildHistoryRecord({
    customerRecordId, email, productKey, couponId, version,
    operationType: OPERATION_FROM_SOURCE[a.kind] || a.kind,
    actor: a.actor, reason: a.reason,
    beforeState: beforeState || '', afterState: afterState || '',
    detail: a.raw, atIso: a.atIso, operationId: a.operationId,
  });
}

/** 監査文字列の `kind` → 操作種別 */
const OPERATION_FROM_SOURCE = Object.freeze({
  'admin-grant': 'grant',
  'admin-correct': 'correct',
  'admin-reissue': 'reissue',
  'admin-revoke-reservation': 'revokeReservation',
});

/** 会員 1 人ぶんの履歴を新しい順に並べる（**他会員の行は混ぜない**） */
export function listHistoryForCustomer({ rows, customerRecordId }) {
  return (rows || [])
    .filter((r) => String(((r && r.fields) || {}).CustomerRecordId || '') === String(customerRecordId))
    .sort((a, b) => Date.parse(String(b.fields.OccurredAt || '')) - Date.parse(String(a.fields.OccurredAt || '')));
}
