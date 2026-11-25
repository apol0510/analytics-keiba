/**
 * subscriptionMetrics.mjs — 月額継続課金の 4 指標（新規月額契約数・継続率・解約率・MRR）を月次で数える（read-only）
 *
 * 定義の正本: docs/decisions.md 2026-11-24（事業の主軸は月額継続課金・Claude の判断としての 4 指標の定義）。
 *   - 対象: カードの定期課金（Paddle・PayPal・既存の Stripe 月額）。月額・年額の購読とも。銀行振込・買い切りは含めない。
 *   - 新規月額契約数: その月に初回の支払いが完了した購読の数。過去に別の購読があった会員（同じ会員 ID）の再開は内訳で分ける。
 *   - 継続率 / 解約率: その月に更新日が来た購読のうち、更新の支払いが完了した / 終わった割合。月初の有効購読数を分母にした解約率も併記。
 *   - MRR: 月末（速報は集計時点）で有効な購読の更新時の料金の合計（年額は 1/12・初回だけの値引きは含めず更新額で数える）。
 *
 * 読むもの（GET のみ・revenueMonthly と同じ読み取り専用の鍵）:
 *   - Paddle: GET /transactions（completed / paid）。AK の購読は custom_data.ak_sub を持ち、KL・HIBI（custom_data.svc）は除く。
 *     支払い済み期間 = 取引の billing_period、更新額 = 取引の明細の unit_price × 数量（値引き前の通常料金）。
 *   - PayPal: Transaction Search（GET）で購読 ID（購読の入金 T0002 の paypal_reference_id・種類 RP / SUB）を集め、GET /v1/billing/subscriptions/{id}。
 *     支払い済み期間 = start_time から暦の周期 × 完了した周期数、更新額・周期 = Plan ID に対応する AK の商品。
 *   - Stripe: GET /v1/subscriptions（status=all）と支払い済みの請求書（GET /v1/invoices?status=paid）の明細の期間。
 *   鍵が無い・取得に失敗した決済会社は 0 件として数えず、subscriptions.data_quality に「未計上」と書く。
 *
 * 🔴 決済会社へ書き込まない。出力は件数・割合・金額の集計値だけ（会員 ID・購読 ID・メール・取引 ID を出さない）。
 *    会員 ID は再開の判定に関数内で使うだけ。例外文に鍵・識別子を含めない。
 */
import { RevenueError, paddleList, stripeListAll } from './revenueMonthly.mjs';
import { planFromPaypalPlanId } from '../src/lib/billing/paypal/paypalSubscriptionCore.js';

const DAY_MS = 24 * 3600 * 1000;
/** 更新日と次の期間の始まりのずれの許容（決済会社の処理時刻の差） */
export const RENEWAL_MATCH_MS = 2 * DAY_MS;
/** 更新日からこの間は支払いの再試行中として「確認中」に置く（解約に数えない） */
export const RENEWAL_GRACE_MS = 7 * DAY_MS;
/** PayPal の購読販売の開始（2026-10-15）より前の月初から探す */
export const PAYPAL_SEARCH_FROM = Date.parse('2026-10-01T00:00:00+09:00');
const PAYPAL_WINDOW_MS = 31 * DAY_MS;
const PAYPAL_API = 'https://api-m.paypal.com';
const PADDLE_API = 'https://api.paddle.com';
const MAX_PAGES = 200;
const PROVIDERS = ['paddle', 'paypal', 'stripe'];
const LABEL = { paddle: 'Paddle', paypal: 'PayPal', stripe: 'Stripe' };

const ms = (v) => {
  const t = typeof v === 'number' ? v : Date.parse(String(v || ''));
  return Number.isFinite(t) ? t : null;
};
const unixMs = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) * 1000 : null);
const blank = (v) => v === undefined || v === null || String(v).trim() === '';

/** 周期（month / year × 回数）と更新額 → 月あたりの金額 */
export function monthlyAmount(amount, interval, frequency = 1) {
  const a = Number(amount);
  const f = Number(frequency) || 1;
  const months = String(interval).toLowerCase() === 'year' ? 12 * f : String(interval).toLowerCase() === 'month' ? f : null;
  if (!Number.isFinite(a) || a <= 0 || !months) return null;
  return a / months;
}

/** 暦の月を足す（UTC の日付で・月末は月末に丸める） */
export function addMonthsMs(t, months) {
  const d = new Date(t);
  const day = d.getUTCDate();
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r.getTime();
}

// ---------------------------------------------------------------- 正規化（provider → 共通の購読）
// 共通の購読: { provider, ref, member, firstPaidMs, periods: [{ startMs, endMs }], monthlyJpy }

/** Paddle の取引一覧 → AK の購読 */
export function normalizePaddle(transactions) {
  const byRef = new Map();
  for (const t of transactions || []) {
    if (!['completed', 'paid'].includes(String(t?.status || ''))) continue;
    const cd = t.custom_data && typeof t.custom_data === 'object' ? t.custom_data : {};
    if (!blank(cd.svc) || blank(cd.ak_sub) || blank(t.subscription_id)) continue; // KL・HIBI・一回払いは除く
    if (String(t.currency_code || '').toUpperCase() !== 'JPY') throw new RevenueError('paddle: non-JPY transaction found');
    const startMs = ms(t.billing_period?.starts_at);
    const endMs = ms(t.billing_period?.ends_at);
    const billedMs = ms(t.billed_at);
    if (startMs === null || endMs === null || billedMs === null) continue;
    const ref = String(t.subscription_id);
    const s = byRef.get(ref) || { provider: 'paddle', ref, member: null, firstPaidMs: billedMs, periods: [], monthlyJpy: null, lastBilledMs: -Infinity };
    s.firstPaidMs = Math.min(s.firstPaidMs, billedMs);
    s.periods.push({ startMs, endMs });
    if (!blank(cd.ak_record)) s.member = String(cd.ak_record);
    if (billedMs >= s.lastBilledMs) {
      const items = Array.isArray(t.items) ? t.items : [];
      let total = 0;
      let cycle = null;
      for (const it of items) {
        const p = it?.price || {};
        total += Number(p.unit_price?.amount) * (Number(it?.quantity) || 1);
        cycle = cycle || p.billing_cycle || null;
      }
      const m = cycle ? monthlyAmount(total, cycle.interval, cycle.frequency) : null;
      if (m !== null) { s.monthlyJpy = m; s.lastBilledMs = billedMs; }
    }
    byRef.set(ref, s);
  }
  return [...byRef.values()].map(({ lastBilledMs, ...s }) => s);
}

/** PayPal の購読の詳細 → AK の購読（Plan が AK の商品でないものは除く） */
export function normalizePaypal(details, { mode = 'live' } = {}) {
  const out = [];
  for (const o of details || []) {
    const plan = planFromPaypalPlanId(o?.plan_id, mode);
    if (!plan) continue;
    const startMs = ms(o.start_time);
    const regular = (o.billing_info?.cycle_executions || []).find((c) => c?.tenure_type === 'REGULAR');
    const paid = Number(regular?.cycles_completed ?? 0);
    if (startMs === null || !Number.isInteger(paid) || paid <= 0) continue; // 1 回も支払われていない購読は数えない
    const step = plan.interval === 'YEAR' ? 12 : 1;
    const periods = [];
    for (let k = 0; k < paid; k += 1) periods.push({ startMs: addMonthsMs(startMs, k * step), endMs: addMonthsMs(startMs, (k + 1) * step) });
    const [recordId] = String(o.custom_id || '').split(':');
    out.push({
      provider: 'paypal', ref: String(o.id || ''), member: /^rec[A-Za-z0-9]{14}$/.test(recordId) ? recordId : null,
      firstPaidMs: startMs, periods, monthlyJpy: monthlyAmount(plan.amountYen, plan.interval, 1),
    });
  }
  return out;
}

/** 請求書の明細 → 購読 ID（新旧の API 形） */
const invoiceSubscription = (inv) => {
  const v = inv?.subscription ?? inv?.parent?.subscription_details?.subscription ?? inv?.lines?.data?.[0]?.subscription ?? null;
  return v && typeof v === 'object' ? v.id : v;
};

/** Stripe の購読・支払い済みの請求書 → AK の購読 */
export function normalizeStripe(subscriptions, paidInvoices) {
  const periodsByRef = new Map();
  const firstByRef = new Map();
  for (const inv of paidInvoices || []) {
    const ref = invoiceSubscription(inv);
    if (!ref || Number(inv?.amount_paid ?? 0) <= 0) continue;
    if (String(inv.currency || '').toLowerCase() !== 'jpy') throw new RevenueError('stripe: non-JPY invoice found');
    const line = (inv.lines?.data || []).find((l) => l?.period?.start && l?.period?.end);
    if (!line) continue;
    const list = periodsByRef.get(ref) || [];
    list.push({ startMs: unixMs(line.period.start), endMs: unixMs(line.period.end) });
    periodsByRef.set(ref, list);
    const paidMs = unixMs(inv.status_transitions?.paid_at) ?? unixMs(inv.created);
    if (paidMs !== null) firstByRef.set(ref, Math.min(firstByRef.get(ref) ?? Infinity, paidMs));
  }
  const out = [];
  for (const s of subscriptions || []) {
    const ref = String(s?.id || '');
    const periods = periodsByRef.get(ref);
    if (!periods || periods.length === 0) continue;
    const item = s.items?.data?.[0] || {};
    const price = item.price || item.plan || {};
    const recurring = price.recurring || { interval: price.interval, interval_count: price.interval_count };
    const amount = Number(price.unit_amount ?? price.amount) * (Number(item.quantity) || 1);
    const recordId = String(s.metadata?.ak_record_id || '');
    out.push({
      provider: 'stripe', ref, member: /^rec[A-Za-z0-9]{14}$/.test(recordId) ? recordId : null,
      firstPaidMs: firstByRef.get(ref) ?? periods[0].startMs, periods, monthlyJpy: monthlyAmount(amount, recurring.interval, recurring.interval_count),
    });
  }
  return out;
}

// ---------------------------------------------------------------- 集計

const covers = (s, t) => s.periods.some((p) => p.startMs <= t && t < p.endMs);
const rate = (n, d) => (d > 0 ? Math.round((n / d) * 10000) / 10000 : null);

/**
 * 共通の購読 → 4 指標。period = { startMs, untilMs, partial }（revenueMonthly.measurementPeriod）。
 * providers: 計上した決済会社 → true / 未計上 → 理由。
 */
export function computeSubscriptionMetrics({ subs, period, nowMs = Date.now(), providers = {} }) {
  const { startMs, untilMs } = period;
  const quality = [];
  const inMonth = (t) => t !== null && t >= startMs && t < untilMs;
  const firstByMember = new Map();
  for (const s of subs) {
    if (!s.member) continue;
    firstByMember.set(s.member, Math.min(firstByMember.get(s.member) ?? Infinity, s.firstPaidMs));
  }
  let newCount = 0;
  let reactivations = 0;
  let due = 0;
  let renewed = 0;
  let churned = 0;
  let pending = 0;
  let activeStart = 0;
  let activeEnd = 0;
  let mrr = 0;
  let unpriced = 0;
  const byProvider = Object.fromEntries(PROVIDERS.map((p) => [p, providers[p] === true
    ? { measured: true, new_subscriptions: 0, renewals_due: 0, renewed: 0, churned: 0, active_at_end: 0, mrr_jpy: 0 }
    : { measured: false }]));
  for (const s of subs) {
    const bp = byProvider[s.provider];
    if (!bp?.measured) continue;
    if (inMonth(s.firstPaidMs)) {
      newCount += 1;
      bp.new_subscriptions += 1;
      if (s.member && firstByMember.get(s.member) < s.firstPaidMs) reactivations += 1;
    }
    for (const p of s.periods) {
      if (!inMonth(p.endMs)) continue;
      due += 1;
      bp.renewals_due += 1;
      if (s.periods.some((q) => q !== p && Math.abs(q.startMs - p.endMs) <= RENEWAL_MATCH_MS)) { renewed += 1; bp.renewed += 1; }
      else if (nowMs - p.endMs < RENEWAL_GRACE_MS) pending += 1;
      else { churned += 1; bp.churned += 1; }
    }
    if (covers(s, startMs)) activeStart += 1;
    if (covers(s, untilMs - 1)) {
      activeEnd += 1;
      bp.active_at_end += 1;
      if (s.monthlyJpy === null) unpriced += 1;
      else { mrr += s.monthlyJpy; bp.mrr_jpy += s.monthlyJpy; }
    }
  }
  for (const p of PROVIDERS) {
    if (providers[p] === true) byProvider[p].mrr_jpy = Math.round(byProvider[p].mrr_jpy);
    else quality.push(`${LABEL[p]}: 未計上（${providers[p] || '読取り鍵が未設定'}）`);
  }
  if (period.partial) quality.unshift('月途中の速報値 — 継続・解約・MRR は集計時点まで');
  if (pending > 0) quality.push(`更新日から ${RENEWAL_GRACE_MS / DAY_MS} 日以内で支払いを確認中の購読 ${pending} 件は継続・解約のどちらにも数えていない`);
  if (unpriced > 0) quality.push(`有効な購読 ${unpriced} 件は更新額が読めず MRR に含めていない`);
  quality.push('再開は同じ会員 ID の過去の購読（決済会社をまたいで）で判定 — 会員 ID の無い購読は新規に数える');
  const resolved = renewed + churned;
  return {
    definition: 'docs/decisions.md 2026-11-24',
    new_subscriptions: newCount,
    new_reactivations: reactivations,
    renewals_due: due,
    renewed,
    churned,
    renewal_pending: pending,
    retention_rate: rate(renewed, resolved),
    churn_rate: rate(churned, resolved),
    active_at_start: activeStart,
    churn_rate_of_start_active: rate(churned, activeStart),
    active_at_end: activeEnd,
    mrr_jpy: Math.round(mrr),
    by_provider: byProvider,
    data_quality: quality,
  };
}

// ---------------------------------------------------------------- 取得（GET のみ）

export async function fetchPaddleSubscriptions({ key, nowMs, fetchImpl = fetch, apiBase = PADDLE_API }) {
  const q = new URLSearchParams({ status: 'completed,paid', 'billed_at[LT]': new Date(nowMs).toISOString(), per_page: '200' });
  const transactions = await paddleList({ key, url: `${apiBase}/transactions?${q}`, fetchImpl, label: 'transactions' });
  return normalizePaddle(transactions);
}

export async function fetchPaypalSubscriptions({ clientId, clientSecret, nowMs, fetchImpl = fetch, apiBase = PAYPAL_API }) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tok = await fetchImpl(`${apiBase}/v1/oauth2/token`, {
    method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials',
  });
  if (!tok.ok) throw new RevenueError(`paypal token: HTTP ${tok.status}`);
  const access = (await tok.json())?.access_token;
  if (!access) throw new RevenueError('paypal token: unexpected response');
  const auth = { Authorization: `Bearer ${access}` };
  const ids = new Set();
  const seen = { payments: 0, refTypes: new Map() };
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (let from = PAYPAL_SEARCH_FROM; from < nowMs; from += PAYPAL_WINDOW_MS) {
    const to = Math.min(from + PAYPAL_WINDOW_MS, nowMs) - 1000;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const q = new URLSearchParams({ start_date: iso(from), end_date: iso(to), fields: 'transaction_info', page_size: '500', page: String(page) });
      const res = await fetchImpl(`${apiBase}/v1/reporting/transactions?${q}`, { method: 'GET', headers: auth });
      if (!res.ok) throw new RevenueError(`paypal transactions: HTTP ${res.status}`);
      const body = await res.json();
      if (body && body.transaction_details === undefined && body.total_items === 0) break;
      if (!body || !Array.isArray(body.transaction_details)) throw new RevenueError('paypal transactions: unexpected response');
      for (const d of body.transaction_details) {
        const t = d?.transaction_info || {};
        if (Number(t.transaction_amount?.value) > 0 && t.transaction_status === 'S') {
          seen.payments += 1;
          const k = `${String(t.transaction_event_code || '?').slice(0, 5)}/${String(t.paypal_reference_id_type || '-').slice(0, 3)}`;
          seen.refTypes.set(k, (seen.refTypes.get(k) || 0) + 1);
        }
        // 購読の入金は T0002・参照の種類 RP（実測 2026-11-24）。SUB も購読 ID として受ける
        if (['RP', 'SUB'].includes(t.paypal_reference_id_type) && !blank(t.paypal_reference_id)) ids.add(String(t.paypal_reference_id));
      }
      if (page >= (Number(body.total_pages) || 1)) break;
      if (page === MAX_PAGES) throw new RevenueError('paypal transactions: too many pages');
    }
  }
  const details = [];
  for (const id of ids) {
    const res = await fetchImpl(`${apiBase}/v1/billing/subscriptions/${encodeURIComponent(id)}`, { method: 'GET', headers: auth });
    if (!res.ok) throw new RevenueError(`paypal subscription: HTTP ${res.status}`);
    details.push(await res.json());
  }
  const subs = normalizePaypal(details);
  // 診断用の件数だけ（識別子は出さない）: 入金の種類（event code / 参照の種類）・購読 ID・AK の Plan・支払い済み
  const akPlan = details.filter((o) => planFromPaypalPlanId(o?.plan_id, 'live')).length;
  const kinds = [...seen.refTypes].sort().map(([k, n]) => `${k}=${n}`).join(' ');
  subs.diagnostic = `PayPal: 入金 ${seen.payments} 件（${kinds || 'なし'}）・購読 ID ${ids.size} 件・AK の Plan ${akPlan} 件・支払い済み ${subs.length} 件`;
  return subs;
}

export async function fetchStripeSubscriptions({ key, fetchImpl = fetch }) {
  const subscriptions = await stripeListAll('subscriptions', { status: 'all' }, { key, fetchImpl });
  const invoices = await stripeListAll('invoices', { status: 'paid' }, { key, fetchImpl });
  return normalizeStripe(subscriptions, invoices);
}

/** env の鍵で 3 社を読み、4 指標を返す。鍵なし・失敗の会社は未計上（全体は失敗させない）。 */
export async function buildSubscriptionMetrics({ env, period, nowMs = Date.now(), fetchImpl = fetch }) {
  const paddleKey = String(env.PADDLE_READ_KEY || '').trim();
  const ppId = String(env.PAYPAL_READ_CLIENT_ID || '').trim();
  const ppSecret = String(env.PAYPAL_READ_CLIENT_SECRET || '').trim();
  const stripeKey = String(env.STRIPE_READ_KEY || '').trim();
  const jobs = {
    paddle: paddleKey ? () => fetchPaddleSubscriptions({ key: paddleKey, nowMs, fetchImpl }) : null,
    paypal: ppId && ppSecret ? () => fetchPaypalSubscriptions({ clientId: ppId, clientSecret: ppSecret, nowMs, fetchImpl }) : null,
    stripe: stripeKey ? () => fetchStripeSubscriptions({ key: stripeKey, fetchImpl }) : null,
  };
  const subs = [];
  const providers = {};
  const diagnostics = [];
  for (const p of PROVIDERS) {
    if (!jobs[p]) continue;
    try {
      const got = await jobs[p]();
      subs.push(...got);
      if (got.diagnostic) diagnostics.push(got.diagnostic);
      providers[p] = true;
    } catch (e) {
      providers[p] = `取得失敗: ${e instanceof RevenueError ? e.message : 'unexpected'}`;
    }
  }
  const metrics = computeSubscriptionMetrics({ subs, period, nowMs, providers });
  metrics.data_quality.push(...diagnostics);
  return metrics;
}
