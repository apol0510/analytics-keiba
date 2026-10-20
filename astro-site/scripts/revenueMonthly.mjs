#!/usr/bin/env node
/**
 * revenueMonthly.mjs — 月間売上の measurement（KAO D-158・`kao.revenue-month/v1`）を作る（read-only）
 *
 * 目的: AK の月間売上 100 万円以上を「継続して」達成しているかを毎月測る。
 *       KAO が `docs/measurements/revenue-YYYY-MM-01.json` を読み、MK report の「事業成果」節に出す
 *       （契約: keiba-agent-orchestrator `docs/business-kpi.md`）。
 *
 * 売上の出所（決済手段ごと・合算して net を出す。月の境界は JST）:
 *   1. bank_transfer（必須）: 入金確認（confirm-bank-payment）で決済ファネルに記録した金額の合計
 *      （admin-payment-funnel `revenueMonth`・読み取り専用の鍵 PAYMENT_FUNNEL_READ_SECRET）。
 *      取得失敗は exit 1 で何も書かない（fail-closed・「0 円」として書かない）。
 *   2. stripe（任意）: Stripe の charges / refunds の一覧（GET のみ・制限付き鍵 STRIPE_READ_KEY）。
 *      gross = 成功した charge の amount_captured、refunds = 成功 / 保留中の refund の amount。
 *   3. paypal（任意）: PayPal Transaction Search（GET /v1/reporting/transactions のみ・PAYPAL_READ_CLIENT_ID / PAYPAL_READ_CLIENT_SECRET）。
 *      gross = 完了した入金（T00xx・正の金額）、refunds = 返金・取消（T11xx・負の金額）。
 *   任意の手段は、鍵が無い・取得に失敗した場合 **0 円として数えず**「未計上」と data_quality に明記する
 *   （KAO では「一部推定値」と表示される）。
 *
 * 🔴 read-only。決済会社へ書き込まない（課金・返金・購読変更・顧客連絡をしない）。PayPal の OAuth は token 取得のみ。
 * 🔴 集計値だけを出す（顧客・メール・charge / 取引 ID・明細を出さない）。例外文に鍵を含めない。
 * ⚠️ 当月（JST）を指定したときは月途中の速報値として `partial: true`・`period_end` を付け、data_quality に明記する
 *    （速報値は達成・連続月数に数えない）。
 *
 * 使い方:
 *   PAYMENT_FUNNEL_READ_SECRET=… [STRIPE_READ_KEY=…] [PAYPAL_READ_CLIENT_ID=… PAYPAL_READ_CLIENT_SECRET=…] \
 *     node scripts/revenueMonthly.mjs --month 2026-10 [--out ../docs/measurements/revenue-2026-10-01.json]
 *   --summary: 集計値の 1 行 JSON だけを出す（file を書かない・dry-run 用）
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SCHEMA = 'kao.revenue-month/v1';
export const TARGET_JPY = 1_000_000;
export const REPO = 'analytics-keiba';
const JST_OFFSET_MS = 9 * 3600 * 1000;
const STRIPE_API = 'https://api.stripe.com/v1';
const PAYPAL_API = 'https://api-m.paypal.com';
const MAX_PAGES = 200;

export class RevenueError extends Error {}

const MONTH_RE = /^(20\d{2})-(0[1-9]|1[0-2])$/;

export function previousMonthJst(nowMs = Date.now()) {
  const d = new Date(nowMs + JST_OFFSET_MS);
  const y = d.getUTCMonth() === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  const m = d.getUTCMonth() === 0 ? 12 : d.getUTCMonth();
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** 'YYYY-MM' → JST の月初〜翌月初（ms）。 */
export function monthRangeJst(month) {
  const m = MONTH_RE.exec(String(month));
  if (!m) throw new RevenueError(`month must be YYYY-MM: ${month}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return {
    startMs: Date.UTC(y, mo - 1, 1) - JST_OFFSET_MS,
    endMs: Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1) - JST_OFFSET_MS,
  };
}

/** 対象月の期間（当月なら now まで＝速報値）。未来の月は拒否。 */
export function measurementPeriod(month, nowMs = Date.now()) {
  const { startMs, endMs } = monthRangeJst(month);
  if (startMs > nowMs) throw new RevenueError(`month is in the future: ${month}`);
  const partial = nowMs < endMs;
  const untilMs = partial ? nowMs : endMs;
  const periodEnd = new Date((partial ? nowMs : endMs - 1) + JST_OFFSET_MS).toISOString().slice(0, 10);
  return { startMs, untilMs, partial, periodEnd };
}

// ---------------------------------------------------------------- bank_transfer（決済ファネル）

export async function fetchRevenueMonth({ siteUrl, secret, month, fetchImpl = fetch }) {
  if (!secret || !String(secret).trim()) throw new RevenueError('PAYMENT_FUNNEL_READ_SECRET is not set');
  const res = await fetchImpl(new URL('/.netlify/functions/admin-payment-funnel', siteUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-funnel-read-secret': secret },
    body: JSON.stringify({ action: 'revenueMonth', month }),
  });
  if (!res.ok) throw new RevenueError(`revenueMonth failed: HTTP ${res.status}`);
  const body = await res.json();
  for (const k of ['confirmedCount', 'pricedCount', 'confirmedYen']) {
    if (!Number.isInteger(body?.[k]) || body[k] < 0) throw new RevenueError(`revenueMonth: unexpected response (${k})`);
  }
  if (body.month !== month) throw new RevenueError('revenueMonth: month mismatch');
  return body;
}

// ---------------------------------------------------------------- stripe（GET のみ）

export async function stripeListAll(path, params, { key, fetchImpl = fetch }) {
  const out = [];
  let startingAfter;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const q = new URLSearchParams({ ...params, limit: '100' });
    if (startingAfter) q.set('starting_after', startingAfter);
    const res = await fetchImpl(`${STRIPE_API}/${path}?${q}`, { method: 'GET', headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new RevenueError(`stripe ${path}: HTTP ${res.status}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.data)) throw new RevenueError(`stripe ${path}: unexpected response`);
    out.push(...body.data);
    if (!body.has_more || body.data.length === 0) return out;
    startingAfter = body.data[body.data.length - 1].id;
  }
  throw new RevenueError(`stripe ${path}: too many pages`);
}

/** charge / refund の一覧 → 集計値（JPY 以外があれば fail-closed）。 */
export function summarizeStripe(charges, refunds) {
  let gross = 0;
  let payments = 0;
  for (const c of charges) {
    if (c?.status !== 'succeeded' || !c.paid) continue;
    if (String(c.currency).toLowerCase() !== 'jpy') throw new RevenueError('stripe: non-JPY charge found');
    gross += Number(c.amount_captured ?? c.amount ?? 0);
    payments += 1;
  }
  let refunded = 0;
  for (const r of refunds) {
    if (r?.status !== 'succeeded' && r?.status !== 'pending') continue;
    if (String(r.currency).toLowerCase() !== 'jpy') throw new RevenueError('stripe: non-JPY refund found');
    refunded += Number(r.amount ?? 0);
  }
  return { gross, refunds: refunded, payments };
}

export async function fetchStripeMonth({ key, period, fetchImpl = fetch }) {
  const params = { 'created[gte]': String(Math.floor(period.startMs / 1000)), 'created[lt]': String(Math.floor(period.untilMs / 1000)) };
  const charges = await stripeListAll('charges', params, { key, fetchImpl });
  const refunds = await stripeListAll('refunds', params, { key, fetchImpl });
  return summarizeStripe(charges, refunds);
}

// ---------------------------------------------------------------- paypal（token 取得と GET のみ）

const ppTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Transaction Search の transaction_details → 集計値（JPY 以外は fail-closed）。 */
export function summarizePaypal(details) {
  let gross = 0;
  let refunded = 0;
  let payments = 0;
  for (const d of details) {
    const t = d?.transaction_info || {};
    if (t.transaction_status !== 'S') continue;
    const code = String(t.transaction_event_code || '');
    const amt = t.transaction_amount || {};
    const value = Number(amt.value);
    if (!Number.isFinite(value) || value === 0) continue;
    if (String(amt.currency_code).toUpperCase() !== 'JPY') throw new RevenueError('paypal: non-JPY transaction found');
    if (/^T00\d\d$/.test(code) && value > 0) { gross += Math.round(value); payments += 1; }
    else if (/^T11\d\d$/.test(code) && value < 0) { refunded += Math.round(-value); }
  }
  return { gross, refunds: refunded, payments };
}

export async function fetchPaypalMonth({ clientId, clientSecret, period, fetchImpl = fetch, apiBase = PAYPAL_API }) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const tok = await fetchImpl(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!tok.ok) throw new RevenueError(`paypal token: HTTP ${tok.status}`);
  const access = (await tok.json())?.access_token;
  if (!access) throw new RevenueError('paypal token: unexpected response');
  const details = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const q = new URLSearchParams({
      start_date: ppTime(period.startMs), end_date: ppTime(period.untilMs - 1000),
      fields: 'transaction_info', page_size: '500', page: String(page),
    });
    const res = await fetchImpl(`${apiBase}/v1/reporting/transactions?${q}`, { method: 'GET', headers: { Authorization: `Bearer ${access}` } });
    if (!res.ok) throw new RevenueError(`paypal transactions: HTTP ${res.status}`);
    const body = await res.json();
    // 該当 0 件のとき PayPal は transaction_details を省く。total_items が 0 と明示された場合だけ 0 件として扱う
    if (body && body.transaction_details === undefined && body.total_items === 0) return summarizePaypal(details);
    if (!body || !Array.isArray(body.transaction_details)) {
      // 値は出さず、形の診断に必要なキー名と件数だけを残す
      const keys = body && typeof body === 'object' ? Object.keys(body).sort().join(',') : typeof body;
      throw new RevenueError(`paypal transactions: unexpected response (keys=${keys}; total_items=${body?.total_items ?? 'n/a'})`);
    }
    details.push(...body.transaction_details);
    const totalPages = Number(body.total_pages) || 1;
    if (page >= totalPages) return summarizePaypal(details);
  }
  throw new RevenueError('paypal transactions: too many pages');
}

// ---------------------------------------------------------------- 文書

export function sustainedMonths(month, netJpy, previous) {
  if (netJpy < TARGET_JPY) return 0;
  let streak = 1;
  let cursor = month;
  for (;;) {
    const [y, m] = cursor.split('-').map(Number);
    cursor = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const prev = previous.get(cursor);
    if (prev === undefined || !(prev >= TARGET_JPY)) return streak;
    streak += 1;
  }
}

export function readPrevious(dir) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!/^revenue-20\d{2}-\d{2}-01\.json$/.test(name)) continue;
    try {
      const doc = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      // 速報値（月途中）は連続月数に数えない
      if (doc.schema === SCHEMA && typeof doc.month === 'string' && typeof doc.net_jpy === 'number' && doc.partial !== true) out.set(doc.month, doc.net_jpy);
    } catch { /* 壊れた file は連続月数に数えない */ }
  }
  return out;
}

const CHANNEL_LABEL = { stripe: 'Stripe', paypal: 'PayPal' };

/**
 * channels.stripe / channels.paypal:
 *   undefined → 鍵なし（未計上）／ { unavailable: reason } → 取得失敗（未計上）／ { gross, refunds, payments } → 計上
 */
export function buildDoc({ month, summary, channels = {}, period, previous = new Map(), nowMs = Date.now() }) {
  const quality = [];
  const unpriced = summary.confirmedCount - summary.pricedCount;
  if (unpriced > 0) quality.push(`銀行振込: 入金確認 ${summary.confirmedCount} 件のうち ${unpriced} 件は金額の記録が無く未計上`);
  const monthStart = month.replace('-', '') + '01';
  if (summary.firstPricedDay === null || summary.firstPricedDay === undefined || summary.firstPricedDay > monthStart) {
    quality.push('銀行振込: 金額の記録はこの月の途中（または未開始）から — 月初からの全額ではない');
  }
  quality.push('銀行振込: 返金は記録が無く差し引いていない');

  const byChannel = {
    bank_transfer: { gross_jpy: summary.confirmedYen, refunds_jpy: 0, net_jpy: summary.confirmedYen, payments: summary.pricedCount },
  };
  let gross = summary.confirmedYen;
  let refunds = 0;
  for (const name of ['stripe', 'paypal']) {
    const c = channels[name];
    if (c === undefined || c === null) {
      byChannel[name] = { measured: false };
      quality.push(`${CHANNEL_LABEL[name]}: 未計上（読取り鍵が未設定）`);
    } else if (c.unavailable) {
      byChannel[name] = { measured: false };
      quality.push(`${CHANNEL_LABEL[name]}: 未計上（取得失敗: ${c.unavailable}）`);
    } else {
      byChannel[name] = { gross_jpy: c.gross, refunds_jpy: c.refunds, net_jpy: c.gross - c.refunds, payments: c.payments };
      gross += c.gross;
      refunds += c.refunds;
    }
  }
  const partial = Boolean(period?.partial);
  if (partial) quality.unshift(`月途中の速報値（${period.periodEnd} まで）— 月末の確定値ではない`);
  const net = gross - refunds;
  const doc = {
    schema: SCHEMA,
    repo: REPO,
    month,
    currency: 'JPY',
    generatedAt: new Date(nowMs).toISOString(),
    target_jpy: TARGET_JPY,
    gross_jpy: gross,
    refunds_jpy: refunds,
    net_jpy: net,
    by_channel: byChannel,
    achieved: !partial && net >= TARGET_JPY,
    sustained_months: partial ? 0 : sustainedMonths(month, net, previous),
    data_quality: quality,
    next_tasks: [],
  };
  if (partial) Object.assign(doc, { partial: true, period_end: period.periodEnd });
  return doc;
}

/** 任意の手段を読む。鍵が無ければ undefined、失敗は理由（鍵を含まない短い文）を返す。 */
async function optionalChannel(enabled, fn) {
  if (!enabled) return undefined;
  try {
    return await fn();
  } catch (e) {
    return { unavailable: e instanceof RevenueError ? e.message : 'unexpected' };
  }
}

export async function buildRevenueMonth({ month, env, fetchImpl = fetch, previous = new Map(), nowMs = Date.now() }) {
  const period = measurementPeriod(month, nowMs);
  const summary = await fetchRevenueMonth({
    siteUrl: env.SITE_URL || 'https://analytics.keiba.link/', secret: env.PAYMENT_FUNNEL_READ_SECRET, month, fetchImpl,
  });
  const stripeKey = String(env.STRIPE_READ_KEY || '').trim();
  const ppId = String(env.PAYPAL_READ_CLIENT_ID || '').trim();
  const ppSecret = String(env.PAYPAL_READ_CLIENT_SECRET || '').trim();
  const channels = {
    stripe: await optionalChannel(Boolean(stripeKey), () => fetchStripeMonth({ key: stripeKey, period, fetchImpl })),
    paypal: await optionalChannel(Boolean(ppId && ppSecret), () => fetchPaypalMonth({ clientId: ppId, clientSecret: ppSecret, period, fetchImpl })),
  };
  return buildDoc({ month, summary, channels, period, previous, nowMs });
}

/** dry-run 用の 1 行（集計値だけ）。 */
export function summaryLine(doc) {
  const ch = Object.fromEntries(Object.entries(doc.by_channel).map(([k, v]) => [k, v.measured === false ? 'unmeasured' : { net_jpy: v.net_jpy, payments: v.payments }]));
  return { status: 'ok', month: doc.month, partial: Boolean(doc.partial), net_jpy: doc.net_jpy, gross_jpy: doc.gross_jpy, refunds_jpy: doc.refunds_jpy,
    by_channel: ch, data_quality: doc.data_quality };
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const month = arg('--month') ?? previousMonthJst();
  const out = arg('--out');
  const doc = await buildRevenueMonth({ month, env: process.env, previous: out ? readPrevious(dirname(out)) : new Map() });
  if (argv.includes('--summary')) {
    console.log(JSON.stringify(summaryLine(doc)));
    return;
  }
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.log(JSON.stringify({ status: 'ok', month, out, partial: Boolean(doc.partial), achieved: doc.achieved }));
  } else {
    process.stdout.write(text);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    // 🔴 例外文に鍵を含めない（HTTP status と理由だけ）
    console.error(JSON.stringify({ status: 'error', reason: e instanceof RevenueError ? e.message : 'unexpected' }));
    process.exit(1);
  });
}
