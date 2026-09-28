/**
 * premiumPlusOrderService.js — Premium Plus 注文台帳の I/O と操作（Redis・依存は注入）
 *
 * 判定は `premiumPlusOrders.js`（純粋）。ここは読む・書く・順番を守るだけ。
 *
 * | キー | 型 | 中身 |
 * |---|---|---|
 * | `ak:pp:orders:v1` | HASH | orderId（`recordId:対象日`）→ 注文 JSON |
 * | `ak:pp:orders:v1:lock:{orderId}` | STRING（NX・EX 120）| 入金確認・修復・取消・訂正の同時実行防止 |
 *
 * ⚠️ 入金確認の順番（**巻き戻さない**）:
 *   ① ロック取得 → ② 注文を読み直して判定 → ③ 状態を confirmed で保存（ここで確定）
 *   → ④ 新系列の購入を記録（orderKey で冪等）→ ⑤ クーポンを使用済み（あれば）→ ⑥ 結果を保存
 *   ④⑤ が失敗しても ③ は戻さない。注文に `needs_repair` を残し、修復操作で再実行する（どちらも冪等）。
 */
import {
  buildNewOrder, applyReReport, planConfirm, applyConfirmed, applyMetricResult, applyCouponRedeemResult,
  planRepair, planCancel, applyCancelled, planRevoke, applyRevoked, purchaseOrderKey, describeOrder,
  COUPON_STATE, METRIC_STATE, CANARY_SALE_DATE, isOrderCanaryEnabled, ORDER_STATUS,
} from './premiumPlusOrders.js';

export const PP_ORDERS_KEY = 'ak:pp:orders:v1';
export const PP_ORDER_LOCK_PREFIX = `${PP_ORDERS_KEY}:lock:`;
const LOCK_TTL_SEC = 120;

function parse(v) {
  if (v === null || v === undefined) return null;
  try { return JSON.parse(typeof v === 'string' ? v : String(v)); } catch { return null; }
}

export function createOrderStore({ redisCmd }) {
  if (typeof redisCmd !== 'function') throw new Error('premiumPlusOrderService: redisCmd が必要です');
  const cmd = (args) => redisCmd(args.map(String));
  return {
    async get(orderId) { return parse(await cmd(['HGET', PP_ORDERS_KEY, orderId])); },
    async save(order) { await cmd(['HSET', PP_ORDERS_KEY, order.orderId, JSON.stringify(order)]); },
    async createIfAbsent(order) {
      return Number(await cmd(['HSETNX', PP_ORDERS_KEY, order.orderId, JSON.stringify(order)])) === 1;
    },
    async list() {
      const raw = (await cmd(['HGETALL', PP_ORDERS_KEY])) || [];
      const out = [];
      if (Array.isArray(raw)) {
        for (let i = 0; i + 1 < raw.length; i += 2) { const o = parse(raw[i + 1]); if (o) out.push(o); }
      } else if (raw && typeof raw === 'object') {
        for (const v of Object.values(raw)) { const o = parse(v); if (o) out.push(o); }
      }
      return out;
    },
    async lock(orderId, nowMs) {
      const r = await cmd(['SET', `${PP_ORDER_LOCK_PREFIX}${orderId}`, String(nowMs), 'NX', 'EX', String(LOCK_TTL_SEC)]);
      return r === 'OK' || r === true;
    },
    async unlock(orderId) { await cmd(['DEL', `${PP_ORDER_LOCK_PREFIX}${orderId}`]); },
    async remove(orderId) { return Number(await cmd(['HDEL', PP_ORDERS_KEY, orderId])) === 1; },
  };
}

/**
 * 振込完了報告の受理で注文を作る（**例外を投げない**。申込を止めない）。
 * 同じ注文への再送は受理記録だけ増やし、金額・クーポン・状態は変えない。
 */
export async function recordOrderOnApplication({ store, input }) {
  try {
    const fresh = buildNewOrder(input);
    if (!fresh) return { outcome: 'invalid_input' };
    if (await store.createIfAbsent(fresh)) return { outcome: 'created', orderId: fresh.orderId };
    const cur = await store.get(fresh.orderId);
    if (!cur) return { outcome: 'read_failed', orderId: fresh.orderId };
    await store.save(applyReReport(cur, { nowMs: input.nowMs }));
    return { outcome: 're_reported', orderId: fresh.orderId, status: cur.status };
  } catch {
    return { outcome: 'failed_error' };
  }
}

async function withLock(store, orderId, nowMs, fn) {
  let locked = false;
  try {
    locked = await store.lock(orderId, nowMs);
  } catch {
    return { ok: false, status: 503, code: 'store_unavailable' };
  }
  if (!locked) return { ok: false, status: 409, code: 'in_progress' };
  try {
    return await fn();
  } finally {
    try { await store.unlock(orderId); } catch { /* TTL で自然に外れる */ }
  }
}

const CODE_STATUS = {
  order_not_found: 404, order_mismatch: 409, record_mismatch: 409, missing_actor: 400, missing_reason: 400,
};
const reject = (plan) => ({
  ok: false,
  status: plan.idempotent ? 200 : (CODE_STATUS[plan.code] || 409),
  code: plan.code,
  idempotent: plan.idempotent === true,
});

/**
 * @typedef {object} OrderDeps
 * @property {(i:{recordId:string, orderKey:string, productPlan:string, nowMs:number}) => Promise<{counted:boolean, reason?:string|null}>} recordPurchase
 * @property {(i:{recordId:string, orderKey:string}) => Promise<{removed:boolean, reason?:string|null}>} revokePurchase
 * @property {(i:{recordId:string, nowMs:number}) => Promise<string>} redeemCoupon  outcome
 * @property {(i:{recordId:string, nowMs:number, reason:string}) => Promise<string>} releaseCoupon outcome
 */

async function runMetric(order, deps, nowMs) {
  let metric;
  try {
    metric = await deps.recordPurchase({
      recordId: order.recordId, orderKey: purchaseOrderKey(order), productPlan: 'Premium Plus', nowMs,
    });
  } catch {
    metric = { counted: false, reason: 'record_failed' };
  }
  return applyMetricResult(order, metric, { nowMs });
}

async function runCoupon(order, deps, nowMs) {
  let outcome;
  try { outcome = await deps.redeemCoupon({ recordId: order.recordId, nowMs }); } catch { outcome = 'failed_error'; }
  return applyCouponRedeemResult(order, outcome, { nowMs });
}

/** 入金確認（購入確定）。**1 注文 1 回**。 */
export async function confirmOrder({ store, deps, orderId, recordId, actor, nowMs }) {
  return withLock(store, orderId, nowMs, async () => {
    const cur = await store.get(orderId);
    const plan = planConfirm(cur, { recordId, orderId, actor });
    if (!plan.ok) return { ...reject(plan), order: describeOrder(cur) };
    // ③ ここで確定（以後の失敗で戻さない）
    let order = applyConfirmed(cur, { nowMs, actor });
    await store.save(order);
    order = await runMetric(order, deps, nowMs);
    if (order.couponState === COUPON_STATE.PENDING) order = await runCoupon(order, deps, nowMs);
    await store.save(order);
    return { ok: true, status: 200, code: order.metricState === METRIC_STATE.COUNTED && order.couponState !== COUPON_STATE.NEEDS_REPAIR ? 'confirmed' : 'confirmed_needs_repair', order: describeOrder(order) };
  });
}

/** 要修復の再実行（計測・クーポンとも冪等） */
export async function repairOrder({ store, deps, orderId, nowMs }) {
  return withLock(store, orderId, nowMs, async () => {
    const cur = await store.get(orderId);
    const plan = planRepair(cur);
    if (!plan.ok) return { ...reject(plan), order: describeOrder(cur) };
    let order = cur;
    if (plan.metric) order = await runMetric(order, deps, nowMs);
    if (plan.coupon) order = await runCoupon(order, deps, nowMs);
    await store.save(order);
    const described = describeOrder(order);
    return { ok: true, status: 200, code: described.needsRepair ? 'repair_incomplete' : 'repaired', order: described };
  });
}

/** 未確認の注文を取り消す（未入金・誤申込）。クーポン予約があれば解除する */
export async function cancelOrder({ store, deps, orderId, actor, reason, nowMs }) {
  return withLock(store, orderId, nowMs, async () => {
    const cur = await store.get(orderId);
    const plan = planCancel(cur, { reason, actor });
    if (!plan.ok) return { ...reject(plan), order: describeOrder(cur) };
    let couponOutcome = null;
    if (cur.couponState === COUPON_STATE.PENDING) {
      try { couponOutcome = await deps.releaseCoupon({ recordId: cur.recordId, nowMs, reason: String(reason) }); } catch { couponOutcome = 'failed_error'; }
    }
    const order = applyCancelled(cur, { nowMs, actor, reason, couponOutcome });
    await store.save(order);
    return { ok: true, status: 200, code: 'cancelled', order: describeOrder(order) };
  });
}

/**
 * 確認済みを取り消す（誤って入金確認した訂正）。新系列の購入から外す。
 * ⚠️ 使用済みにしたクーポンは**自動では戻さない**（戻すかは運営判断。クーポン管理の訂正操作で行う）。
 */
export async function revokeOrder({ store, deps, orderId, actor, reason, nowMs }) {
  return withLock(store, orderId, nowMs, async () => {
    const cur = await store.get(orderId);
    const plan = planRevoke(cur, { reason, actor });
    if (!plan.ok) return { ...reject(plan), order: describeOrder(cur) };
    let metric;
    try {
      metric = await deps.revokePurchase({ recordId: cur.recordId, orderKey: purchaseOrderKey(cur) });
    } catch {
      metric = { removed: false, reason: 'revoke_failed' };
    }
    const order = applyRevoked(cur, { nowMs, actor, reason, metric });
    await store.save(order);
    return { ok: true, status: 200, code: 'revoked', order: describeOrder(order) };
  });
}

/**
 * 本番の実操作確認用のテスト注文を作る（**env gate が開いているときだけ**・クーポンなし・金額なし）。
 * 入金確認 → 新系列 1 件 → 訂正で 0 件 → 削除、の順で使い、実 KPI に残さない。
 */
export async function createCanaryOrder({ store, env, recordId, nowMs }) {
  if (!isOrderCanaryEnabled(env)) return { ok: false, status: 403, code: 'canary_disabled' };
  const order = buildNewOrder({ recordId, saleDate: CANARY_SALE_DATE, saleLabel: 'テスト注文（実操作確認）', amount: null, couponId: null, nowMs, canary: true });
  if (!order) return { ok: false, status: 400, code: 'invalid_input' };
  const created = await store.createIfAbsent(order);
  return created ? { ok: true, status: 200, code: 'canary_created', order: describeOrder(order) }
    : { ok: false, status: 409, code: 'canary_exists' };
}

/** テスト注文の削除。**テスト注文かつ終端状態（取消・訂正済み）だけ**。実注文は消せない */
export async function deleteCanaryOrder({ store, env, orderId, nowMs }) {
  if (!isOrderCanaryEnabled(env)) return { ok: false, status: 403, code: 'canary_disabled' };
  return withLock(store, orderId, nowMs, async () => {
    const cur = await store.get(orderId);
    if (!cur) return { ok: false, status: 404, code: 'order_not_found' };
    if (cur.canary !== true) return { ok: false, status: 409, code: 'not_canary' };
    if (cur.status !== ORDER_STATUS.REVOKED && cur.status !== ORDER_STATUS.CANCELLED) {
      return { ok: false, status: 409, code: `not_terminal:${cur.status}` };
    }
    if (cur.status === ORDER_STATUS.REVOKED && cur.metricState !== METRIC_STATE.REMOVED) {
      return { ok: false, status: 409, code: 'metric_not_removed' };
    }
    await store.remove(orderId);
    return { ok: true, status: 200, code: 'canary_deleted' };
  });
}
