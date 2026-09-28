/**
 * premiumPlusOrders.js — Premium Plus の注文ライフサイクル（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-09-29 MK 決定 B）
 *
 * Premium Plus の申込は Customers の申込列（`RequestedPlan` / `PaymentConfirmed`）を使わない
 * （1 人 1 行なので他商品の申込と衝突する・Plus は単品で会員の プラン を変えない）。
 * そのため入金確認（`confirm-bank-payment`）へ届く経路が無く、購入の確定・計測・クーポン消化が
 * **一度も動いていなかった**。Plus 専用の注文台帳を持ち、Plus 管理画面の「入金確認」で確定させる。
 *
 * ## 状態
 *
 *   awaiting_payment（未確認）──入金確認──▶ confirmed（確認済み）──訂正──▶ revoked（確認の取消）
 *          │
 *          └──取消（未入金・誤申込）──▶ cancelled
 *
 * - 注文 ID は `recordId:対象日`。Plus は 1 日 1 鞍なので**同じ会員・同じ対象日は 1 注文**
 *   （報告の再送・再読込は同じ注文にまとまる）。
 * - 購入の計測キー（orderKey）は `recordId:premium-plus:対象日`（`confirm-bank-payment` と同じ規則）。
 * - 会員の プラン / tier / 権利 / Customers の申込列には**一切触らない**。
 */

export const PP_ORDER_SCHEMA = 1;

export const ORDER_STATUS = Object.freeze({
  AWAITING: 'awaiting_payment',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  REVOKED: 'revoked',
});

export const ORDER_STATUS_LABEL = Object.freeze({
  awaiting_payment: '未確認（入金待ち）',
  confirmed: '確認済み',
  cancelled: '取消（未入金・誤申込）',
  revoked: '確認を取消（訂正）',
});

/** クーポン消化の状態 */
export const COUPON_STATE = Object.freeze({
  NONE: 'none',                 // クーポンなしの注文
  PENDING: 'pending',           // クーポンあり・入金確認前
  REDEEMED: 'redeemed',         // 使用済みにした
  NEEDS_REPAIR: 'needs_repair', // 購入は確定・クーポンを使用済みにできなかった（要修復）
  RELEASED: 'released',         // 注文取消で予約を解除した
});

export const COUPON_STATE_LABEL = Object.freeze({
  none: 'クーポンなし',
  pending: 'クーポンあり（入金確認で使用済みにする）',
  redeemed: 'クーポン使用済み',
  needs_repair: '⚠️ 要修復: クーポンを使用済みにできていません（購入は確定済み）',
  released: '注文取消によりクーポン予約を解除',
});

/** 計測（新系列の購入）の状態 */
export const METRIC_STATE = Object.freeze({
  NOT_YET: 'not_yet',
  COUNTED: 'counted',
  NEEDS_REPAIR: 'needs_repair',
  REMOVED: 'removed',
});

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_MAX = 30;

export function buildOrderId(recordId, saleDate) {
  if (!RECORD_ID_RE.test(String(recordId || '')) || !DATE_RE.test(String(saleDate || ''))) return null;
  return `${recordId}:${saleDate}`;
}

export function parseOrderId(orderId) {
  const m = /^(rec[A-Za-z0-9]{14}):(\d{4}-\d{2}-\d{2})$/.exec(String(orderId || ''));
  return m ? { recordId: m[1], saleDate: m[2] } : null;
}

/** 新系列の購入計測キー（confirm-bank-payment と同じ規則） */
export function purchaseOrderKey(order) {
  return `${order.recordId}:premium-plus:${order.saleDate}`;
}

const withHistory = (order, entry) => ({
  ...order,
  history: [...(Array.isArray(order.history) ? order.history : []), entry].slice(-HISTORY_MAX),
});

/**
 * 振込完了報告の受理で作る注文。
 * @returns {object|null} 識別子が不正なら null（作らない）
 */
/**
 * 本番の実操作確認用の注文（テスト）か。**env `PP_ORDER_CANARY_ENABLED=1` のときだけ作れる**。
 * 対象日は実在しない 2000-01-01 に固定し、実注文（今日以降の対象日）と衝突させない。
 */
export const CANARY_SALE_DATE = '2000-01-01';
export function isOrderCanaryEnabled(env = {}) {
  return String(env.PP_ORDER_CANARY_ENABLED || '') === '1';
}

export function buildNewOrder({ recordId, saleDate, saleLabel, amount, couponId, nowMs, canary = false }) {
  const orderId = buildOrderId(recordId, saleDate);
  if (!orderId) return null;
  const hasCoupon = typeof couponId === 'string' && couponId.trim() !== '';
  return {
    v: PP_ORDER_SCHEMA,
    orderId,
    ...(canary === true ? { canary: true } : {}),
    recordId,
    saleDate,
    saleLabel: typeof saleLabel === 'string' ? saleLabel.slice(0, 80) : null,
    amount: Number.isFinite(amount) ? amount : null,
    couponId: hasCoupon ? couponId.trim() : null,
    status: ORDER_STATUS.AWAITING,
    couponState: hasCoupon ? COUPON_STATE.PENDING : COUPON_STATE.NONE,
    metricState: METRIC_STATE.NOT_YET,
    receivedAt: nowMs,
    lastReportedAt: nowMs,
    reportCount: 1,
    history: [{ at: nowMs, action: 'received', result: 'ok' }],
  };
}

/**
 * 同じ注文への報告の再送。**金額・クーポン・状態は上書きしない**（最初の受理が正）。
 * 確定後・取消後の再送は記録だけ残す。
 */
export function applyReReport(order, { nowMs }) {
  return withHistory({
    ...order,
    lastReportedAt: nowMs,
    reportCount: (Number(order.reportCount) || 1) + 1,
  }, { at: nowMs, action: 're_reported', result: order.status });
}

/**
 * 入金確認できるか（**確定前の判定・副作用なし**）。
 * 一意に確認できないものは全部止める（fail closed）。
 */
export function planConfirm(order, { recordId, orderId, actor }) {
  if (!order) return { ok: false, code: 'order_not_found' };
  if (order.orderId !== orderId) return { ok: false, code: 'order_mismatch' };
  if (!RECORD_ID_RE.test(String(recordId || '')) || order.recordId !== recordId) {
    return { ok: false, code: 'record_mismatch' };
  }
  if (!String(actor || '').trim()) return { ok: false, code: 'missing_actor' };
  if (order.status === ORDER_STATUS.CONFIRMED) return { ok: false, code: 'already_confirmed', idempotent: true };
  if (order.status !== ORDER_STATUS.AWAITING) return { ok: false, code: `not_awaiting:${order.status}` };
  return { ok: true };
}

export function applyConfirmed(order, { nowMs, actor }) {
  return withHistory({
    ...order,
    status: ORDER_STATUS.CONFIRMED,
    confirmedAt: nowMs,
    confirmedBy: String(actor).slice(0, 40),
  }, { at: nowMs, action: 'confirmed', result: 'ok', actor: String(actor).slice(0, 40) });
}

/** 計測結果を反映（already_counted も「数え済み」として正常） */
export function applyMetricResult(order, metric, { nowMs }) {
  const ok = metric && (metric.counted === true || metric.reason === 'already_counted');
  return withHistory({
    ...order,
    metricState: ok ? METRIC_STATE.COUNTED : METRIC_STATE.NEEDS_REPAIR,
    metricReason: ok ? null : String(metric?.reason || 'unknown'),
  }, { at: nowMs, action: 'metric', result: ok ? 'counted' : `needs_repair:${metric?.reason || 'unknown'}` });
}

/** クーポン消化の結果を反映 */
export function applyCouponRedeemResult(order, outcome, { nowMs }) {
  if (order.couponState === COUPON_STATE.NONE) return order;
  const ok = outcome === 'redeemed' || outcome === 'skipped:already_redeemed';
  return withHistory({
    ...order,
    couponState: ok ? COUPON_STATE.REDEEMED : COUPON_STATE.NEEDS_REPAIR,
    couponReason: ok ? null : String(outcome || 'unknown'),
  }, { at: nowMs, action: 'coupon_redeem', result: ok ? 'redeemed' : `needs_repair:${outcome}` });
}

/** 修復できるか（確認済みで、計測かクーポンが要修復のとき） */
export function planRepair(order) {
  if (!order) return { ok: false, code: 'order_not_found' };
  if (order.status !== ORDER_STATUS.CONFIRMED) return { ok: false, code: `not_confirmed:${order.status}` };
  const metric = order.metricState !== METRIC_STATE.COUNTED;
  const coupon = order.couponState === COUPON_STATE.NEEDS_REPAIR;
  if (!metric && !coupon) return { ok: false, code: 'nothing_to_repair', idempotent: true };
  return { ok: true, metric, coupon };
}

/** 未確認の注文を取り消す（未入金・誤申込） */
export function planCancel(order, { reason, actor }) {
  if (!order) return { ok: false, code: 'order_not_found' };
  if (!String(actor || '').trim()) return { ok: false, code: 'missing_actor' };
  if (!String(reason || '').trim()) return { ok: false, code: 'missing_reason' };
  if (order.status === ORDER_STATUS.CANCELLED) return { ok: false, code: 'already_cancelled', idempotent: true };
  if (order.status !== ORDER_STATUS.AWAITING) return { ok: false, code: `not_awaiting:${order.status}` };
  return { ok: true };
}

export function applyCancelled(order, { nowMs, actor, reason, couponOutcome }) {
  let couponState = order.couponState;
  if (order.couponState === COUPON_STATE.PENDING) {
    couponState = couponOutcome === 'released' || couponOutcome === 'no_reservation'
      ? COUPON_STATE.RELEASED : COUPON_STATE.NEEDS_REPAIR;
  }
  return withHistory({
    ...order,
    status: ORDER_STATUS.CANCELLED,
    cancelledAt: nowMs,
    cancelReason: String(reason).slice(0, 200),
    couponState,
    couponReason: couponState === COUPON_STATE.NEEDS_REPAIR ? String(couponOutcome || 'unknown') : null,
  }, { at: nowMs, action: 'cancelled', result: couponOutcome || 'ok', actor: String(actor).slice(0, 40) });
}

/** 確認済みを取り消す（誤って入金確認した訂正） */
export function planRevoke(order, { reason, actor }) {
  if (!order) return { ok: false, code: 'order_not_found' };
  if (!String(actor || '').trim()) return { ok: false, code: 'missing_actor' };
  if (!String(reason || '').trim()) return { ok: false, code: 'missing_reason' };
  if (order.status === ORDER_STATUS.REVOKED) return { ok: false, code: 'already_revoked', idempotent: true };
  if (order.status !== ORDER_STATUS.CONFIRMED) return { ok: false, code: `not_confirmed:${order.status}` };
  return { ok: true };
}

export function applyRevoked(order, { nowMs, actor, reason, metric }) {
  const removed = metric && (metric.removed === true || metric.reason === 'not_found');
  return withHistory({
    ...order,
    status: ORDER_STATUS.REVOKED,
    revokedAt: nowMs,
    revokeReason: String(reason).slice(0, 200),
    metricState: removed ? METRIC_STATE.REMOVED : METRIC_STATE.NEEDS_REPAIR,
    metricReason: removed ? null : String(metric?.reason || 'unknown'),
  }, { at: nowMs, action: 'revoked', result: removed ? 'metric_removed' : `metric_needs_repair:${metric?.reason}`, actor: String(actor).slice(0, 40) });
}

/** 管理画面向けの要約（ラベル付き） */
export function describeOrder(order) {
  if (!order) return null;
  const needsRepair = order.couponState === COUPON_STATE.NEEDS_REPAIR
    || (order.status === ORDER_STATUS.CONFIRMED && order.metricState !== METRIC_STATE.COUNTED)
    || (order.status === ORDER_STATUS.REVOKED && order.metricState !== METRIC_STATE.REMOVED);
  const last = Array.isArray(order.history) && order.history.length ? order.history[order.history.length - 1] : null;
  return {
    ...order,
    statusLabel: (order.canary ? '【テスト】' : '') + (ORDER_STATUS_LABEL[order.status] || order.status),
    couponLabel: COUPON_STATE_LABEL[order.couponState] || order.couponState,
    needsRepair,
    lastAction: last,
  };
}
