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
/** 前段チェック（mode / parsed / event-type）。grant/adjustment でなければ stop を返す。 */
function paddlePrecheck({ env, origin, parsed }) {
  const mode = resolvePaddleMode({ key: env.PADDLE_API_KEY, origin });
  if (!mode.ok) return { stop: { result: `ignored_${mode.reason}` } };
  if (!parsed || parsed.ignored) return { stop: { result: 'ignored_event' } };
  const isGrant = GRANT_EVENTS.includes(parsed.eventType);
  if (!isGrant && !ADJUSTMENT_EVENTS.includes(parsed.eventType)) return { stop: { result: 'ignored_event' } };
  return { mode, isGrant };
}

/**
 * Paddle API で取引を照会・照合し、付与/返金の「指示」だけを返す（DB 書き込み・notify はしない）。
 * PADDLE_API_KEY だけ必要。分離サイト（独立 runtime）から会員付与を本番へ委譲するために使う。
 * @returns {{ result: string, retry?: boolean, alert?: { reason: string },
 *   apply?: { kind: 'grant'|'refund', provider: string, paymentId: string, recordId: string, productId?: string, paidAt?: *, full?: boolean } }}
 */
async function paddleGrantDecision({ api, parsed, isGrant }) {
  let txn;
  try { txn = await api.getTransaction(parsed.transactionId); } catch (e) {
    return { result: 'transaction_lookup_failed', retry: e.status !== 404 };
  }
  const m = matchTransaction(txn);
  if (!m.ok) {
    // 未払い（ready/billed）の通知は正常な途中経過。照合違いだけ管理者へ
    const alert = String(m.reason).startsWith('status_') ? undefined : { reason: m.reason };
    return { result: `mismatch_${m.reason}`, ...(alert ? { alert } : {}) };
  }
  if (isGrant) {
    return { result: 'grant', apply: { kind: 'grant', provider: PROVIDER, paymentId: parsed.transactionId, recordId: m.recordId, productId: m.productId, paidAt: m.paidAt } };
  }
  let adj;
  try { adj = await api.getAdjustment(parsed.adjustmentId); } catch (e) {
    return { result: 'adjustment_lookup_failed', retry: e.status !== 404 };
  }
  const d = decideAdjustment(adj, parsed.transactionId);
  if (d.action !== 'revert') return { result: `ignored_${d.reason}` };
  return { result: 'refund', apply: { kind: 'refund', provider: PROVIDER, paymentId: parsed.transactionId, recordId: m.recordId, full: d.full } };
}

/**
 * 署名検証済み Webhook を照会・照合して付与/返金「指示」を返す（DB・notify なし）。
 * 分離サイト（checkout.tirol.link の modern function）が使い、apply を本番 grant endpoint へ渡す。
 */
export async function decidePaddleGrant({ env, origin, parsed, fetchImpl }) {
  const pc = paddlePrecheck({ env, origin, parsed });
  if (pc.stop) return pc.stop;
  const api = paddleApi({ apiBase: pc.mode.apiBase, key: env.PADDLE_API_KEY, fetchImpl });
  return paddleGrantDecision({ api, parsed, isGrant: pc.isGrant });
}

/**
 * 本番の付与「指示」（decidePaddleGrant の apply）を entitlementLedger へ反映する。
 * Airtable / Redis だけ必要（PADDLE_API_KEY 不要）。本番 grant endpoint が使う。
 */
export async function applyPaddleGrant({ env, apply, redis, notify = async () => {}, fetchImpl, now }) {
  if (!redis) return { result: 'redis_missing', retry: true };
  if (!apply || (apply.kind !== 'grant' && apply.kind !== 'refund')) return { result: 'ignored_no_apply' };
  const at = airtable(env, fetchImpl);
  const common = { redis, at, provider: apply.provider || PROVIDER, paymentId: apply.paymentId, recordId: apply.recordId, notify, ...(now ? { now } : {}) };
  if (apply.kind === 'grant') return applyCardGrant({ ...common, productId: apply.productId, paidAt: apply.paidAt });
  return applyCardRefund({ ...common, full: apply.full });
}

export async function handlePaddleEvent({ env, origin, parsed, redis, notify = async () => {}, fetchImpl, now }) {
  const pc = paddlePrecheck({ env, origin, parsed });
  if (pc.stop) return pc.stop;
  if (!redis) return { result: 'redis_missing', retry: true };
  const api = paddleApi({ apiBase: pc.mode.apiBase, key: env.PADDLE_API_KEY, fetchImpl });
  const dec = await paddleGrantDecision({ api, parsed, isGrant: pc.isGrant });
  if (dec.alert) await notify('mismatch', { provider: PROVIDER, paymentId: parsed.transactionId, reason: dec.alert.reason });
  if (!dec.apply) return dec.retry ? { result: dec.result, retry: dec.retry } : { result: dec.result };
  const at = airtable(env, fetchImpl);
  const common = { redis, at, provider: PROVIDER, paymentId: parsed.transactionId, recordId: dec.apply.recordId, notify, ...(now ? { now } : {}) };
  if (dec.apply.kind === 'grant') return applyCardGrant({ ...common, productId: dec.apply.productId, paidAt: dec.apply.paidAt });
  return applyCardRefund({ ...common, full: dec.apply.full });
}

/** 決済完了画面の確認用（本人の取引だけ） */
export function readPaddleOrderStatus({ redis, transactionId, recordId }) {
  return readCardOrderStatus({ redis, provider: PROVIDER, paymentId: transactionId, recordId });
}
