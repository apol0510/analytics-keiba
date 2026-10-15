/**
 * entitlementLedger.js — カード決済（決済会社共通）の**会員権限への反映**の単一源（Redis・Airtable の I/O）
 *
 * 各決済会社のアダプタ（paddle / paypal）は「決済会社の API で照会して確かめた事実」
 * （どの会員が・どの商品を・いつ支払った／全額返金された）だけを渡す。権限の書き換えはここだけが行う。
 * 判定（何を書くか）は cardOneTime.decideCardGrant、返金の戻しは decideRefundRevert（純粋）。
 *
 * ## 二重昇格・期限誤更新・誤失効を作らない仕組み
 * - **会員ごとのロック** `ak:billing:member-lock:{recordId}`（決済会社をまたいで同じ鍵）で直列化。
 * - **決済ごとの状態** `ak:card:{provider}:applied:{paymentId}`: PATCH の前に pending（付与前の値と付与する値を保存）
 *   → PATCH → done。再送で pending を見たら、レコードが付与後の値なら done にするだけ（年払いの二重延長を防ぐ）。
 * - **二重購入の疑い**: 同じ会員に別の決済の付与が 30 分以内にあれば、権限は変えず管理者へ（返金判断）。
 *   決済会社をまたいだ二重クリック・二重決済で期限が 2 年延びる事故を防ぐ。返金で戻した決済は対象から外す。
 * - **返金は全額だけ戻す**（一部返金は権限を変えず管理者へ）。付与後に別の変更があれば戻さない（管理者へ）。
 * - Redis が無ければ反映しない（fail closed。決済会社が再送する）。
 *
 * ⚠️ 鍵・カード情報・メールアドレス・レコード内容をログに出さない。
 */

import { decideCardGrant } from './cardOneTime.js';
import { snapshotFields, decideRefundRevert } from './cardRefund.js';

const APPLIED_TTL_SEC = 400 * 24 * 3600; // 返金・チャージバック期限より長く持つ
export const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;
export const PROVIDERS = Object.freeze(['paddle', 'paypal']);

export const appliedKey = (provider, paymentId) => `ak:card:${provider}:applied:${paymentId}`;
const memberLockKey = (recordId) => `ak:billing:member-lock:${recordId}`;
const recentGrantKey = (recordId) => `ak:billing:recent-grant:${recordId}`;
const RECORD_RE = /^rec[A-Za-z0-9]{14}$/;

function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) throw Object.assign(new Error('invalid_provider'), { code: 'invalid_provider' });
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

async function readJson(redis, key) {
  const v = await redis(['GET', key]);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
const writeApplied = (redis, provider, paymentId, obj) => redis(['SET', appliedKey(provider, paymentId), JSON.stringify(obj), 'EX', String(APPLIED_TTL_SEC)]);

/**
 * 支払い確認済みの決済を会員へ反映する。
 * @param {{ redis, at, provider, paymentId, recordId, productId, paidAt: Date, notify?, now?: () => number }} input
 * @returns {Promise<{ result: string, retry?: boolean }>}
 */
export async function applyCardGrant({ redis, at, provider, paymentId, recordId, productId, paidAt, notify = async () => {}, now = Date.now }) {
  assertProvider(provider);
  if (!redis) return { result: 'redis_missing', retry: true };
  if (!RECORD_RE.test(String(recordId || ''))) return { result: 'invalid_record' };
  const out = await withMemberLock(redis, recordId, async () => {
    const applied = await readJson(redis, appliedKey(provider, paymentId));
    if (applied?.state === 'done') return { result: 'already_applied' };
    if (applied?.state === 'conflict') return { result: `conflict_${applied.reason}` };
    let rec;
    try { rec = await at.get(recordId); } catch { return { result: 'record_lookup_failed', retry: true }; }
    const fields = rec?.fields || {};

    if (applied?.state === 'pending') {
      // 前回 PATCH 後に止まった可能性。レコードが付与後の値ならそのまま done（再 PATCH しない）
      if (String(fields['有効期限'] || '').slice(0, 10) === applied.expiration && fields.PaymentMethod === provider) {
        await writeApplied(redis, provider, paymentId, { ...applied, state: 'done' });
        await markRecentGrant(redis, recordId, provider, paymentId, now());
        return { result: 'recovered_applied' };
      }
    } else {
      const recent = await readJson(redis, recentGrantKey(recordId));
      if (recent && !(recent.provider === provider && recent.paymentId === paymentId) && now() - Number(recent.at) < DUPLICATE_WINDOW_MS) {
        const reason = 'possible_duplicate_purchase';
        await writeApplied(redis, provider, paymentId, { state: 'conflict', recordId, productId, reason, other: `${recent.provider}:${recent.paymentId}` });
        await notify('conflict', { provider, paymentId, recordId, productId, reason });
        return { result: `conflict_${reason}` };
      }
    }

    const g = decideCardGrant({ productId, fields, paidAt, provider });
    if (g.action === 'conflict') {
      await writeApplied(redis, provider, paymentId, { state: 'conflict', recordId, productId, reason: g.reason });
      await notify('conflict', { provider, paymentId, recordId, productId, reason: g.reason });
      return { result: `conflict_${g.reason}` };
    }
    if (g.action !== 'grant') return { result: `invalid_${g.reason}` };
    const base = applied?.state === 'pending' ? applied : {
      provider, recordId, productId, before: snapshotFields(fields), grantFields: g.fields, expiration: g.expiration,
    };
    await writeApplied(redis, provider, paymentId, { ...base, state: 'pending' });
    await at.patch(recordId, g.fields);
    await writeApplied(redis, provider, paymentId, { ...base, state: 'done', appliedAt: new Date(now()).toISOString() });
    await markRecentGrant(redis, recordId, provider, paymentId, now());
    await notify('granted', { provider, paymentId, recordId, productId, expiration: g.expiration });
    return { result: 'granted' };
  });
  if (out?.busy) return { result: 'busy', retry: true };
  return out;
}

async function markRecentGrant(redis, recordId, provider, paymentId, at) {
  await redis(['SET', recentGrantKey(recordId), JSON.stringify({ provider, paymentId, at }), 'EX', String(Math.ceil(DUPLICATE_WINDOW_MS / 1000))]);
}

/**
 * 全額返金・取消・チャージバックが確定した決済を、付与前の状態へ戻す。
 * @param {{ redis, at, provider, paymentId, recordId, full?: boolean, notify? }} input  full=false は一部返金（戻さず管理者へ）
 */
export async function applyCardRefund({ redis, at, provider, paymentId, recordId, full = true, notify = async () => {}, now = Date.now }) {
  assertProvider(provider);
  if (!redis) return { result: 'redis_missing', retry: true };
  if (!RECORD_RE.test(String(recordId || ''))) return { result: 'invalid_record' };
  const out = await withMemberLock(redis, recordId, async () => {
    const applied = await readJson(redis, appliedKey(provider, paymentId));
    if (!applied || applied.state !== 'done') {
      if (applied?.state === 'conflict') await notify('refund_of_conflict', { provider, paymentId, recordId, reason: applied.reason });
      return { result: 'refund_without_grant' };
    }
    if (String(applied.recordId) !== String(recordId)) return { result: 'record_mismatch' };
    if (applied.reverted) return { result: 'already_reverted' };
    if (!full) {
      await notify('partial_refund', { provider, paymentId, recordId });
      return { result: 'partial_refund_no_change' };
    }
    let rec;
    try { rec = await at.get(recordId); } catch { return { result: 'record_lookup_failed', retry: true }; }
    const r = decideRefundRevert({ current: rec?.fields || {}, applied });
    if (r.action === 'noop') return { result: r.reason };
    if (r.action === 'conflict') {
      await notify('refund_conflict', { provider, paymentId, recordId, reason: r.reason });
      return { result: `refund_conflict_${r.reason}` };
    }
    await at.patch(recordId, r.fields);
    await writeApplied(redis, provider, paymentId, { ...applied, reverted: true, revertedAt: new Date(now()).toISOString() });
    // 返金で戻した決済は「直前の付与」から外す（返金→すぐ再購入を二重購入と誤判定しない）
    const recent = await readJson(redis, recentGrantKey(recordId));
    if (recent && recent.provider === provider && recent.paymentId === paymentId) await redis(['DEL', recentGrantKey(recordId)]);
    await notify('refunded', { provider, paymentId, recordId });
    return { result: 'reverted' };
  });
  if (out?.busy) return { result: 'busy', retry: true };
  return out;
}

/** 決済完了画面の確認用（本人の決済だけ） */
export async function readCardOrderStatus({ redis, provider, paymentId, recordId }) {
  assertProvider(provider);
  if (!redis) return { status: 'unknown' };
  const a = await readJson(redis, appliedKey(provider, paymentId));
  if (!a) return { status: 'pending' };
  if (String(a.recordId) !== String(recordId)) return { status: 'not_found' };
  if (a.state === 'done') return { status: a.reverted ? 'refunded' : 'active', expiration: a.expiration };
  if (a.state === 'conflict') return { status: 'needs_support' };
  return { status: 'pending' };
}
