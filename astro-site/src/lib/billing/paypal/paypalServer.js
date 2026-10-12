/**
 * paypalServer.js — PayPal 連携の I/O（PayPal API・Airtable）。判定は paypalCore / cardOneTime、
 * 会員への反映は決済会社共通の entitlementLedger.js。
 *
 * 流れ: 注文作成（サーバー）→ 顧客が PayPal で承認 → 戻り先からサーバーが capture → 注文を照会して反映。
 * Webhook（CHECKOUT.ORDER.APPROVED / PAYMENT.CAPTURE.*）でも同じ処理を通る（戻り先を閉じても反映される）。
 * capture は PayPal-Request-Id で冪等、反映は entitlementLedger で決済ごとに 1 回。
 *
 * ⚠️ クライアント秘密・カード情報・メールアドレス・レコード内容をログに出さない。
 */

import { randomBytes } from 'node:crypto';
import { airtable } from '../stripeServer.js';
import { checkoutProviderGate } from '../cardSales.js';
import { decideCardPurchase } from '../cardOneTime.js';
import { applyCardGrant, applyCardRefund, readCardOrderStatus } from '../entitlementLedger.js';
import {
  resolvePaypalMode, buildOrderBody, approveUrlOf, matchOrder, isOrderId, buildVerifyBody, parsePaypalWebhook,
  APPROVED_EVENTS, REFUND_EVENTS, PROVIDER,
} from './paypalCore.js';

export function paypalApi({ apiBase, clientId, secret, fetchImpl }) {
  const f = fetchImpl || fetch;
  let token = null;
  async function getToken() {
    if (token) return token;
    const res = await f(`${apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.access_token) throw Object.assign(new Error(`paypal_token_${res.status}`), { status: res.status });
    token = j.access_token;
    return token;
  }
  async function call(method, path, body, requestId) {
    const headers = { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const res = await f(`${apiBase}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const code = json?.details?.[0]?.issue || json?.name || res.status;
      throw Object.assign(new Error(`paypal_${res.status}_${code}`), { status: res.status, issue: code });
    }
    return json;
  }
  return {
    createOrder: (body, requestId) => call('POST', '/v2/checkout/orders', body, requestId),
    getOrder: (id) => call('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`),
    captureOrder: (id) => call('POST', `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {}, `ak-cap-${id}`),
    getCapture: (id) => call('GET', `/v2/payments/captures/${encodeURIComponent(id)}`),
    verifyWebhook: (body) => call('POST', '/v1/notifications/verify-webhook-signature', body),
  };
}

const apiFor = (env, mode, fetchImpl) => paypalApi({ apiBase: mode.apiBase, clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, fetchImpl });

/**
 * 注文を作る（ログイン中の会員だけ）。
 * @returns {{ ok: true, url, orderId } | { ok: false, status, code }}
 */
export async function createPaypalOrder({ env, origin, recordId, productId, entry = 'direct', now = new Date(), rand, fetchImpl }) {
  const mode = resolvePaypalMode({ env, origin });
  if (!mode.ok) return { ok: false, status: 503, code: mode.reason };
  const gate = checkoutProviderGate({ provider: PROVIDER, mode: mode.mode, entry });
  if (!gate.ok) return { ok: false, status: 409, code: gate.reason };
  if (!recordId) return { ok: false, status: 401, code: 'login_required' };
  const at = airtable(env, fetchImpl);
  let rec;
  try { rec = await at.get(recordId); } catch { return { ok: false, status: 401, code: 'login_required' }; }
  const d = decideCardPurchase({ productId, fields: rec?.fields || {}, now });
  if (!d.ok) return { ok: false, status: d.code === 'invalid_product' ? 400 : 409, code: d.code };
  const invoiceId = `ak-${productId}-${rand || randomBytes(9).toString('hex')}`;
  const order = await apiFor(env, mode, fetchImpl).createOrder(buildOrderBody({ productId, recordId, origin, invoiceId }), invoiceId);
  const url = approveUrlOf(order);
  if (!isOrderId(order?.id) || !url) return { ok: false, status: 502, code: 'order_failed' };
  return { ok: true, url, orderId: order.id };
}

/**
 * 注文 1 件を照会して、状態に応じて capture・反映・返金の戻しを行う（戻り先・Webhook 共通）。
 * @param {{ capture?: boolean, refundEvent?: string }} opts  capture=true: 承認済みなら capture する
 */
export async function settlePaypalOrder({ env, origin, orderId, redis, notify = async () => {}, fetchImpl, now, capture = false, refundEvent = null }) {
  const mode = resolvePaypalMode({ env, origin });
  if (!mode.ok) return { result: `ignored_${mode.reason}` };
  if (!isOrderId(orderId)) return { result: 'invalid_order' };
  if (!redis) return { result: 'redis_missing', retry: true };
  const api = apiFor(env, mode, fetchImpl);
  let order;
  try { order = await api.getOrder(orderId); } catch (e) { return { result: 'order_lookup_failed', retry: e.status !== 404 }; }
  let m = matchOrder(order);
  if (m.ok && m.kind === 'approved') {
    if (!capture) return { result: 'approved_not_captured' };
    try { await api.captureOrder(orderId); } catch (e) {
      // 既に capture 済み（同時の戻り先と Webhook）は照会し直して進める
      if (e.issue !== 'ORDER_ALREADY_CAPTURED') return { result: `capture_failed_${e.issue || e.status}`, retry: (e.status || 500) >= 500 };
    }
    try { order = await api.getOrder(orderId); } catch { return { result: 'order_lookup_failed', retry: true }; }
    m = matchOrder(order);
  }
  if (!m.ok) {
    if (!String(m.reason).startsWith('status_')) await notify('mismatch', { provider: PROVIDER, paymentId: orderId, reason: m.reason });
    return { result: `mismatch_${m.reason}` };
  }
  const at = airtable(env, fetchImpl);
  const common = { redis, at, provider: PROVIDER, paymentId: orderId, recordId: m.recordId, notify, ...(now ? { now } : {}) };
  if (refundEvent === 'PAYMENT.CAPTURE.REVERSED') return applyCardRefund({ ...common, full: true });
  if (m.kind === 'refunded') return applyCardRefund({ ...common, full: true });
  if (m.kind === 'partially_refunded') return applyCardRefund({ ...common, full: false });
  if (m.kind === 'pending') return { result: 'capture_pending' };
  return applyCardGrant({ ...common, productId: m.productId, paidAt: m.paidAt });
}

/**
 * Webhook 1 件。PayPal の検証 API で SUCCESS のものだけ処理する。
 * @returns {{ status: number, result: string }}  status=500 は PayPal に再送させる
 */
export async function handlePaypalWebhook({ env, origin, headers, rawBody, redis, notify, fetchImpl, now }) {
  const mode = resolvePaypalMode({ env, origin });
  if (!mode.ok) return { status: 200, result: `ignored_${mode.reason}` };
  let event;
  try { event = JSON.parse(rawBody); } catch { return { status: 400, result: 'invalid_json' }; }
  const vb = buildVerifyBody(headers, env.PAYPAL_WEBHOOK_ID, event);
  if (!vb) return { status: 401, result: 'invalid_signature' };
  const api = apiFor(env, mode, fetchImpl);
  let v;
  try { v = await api.verifyWebhook(vb); } catch { return { status: 500, result: 'verify_failed' }; }
  if (v?.verification_status !== 'SUCCESS') return { status: 401, result: 'invalid_signature' };

  const p = parsePaypalWebhook(event);
  if (!p || p.ignored) return { status: 200, result: 'ignored_event' };
  let orderId = p.orderId;
  if (!orderId && p.captureId) {
    try {
      const cap = await api.getCapture(p.captureId);
      orderId = cap?.supplementary_data?.related_ids?.order_id;
    } catch (e) { return { status: e.status === 404 ? 200 : 500, result: 'capture_lookup_failed' }; }
  }
  if (!isOrderId(orderId)) return { status: 200, result: 'order_unknown' };
  const r = await settlePaypalOrder({
    env, origin, orderId, redis, notify, fetchImpl, now,
    capture: APPROVED_EVENTS.includes(p.eventType),
    refundEvent: REFUND_EVENTS.includes(p.eventType) ? p.eventType : null,
  });
  return { status: r.retry ? 500 : 200, result: r.result };
}

export function readPaypalOrderStatus({ redis, orderId, recordId }) {
  return readCardOrderStatus({ redis, provider: PROVIDER, paymentId: orderId, recordId });
}
