/**
 * stripeServer.js — Stripe 購読を Customers へ反映する I/O 層（Webhook と決済完了画面が共用）
 *
 * 判定は `stripeSubscriptionSync.decideSubscriptionSync`（純粋）。ここは
 *   1. 誰のレコードか特定する
 *   2. 判定に要る事実（別購読が生きているか）を Stripe から集める
 *   3. 判定どおりに PATCH する
 * だけを行う。
 *
 * ## レコードの特定（上から順に・最初に当たったもの）
 *   1. `StripeSubscriptionId` が一致するレコード（2 回目以降のイベント）
 *   2. 購読 metadata の `ak_record_id`（ログイン中に申し込んだ会員）
 *   3. Stripe Customer のメールアドレス（`LOWER(TRIM({Email}))`・マジックリンクと同じ照合）
 *   4. どれも無ければ新規作成（未登録のまま決済した人）
 * 同じメールで複数レコードがある場合は**書かない**（マジックリンクと同じ fail closed）。
 *
 * ⚠️ 秘密鍵・メールアドレス・レコード内容をログに出さない。
 */

import { snapshotSubscription, decideSubscriptionSync } from './stripeSubscriptionSync.js';
import { buildPremiumConversionFields } from '../payments/premiumConversion.js';

const TABLE = 'Customers';

function airtable(env, fetchImpl) {
  const key = env.AIRTABLE_API_KEY;
  const base = env.AIRTABLE_BASE_ID;
  if (!key || !base) throw new Error('airtable_env_missing');
  const f = fetchImpl || fetch;
  const root = `https://api.airtable.com/v0/${encodeURIComponent(base)}/${encodeURIComponent(TABLE)}`;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  async function call(url, init) {
    const res = await f(url, { headers, ...init });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const code = json?.error?.type || json?.error || res.status;
      throw new Error(`airtable_${res.status}_${code}`);
    }
    return json;
  }
  return {
    async get(id) {
      return call(`${root}/${encodeURIComponent(id)}`, { method: 'GET' });
    },
    async select(formula, maxRecords = 5) {
      const q = new URLSearchParams({ filterByFormula: formula, maxRecords: String(maxRecords) });
      const j = await call(`${root}?${q}`, { method: 'GET' });
      return j?.records || [];
    },
    async patch(id, fields) {
      return call(`${root}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ fields }) });
    },
    async create(fields) {
      const j = await call(root, { method: 'POST', body: JSON.stringify({ records: [{ fields }] }) });
      return j?.records?.[0];
    },
  };
}

/** Airtable の数式に入れる文字列を安全にする */
export function formulaString(v) {
  return `'${String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function normalizeEmail(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
}

/** メールでレコードを探す。{kind:'none'|'one'|'conflict', record?} */
export async function findCustomerByEmail(at, email) {
  const e = normalizeEmail(email);
  if (!e) return { kind: 'none' };
  const recs = await at.select(`LOWER(TRIM({Email})) = ${formulaString(e)}`, 3);
  if (recs.length === 0) return { kind: 'none' };
  if (recs.length > 1) return { kind: 'conflict' };
  return { kind: 'one', record: recs[0] };
}

/**
 * 購読 1 件を Customers へ反映する。
 *
 * @param {{ stripe: object, env: object, subscription: object|string, now?: Date, fetchImpl?: Function, notify?: Function, redis?: Function|null }} input
 *   notify(event, detail) — 管理者通知（新規契約・conflict）。失敗しても反映は止めない。
 * @returns {Promise<{ ok: boolean, action: string, reason: string, recordId?: string, email?: string, planId?: string }>}
 */
export async function applySubscription(input) {
  const { env, subscription, redis = null } = input;
  const subId = typeof subscription === 'string' ? subscription : subscription?.id;
  if (!subId) return { ok: false, action: 'skip', reason: 'no_subscription' };
  // ⚠️ Webhook と決済完了画面が**同時に**同じ購読を処理すると、未登録の人のレコードが
  //    2 件作られる。購読ごとの排他ロック（Redis SET NX）で 1 本ずつ通す。
  if (!redis) return applySubscriptionLocked({ ...input, subId });
  const key = `ak:stripe:lock:${subId}`;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (let i = 0; i < 16; i += 1) {
    const got = await redis(['SET', key, token, 'NX', 'PX', '30000']);
    if (got === 'OK') {
      try {
        return await applySubscriptionLocked({ ...input, subId });
      } finally {
        try {
          const cur = await redis(['GET', key]);
          if (cur === token) await redis(['DEL', key]);
        } catch { /* 30 秒で自然に外れる */ }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, action: 'busy', reason: 'lock_timeout' };
}

async function applySubscriptionLocked({ stripe, env, subId, now = new Date(), fetchImpl, notify = async () => {} }) {
  // イベントに載ってきた購読は古いことがある（順不同で届く）。常に Stripe の最新を読む。
  const fresh = await stripe.subscriptions.retrieve(subId);
  const sub = snapshotSubscription(fresh);
  const at = airtable(env, fetchImpl);

  // ── 1〜4. レコード特定 ──
  let record = null;
  const bySub = await at.select(`{StripeSubscriptionId} = ${formulaString(sub.id)}`, 2);
  if (bySub.length > 1) {
    await notify('conflict', { reason: 'duplicate_subscription_records', subscriptionId: sub.id });
    return { ok: false, action: 'conflict', reason: 'duplicate_subscription_records' };
  }
  if (bySub.length === 1) record = bySub[0];

  if (!record && /^rec[A-Za-z0-9]{14}$/.test(String(sub.metadata.ak_record_id || ''))) {
    try { record = await at.get(sub.metadata.ak_record_id); } catch { record = null; }
  }

  let email = '';
  if (record) {
    email = normalizeEmail(record.fields?.Email);
  } else {
    const customer = sub.customerId ? await stripe.customers.retrieve(sub.customerId) : null;
    email = normalizeEmail(customer?.email || sub.metadata.ak_email);
    if (!email) {
      await notify('conflict', { reason: 'no_email', subscriptionId: sub.id });
      return { ok: false, action: 'conflict', reason: 'no_email' };
    }
    const found = await findCustomerByEmail(at, email);
    if (found.kind === 'conflict') {
      await notify('conflict', { reason: 'duplicate_email_records', subscriptionId: sub.id });
      return { ok: false, action: 'conflict', reason: 'duplicate_email_records' };
    }
    if (found.kind === 'one') record = found.record;
  }

  const fields = record?.fields || {};

  // ── 2. 別の購読が生きているか（二重課金の検知）──
  let otherSubscriptionLive = false;
  const otherId = String(fields.StripeSubscriptionId || '');
  if (otherId && otherId !== sub.id) {
    try {
      const other = await stripe.subscriptions.retrieve(otherId);
      otherSubscriptionLive = ['active', 'trialing', 'past_due', 'incomplete', 'unpaid'].includes(other.status);
    } catch {
      // 読めない＝存在しない購読（テストの残骸など）。乗り換えとして扱う。
      otherSubscriptionLive = false;
    }
  }

  const decision = decideSubscriptionSync({ fields, sub, env, now, otherSubscriptionLive });
  if (decision.action === 'skip') {
    return { ok: true, action: 'skip', reason: decision.reason, recordId: record?.id };
  }
  if (decision.action === 'conflict') {
    await notify('conflict', { reason: decision.reason, subscriptionId: sub.id, recordId: record?.id || null, planId: decision.plan?.id || null });
    return { ok: false, action: 'conflict', reason: decision.reason, recordId: record?.id };
  }

  // ── 3. 書く ──
  if (!record) {
    if (decision.reason === 'ended') return { ok: true, action: 'skip', reason: 'ended_no_record' };
    record = await at.create({ Email: email, Source: 'stripe-checkout' });
  }
  await at.patch(record.id, decision.fields);

  if (decision.newlyAttached) {
    // Light → Premium 転換履歴（銀行振込と同じ単一源・best effort）
    try {
      const conv = buildPremiumConversionFields({
        previousFields: fields, confirmationFields: decision.fields, confirmedAt: now,
      });
      if (conv) await at.patch(record.id, conv);
    } catch {
      // 履歴は失敗しても権限付与を巻き戻さない
    }
    // 後から来るイベントが確実に同じレコードへ届くよう、購読にレコード ID を残す
    if (sub.metadata.ak_record_id !== record.id) {
      try {
        await stripe.subscriptions.update(sub.id, { metadata: { ...sub.metadata, ak_record_id: record.id } });
      } catch {
        // StripeSubscriptionId で引けるので致命的ではない
      }
    }
    await notify('attached', { subscriptionId: sub.id, recordId: record.id, planId: decision.plan?.id || null, expiration: decision.expiration });
  }

  return {
    ok: true,
    action: 'write',
    reason: decision.reason,
    recordId: record.id,
    email,
    planId: decision.plan?.id || null,
  };
}

/** イベントから購読 ID を取り出す（無ければ null = 対象外） */
export function subscriptionIdFromEvent(evt) {
  const o = evt?.data?.object || {};
  switch (evt?.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return o.mode === 'subscription' && typeof o.subscription === 'string' ? o.subscription
        : (o.subscription?.id || null);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return o.id || null;
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const s = o.parent?.subscription_details?.subscription ?? o.subscription;
      return typeof s === 'string' ? s : (s?.id || null);
    }
    default:
      return null;
  }
}
