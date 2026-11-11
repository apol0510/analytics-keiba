/**
 * paddleSubscriptionServer.js — Paddle の定期課金（月額・年額）の I/O（Paddle API・Airtable・Redis）
 * 判定は paddleSubscriptionCore.js（純粋）。仕様は CARD_PAYMENT_PROVIDERS.md §3.8・decisions 2026-11-02。
 *
 * 鍵の置き場所（案 B・2026-10-24）: 本番サイトは PADDLE_API_KEY を持たない（Lambda 4KB）。Paddle API を叩く処理だけを
 *   中立サイト checkout.tirol.link（modern functions）が行い、会員の判定・書込み（Airtable / Redis）は本番サイトが行う。
 *   - 申込: 本番が会員資格を確認 → 署名付き intent（kind=subscription）→ 中立サイトが取引を作る（createPaddleSubscriptionTransaction）
 *   - 通知: 中立サイトが署名検証 → 取引・購読を API で照会 → 購読の写し（snapshot）を本番の internal-paddle-grant へ署名付きで渡す
 *           → 本番が applyPaddleSubscription（購読ごとのロック・絶対値・冪等）
 *   - 退会: 本番が退会の印を置く → 署名付き intent → 中立サイトが本人の購読か確かめて即時解約（cancelPaddleSubscriptionForMember）
 *   Sandbox の Deploy Preview は鍵をローカルに持つので、同じ関数を委譲せずに直接呼ぶ。
 *
 * ⚠️ API 鍵・カード情報・メールアドレス・レコード内容をログに出さない。
 */

import { airtable, withSubscriptionLock, normalizeEmail } from '../stripeServer.js';
import { resolveCardMode, resolveCardModeDelegated, subscriptionProviderGate, SUBSCRIPTION_SALES_OPEN } from '../cardSales.js';
import { buildPremiumConversionFields } from '../../payments/premiumConversion.js';
import { withdrawalFields } from '../stripeSubscriptionSync.js';
import { PADDLE_CHECKOUT_CREATE_URL, PADDLE_SUBSCRIPTION_CANCEL_URL, SUBSCRIPTION_CHECKOUT_FLAG } from '../neutralCheckoutHost.js';
import { resolveCheckoutRecord } from '../paypal/paypalSubscriptionServer.js';
import { markPostPurchase, destinationForPlan } from '../paypal/postPurchaseLanding.js';
import { paddleApi, shouldDelegatePaddle, postSignedIntent } from './paddleApi.js';
import { decideCampaignForCheckout } from '../subscriptionCampaign.js';
import { memberKey as paypalMemberKey } from '../paypal/paypalSubscriptionCore.js';
import { keyMode, PADDLE_API, checkoutUrlMatchesOrigin, isTransactionId } from './paddleCore.js';
import {
  PROVIDER, buildSubscriptionTransactionBody, snapshotPaddleSubscription, decidePaddleSubscriptionSync,
  decidePaddleSubscriptionPurchase, decidePaddleWithdrawal, isPaddleSubscriptionId, isPaddleSubscriber,
  memberKey, withdrawalMarkKey, checkoutMarkKey, txnResultKey, MARK_TTL_SECONDS, returnStatusOf,
  subscriptionPlanById, LIFETIME_BANK_ONLY, CANCELLABLE_STATUSES, isSubscriptionTransaction, SUBSCRIPTION_EVENTS,
} from './paddleSubscriptionCore.js';

const isTruthy = (v) => v === true || v === 1 || /^(true|1|yes)$/i.test(String(v ?? '').trim());
/** 二重クリックで取引を 2 つ作らない（同じ会員・同じ商品の申込を 30 分は同じ取引で返す）*/
export const OPEN_CHECKOUT_TTL_SECONDS = 30 * 60;
export const openCheckoutKey = (recordId, planId) => `ak:paddle:sub:open:${recordId}:${planId}`;
/** 退会の印の寿命（canceled の通知が届くまで十分な長さ）*/
const WITHDRAWAL_MARK_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * このサイトで Paddle の定期課金を受け付けるか（新規の申込用。本番は SUBSCRIPTION_SALES_OPEN.paddle のときだけ）。
 * 鍵が無い本番サイトは委譲の条件（CARD_GRANT_INTERNAL_SECRET）で判定し、鍵の種類は鍵を持つ中立サイトが検査する。
 */
export function resolvePaddleSubscriptionMode({ env = {}, origin, salesOpen = SUBSCRIPTION_SALES_OPEN[PROVIDER] === true } = {}) {
  if (shouldDelegatePaddle({ env, origin })) {
    const r = resolveCardModeDelegated({ provider: PROVIDER, origin, salesOpen });
    return r.ok ? { ...r, delegate: true } : r;
  }
  const r = resolveCardMode({ provider: PROVIDER, keyMode: keyMode(env.PADDLE_API_KEY), origin, salesOpen });
  return r.ok ? { ...r, apiBase: PADDLE_API[r.mode], delegate: false } : r;
}

/** 確定・退会・通知の反映に使うモード（販売を閉じた後も既存の購読の更新・終了は反映し続ける）*/
export function resolvePaddleSubscriptionSettleMode({ env = {}, origin } = {}) {
  return resolvePaddleSubscriptionMode({ env, origin, salesOpen: true });
}

/** 有効な Paddle 購読を持つか（本番は Paddle を照会できないので Customers の値で判定・退会済み/期限切れは対象外）*/
function hasLivePaddleFields(fields = {}, now = new Date()) {
  if (!isPaddleSubscriber(fields) || isTruthy(fields.WithdrawalRequested)) return false;
  const ymd = String(fields['有効期限'] || '').trim();
  const end = /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? Date.parse(`${ymd}T23:59:59+09:00`) : NaN;
  return Number.isFinite(end) && end >= now.getTime();
}

/**
 * これまでにカードの定期課金（Paddle / PayPal）を持ったことがあるか。購読の対応は反映時に書かれ、退会後も残る。
 * 読めなければ null（特別価格を付けない）。
 */
async function readHadCardSubscription(redis, recordId, ownedPaddleSubId) {
  if (ownedPaddleSubId) return true;
  try {
    const [paddle, paypal] = await Promise.all([
      redis(['GET', memberKey(recordId)]),
      redis(['GET', paypalMemberKey(recordId)]),
    ]);
    return Boolean(paddle || paypal);
  } catch { return null; }
}

async function readOwnedSubId(redis, recordId) {
  const v = await redis(['GET', memberKey(recordId)]);
  return isPaddleSubscriptionId(v) ? v : null;
}

function withSubscriptionFlag(url) {
  const u = new URL(url);
  u.searchParams.set(SUBSCRIPTION_CHECKOUT_FLAG.name, SUBSCRIPTION_CHECKOUT_FLAG.value);
  return u.toString();
}

/**
 * Paddle API で定期課金の取引だけを作る（会員資格の確認・Airtable 読みはしない・PADDLE_API_KEY が要る）。
 * 中立サイト（鍵を持つ）が、本番で資格確認済みの intent を受けて使う。Sandbox の Deploy Preview は直接使う。
 * @returns {{ ok: true, url, transactionId } | { ok: false, status, code }}
 */
export async function createPaddleSubscriptionTransaction({ env, origin, recordId, planId, entry = 'direct', campaignId = null, salesOpen, active, fetchImpl }) {
  const mode = resolveCardMode({
    provider: PROVIDER, keyMode: keyMode(env.PADDLE_API_KEY), origin,
    salesOpen: salesOpen === undefined ? SUBSCRIPTION_SALES_OPEN[PROVIDER] === true : salesOpen,
  });
  if (!mode.ok) return { ok: false, status: 503, code: mode.reason };
  const gate = subscriptionProviderGate({ provider: PROVIDER, mode: mode.mode, entry, ...(active ? { active } : {}) });
  if (!gate.ok) return { ok: false, status: 409, code: gate.reason };
  if (String(planId || '') === 'premium-lifetime') return { ok: false, status: 409, code: LIFETIME_BANK_ONLY };
  if (!subscriptionPlanById(planId)) return { ok: false, status: 400, code: 'invalid_plan' };
  let body;
  try { body = buildSubscriptionTransactionBody({ planId, recordId, campaignId }); } catch (e) { return { ok: false, status: 400, code: e.code || 'invalid_plan' }; }
  const api = paddleApi({ apiBase: PADDLE_API[mode.mode], key: env.PADDLE_API_KEY, fetchImpl });
  const txn = await api.createTransaction(body);
  if (!isTransactionId(txn?.id) || !txn?.checkout?.url) return { ok: false, status: 502, code: 'checkout_failed' };
  if (!checkoutUrlMatchesOrigin(txn.checkout.url, origin)) return { ok: false, status: 502, code: 'checkout_url_mismatch' };
  return { ok: true, url: txn.checkout.url, transactionId: txn.id };
}

/**
 * 申込を作る（monthly-create-checkout から）。ログイン中（recordId）はその会員、未ログインは入力メール（email）の会員に固定する。
 * @returns {{ ok: true, url, subscriptionId, provider, recordId, guest } | { ok: false, status, code }}
 *   subscriptionId は戻り先の確認に使う取引 ID（txn_…・Paddle の購読 ID は支払い後にできる）
 */
export async function createPaddleSubscriptionCheckout({ env, origin, recordId, email = '', planId, entry = 'direct', redis, fetchImpl, now = new Date() }) {
  const mode = resolvePaddleSubscriptionMode({ env, origin });
  if (!mode.ok) return { ok: false, status: 503, code: mode.reason };
  const gate = subscriptionProviderGate({ provider: PROVIDER, mode: mode.mode, entry });
  if (!gate.ok) return { ok: false, status: 409, code: gate.reason };
  if (String(planId || '') === 'premium-lifetime') return { ok: false, status: 409, code: LIFETIME_BANK_ONLY };
  if (!subscriptionPlanById(planId)) return { ok: false, status: 400, code: 'invalid_plan' };
  if (!recordId) {
    if (!String(email ?? '').trim()) return { ok: false, status: 400, code: 'email_required' };
    if (!normalizeEmail(email)) return { ok: false, status: 400, code: 'invalid_email' };
  }
  if (!redis) return { ok: false, status: 503, code: 'redis_missing' };
  const at = airtable(env, fetchImpl);
  const guest = !recordId;
  let fields;
  if (recordId) {
    let rec;
    try { rec = await at.get(recordId); } catch { return { ok: false, status: 401, code: 'login_required' }; }
    fields = rec?.fields || {};
  } else {
    const r = await resolveCheckoutRecord({ at, email: normalizeEmail(email), planId, redis, now, decidePurchase: decidePaddleSubscriptionPurchase });
    if (!r.ok) return r;
    recordId = r.recordId;
    fields = r.fields;
  }
  const owned = await readOwnedSubId(redis, recordId);
  const d = decidePaddleSubscriptionPurchase({ planId, fields, ownedSubLive: Boolean(owned) && hasLivePaddleFields(fields, now), now });
  if (!d.ok) return { ok: false, status: d.code === 'invalid_plan' ? 400 : 409, code: d.code };

  // 特別価格（2026-11-11 MK・subscriptionCampaign.js）: 過去にカードの定期課金を持ったことがない会員だけ。
  // 履歴が読めなければ付けない（安全側）。戻り値の price は画面が「請求される額」を案内するのに使う。
  const campaign = decideCampaignForCheckout({
    planId: d.plan.id, plan: d.plan, fields,
    hadCardSubscription: await readHadCardSubscription(redis, recordId, owned),
  });
  const campaignId = campaign.applied ? campaign.campaignId : null;
  const price = campaign.applied
    ? { firstYen: campaign.firstYen, regularYen: campaign.regularYen, discountYen: campaign.discountYen, campaign: true }
    : { firstYen: d.plan.amountYen, regularYen: d.plan.amountYen, discountYen: 0, campaign: false };

  // 二重クリック・再読み込み: 30 分以内の同じ申込は同じ取引を返す（Paddle の取引は支払うまで課金されない）
  // 特別価格の有無が前回と違う取引は使い回さない（見せた額と請求額をずらさない）
  const openKey = openCheckoutKey(recordId, d.plan.id);
  try {
    const prev = JSON.parse(await redis(['GET', openKey]) || 'null');
    if (prev && isTransactionId(prev.transactionId) && checkoutUrlMatchesOrigin(prev.url, origin) && (prev.campaignId || null) === campaignId) {
      return { ok: true, url: withSubscriptionFlag(prev.url), subscriptionId: prev.transactionId, provider: PROVIDER, recordId, guest, price, reused: true };
    }
  } catch { /* 読めなければ作る */ }

  let r;
  if (mode.delegate) {
    const res = await postSignedIntent({
      url: PADDLE_CHECKOUT_CREATE_URL, secret: env.CARD_GRANT_INTERNAL_SECRET, fetchImpl,
      intent: { kind: 'subscription', recordId, planId: d.plan.id, origin, entry, ...(campaignId ? { campaignId } : {}) },
    });
    if (!res.ok) {
      const code = res.status === 503 && typeof res.data?.error === 'string' ? res.data.error : 'checkout_failed';
      return { ok: false, status: res.status === 503 ? 503 : 502, code };
    }
    if (!isTransactionId(res.data?.transactionId) || !checkoutUrlMatchesOrigin(res.data?.url, origin)) return { ok: false, status: 502, code: 'checkout_failed' };
    r = { ok: true, url: res.data.url, transactionId: res.data.transactionId };
  } else {
    r = await createPaddleSubscriptionTransaction({ env, origin, recordId, planId: d.plan.id, entry, campaignId, fetchImpl });
    if (!r.ok) return r;
  }
  // 戻り先で「本人の申込か」を確かめるための印（会員 ID・商品）。お客様へは返さない
  // firstYen は戻り先の GA4 purchase の金額（実際の初回請求額）に使う
  await redis(['SET', checkoutMarkKey(r.transactionId), JSON.stringify({ recordId, planId: d.plan.id, firstYen: price.firstYen, ...(campaignId ? { campaignId } : {}) }), 'EX', String(MARK_TTL_SECONDS)]);
  try { await redis(['SET', openKey, JSON.stringify({ url: r.url, transactionId: r.transactionId, campaignId }), 'EX', String(OPEN_CHECKOUT_TTL_SECONDS)]); } catch { /* 二重クリック対策は best-effort */ }
  return { ok: true, url: withSubscriptionFlag(r.url), subscriptionId: r.transactionId, provider: PROVIDER, recordId, guest, price };
}

// ───────────────────────────────── 通知（照会して購読の写しを作る＝鍵を持つ側）

/**
 * 署名検証済みの通知 1 件を、購読の「反映指示」にする（Paddle API で照会した事実だけ）。DB には書かない。
 * - subscription.* … 購読を照会
 * - transaction.*  … 取引を照会し、定期課金の取引なら購読を照会（支払い時点で購読 ID が無ければ後続の通知に任せる）
 * - adjustment.*   … 定期課金の取引への返金・チャージバックは自動で権限を戻さず管理者へ（PayPal 月額と同じ方針）
 * @returns {null | { result: string, retry?: boolean, apply?: object }}  null = 定期課金ではない（一回払いの処理へ）
 */
export async function decidePaddleSubscriptionEvent({ api, parsed, txn = null }) {
  let subscriptionId = null;
  let transactionId = null;
  let refund = false;
  if (SUBSCRIPTION_EVENTS.includes(parsed.eventType)) {
    subscriptionId = parsed.subscriptionId;
  } else {
    if (!txn || !isSubscriptionTransaction(txn)) return null;
    transactionId = txn.id;
    subscriptionId = txn.subscription_id;
    if (!isPaddleSubscriptionId(subscriptionId)) return { result: 'awaiting_subscription' };
    if (parsed.adjustmentId) {
      // 返金・チャージバックは承認済みのものだけ管理者へ（申請中〔pending_approval〕・却下で知らせない＝1 件の返金で 1 回）
      let adj;
      try { adj = await api.getAdjustment(parsed.adjustmentId); } catch (e) { return { result: 'adjustment_lookup_failed', retry: e.status !== 404 }; }
      const approved = adj && String(adj.transaction_id || '') === String(txn.id) && String(adj.status || '') === 'approved';
      const kind = String(adj?.action || '') === 'refund' || /chargeback/.test(String(adj?.type || adj?.action || ''));
      if (!approved || !kind) return { result: `ignored_adjustment_${adj?.status || 'unknown'}` };
      refund = true;
    }
  }
  if (!isPaddleSubscriptionId(subscriptionId)) return { result: 'ignored_event' };
  let raw;
  try { raw = await api.getSubscription(subscriptionId); } catch (e) {
    return { result: 'subscription_lookup_failed', retry: e.status !== 404 };
  }
  const subscription = snapshotPaddleSubscription(raw);
  // 取引の結果（戻り先の表示）は、その取引が支払い済みのときだけ書かせる
  const paidTxn = transactionId && ['paid', 'completed'].includes(String(txn?.status || '')) ? transactionId : null;
  return {
    result: refund ? 'subscription_refund' : 'subscription',
    apply: { kind: 'subscription', provider: PROVIDER, subscription, ...(paidTxn ? { transactionId: paidTxn } : {}), ...(refund ? { refund: true, eventType: parsed.eventType } : {}) },
  };
}

// ───────────────────────────────── 反映（Airtable / Redis を持つ本番）

/**
 * 購読の写し 1 件を Customers へ反映する（中立サイトの指示・Sandbox の Webhook 共通・冪等）。
 * @returns {{ ok: boolean, action: 'write'|'skip'|'conflict'|'busy', reason: string, recordId?: string, result: string, retry?: boolean }}
 */
export async function applyPaddleSubscription({ env, apply, redis, notify = async () => {}, fetchImpl, now = new Date() }) {
  const sub = apply?.subscription;
  if (!sub || !isPaddleSubscriptionId(sub.id)) return { ok: false, action: 'skip', reason: 'invalid_subscription', result: 'skip_invalid_subscription' };
  if (!redis) return { ok: false, action: 'busy', reason: 'redis_missing', result: 'redis_missing', retry: true };
  const out = await withSubscriptionLock(redis, sub.id, async () => {
    if (!sub.recordId) {
      await notify('subscription_conflict', { provider: PROVIDER, reason: 'no_record', paymentId: sub.id });
      return { ok: false, action: 'conflict', reason: 'no_record' };
    }
    if (apply.refund) {
      // 返金・チャージバック: 定期課金は返金しない方針（例外は管理者が手で）。権限は自動で戻さず管理者へ（PayPal・Stripe 月額と同じ）
      await notify('subscription_refunded', { provider: PROVIDER, paymentId: sub.id, recordId: sub.recordId, reason: apply.eventType || 'adjustment' });
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
    const otherSubscriptionLive = Boolean(ownedSubId && ownedSubId !== sub.id) && hasLivePaddleFields(fields, now);
    const withdrawalMarked = Boolean(await redis(['GET', withdrawalMarkKey(sub.id)]));
    const decision = decidePaddleSubscriptionSync({ fields, sub, ownedSubId, otherSubscriptionLive, withdrawalMarked, now });
    if (decision.action === 'skip') return { ok: true, action: 'skip', reason: decision.reason, recordId: sub.recordId };
    if (decision.action === 'conflict') {
      await notify('subscription_conflict', { provider: PROVIDER, reason: decision.reason, paymentId: sub.id, recordId: sub.recordId, productId: decision.plan?.id });
      return { ok: false, action: 'conflict', reason: decision.reason, recordId: sub.recordId };
    }
    await at.patch(sub.recordId, decision.fields);
    if (decision.newlyAttached) {
      await redis(['SET', memberKey(sub.recordId), sub.id]);
      try {
        const conv = buildPremiumConversionFields({ previousFields: fields, confirmationFields: decision.fields, confirmedAt: now });
        if (conv) await at.patch(sub.recordId, conv);
      } catch { /* 履歴は失敗しても権限付与を巻き戻さない */ }
      await notify('subscription_attached', { provider: PROVIDER, paymentId: sub.id, recordId: sub.recordId, productId: decision.plan?.id, expiration: decision.expiration });
      await markPostPurchase(redis, { recordId: sub.recordId, planId: decision.plan?.id, subscriptionId: sub.id, now });
    }
    return { ok: true, action: 'write', reason: decision.reason, recordId: sub.recordId };
  });
  // 戻り先の表示（取引ごと）。支払い済みの取引の通知で、反映できた／管理者対応になったことを残す
  if (apply.transactionId && out?.recordId) {
    const r = out.action === 'write' && ['attached', 'renewed'].includes(out.reason) ? 'active'
      : out.action === 'conflict' ? 'needs_support' : null;
    if (r) { try { await redis(['SET', txnResultKey(apply.transactionId), r, 'EX', String(MARK_TTL_SECONDS)]); } catch { /* 表示用・best-effort */ } }
  }
  return { ...out, result: `${out.action}_${out.reason}`, ...(out.action === 'busy' ? { retry: true } : {}) };
}

/**
 * 戻り先（paypal-subscription-confirm?provider=paddle&order=txn_…）: 本人の申込か確かめて状態を返す（表示用・書かない）。
 * 反映は通知（中立サイト → 本番）だけ。本番は Paddle を照会しない（鍵を持たない）。
 */
export async function confirmPaddleSubscription({ transactionId, recordId, redis }) {
  if (!isTransactionId(transactionId)) return { status: 400, body: { error: 'invalid_order' } };
  if (!redis) return { status: 503, body: { error: 'redis_missing' } };
  let mark = null;
  try { mark = JSON.parse(await redis(['GET', checkoutMarkKey(transactionId)]) || 'null'); } catch { mark = null; }
  if (!mark || !recordId || mark.recordId !== recordId) return { status: 404, body: { status: 'not_found' } };
  const status = returnStatusOf(await redis(['GET', txnResultKey(transactionId)]));
  const destination = status === 'active' ? destinationForPlan(mark.planId) : null;
  // 初回の請求額（特別価格なら値引き後）。GA4 の purchase の value に使う（申込時にサーバーが決めた値だけ）
  const firstYen = Number.isInteger(mark.firstYen) ? mark.firstYen : null;
  return { status: 200, body: { status, plan: mark.planId, ...(firstYen !== null ? { firstYen } : {}), ...(mark.campaignId ? { campaign: mark.campaignId } : {}), ...(destination ? { destination } : {}) } };
}

// ───────────────────────────────── 退会（即時）

/**
 * 鍵を持つ側: 本人の購読か確かめてから即時解約し、解約後の写しを返す（中立サイト・Sandbox）。
 * @returns {{ ok: true, sub, cancelled: boolean } | { ok: false, code }}
 */
export async function cancelPaddleSubscriptionForMember({ api, subscriptionId, recordId }) {
  if (!isPaddleSubscriptionId(subscriptionId)) return { ok: false, code: 'invalid_subscription' };
  let sub;
  try { sub = snapshotPaddleSubscription(await api.getSubscription(subscriptionId)); } catch { return { ok: false, code: 'lookup_failed' }; }
  if (sub.recordId !== recordId) return { ok: false, code: 'subscription_mismatch' };
  if (!CANCELLABLE_STATUSES.includes(sub.status)) return { ok: true, sub, cancelled: false };
  try { await api.cancelSubscriptionNow(subscriptionId); } catch { /* 下で照会し直して判定する */ }
  let after;
  try { after = snapshotPaddleSubscription(await api.getSubscription(subscriptionId)); } catch { return { ok: false, code: 'cancel_failed' }; }
  if (after.status !== 'canceled') return { ok: false, code: 'cancel_failed' };
  return { ok: true, sub: after, cancelled: true };
}

async function cancelViaSite({ env, origin, subscriptionId, recordId, fetchImpl }) {
  const mode = resolvePaddleSubscriptionSettleMode({ env, origin });
  if (!mode.ok) return { ok: false, code: 'not_configured' };
  if (mode.delegate) {
    const res = await postSignedIntent({ url: PADDLE_SUBSCRIPTION_CANCEL_URL, secret: env.CARD_GRANT_INTERNAL_SECRET, fetchImpl, intent: { kind: 'cancel', subscriptionId, recordId, origin } });
    if (!res.ok || !res.data?.ok) return { ok: false, code: res.data?.code === 'subscription_mismatch' ? 'subscription_mismatch' : 'cancel_failed' };
    return { ok: true, sub: res.data.sub, cancelled: res.data.cancelled === true };
  }
  return cancelPaddleSubscriptionForMember({ api: paddleApi({ apiBase: mode.apiBase, key: env.PADDLE_API_KEY, fetchImpl }), subscriptionId, recordId });
}

/**
 * 退会（マイページ・即時。2026-10-07 の月額退会の仕様を Paddle に適用）。
 * Paddle の解約に失敗したら会員の状態は変えない（cancel_failed）。解約後に書込みが失敗しても、canceled の通知が退会の印で同じ状態へ収束させる。
 */
export async function withdrawPaddleSubscriber({ env, origin, recordId, reason = null, redis, fetchImpl, now = new Date() }) {
  const mode = resolvePaddleSubscriptionSettleMode({ env, origin });
  if (!mode.ok) return { ok: false, result: 'not_configured' };
  if (!recordId) return { ok: false, result: 'record_not_found' };
  if (!redis) return { ok: false, result: 'busy' };
  const ownedSubId = await readOwnedSubId(redis, recordId);
  if (!ownedSubId) return { ok: false, result: 'not_paddle_subscriber' };
  const at = airtable(env, fetchImpl);
  const r = await withSubscriptionLock(redis, ownedSubId, async () => {
    let record;
    try { record = await at.get(recordId); } catch { return { ok: false, result: 'record_not_found' }; }
    const fields = record?.fields || {};
    const pre = decidePaddleWithdrawal({ fields, recordId, ownedSubId, sub: { id: ownedSubId, recordId, status: 'active' } });
    if (!pre.ok) return { ok: false, result: pre.reason };
    // 先に印を置く（解約後に書込みが失敗しても、canceled の通知を「退会」として収束させる）
    await redis(['SET', withdrawalMarkKey(ownedSubId), now.toISOString(), 'EX', String(WITHDRAWAL_MARK_TTL_SECONDS)]);
    const c = await cancelViaSite({ env, origin, subscriptionId: ownedSubId, recordId, fetchImpl });
    if (!c.ok) {
      try { await redis(['DEL', withdrawalMarkKey(ownedSubId)]); } catch { /* 印が残っても active の通知では権限を戻さないだけ */ }
      return { ok: false, result: c.code === 'subscription_mismatch' ? 'subscription_mismatch' : 'cancel_failed' };
    }
    const d = decidePaddleWithdrawal({ fields, recordId, ownedSubId, sub: c.sub });
    if (!d.ok) return { ok: false, result: d.reason };
    const out = withdrawalFields({ fields, now, reason });
    try { await at.patch(recordId, out); } catch { return { ok: false, result: 'record_write_failed', cancelled: c.cancelled }; }
    return { ok: true, result: 'withdrawn', email: String(fields.Email || ''), cancelled: c.cancelled };
  });
  if (r && r.action === 'busy') return { ok: false, result: 'busy' };
  return r;
}

export const WITHDRAWAL_STATUS = Object.freeze({
  withdrawn: 200, already_withdrawn: 409, subscription_mismatch: 409, not_paddle_subscriber: 404,
  record_not_found: 404, cancel_failed: 502, record_write_failed: 502, busy: 503,
});
