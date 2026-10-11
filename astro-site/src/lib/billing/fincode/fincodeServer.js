/**
 * fincodeServer.js — fincode 連携の I/O（fincode API・Airtable・Redis）。判定は fincodeCore / cardOneTime。
 *
 * ## 二重昇格・期限誤更新を作らない仕組み
 * - 反映は**会員ごとのロック**（Redis SET NX）の中で行う（同じ会員への並行反映を直列化）。
 * - 決済ごとの状態 `ak:card:fincode:applied:{orderId}` を **PATCH の前に pending で置き**、PATCH 後に done にする。
 *   再送で pending を見つけたら、レコードが既に付与後の値なら done にするだけ（再 PATCH しない＝年払いの二重延長を防ぐ）。
 * - Redis が無い環境では反映しない（fail closed。fincode が再送する）。
 * - 決済の成否・金額・会員・商品は**通知ではなく API 照会**で確かめる（fincodeCore.matchPayment）。
 *
 * ⚠️ 秘密鍵・カード情報・メールアドレス・レコード内容をログに出さない。
 */

import { airtable } from '../stripeServer.js';
import { decideCardPurchase, decideCardGrant, cardProductById } from '../cardOneTime.js';
import {
  resolveFincodeMode, buildSessionBody, newOrderId, matchPayment, snapshotFields, decideRefundRevert,
  GRANT_EVENTS, REFUND_EVENTS, PROVIDER,
} from './fincodeCore.js';

const APPLIED_TTL_SEC = 400 * 24 * 3600; // 返金期限（180 日）より長く持つ
const appliedKey = (orderId) => `ak:card:fincode:applied:${orderId}`;
const memberLockKey = (recordId) => `ak:billing:member-lock:${recordId}`;

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

/** 会員ごとの排他。取れなければ { busy: true } */
export async function withMemberLock(redis, recordId, fn) {
  const key = memberLockKey(recordId);
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (let i = 0; i < 10; i += 1) {
    if (await redis(['SET', key, token, 'NX', 'PX', '30000']) === 'OK') {
      try { return await fn(); } finally {
        try { if (await redis(['GET', key]) === token) await redis(['DEL', key]); } catch { /* 30 秒で外れる */ }
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { busy: true };
}

async function readApplied(redis, orderId) {
  const v = await redis(['GET', appliedKey(orderId)]);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
const writeApplied = (redis, orderId, obj) => redis(['SET', appliedKey(orderId), JSON.stringify(obj), 'EX', String(APPLIED_TTL_SEC)]);

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
export async function handleFincodeEvent({ env, origin, event, orderId, redis, notify = async () => {}, fetchImpl }) {
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
  const out = await withMemberLock(redis, m.recordId, async () => {
    const applied = await readApplied(redis, orderId);
    let rec;
    try { rec = await at.get(m.recordId); } catch { return { result: 'record_not_found' }; }
    const fields = rec?.fields || {};

    if (isGrant) {
      if (applied?.state === 'done') return { result: 'already_applied' };
      if (applied?.state === 'pending') {
        // 前回 PATCH 後に止まった可能性。レコードが付与後の値ならそのまま done（再 PATCH しない）
        if (String(fields['有効期限'] || '').slice(0, 10) === applied.expiration && fields.PaymentMethod === PROVIDER) {
          await writeApplied(redis, orderId, { ...applied, state: 'done' });
          return { result: 'recovered_applied' };
        }
      }
      const g = decideCardGrant({ productId: m.productId, fields, paidAt: m.paidAt, provider: PROVIDER });
      if (g.action === 'conflict') {
        await writeApplied(redis, orderId, { state: 'conflict', recordId: m.recordId, reason: g.reason });
        await notify('conflict', { orderId, recordId: m.recordId, reason: g.reason });
        return { result: `conflict_${g.reason}` };
      }
      if (g.action !== 'grant') return { result: `invalid_${g.reason}` };
      const base = applied?.state === 'pending' ? applied : {
        recordId: m.recordId, productId: m.productId, before: snapshotFields(fields),
        grantFields: g.fields, expiration: g.expiration,
      };
      await writeApplied(redis, orderId, { ...base, state: 'pending' });
      await at.patch(m.recordId, g.fields);
      await writeApplied(redis, orderId, { ...base, state: 'done', appliedAt: new Date().toISOString() });
      await notify('granted', { orderId, recordId: m.recordId, productId: m.productId, expiration: g.expiration });
      return { result: 'granted' };
    }

    // 返金（取消）
    if (!applied || applied.state !== 'done') return { result: 'refund_without_grant' };
    const r = decideRefundRevert({ current: fields, applied });
    if (r.action === 'noop') return { result: r.reason };
    if (r.action === 'conflict') {
      await notify('refund_conflict', { orderId, recordId: m.recordId, reason: r.reason });
      return { result: `refund_conflict_${r.reason}` };
    }
    await at.patch(m.recordId, r.fields);
    await writeApplied(redis, orderId, { ...applied, reverted: true, revertedAt: new Date().toISOString() });
    await notify('refunded', { orderId, recordId: m.recordId });
    return { result: 'reverted' };
  });
  if (out?.busy) return { result: 'busy', retry: true };
  return out;
}

/** 決済完了画面の確認用（本人の注文だけ） */
export async function readCardOrderStatus({ redis, orderId, recordId }) {
  if (!redis) return { status: 'unknown' };
  const a = await readApplied(redis, orderId);
  if (!a) return { status: 'pending' };
  if (String(a.recordId) !== String(recordId)) return { status: 'not_found' };
  if (a.state === 'done') return { status: a.reverted ? 'refunded' : 'active', expiration: a.expiration };
  if (a.state === 'conflict') return { status: 'needs_support' };
  return { status: 'pending' };
}
