/**
 * paypalSubscriptionServer.js — PayPal 月額定期課金の I/O（PayPal API・Airtable・Redis）
 * 判定は paypalSubscriptionCore.js（純粋）。仕様は同ファイル冒頭と CARD_PAYMENT_PROVIDERS.md §3.5。
 *
 * 流れ: 申込作成（サーバー。ログイン中はその会員・未ログインは入力メールの会員）→ 顧客が PayPal で承認 → 戻り先・Webhook がそれぞれ
 *   「購読を PayPal API で照会 → 同じ判定で絶対値を書く」（applyPaypalSubscription）。順不同・重複・再送でも同じ結果。
 * 退会: withdrawPaypalSubscriber（購読を即時 cancel → 退会状態）。cancel 後に書込みが失敗しても、
 *   CANCELLED の通知が status_change_note の印を見て同じ退会状態へ収束させる。
 * 購読ごとの排他は stripeServer.withSubscriptionLock（反映と退会が同じ鍵）。
 *
 * ⚠️ クライアント秘密・メールアドレス・レコード内容をログに出さない。
 */

import { createHash } from 'node:crypto';
import { airtable, withSubscriptionLock, findCustomerByEmail, normalizeEmail } from '../stripeServer.js';
import { resolveMembership, MEMBER_TYPE } from '../../auth/memberResolution.js';
import { UNVERIFIED_CHECKOUT_SOURCE } from '../../marketing/unverifiedCheckoutRecord.js';
import { subscriptionProviderGate, SUBSCRIPTION_SALES_OPEN, resolveCardMode } from '../cardSales.js';
import { buildPremiumConversionFields } from '../../payments/premiumConversion.js';
import { withdrawalFields } from '../stripeSubscriptionSync.js';
import { paypalApi } from './paypalServer.js';
import { markPostPurchase, destinationForPlan } from './postPurchaseLanding.js';
import { keyMode, PAYPAL_API } from './paypalCore.js';
import {
  PROVIDER, buildSubscriptionBody, approveUrlOf, snapshotPaypalSubscription, decidePaypalSubscriptionSync,
  decidePaypalSubscriptionPurchase, decidePaypalWithdrawal, parseSubscriptionWebhook, isSubscriptionId,
  memberKey, LIVE_STATUSES, MEMBER_WITHDRAWAL_NOTE, PAYPAL_PLAN_IDS, LIFETIME_BANK_ONLY, subscriptionPlanById,
} from './paypalSubscriptionCore.js';

/** このサイト・この鍵で月額を受け付けるか（本番は SUBSCRIPTION_SALES_OPEN.paypal のときだけ）*/
export function resolvePaypalSubscriptionMode({ env = {}, origin, salesOpen = SUBSCRIPTION_SALES_OPEN[PROVIDER] === true } = {}) {
  const km = keyMode({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, env: env.PAYPAL_ENV });
  const r = resolveCardMode({ provider: PROVIDER, keyMode: km, origin, salesOpen });
  return r.ok ? { ...r, apiBase: PAYPAL_API[r.mode] } : r;
}

/**
 * 確定・退会・通知の反映に使うモード。販売を閉じた後でも、既存の購読の更新・終了は反映し続ける
 * （新規の申込だけを SUBSCRIPTION_SALES_OPEN で止める。Stripe の既存契約と同じ扱い）。
 */
export function resolvePaypalSubscriptionSettleMode({ env = {}, origin } = {}) {
  return resolvePaypalSubscriptionMode({ env, origin, salesOpen: true });
}

/** 一回払いと同じ PayPal クライアント（トークン・エラー処理）の上に、月額の API だけを足す */
function apiFor(env, mode, fetchImpl) {
  const { call, verifyWebhook } = paypalApi({ apiBase: mode.apiBase, clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, fetchImpl });
  return {
    verifyWebhook,
    createSubscription: (body, requestId) => call('POST', '/v1/billing/subscriptions', body, requestId),
    getSubscription: (id) => call('GET', `/v1/billing/subscriptions/${encodeURIComponent(id)}`),
    cancelSubscription: (id, reason) => call('POST', `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason }),
    getSale: (id) => call('GET', `/v1/payments/sale/${encodeURIComponent(id)}`),
  };
}

async function readOwnedSubId(redis, recordId) {
  const v = await redis(['GET', memberKey(recordId)]);
  return isSubscriptionId(v) ? v : null;
}

async function isLive(api, subId) {
  try { return LIVE_STATUSES.includes(String((await api.getSubscription(subId))?.status || '')); } catch (e) { return e.status === 404 ? false : true; }
}

/**
 * 未ログインの申込で新しく作る会員レコード（無料会員と同じ形。ポイント・メール登録・通知はしない）。
 * メールは本人確認前なので、支払いで有料になるまで全配信から外す（marketing/unverifiedCheckoutRecord.js）。
 */
export const CHECKOUT_RECORD_SOURCE = UNVERIFIED_CHECKOUT_SOURCE;

/**
 * 未ログインの申込: 入力メールの会員レコードを決める（2026-10-21・無料会員／初めての方が申し込めない不具合の修正）。
 *
 * 無料会員はセッションを持たない（decisions「無料会員はセッションを持たず」）ため、ログイン必須では
 * 無料会員・初めての方が月額・年額へ進めなかった（ログイン→料金ページ→ログインの往復）。
 * 旧 Stripe 月額（未ログインは入力メールで受付）と同じく、メールで会員を決めて custom_id の recordId に固定する。
 * Webhook・戻り先は custom_id の recordId だけを信用する（従来どおり・クライアントの値は使わない）。
 *   - 一致 1 件: そのレコード。ただし利用停止・強制ログアウト・判定不能（ログインできない会員）は 403 で断る
 *     （支払いで Status=active に戻せてしまうため）
 *   - 一致 0 件: 申込を作れると判定できた後にだけ、無料会員のレコードを 1 件作る（メールごとの排他で二重作成しない）
 *   - 複数一致: 特定できないので 409（マジックリンク・Stripe と同じ fail closed）
 * 他人のメールで払っても、決済後のログインはそのメールに届くマジックリンクなので、払った人は閲覧できない（Stripe と同じ考え方）。
 * @returns {Promise<{ ok: true, recordId: string, fields: object, created: boolean } | { ok: false, status: number, code: string }>}
 */
async function resolveCheckoutRecord({ at, email, planId, redis, now }) {
  const existing = await findCustomerByEmail(at, email);
  if (existing.kind === 'conflict') return { ok: false, status: 409, code: 'account_conflict' };
  if (existing.kind === 'one') {
    const m = resolveMembership({ fields: existing.record.fields || {}, recordId: existing.record.id, now: now.getTime() });
    if (m.memberType === MEMBER_TYPE.DENIED) return { ok: false, status: 403, code: 'account_unavailable' };
    return { ok: true, recordId: existing.record.id, fields: existing.record.fields || {}, created: false };
  }
  // 新しい方: レコードを作る前に、空の会員として申込めるかを先に確かめる（特典価格など作っても申込めないなら作らない）
  const pre = decidePaypalSubscriptionPurchase({ planId, fields: {}, ownedSubLive: false, now });
  if (!pre.ok) return { ok: false, status: pre.code === 'invalid_plan' ? 400 : 409, code: pre.code };
  // メールアドレスそのものを Redis の鍵に残さない（ハッシュ）
  const lockKey = `email-${createHash('sha256').update(email).digest('hex').slice(0, 32)}`;
  const r = await withSubscriptionLock(redis, lockKey, async () => {
    const again = await findCustomerByEmail(at, email);
    if (again.kind === 'conflict') return { ok: false, status: 409, code: 'account_conflict' };
    if (again.kind === 'one') return { ok: true, recordId: again.record.id, fields: again.record.fields || {}, created: false };
    const rec = await at.create({ Email: email, 'プラン': 'Free', Source: CHECKOUT_RECORD_SOURCE });
    if (!rec?.id) return { ok: false, status: 502, code: 'subscription_failed' };
    return { ok: true, recordId: rec.id, fields: rec.fields || {}, created: true };
  });
  if (r?.action === 'busy') return { ok: false, status: 503, code: 'busy' };
  return r;
}

/**
 * 申込を作る。ログイン中（recordId）はその会員、未ログインは入力メール（email）の会員に固定する。
 * @returns {{ ok: true, url, subscriptionId, provider, recordId, guest } | { ok: false, status, code }}
 */
export async function createPaypalSubscription({ env, origin, recordId, email = '', planId, entry = 'direct', redis, fetchImpl, ids = PAYPAL_PLAN_IDS, now = new Date() }) {
  const mode = resolvePaypalSubscriptionMode({ env, origin });
  if (!mode.ok) return { ok: false, status: 503, code: mode.reason };
  const gate = subscriptionProviderGate({ provider: PROVIDER, mode: mode.mode, entry });
  if (!gate.ok) return { ok: false, status: 409, code: gate.reason };
  // 会員に触れる前に商品を確かめる（買い切りは銀行振込だけ・知らない商品は断る）
  if (String(planId || '') === 'premium-lifetime') return { ok: false, status: 409, code: LIFETIME_BANK_ONLY };
  if (!subscriptionPlanById(planId)) return { ok: false, status: 400, code: 'invalid_plan' };
  if (!recordId) {
    if (!String(email ?? '').trim()) return { ok: false, status: 400, code: 'email_required' };
    if (!normalizeEmail(email)) return { ok: false, status: 400, code: 'invalid_email' };
  }
  if (!redis) return { ok: false, status: 503, code: 'redis_missing' };
  const at = airtable(env, fetchImpl);
  let fields;
  const guest = !recordId;
  if (recordId) {
    let rec;
    try { rec = await at.get(recordId); } catch { return { ok: false, status: 401, code: 'login_required' }; }
    fields = rec?.fields || {};
  } else {
    const r = await resolveCheckoutRecord({ at, email: normalizeEmail(email), planId, redis, now });
    if (!r.ok) return r;
    recordId = r.recordId;
    fields = r.fields;
  }
  const api = apiFor(env, mode, fetchImpl);
  const owned = await readOwnedSubId(redis, recordId);
  const ownedSubLive = owned ? await isLive(api, owned) : false;
  const d = decidePaypalSubscriptionPurchase({ planId, fields, ownedSubLive, now });
  if (!d.ok) return { ok: false, status: d.code === 'invalid_plan' ? 400 : 409, code: d.code };
  let body;
  try { body = buildSubscriptionBody({ planId: d.plan.id, recordId, origin, mode: mode.mode, ids }); } catch (e) { return { ok: false, status: 503, code: e.code || 'plan_not_configured' }; }
  const sub = await api.createSubscription(body, `ak-sub-${recordId}-${d.plan.id}-${Date.now()}`);
  const url = approveUrlOf(sub);
  if (!isSubscriptionId(sub?.id) || !url) return { ok: false, status: 502, code: 'subscription_failed' };
  // recordId は申込の Function が戻り先の鍵（subscriptionReturnToken.js）を作るためだけに使う。お客様へは返さない
  return { ok: true, url, subscriptionId: sub.id, provider: PROVIDER, recordId, guest };
}

/**
 * 購読 1 件を PayPal で照会し、Customers へ反映する（戻り先・Webhook 共通・冪等）。
 * @returns {{ ok: boolean, action: 'write'|'skip'|'conflict'|'busy', reason: string, recordId?: string }}
 */
export async function applyPaypalSubscription({ env, origin, subscriptionId, redis, notify = async () => {}, fetchImpl, now = new Date(), ids = PAYPAL_PLAN_IDS }) {
  const mode = resolvePaypalSubscriptionSettleMode({ env, origin });
  if (!mode.ok) return { ok: true, action: 'skip', reason: `ignored_${mode.reason}` };
  if (!isSubscriptionId(subscriptionId)) return { ok: false, action: 'skip', reason: 'invalid_subscription' };
  if (!redis) return { ok: false, action: 'busy', reason: 'redis_missing' };
  return withSubscriptionLock(redis, subscriptionId, async () => {
    const api = apiFor(env, mode, fetchImpl);
    let raw;
    try { raw = await api.getSubscription(subscriptionId); } catch (e) {
      return e.status === 404 ? { ok: true, action: 'skip', reason: 'subscription_not_found' } : { ok: false, action: 'busy', reason: 'lookup_failed' };
    }
    const sub = snapshotPaypalSubscription(raw);
    if (!sub.recordId) {
      await notify('subscription_conflict', { provider: PROVIDER, reason: 'no_record', paymentId: sub.id });
      return { ok: false, action: 'conflict', reason: 'no_record' };
    }
    const at = airtable(env, fetchImpl);
    let record;
    try { record = await at.get(sub.recordId); } catch (e) {
      if (/airtable_404/.test(String(e?.message))) {
        await notify('subscription_conflict', { provider: PROVIDER, reason: 'record_not_found', paymentId: sub.id });
        return { ok: false, action: 'conflict', reason: 'record_not_found' };
      }
      throw e;
    }
    const fields = record?.fields || {};
    const ownedSubId = await readOwnedSubId(redis, sub.recordId);
    const otherSubscriptionLive = ownedSubId && ownedSubId !== sub.id ? await isLive(api, ownedSubId) : false;
    const decision = decidePaypalSubscriptionSync({ fields, sub, mode: mode.mode, ownedSubId, otherSubscriptionLive, now, ids });
    if (decision.action === 'skip') return { ok: true, action: 'skip', reason: decision.reason, recordId: sub.recordId };
    if (decision.action === 'conflict') {
      await notify('subscription_conflict', { provider: PROVIDER, reason: decision.reason, paymentId: sub.id, recordId: sub.recordId, productId: decision.plan?.id });
      return { ok: false, action: 'conflict', reason: decision.reason, recordId: sub.recordId };
    }
    await at.patch(sub.recordId, decision.fields);
    if (decision.newlyAttached) {
      // 以後の更新・退会がこの購読へ届くように（Customers には ID の列が無い）
      await redis(['SET', memberKey(sub.recordId), sub.id]);
      try {
        const conv = buildPremiumConversionFields({ previousFields: fields, confirmationFields: decision.fields, confirmedAt: now });
        if (conv) await at.patch(sub.recordId, conv);
      } catch { /* 履歴は失敗しても権限付与を巻き戻さない */ }
      await notify('subscription_attached', { provider: PROVIDER, paymentId: sub.id, recordId: sub.recordId, productId: decision.plan?.id, expiration: decision.expiration });
      // 購入直後の印（ログイン後に利用画面へ自動で届けるため・postPurchaseLanding.js）。失敗しても付与は巻き戻さない
      await markPostPurchase(redis, { recordId: sub.recordId, planId: decision.plan?.id, subscriptionId: sub.id, now });
    }
    return { ok: true, action: 'write', reason: decision.reason, recordId: sub.recordId };
  });
}

/** Webhook（検証済み）の 1 件。購読・月額の売上のイベントでなければ null（一回払いの処理へ回す）*/
export async function handlePaypalSubscriptionEvent({ env, origin, event, redis, notify = async () => {}, fetchImpl, now, ids }) {
  const p = parseSubscriptionWebhook(event);
  if (!p) return null;
  if (p.ignored) return { status: 200, result: 'ignored_event' };
  const mode = resolvePaypalSubscriptionSettleMode({ env, origin });
  if (!mode.ok) return { status: 200, result: `ignored_${mode.reason}` };
  let subId = p.subscriptionId;
  if (!subId && p.saleId) {
    try { subId = (await apiFor(env, mode, fetchImpl).getSale(p.saleId))?.billing_agreement_id; } catch (e) { return { status: e.status === 404 ? 200 : 500, result: 'sale_lookup_failed' }; }
  }
  if (!isSubscriptionId(subId)) return { status: 200, result: 'subscription_unknown' };
  // 返金・リバーサル: 月額は返金しない方針（例外は管理者が手で行う）。権限は自動で戻さず管理者へ知らせる（Stripe 月額と同じ）
  if (p.refund) {
    await notify('subscription_refunded', { provider: PROVIDER, paymentId: subId, reason: p.eventType });
    return { status: 200, result: 'refund_notified' };
  }
  const r = await applyPaypalSubscription({ env, origin, subscriptionId: subId, redis, notify, fetchImpl, now, ids });
  return { status: r.action === 'busy' ? 500 : 200, result: `${r.action}_${r.reason}` };
}

/** 戻り先: 本人の購読か確かめてから反映し、状態を返す（表示用）*/
export async function confirmPaypalSubscription({ env, origin, subscriptionId, recordId, redis, notify, fetchImpl, now, ids }) {
  const mode = resolvePaypalSubscriptionSettleMode({ env, origin });
  if (!mode.ok) return { status: 503, body: { error: mode.reason } };
  if (!isSubscriptionId(subscriptionId)) return { status: 400, body: { error: 'invalid_subscription' } };
  let raw;
  try { raw = await apiFor(env, mode, fetchImpl).getSubscription(subscriptionId); } catch { return { status: 502, body: { error: 'lookup_failed' } }; }
  const sub = snapshotPaypalSubscription(raw);
  if (!recordId || sub.recordId !== recordId) return { status: 404, body: { status: 'not_found' } };
  const r = await applyPaypalSubscription({ env, origin, subscriptionId, redis, notify, fetchImpl, now, ids });
  const status = r.action === 'write' || (r.action === 'skip' && r.reason === 'renewed') ? 'active'
    : r.action === 'conflict' ? 'needs_support'
      : ['APPROVAL_PENDING', 'APPROVED'].includes(sub.status) || r.reason === 'awaiting_payment' ? 'pending' : 'unknown';
  // 反映済み（active）のときだけ、買った商品の利用画面を返す（戻り先がそこへ自動で移る・遷移先は許可リストの 3 つだけ）
  const destination = status === 'active' ? destinationForPlan(sub.planId) : null;
  return { status: 200, body: { status, plan: sub.planId, ...(destination ? { destination } : {}) } };
}

export const WITHDRAWAL_STATUS = Object.freeze({
  withdrawn: 200, already_withdrawn: 409, subscription_mismatch: 409, not_paypal_subscriber: 404,
  record_not_found: 404, cancel_failed: 502, record_write_failed: 502, busy: 503,
});

/** 退会（即時・2026-10-07 の月額退会の仕様をそのまま PayPal に適用）*/
export async function withdrawPaypalSubscriber({ env, origin, recordId, reason = null, redis, fetchImpl, now = new Date() }) {
  const mode = resolvePaypalSubscriptionSettleMode({ env, origin });
  if (!mode.ok) return { ok: false, result: 'not_configured' };
  if (!recordId) return { ok: false, result: 'record_not_found' };
  if (!redis) return { ok: false, result: 'busy' };
  const ownedSubId = await readOwnedSubId(redis, recordId);
  if (!ownedSubId) return { ok: false, result: 'not_paypal_subscriber' };
  const at = airtable(env, fetchImpl);
  const r = await withSubscriptionLock(redis, ownedSubId, async () => {
    let record;
    try { record = await at.get(recordId); } catch { return { ok: false, result: 'record_not_found' }; }
    const fields = record?.fields || {};
    const api = apiFor(env, mode, fetchImpl);
    let sub;
    try { sub = snapshotPaypalSubscription(await api.getSubscription(ownedSubId)); } catch { return { ok: false, result: 'subscription_mismatch' }; }
    const d = decidePaypalWithdrawal({ fields, recordId, ownedSubId, sub });
    if (!d.ok) return { ok: false, result: d.reason };
    if (d.cancel) {
      try { await api.cancelSubscription(ownedSubId, MEMBER_WITHDRAWAL_NOTE); } catch {
        let again = null;
        try { again = snapshotPaypalSubscription(await api.getSubscription(ownedSubId)); } catch { again = null; }
        if (!again || !['CANCELLED', 'EXPIRED'].includes(again.status)) return { ok: false, result: 'cancel_failed' };
      }
    }
    const out = withdrawalFields({ fields, now, reason });
    try { await at.patch(recordId, out); } catch { return { ok: false, result: 'record_write_failed', cancelled: d.cancel }; }
    return { ok: true, result: 'withdrawn', email: String(fields.Email || ''), cancelled: d.cancel };
  });
  if (r && r.action === 'busy') return { ok: false, result: 'busy' };
  return r;
}
