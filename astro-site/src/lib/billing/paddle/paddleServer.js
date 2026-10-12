/**
 * paddleServer.js — Paddle 連携の I/O（Paddle API・Airtable）。判定は paddleCore / cardOneTime、
 * 会員への反映は決済会社共通の entitlementLedger.js。
 *
 * ⚠️ API 鍵・カード情報・メールアドレス・レコード内容をログに出さない。
 */

import { airtable } from '../stripeServer.js';
import { checkoutProviderGate } from '../cardSales.js';
import { decideCardPurchase } from '../cardOneTime.js';
import { applyCardGrant, applyCardRefund, readCardOrderStatus } from '../entitlementLedger.js';
import {
  resolvePaddleMode, buildTransactionBody, matchTransaction, decideAdjustment, isTransactionId, checkoutUrlMatchesOrigin,
  GRANT_EVENTS, ADJUSTMENT_EVENTS, PROVIDER,
} from './paddleCore.js';

export function paddleApi({ apiBase, key, fetchImpl }) {
  const f = fetchImpl || fetch;
  async function call(method, path, body) {
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const res = await f(`${apiBase}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const code = json?.error?.code || res.status;
      throw Object.assign(new Error(`paddle_${res.status}_${code}`), { status: res.status });
    }
    return json?.data ?? null;
  }
  return {
    createTransaction: (body) => call('POST', '/transactions', body),
    getTransaction: (id) => call('GET', `/transactions/${encodeURIComponent(id)}`),
    getAdjustment: async (id) => {
      const list = await call('GET', `/adjustments?id=${encodeURIComponent(id)}`);
      return Array.isArray(list) ? list.find((a) => a?.id === id) || null : null;
    },
  };
}

/**
 * 決済画面（取引）を作る（ログイン中の会員だけ）。
 * @returns {{ ok: true, url, transactionId } | { ok: false, status, code }}
 */
export async function createPaddleCheckout({ env, origin, recordId, productId, entry = 'direct', now = new Date(), fetchImpl }) {
  const mode = resolvePaddleMode({ key: env.PADDLE_API_KEY, origin });
  if (!mode.ok) return { ok: false, status: 503, code: mode.reason };
  const gate = checkoutProviderGate({ provider: PROVIDER, mode: mode.mode, entry });
  if (!gate.ok) return { ok: false, status: 409, code: gate.reason };
  if (!recordId) return { ok: false, status: 401, code: 'login_required' };
  const at = airtable(env, fetchImpl);
  let rec;
  try { rec = await at.get(recordId); } catch { return { ok: false, status: 401, code: 'login_required' }; }
  const d = decideCardPurchase({ productId, fields: rec?.fields || {}, now });
  if (!d.ok) return { ok: false, status: d.code === 'invalid_product' ? 400 : 409, code: d.code };
  const api = paddleApi({ apiBase: mode.apiBase, key: env.PADDLE_API_KEY, fetchImpl });
  const txn = await api.createTransaction(buildTransactionBody({ productId, recordId, origin }));
  if (!isTransactionId(txn?.id) || !txn?.checkout?.url) return { ok: false, status: 502, code: 'checkout_failed' };
  // Default payment link が別サイトを指していたら使わない（未払いの取引は課金されない）
  if (!checkoutUrlMatchesOrigin(txn.checkout.url, origin)) return { ok: false, status: 502, code: 'checkout_url_mismatch' };
  return { ok: true, url: txn.checkout.url, transactionId: txn.id };
}

/**
 * Webhook 1 件（署名検証は呼び出し側）。
 * @returns {{ result: string, retry?: boolean }}  retry=true は Paddle に再送させる（500）
 */
export async function handlePaddleEvent({ env, origin, parsed, redis, notify = async () => {}, fetchImpl, now }) {
  const mode = resolvePaddleMode({ key: env.PADDLE_API_KEY, origin });
  if (!mode.ok) return { result: `ignored_${mode.reason}` };
  if (!parsed || parsed.ignored) return { result: 'ignored_event' };
  const isGrant = GRANT_EVENTS.includes(parsed.eventType);
  const isAdj = ADJUSTMENT_EVENTS.includes(parsed.eventType);
  if (!isGrant && !isAdj) return { result: 'ignored_event' };
  if (!redis) return { result: 'redis_missing', retry: true };

  const api = paddleApi({ apiBase: mode.apiBase, key: env.PADDLE_API_KEY, fetchImpl });
  let txn;
  try { txn = await api.getTransaction(parsed.transactionId); } catch (e) {
    return { result: 'transaction_lookup_failed', retry: e.status !== 404 };
  }
  const m = matchTransaction(txn);
  if (!m.ok) {
    // 未払い（ready/billed）の通知は正常な途中経過。照合違いだけ管理者へ
    if (!String(m.reason).startsWith('status_')) await notify('mismatch', { provider: PROVIDER, paymentId: parsed.transactionId, reason: m.reason });
    return { result: `mismatch_${m.reason}` };
  }
  const at = airtable(env, fetchImpl);
  const common = { redis, at, provider: PROVIDER, paymentId: parsed.transactionId, recordId: m.recordId, notify, ...(now ? { now } : {}) };
  if (isGrant) return applyCardGrant({ ...common, productId: m.productId, paidAt: m.paidAt });

  let adj;
  try { adj = await api.getAdjustment(parsed.adjustmentId); } catch (e) {
    return { result: 'adjustment_lookup_failed', retry: e.status !== 404 };
  }
  const d = decideAdjustment(adj, parsed.transactionId);
  if (d.action !== 'revert') return { result: `ignored_${d.reason}` };
  return applyCardRefund({ ...common, full: d.full });
}

/** 決済完了画面の確認用（本人の取引だけ） */
export function readPaddleOrderStatus({ redis, transactionId, recordId }) {
  return readCardOrderStatus({ redis, provider: PROVIDER, paymentId: transactionId, recordId });
}
