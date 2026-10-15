/**
 * paypalCore.js — PayPal（Orders v2・一回払い）連携の判定（純粋・I/O なし）
 *
 * 2026-10-11 MK 確定: 代替決済の第二優先。**新規アカウント**だけを使う。Sandbox E2E を先に完成させる。
 * 本番受付は PayPal が AK の取扱商品を承認（利用規定の事前承認）したあと、MK の明示決定で
 * cardSales.CARD_SALES_OPEN.paypal を変える PR だけで開く（env では開かない）。
 * 売るのは一回払いだけ（Subscriptions API は使わない＝新規の月払いを作らない）。
 *
 * ⚠️ 旧 `netlify/functions/paypal-webhook.js` は 2026-07-22 に廃止（410）。復活させない。新経路は別名。
 *
 * ## 守ること
 * - 金額・商品はサーバー（cardOneTime.js）が決める。JPY は小数なし（"49800"）。
 * - 支払いの成否は**通知を信じず API で照会**（GET /v2/checkout/orders/{id}）。custom_id・JPY・金額・capture の状態を照合。
 * - Webhook は PayPal の検証 API（verify-webhook-signature）で SUCCESS のものだけ。
 * - 決済会社へ送る名前は paymentDisplayNames の禁止語ルールを通った名前だけ。custom_id は recordId と商品 ID だけ。
 */

import { cardProductById } from '../cardOneTime.js';
import { CARD_SALES_OPEN as SALES, resolveCardMode } from '../cardSales.js';
import { PAYMENT_BASE_NAME } from '../paymentDisplayNames.js';
import { paypalReturnUrls } from '../neutralCheckoutHost.js';

export const PROVIDER = 'paypal';
export const CARD_SALES_OPEN = SALES[PROVIDER];
export const PAYPAL_API = Object.freeze({ test: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' });

export const GRANT_EVENTS = Object.freeze(['PAYMENT.CAPTURE.COMPLETED']);
export const APPROVED_EVENTS = Object.freeze(['CHECKOUT.ORDER.APPROVED']);
export const REFUND_EVENTS = Object.freeze(['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED']);

const ORDER_RE = /^[A-Z0-9]{10,24}$/;
const RECORD_RE = /^rec[A-Za-z0-9]{14}$/;
export const isOrderId = (id) => ORDER_RE.test(String(id || ''));

/** PayPal の鍵は接頭辞で環境を見分けられないため、PAYPAL_ENV（sandbox|live）と ID・秘密の揃いで決める */
export function keyMode({ clientId, secret, env } = {}) {
  if (!String(clientId || '').trim() || !String(secret || '').trim()) return null;
  const e = String(env || '').trim().toLowerCase();
  if (e === 'sandbox') return 'test';
  if (e === 'live') return 'live';
  return null;
}

export function resolvePaypalMode({ env = {}, origin, salesOpen = CARD_SALES_OPEN } = {}) {
  const km = keyMode({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, env: env.PAYPAL_ENV });
  const r = resolveCardMode({ provider: PROVIDER, keyMode: km, origin, salesOpen });
  return r.ok ? { ...r, apiBase: PAYPAL_API[r.mode] } : r;
}

export const customIdOf = (recordId, productId) => `${recordId}:${productId}`;

/** 注文（POST /v2/checkout/orders）の本文。即時売上（CAPTURE）・配送なし・承認後すぐ支払い */
export function buildOrderBody({ productId, recordId, origin, invoiceId }) {
  const product = cardProductById(productId);
  if (!product) throw Object.assign(new Error('invalid_product'), { code: 'invalid_product' });
  if (!RECORD_RE.test(String(recordId || ''))) throw Object.assign(new Error('invalid_record'), { code: 'invalid_record' });
  return {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: product.id,
      custom_id: customIdOf(recordId, product.id),
      invoice_id: invoiceId,
      description: product.displayName,
      amount: { currency_code: 'JPY', value: String(product.amountYen) },
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: PAYMENT_BASE_NAME,
          locale: 'ja-JP',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          ...paypalReturnUrls(origin, 'order'),
        },
      },
    },
  };
}

/** 顧客を送る承認 URL（payer-action / approve） */
export function approveUrlOf(order) {
  const links = Array.isArray(order?.links) ? order.links : [];
  const l = links.find((x) => x?.rel === 'payer-action') || links.find((x) => x?.rel === 'approve');
  return l?.href && /^https:\/\/(www\.)?(sandbox\.)?paypal\.com\//.test(l.href) ? l.href : null;
}

/**
 * API で照会した注文を確かめる。
 * @returns {{ ok: true, kind: 'approved'|'paid'|'refunded'|'partially_refunded'|'pending', recordId, productId, paidAt, captureId? }
 *          | { ok: false, reason }}
 */
export function matchOrder(order) {
  if (!order || typeof order !== 'object') return { ok: false, reason: 'order_not_found' };
  const pu = Array.isArray(order.purchase_units) && order.purchase_units.length === 1 ? order.purchase_units[0] : null;
  if (!pu) return { ok: false, reason: 'purchase_units_invalid' };
  const [recordId, productId] = String(pu.custom_id || '').split(':');
  const product = cardProductById(productId);
  if (!product) return { ok: false, reason: 'invalid_product' };
  if (!RECORD_RE.test(String(recordId || ''))) return { ok: false, reason: 'invalid_record' };
  if (String(pu.amount?.currency_code || '') !== 'JPY' || Number(pu.amount?.value) !== product.amountYen) return { ok: false, reason: 'amount_mismatch' };
  const base = { ok: true, recordId, productId: product.id };
  const status = String(order.status || '');
  if (status === 'APPROVED') return { ...base, kind: 'approved', paidAt: null };
  if (status !== 'COMPLETED') return { ok: false, reason: `status_${status.toLowerCase() || 'unknown'}` };
  const caps = Array.isArray(pu.payments?.captures) ? pu.payments.captures : [];
  if (caps.length !== 1) return { ok: false, reason: 'capture_count_invalid' };
  const cap = caps[0];
  if (String(cap.amount?.currency_code || '') !== 'JPY' || Number(cap.amount?.value) !== product.amountYen) return { ok: false, reason: 'capture_amount_mismatch' };
  const at = new Date(cap.create_time || order.update_time || Date.now());
  const paidAt = Number.isNaN(at.getTime()) ? new Date() : at;
  const kindOf = { COMPLETED: 'paid', REFUNDED: 'refunded', PARTIALLY_REFUNDED: 'partially_refunded', PENDING: 'pending' };
  const kind = kindOf[String(cap.status || '')];
  if (!kind) return { ok: false, reason: `capture_${String(cap.status || 'unknown').toLowerCase()}` };
  return { ...base, kind, paidAt, captureId: String(cap.id || '') };
}

/** Webhook 本文から注文 ID を取り出す（照会の手がかりだけ。capture/refund は関連 ID か up リンクから） */
export function parsePaypalWebhook(body) {
  let j = body;
  if (typeof body === 'string') {
    try { j = JSON.parse(body); } catch { return null; }
  }
  if (!j || typeof j !== 'object') return null;
  const eventType = String(j.event_type || '');
  const r = j.resource || {};
  if (APPROVED_EVENTS.includes(eventType)) return isOrderId(r.id) ? { eventType, orderId: r.id, raw: j } : { eventType, ignored: true };
  if (GRANT_EVENTS.includes(eventType) || REFUND_EVENTS.includes(eventType)) {
    const orderId = r.supplementary_data?.related_ids?.order_id;
    if (isOrderId(orderId)) return { eventType, orderId, raw: j };
    // 返金（refund リソース）は capture への up リンクから capture ID を取り、照会で注文を引く
    const up = (Array.isArray(r.links) ? r.links : []).find((l) => l?.rel === 'up' && /\/v2\/payments\/captures\/[A-Z0-9]+$/.test(String(l.href || '')));
    const captureId = up ? String(up.href).split('/').pop() : (GRANT_EVENTS.includes(eventType) && isOrderId(r.id) ? r.id : null);
    return captureId ? { eventType, captureId, raw: j } : { eventType, ignored: true };
  }
  return { eventType, ignored: true };
}

/** verify-webhook-signature に渡す本文（ヘッダ名は小文字で受ける） */
export function buildVerifyBody(headers = {}, webhookId, event) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), v]));
  const need = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  if (!webhookId || need.some((k) => !h[k])) return null;
  if (!/^https:\/\/api(-m)?\.(sandbox\.)?paypal\.com\//.test(String(h['paypal-cert-url']))) return null;
  return {
    auth_algo: h['paypal-auth-algo'],
    cert_url: h['paypal-cert-url'],
    transmission_id: h['paypal-transmission-id'],
    transmission_sig: h['paypal-transmission-sig'],
    transmission_time: h['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: event,
  };
}
