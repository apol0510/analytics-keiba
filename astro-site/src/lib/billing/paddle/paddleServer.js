/**
 * paddleServer.js — Paddle 連携の I/O（Paddle API・Airtable）。判定は paddleCore / cardOneTime、
 * 会員への反映は決済会社共通の entitlementLedger.js。
 *
 * ⚠️ API 鍵・カード情報・メールアドレス・レコード内容をログに出さない。
 */

import { randomUUID } from 'node:crypto';
import { airtable } from '../stripeServer.js';
import { checkoutProviderGate, resolveCardModeDelegated, PRODUCTION_ORIGIN } from '../cardSales.js';
import { decideCardPurchase, cardProductById } from '../cardOneTime.js';
import { PADDLE_CHECKOUT_CREATE_URL } from '../neutralCheckoutHost.js';
import { applyCardGrant, applyCardRefund, readCardOrderStatus } from '../entitlementLedger.js';
import {
  resolvePaddleMode, buildTransactionBody, matchTransaction, decideAdjustment, isTransactionId, checkoutUrlMatchesOrigin,
  signTsBody, GRANT_EVENTS, ADJUSTMENT_EVENTS, PROVIDER,
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
 * Paddle API で取引だけを作る（会員資格の確認・Airtable 読みはしない・PADDLE_API_KEY が要る）。
 * 分離サイト（鍵を持つ）が、委譲元で資格確認済みの intent を受けて使う。商品カタログの純粋検証だけ再実行する（防御）。
 * @returns {{ ok: true, url, transactionId } | { ok: false, status, code }}
 */
export async function createPaddleTransaction({ env, origin, recordId, productId, entry = 'direct', salesOpen, now = new Date(), fetchImpl }) {
  const mode = resolvePaddleMode({ key: env.PADDLE_API_KEY, origin, ...(salesOpen === undefined ? {} : { salesOpen }) });
  if (!mode.ok) return { ok: false, status: 503, code: mode.reason };
  const gate = checkoutProviderGate({ provider: PROVIDER, mode: mode.mode, entry });
  if (!gate.ok) return { ok: false, status: 409, code: gate.reason };
  if (!recordId) return { ok: false, status: 401, code: 'login_required' };
  // カタログ不変条件だけを再検査する（fail closed）。会員資格（memberOnly・既存契約・買い切り会員）は
  // fields が要るので委譲元（Airtable を持つ本番サイト）が確認済み。ここで fields:null で再判定すると
  // 会員限定価格（premium-annual-light）を誤って弾くため、商品の存在と「買い切りはカード不可」だけ見る。
  const product = cardProductById(productId);
  if (!product) return { ok: false, status: 400, code: 'invalid_product' };
  if (product.planType === 'Lifetime') return { ok: false, status: 409, code: 'lifetime_bank_transfer_only' };
  const api = paddleApi({ apiBase: mode.apiBase, key: env.PADDLE_API_KEY, fetchImpl });
  const txn = await api.createTransaction(buildTransactionBody({ productId, recordId, origin }));
  if (!isTransactionId(txn?.id) || !txn?.checkout?.url) return { ok: false, status: 502, code: 'checkout_failed' };
  // Default payment link が別サイトを指していたら使わない（未払いの取引は課金されない）
  if (!checkoutUrlMatchesOrigin(txn.checkout.url, origin)) return { ok: false, status: 502, code: 'checkout_url_mismatch' };
  return { ok: true, url: txn.checkout.url, transactionId: txn.id };
}

/**
 * 本番サイト → 分離サイトへ、短寿命・署名付き intent を渡して取引を作らせる（案 B・PADDLE_CHECKOUT_CREATE_URL）。
 * intent は会員資格の確認後に本番で作り、CARD_GRANT_INTERNAL_SECRET で署名する。クライアントには出さない（server-to-server）。
 * 署名は `signTsBody`（ts:rawBody）。分離サイトが短い tolerance で検証するため、リプレイは短窓のみ・かつ再送しても
 * 新たな「未払い」取引が増えるだけ（Paddle はカード入力時にしか課金しない・付与は transactionId で冪等）。
 * @returns {{ ok: true, url, transactionId } | { ok: false, status, code }}
 */
async function delegatePaddleCheckout({ env, origin, recordId, productId, entry, fetchImpl }) {
  const f = fetchImpl || fetch;
  const body = JSON.stringify({ v: 1, recordId, productId, origin, entry, nonce: randomUUID() });
  const sig = signTsBody({ rawBody: body, secret: env.CARD_GRANT_INTERNAL_SECRET });
  let res;
  try {
    res = await f(PADDLE_CHECKOUT_CREATE_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-signature': sig }, body });
  } catch { return { ok: false, status: 502, code: 'checkout_failed' }; }
  const text = await res.text().catch(() => '');
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    // 受付前・設定不足（分離サイトの 503: card_sales_not_open / *_key_missing 等）はそのまま伝える。
    // 署名・配線・transient（401/400/5xx）は内部理由を出さず 502 checkout_failed に丸める（別社へ作り直さない）。
    const code = res.status === 503 && typeof data?.error === 'string' ? data.error : 'checkout_failed';
    return { ok: false, status: res.status === 503 ? 503 : 502, code };
  }
  if (!isTransactionId(data?.transactionId) || !checkoutUrlMatchesOrigin(data?.url, origin)) {
    return { ok: false, status: 502, code: 'checkout_failed' };
  }
  return { ok: true, url: data.url, transactionId: data.transactionId };
}

/**
 * このサイト・この鍵が無い本番で、取引作成を分離サイトへ委譲する条件。
 * 本番サイト（PADDLE_API_KEY を 4KB 制約で置けない）だけが true。鍵を持つサイト（分離サイト・Sandbox preview）は false。
 */
export function shouldDelegatePaddle({ env = {}, origin } = {}) {
  return !env.PADDLE_API_KEY && Boolean(env.CARD_GRANT_INTERNAL_SECRET) && String(origin || '') === PRODUCTION_ORIGIN;
}

/**
 * 「このサイト・この鍵・この origin で Paddle を受け付けられるか」を委譲の有無に関わらず同じ基準で返す。
 * ⚠️ 入口の Function（早期 503 判定）も createPaddleCheckout も必ずこれを使う。直接 resolvePaddleMode を呼ぶと、
 *    委譲時（本番は鍵なし）に paddle_key_missing で止まり、createPaddleCheckout の委譲経路へ到達しない。
 * @returns {{ ok: true, mode } | { ok: false, reason }}
 */
export function resolvePaddleModeForEnv({ env = {}, origin, salesOpen } = {}) {
  return shouldDelegatePaddle({ env, origin })
    ? resolveCardModeDelegated({ provider: PROVIDER, origin, salesOpen })
    : resolvePaddleMode({ key: env.PADDLE_API_KEY, origin, ...(salesOpen === undefined ? {} : { salesOpen }) });
}

/**
 * 決済画面（取引）を作る（ログイン中の会員だけ）。会員資格は必ず本番サイト（Airtable を持つ）で確認する。
 * - ローカルに PADDLE_API_KEY がある（分離サイト・Sandbox の Deploy Preview）: そのまま取引を作る。
 * - 本番サイトで鍵が無い（4KB で本番には置かない）: 資格確認のあと、取引の作成だけ分離サイトへ委譲する。
 * @returns {{ ok: true, url, transactionId } | { ok: false, status, code }}
 */
export async function createPaddleCheckout({ env, origin, recordId, productId, entry = 'direct', salesOpen, now = new Date(), fetchImpl }) {
  const delegate = shouldDelegatePaddle({ env, origin });
  const mode = resolvePaddleModeForEnv({ env, origin, salesOpen });
  if (!mode.ok) return { ok: false, status: 503, code: mode.reason };
  const gate = checkoutProviderGate({ provider: PROVIDER, mode: mode.mode, entry });
  if (!gate.ok) return { ok: false, status: 409, code: gate.reason };
  if (!recordId) return { ok: false, status: 401, code: 'login_required' };
  const at = airtable(env, fetchImpl);
  let rec;
  try { rec = await at.get(recordId); } catch { return { ok: false, status: 401, code: 'login_required' }; }
  const d = decideCardPurchase({ productId, fields: rec?.fields || {}, now });
  if (!d.ok) return { ok: false, status: d.code === 'invalid_product' ? 400 : 409, code: d.code };
  if (delegate) return delegatePaddleCheckout({ env, origin, recordId, productId: d.product.id, entry, fetchImpl });
  return createPaddleTransaction({ env, origin, recordId, productId: d.product.id, entry, salesOpen, now, fetchImpl });
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
