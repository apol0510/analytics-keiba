/**
 * servicePaddle.mjs（分離サイト / checkout.tirol.link 専用）— AK 以外のサービス（KL・HIBI）の Paddle 決済を中立サイトで受ける本体
 *
 * 2026-11-24 MK 決定（KL・HIBI の Stripe が入金を受けられない → Paddle へ）。プロトコルの正本は apol0510/keiba-live PR #57:
 *  - 各サービスは会員資格（ログイン・確認済みメール・二重購読・販売中のプラン）を自分で確かめたあと、短寿命・署名付きの intent を
 *    server-to-server で `/.netlify/functions/<svc>-paddle` へ送る（`X-Internal-Signature: ts=…;h1=…` = HMAC-SHA256(<svc の secret>, `${ts}:${rawBody}`)・
 *    許容 120 秒）。intent = `{ v:1, svc, kind, nonce, issuedAt, … }`。🛑 svc は呼ばれた endpoint・署名に使った secret のサービスと一致しなければ拒否。
 *  - kind: checkout・checkout_status・checkout_cancel・portal・change_plan・cancel・resume（KL の DELEGATE_KINDS）。
 *  - 取引は非カタログ価格（billing_cycle・JPY・tax_mode internal・数量 1 固定）で作り、custom_data = { svc, member_id, plan_code }。
 *    金額・名前はこのサイトの表（services.mjs）からだけ組む（intent の金額・名前は受け取らない）。🛑 checkout.url は送らない
 *    （アカウントの Default payment link = https://checkout.tirol.link/pay/ に任せ、返ってきた URL がそれ以外なら使わない）。
 *    返す URL は `https://checkout.tirol.link/pay/?_ptxn=<txn>&svc=<svc>`（決済ページが svc ごとの戻り先を使う）。
 *  - 購読・顧客の操作は、購読の custom_data の svc と member_id が intent と一致するときだけ（他の会員・他のサービス・AK の購読は触らない）。
 *  - 通知（paddle-webhook.mjs）: 署名検証のあと custom_data.svc（無ければ購読・取引を照会）で振り分け、KL・HIBI の event は
 *    **本文を変えずに** そのサービスの grantUrl へ、そのサービスの secret で署名して転送する。AK の event は従来の処理のまま。
 *
 * 必要 env（このサイト）: PADDLE_API_KEY（Live）・KL_GRANT_INTERNAL_SECRET・HIBI_GRANT_INTERNAL_SECRET（各 32 文字以上）
 * 🛑 secret・API key・顧客情報（メール等）をログ・応答・例外に出さない（ログは event の種類・svc・status・理由コードだけ）。
 */
import { verifyPaddleSignature, signTsBody, keyMode, PADDLE_API } from '../../../../../astro-site/src/lib/billing/paddle/paddleCore.js';
import { PADDLE_LIVE_PAYMENT_LINK } from '../../../../../astro-site/src/lib/billing/neutralCheckoutHost.js';
import { idempotentCreateCheckout } from './checkoutIdempotency.mjs';
import { serviceById, planFor } from '../../../services.mjs';

export const INTENT_TTL_SEC = 120;
export const MIN_SECRET_LENGTH = 32;
export const MAX_INTENT_BYTES = 16 * 1024;
export const SERVICE_KINDS = Object.freeze(['checkout', 'checkout_status', 'checkout_cancel', 'portal', 'change_plan', 'cancel', 'resume']);

const TXN_RE = /^txn_[a-z0-9]{10,40}$/;
const SUB_RE = /^sub_[a-z0-9]{10,40}$/;
const CTM_RE = /^ctm_[a-z0-9]{10,40}$/;
const MEMBER_RE = /^[A-Za-z0-9_-]{1,100}$/;
const NONCE_RE = /^[A-Za-z0-9-]{16,80}$/;
const OPEN_TXN = Object.freeze(['draft', 'ready']);
const CHECKOUT_STATUS = Object.freeze({ draft: 'open', ready: 'open', completed: 'complete', billed: 'complete', paid: 'complete', canceled: 'expired' });

const H = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const resp = (status, obj) => new Response(JSON.stringify(obj), { status, headers: H });
const fail = (status, error) => resp(status, { ok: false, error });
const log = (o) => console.log(JSON.stringify(o));

const customData = (o) => (o?.custom_data && typeof o.custom_data === 'object' && !Array.isArray(o.custom_data) ? o.custom_data : null);

/** サービスの secret（短すぎる・未設定は null＝fail closed） */
export function serviceSecret(env, service) {
  const s = env?.[service.secretEnv];
  return typeof s === 'string' && s.length >= MIN_SECRET_LENGTH ? s : null;
}

/** Paddle API の小さなクライアント（鍵・本文はエラーに出さない。status だけ） */
export function paddleClient({ key, fetchImpl, timeoutMs = 10_000 }) {
  const mode = keyMode(key);
  if (!mode) return null;
  const base = PADDLE_API[mode];
  const f = fetchImpl || fetch;
  return {
    mode,
    async call(method, path, body) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await f(`${base}${path}`, {
          method,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: ctrl.signal,
        });
      } catch {
        throw Object.assign(new Error('paddle_unreachable'), { status: 0 });
      } finally { clearTimeout(timer); }
      const text = await res.text().catch(() => '');
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (!res.ok) throw Object.assign(new Error(`paddle_${res.status}`), { status: res.status });
      return json?.data ?? null;
    },
  };
}

/** 非カタログ価格（取引・購読の items[].price）。金額・名前・周期は表からだけ */
export function nonCatalogPrice(plan) {
  return {
    description: plan.name,
    name: plan.name,
    unit_price: { amount: plan.amount, currency_code: plan.currency },
    tax_mode: 'internal',
    billing_cycle: { interval: plan.interval, frequency: plan.frequency },
    quantity: { minimum: 1, maximum: 1 },
    product: { name: plan.name, tax_category: 'standard' },
  };
}

/** 取引の本文。🛑 checkout.url は入れない（Default payment link に任せる） */
export function buildServiceTransactionBody({ svc, plan, memberId }) {
  return {
    items: [{ quantity: 1, price: nonCatalogPrice(plan) }],
    currency_code: plan.currency,
    collection_mode: 'automatic',
    custom_data: { svc, member_id: memberId, plan_code: plan.planCode },
  };
}

/** Paddle が返した checkout.url が中立サイトの /pay/（Default payment link）でこの取引を指すか */
export function isDefaultPaymentLink(url, transactionId) {
  try {
    const u = new URL(String(url || ''));
    return `${u.origin}${u.pathname}` === PADDLE_LIVE_PAYMENT_LINK && u.searchParams.get('_ptxn') === transactionId;
  } catch { return false; }
}

export const servicePayUrl = (transactionId, svc) => `${PADDLE_LIVE_PAYMENT_LINK}?_ptxn=${encodeURIComponent(transactionId)}&svc=${encodeURIComponent(svc)}`;

const idemRecord = (svc, memberId) => `${svc}:${memberId}`;
const idemKeyFor = (svc, memberId, planCode) => `idem:${idemRecord(svc, memberId)}:${planCode}`;

/**
 * intent を受けて kind ごとに処理する（`<svc>-paddle` function の本体・テスト可能）。
 * 応答: 200 { ok: true, … } / 4xx・5xx { ok: false, error }（error は英小文字の理由コードだけ）
 */
export async function handleServiceIntent({ request, env, svc, store, fetchImpl, now = new Date() }) {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed');
  const service = serviceById(svc);
  if (!service) return fail(404, 'unknown_service');
  const raw = await request.text();
  if (raw.length > MAX_INTENT_BYTES) return fail(413, 'too_large');
  const secret = serviceSecret(env, service);
  if (!secret) return fail(503, 'service_secret_missing');
  const sig = request.headers.get('x-internal-signature') || '';
  if (!verifyPaddleSignature({ header: sig, rawBody: raw, secret, nowSec: Math.floor(now.getTime() / 1000), toleranceSec: INTENT_TTL_SEC })) {
    return fail(401, 'invalid_signature');
  }
  let intent = null;
  try { intent = JSON.parse(raw); } catch { return fail(400, 'invalid_json'); }
  if (!intent || typeof intent !== 'object' || intent.v !== 1) return fail(400, 'invalid_intent');
  // 🛑 署名に使った secret（= endpoint のサービス）と本文の svc が一致するときだけ
  if (intent.svc !== service.svc) return fail(400, 'service_mismatch');
  if (!SERVICE_KINDS.includes(intent.kind)) return fail(400, 'unknown_kind');
  const api = paddleClient({ key: env.PADDLE_API_KEY, fetchImpl });
  // このサイトは本番（Live）専用。Sandbox の鍵・鍵なしは受けない（fail closed）
  if (!api || api.mode !== 'live') return fail(503, 'paddle_not_configured');

  const ctx = { service, svc: service.svc, intent, api, store, now };
  try {
    const r = await KIND_HANDLERS[intent.kind](ctx);
    log({ event: 'svc_paddle_intent', svc: service.svc, kind: intent.kind, status: r.status, ...(r.reason ? { reason: r.reason } : {}) });
    return resp(r.status, r.body);
  } catch (e) {
    log({ event: 'svc_paddle_intent_error', svc: service.svc, kind: intent.kind, paddle_status: Number(e?.status) || 0 });
    return fail(502, 'paddle_error');
  }
}

const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } });
const no = (status, error) => ({ status, body: { ok: false, error }, reason: error });

/** 購読を照会し、custom_data の svc・member_id が intent と一致するときだけ返す */
async function ownedSubscription({ api, svc, intent }) {
  const subscriptionId = String(intent.subscriptionId || '');
  const memberId = String(intent.memberId || '');
  if (!SUB_RE.test(subscriptionId)) return { err: no(400, 'invalid_subscription') };
  if (!MEMBER_RE.test(memberId)) return { err: no(400, 'invalid_member') };
  const sub = await api.call('GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  const cd = customData(sub);
  if (!sub || sub.id !== subscriptionId || !cd || cd.svc !== svc || cd.member_id !== memberId) return { err: no(403, 'subscription_mismatch') };
  return { sub, cd, subscriptionId, memberId };
}

/** 取引を照会し、custom_data の svc がこのサービスのときだけ返す */
async function ownedTransaction({ api, svc, intent }) {
  const transactionId = String(intent.transactionId || '');
  if (!TXN_RE.test(transactionId)) return { err: no(400, 'invalid_transaction') };
  const txn = await api.call('GET', `/transactions/${encodeURIComponent(transactionId)}`);
  const cd = customData(txn);
  if (!txn || txn.id !== transactionId || !cd || cd.svc !== svc) return { err: no(403, 'transaction_mismatch') };
  return { txn, cd, transactionId };
}

const KIND_HANDLERS = Object.freeze({
  async checkout({ svc, intent, api, store, now }) {
    const memberId = String(intent.memberId || '');
    if (!MEMBER_RE.test(memberId)) return no(400, 'invalid_member');
    const plan = planFor(svc, intent.planCode);
    if (!plan) return no(400, 'unknown_plan');
    const nonce = String(intent.nonce || '');
    if (!NONCE_RE.test(nonce)) return no(400, 'invalid_nonce');
    const body = buildServiceTransactionBody({ svc, plan, memberId });
    const create = async () => {
      const txn = await api.call('POST', '/transactions', body);
      if (!TXN_RE.test(String(txn?.id || ''))) return { ok: false, status: 502, code: 'checkout_failed' };
      // 🛑 Default payment link（中立サイトの /pay/）以外の URL は使わない
      if (!isDefaultPaymentLink(txn?.checkout?.url, txn.id)) return { ok: false, status: 502, code: 'checkout_url_mismatch' };
      return { ok: true, transactionId: txn.id, url: servicePayUrl(txn.id, svc) };
    };
    // 冪等化（AK と同じ checkoutIdempotency・キーはサービスで名前空間を分ける: nonce:<svc>:…・idem:<svc>:<member>:<plan>）
    const run = (n) => idempotentCreateCheckout({ store, nonce: n, recordId: idemRecord(svc, memberId), productId: plan.planCode, now, create });
    let r = await run(`${svc}:${nonce}`);
    if (r.ok && r.reused) {
      // 使い回す取引がもう開けない（支払い済み・取消し済み）なら、予約を外して作り直す
      let still = false;
      try { still = OPEN_TXN.includes(String((await api.call('GET', `/transactions/${encodeURIComponent(r.transactionId)}`))?.status || '')); } catch { still = true; }
      if (!still) {
        if (typeof store?.release === 'function') await store.release(idemKeyFor(svc, memberId, plan.planCode));
        r = await run('');
      }
    }
    if (!r.ok) return no(r.status || 502, r.code || 'checkout_failed');
    return { status: 200, body: { ok: true, transactionId: r.transactionId, url: r.url }, ...(r.degraded ? { reason: 'degraded' } : {}) };
  },

  async checkout_status(ctx) {
    const o = await ownedTransaction(ctx);
    if (o.err) return o.err;
    return ok({ status: CHECKOUT_STATUS[String(o.txn.status || '')] || 'unknown', memberId: typeof o.cd.member_id === 'string' ? o.cd.member_id : null });
  },

  async checkout_cancel(ctx) {
    const o = await ownedTransaction(ctx);
    if (o.err) return o.err;
    let canceled = false;
    if (OPEN_TXN.includes(String(o.txn.status || ''))) {
      await ctx.api.call('PATCH', `/transactions/${encodeURIComponent(o.transactionId)}`, { status: 'canceled' });
      canceled = true;
    }
    // 取り消した取引を 30 分の冪等化で使い回さない（同じプランへ戻ったときに新しい取引を作る）
    if (MEMBER_RE.test(String(o.cd.member_id || '')) && typeof o.cd.plan_code === 'string' && typeof ctx.store?.release === 'function') {
      await ctx.store.release(idemKeyFor(ctx.svc, o.cd.member_id, o.cd.plan_code));
    }
    return ok({ canceled });
  },

  async portal({ svc, intent, api }) {
    const memberId = String(intent.memberId || '');
    const customerId = String(intent.customerId || '');
    if (!MEMBER_RE.test(memberId)) return no(400, 'invalid_member');
    if (!CTM_RE.test(customerId)) return no(400, 'invalid_customer');
    // 顧客の所有確認: その顧客の購読のうち、custom_data の svc・member_id が一致するものがあるときだけ
    const subs = await api.call('GET', `/subscriptions?customer_id=${encodeURIComponent(customerId)}&per_page=50`);
    const owned = (Array.isArray(subs) ? subs : []).filter((s) => s && s.customer_id === customerId && SUB_RE.test(String(s.id || ''))
      && customData(s)?.svc === svc && customData(s)?.member_id === memberId);
    if (!owned.length) return no(403, 'customer_mismatch');
    const p = await api.call('POST', `/customers/${encodeURIComponent(customerId)}/portal-sessions`, { subscription_ids: owned.slice(0, 25).map((s) => s.id) });
    const url = p?.urls?.general?.overview;
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return no(502, 'bad_portal_session');
    return ok({ url });
  },

  async change_plan(ctx) {
    const plan = planFor(ctx.svc, ctx.intent.planCode);
    if (!plan) return no(400, 'unknown_plan');
    const o = await ownedSubscription(ctx);
    if (o.err) return o.err;
    if (o.sub.status === 'canceled') return no(409, 'subscription_canceled');
    const path = `/subscriptions/${encodeURIComponent(o.subscriptionId)}`;
    const item = Array.isArray(o.sub.items) ? o.sub.items[0] : null;
    const samePlan = o.cd.plan_code === plan.planCode && String(item?.price?.unit_price?.amount ?? '') === plan.amount
      && item?.price?.billing_cycle?.interval === plan.interval;
    if (samePlan && !o.sub.scheduled_change) return ok({ changed: false });
    // プランを変えるなら予約中の解約は取り消す（KL の direct と同じ・予約があると items を変えられない）
    if (o.sub.scheduled_change) await ctx.api.call('PATCH', path, { scheduled_change: null });
    if (samePlan) return ok({ changed: false });
    await ctx.api.call('PATCH', path, {
      items: [{ quantity: 1, price: nonCatalogPrice(plan) }],
      proration_billing_mode: 'prorated_immediately',
      // 各サービスの webhook は custom_data.plan_code と金額・周期の一致で権利を決める → 同時に更新する
      custom_data: { svc: ctx.svc, member_id: o.memberId, plan_code: plan.planCode },
    });
    return ok({ changed: true });
  },

  async cancel(ctx) {
    const o = await ownedSubscription(ctx);
    if (o.err) return o.err;
    if (o.sub.status === 'canceled') return ok({ canceled: false });
    const atPeriodEnd = ctx.intent.atPeriodEnd !== false;
    await ctx.api.call('POST', `/subscriptions/${encodeURIComponent(o.subscriptionId)}/cancel`, { effective_from: atPeriodEnd ? 'next_billing_period' : 'immediately' });
    return ok({ canceled: true });
  },

  async resume(ctx) {
    const o = await ownedSubscription(ctx);
    if (o.err) return o.err;
    if (o.sub.status === 'canceled') return no(409, 'subscription_canceled');
    if (o.sub.scheduled_change?.action !== 'cancel') return ok({ resumed: false });
    await ctx.api.call('PATCH', `/subscriptions/${encodeURIComponent(o.subscriptionId)}`, { scheduled_change: null });
    return ok({ resumed: true });
  },
});

// ------------------------------------------------------------------------------------------------ 通知の振り分け

/** custom_data からサービスを読む: 'ak'（ak_* を持つ）/ svc の値 / null（印なし） */
export function serviceMark(cd) {
  if (!cd) return null;
  if (typeof cd.svc === 'string' && cd.svc) return cd.svc;
  if (Object.keys(cd).some((k) => /^ak_/.test(k))) return 'ak';
  return null;
}

/**
 * Paddle の event がどのサービスのものか。
 * @returns {Promise<{ route: 'ak' } | { route: 'service', service } | { route: 'unknown', svc } | { route: 'retry' }>}
 *  - 本文の custom_data に印があればそれ。無ければ購読（subscription.* の data.id・transaction.* の subscription_id）や
 *    取引（adjustment.* の transaction_id）を照会して印を読む。照会できない（鍵なし）・照会しても印が無い → 'ak'（従来の処理）。
 *  - 照会の失敗は 'retry'（他サービスの event を AK の処理へ誤って入れない・Paddle に再送させる）。
 */
export async function resolveEventService({ payload, api }) {
  const d = payload?.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { route: 'ak' };
  const type = String(payload.event_type || '');
  const decide = (mark) => {
    if (mark === null || mark === 'ak') return { route: 'ak' };
    const service = serviceById(mark);
    return service ? { route: 'service', service } : { route: 'unknown', svc: mark };
  };
  const direct = serviceMark(customData(d));
  if (direct) return decide(direct);
  let subId = null;
  let txnId = null;
  if (type.startsWith('subscription.')) subId = SUB_RE.test(String(d.id || '')) ? d.id : null;
  else if (type.startsWith('transaction.')) subId = SUB_RE.test(String(d.subscription_id || '')) ? d.subscription_id : null;
  else if (type.startsWith('adjustment.')) txnId = TXN_RE.test(String(d.transaction_id || '')) ? d.transaction_id : null;
  if (!subId && !txnId) return { route: 'ak' };
  if (!api) return { route: 'ak' };
  try {
    if (txnId) {
      const txn = await api.call('GET', `/transactions/${encodeURIComponent(txnId)}`);
      const m = serviceMark(customData(txn));
      if (m) return decide(m);
      subId = SUB_RE.test(String(txn?.subscription_id || '')) ? txn.subscription_id : null;
      if (!subId) return { route: 'ak' };
    }
    const sub = await api.call('GET', `/subscriptions/${encodeURIComponent(subId)}`);
    return decide(serviceMark(customData(sub)));
  } catch {
    return { route: 'retry' };
  }
}

/**
 * 検証済みの Paddle の通知本文を、そのサービスの grantUrl へ **変えずに** 転送する（そのサービスの secret で ts:rawBody に署名）。
 * Paddle への応答: サービスが 2xx・4xx → 200（4xx はログ・再送しても直らない）／5xx・到達不能・secret なし → 500（Paddle が再送）。
 */
export async function forwardToService({ service, raw, env, fetchImpl, eventType = '', timeoutMs = 8_000, nowSec }) {
  const secret = serviceSecret(env, service);
  if (!secret) {
    log({ event: 'svc_paddle_webhook_secret_missing', svc: service.svc, type: eventType });
    return resp(500, { error: 'service_secret_missing' });
  }
  const sig = signTsBody({ rawBody: raw, secret, ...(nowSec ? { nowSec } : {}) });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await (fetchImpl || fetch)(service.grantUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-signature': sig }, body: raw, signal: ctrl.signal });
  } catch {
    log({ event: 'svc_paddle_webhook_unreachable', svc: service.svc, type: eventType });
    return resp(500, { error: 'service_unreachable' });
  } finally { clearTimeout(timer); }
  if (res.status >= 500) {
    log({ event: 'svc_paddle_webhook_retry', svc: service.svc, type: eventType, status: res.status });
    return resp(500, { error: 'service_retry' });
  }
  if (!res.ok) {
    log({ event: 'svc_paddle_webhook_4xx', svc: service.svc, type: eventType, status: res.status });
    return resp(200, { received: true, service_status: res.status });
  }
  log({ event: 'svc_paddle_webhook', svc: service.svc, type: eventType, status: res.status });
  return resp(200, { received: true });
}

/**
 * paddle-webhook.mjs から呼ぶ: KL・HIBI の event なら転送して Response を返す。AK の event（従来の処理）なら null。
 * 本文が JSON でなければ null（AK の処理が従来どおり扱う）。
 */
export async function routeServiceEvent({ raw, env, fetchImpl }) {
  let payload = null;
  try { payload = JSON.parse(raw); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  const api = paddleClient({ key: env.PADDLE_API_KEY, fetchImpl });
  const r = await resolveEventService({ payload, api });
  const eventType = String(payload.event_type || '').slice(0, 60);
  if (r.route === 'ak') return null;
  if (r.route === 'retry') {
    log({ event: 'svc_paddle_webhook_lookup_failed', type: eventType });
    return resp(500, { error: 'lookup_failed' });
  }
  if (r.route === 'unknown') {
    // 知らないサービスの印: AK にも他サービスにも入れない（再送しても直らないので 200）
    log({ event: 'svc_paddle_webhook_unknown_service', type: eventType });
    return resp(200, { received: true, ignored: 'unknown_service' });
  }
  return forwardToService({ service: r.service, raw, env, fetchImpl, eventType });
}
