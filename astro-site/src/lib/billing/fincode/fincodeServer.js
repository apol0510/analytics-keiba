/**
 * fincodeServer.js — fincode 連携の I/O（fincode API・Airtable・Redis）。判定は fincodeCore / cardOneTime。
 *
 * - 決済の成否・金額・会員・商品は**通知ではなく API 照会**で確かめる（fincodeCore.matchPayment）。
 * - 会員への反映（ロック・決済ごとの状態・二重購入の疑い・返金の戻し）は決済会社共通の entitlementLedger.js。
 *
 * ⚠️ 秘密鍵・カード情報・メールアドレス・レコード内容をログに出さない。
 */

import { airtable } from '../stripeServer.js';
import { decideCardPurchase, cardProductById } from '../cardOneTime.js';
import { applyCardGrant, applyCardRefund, readCardOrderStatus as readLedgerStatus } from '../entitlementLedger.js';
import {
  resolveFincodeMode, buildSessionBody, newOrderId, matchPayment, GRANT_EVENTS, REFUND_EVENTS, PROVIDER,
} from './fincodeCore.js';

export { withMemberLock } from '../entitlementLedger.js';

export function fincodeApi({ apiBase, key, fetchImpl }) {
  const f = fetchImpl || fetch;
  async function call(method, path, body, idempotentKey) {
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    if (idempotentKey) headers.idempotent_key = idempotentKey;
    const res = await f(`${apiBase}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const code = json?.errors?.[0]?.error_code || res.status;
      throw Object.assign(new Error(`fincode_${res.status}_${code}`), { status: res.status });
    }
    return json;
  }
  return {
    createSession: (body, idem) => call('POST', '/v1/sessions', body, idem),
    getPayment: (orderId) => call('GET', `/v1/payments/${encodeURIComponent(orderId)}?pay_type=Card`),
    cancelPayment: (orderId, accessId, idem) => call('PUT', `/v1/payments/${encodeURIComponent(orderId)}/cancel`, { pay_type: 'Card', access_id: accessId }, idem),
  };
}

/**
 * 決済画面を作る（ログイン中の会員だけ）。
 * @returns {{ ok: true, url, orderId } | { ok: false, status, code }}
 */
export async function createCardSession({ env, origin, recordId, productId, now = new Date(), rand, fetchImpl }) {
  const mode = resolveFincodeMode({ key: env.FINCODE_SECRET_KEY, origin });
  if (!mode.ok) return { ok: false, status: 503, code: mode.reason };
  if (!recordId) return { ok: false, status: 401, code: 'login_required' };
  const at = airtable(env, fetchImpl);
  let rec;
  try { rec = await at.get(recordId); } catch { return { ok: false, status: 401, code: 'login_required' }; }
  const d = decideCardPurchase({ productId, fields: rec?.fields || {}, now });
  if (!d.ok) return { ok: false, status: d.code === 'invalid_product' ? 400 : 409, code: d.code };
  const orderId = newOrderId(productId, rand || `${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  const expireAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19).replace(/-/g, '/');
  const api = fincodeApi({ apiBase: mode.apiBase, key: env.FINCODE_SECRET_KEY, fetchImpl });
  const session = await api.createSession(buildSessionBody({ productId, orderId, recordId, origin, expireAt }), orderId);
  if (!session?.link_url) return { ok: false, status: 502, code: 'session_failed' };
  return { ok: true, url: session.link_url, orderId };
}

/**
 * Webhook 1 件の処理（署名検証は呼び出し側）。
 * @returns {{ result: string, retry?: boolean }}  retry=true は fincode に再送させる（500 を返す）
 */
export async function handleFincodeEvent({ env, origin, event, orderId, redis, notify = async () => {}, fetchImpl, now }) {
  const mode = resolveFincodeMode({ key: env.FINCODE_SECRET_KEY, origin });
  if (!mode.ok) return { result: `ignored_${mode.reason}` };
  const isGrant = GRANT_EVENTS.includes(event);
  const isRefund = REFUND_EVENTS.includes(event);
  if (!isGrant && !isRefund) return { result: 'ignored_event' };
  if (!redis) return { result: 'redis_missing', retry: true };

  const api = fincodeApi({ apiBase: mode.apiBase, key: env.FINCODE_SECRET_KEY, fetchImpl });
  let payment;
  try { payment = await api.getPayment(orderId); } catch (e) {
    return { result: 'payment_lookup_failed', retry: !(e.status === 404) };
  }
  // 予約は決済そのものから復元する（client_field はサーバーが決済画面を作るときに入れた値。顧客は変えられない）
  const productId = String(payment?.client_field_2 || '');
  const product = cardProductById(productId);
  const reservation = product && String(orderId).startsWith(`ak-${product.id}-`)
    ? { orderId, recordId: String(payment.client_field_1 || ''), productId, amountYen: product.amountYen }
    : null;
  const m = matchPayment({ payment, reservation });
  if (!m.ok) {
    await notify('mismatch', { orderId, reason: m.reason });
    return { result: `mismatch_${m.reason}` };
  }
  if (isGrant && m.kind !== 'paid') return { result: `not_paid_${m.kind}` };
  if (isRefund && m.kind !== 'canceled') return { result: 'not_canceled' };

  const at = airtable(env, fetchImpl);
  const n = (kind, d) => notify(kind, { ...d, orderId });
  const common = { redis, at, provider: PROVIDER, paymentId: orderId, recordId: m.recordId, notify: n, ...(now ? { now } : {}) };
  if (isGrant) return applyCardGrant({ ...common, productId: m.productId, paidAt: m.paidAt });
  return applyCardRefund({ ...common, full: true });
}

/** 決済完了画面の確認用（本人の注文だけ） */
export function readCardOrderStatus({ redis, orderId, recordId }) {
  return readLedgerStatus({ redis, provider: PROVIDER, paymentId: orderId, recordId });
}
