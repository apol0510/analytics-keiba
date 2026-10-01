#!/usr/bin/env node
/**
 * revenueMonthly.mjs — 月間売上の measurement（KAO D-158・`kao.revenue-month/v1`）を作る（read-only）
 *
 * 目的: AK の月間売上 100 万円以上を「継続して」達成しているかを毎月測る。
 *       KAO が `docs/measurements/revenue-YYYY-MM-01.json` を読み、MK report の「事業成果」節に出す
 *       （契約: keiba-agent-orchestrator `docs/business-kpi.md`）。
 *
 * 売上の出所: 入金確認（confirm-bank-payment）で決済ファネルに記録した金額の合計
 *   （admin-payment-funnel `revenueMonth`・読み取り専用の鍵 PAYMENT_FUNNEL_READ_SECRET）。
 * 🔴 read-only。集計値だけ（識別子・メール・明細を出さない）。取得失敗は exit 1 で何も書かない。
 * ⚠️ 金額の記録を始める前の入金確認・金額が読めなかった入金確認・PayPal は計上されない → data_quality に明記する。
 *
 * 使い方:
 *   PAYMENT_FUNNEL_READ_SECRET=… node scripts/revenueMonthly.mjs --month 2026-10 [--out ../docs/measurements/revenue-2026-10-01.json]
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SCHEMA = 'kao.revenue-month/v1';
export const TARGET_JPY = 1_000_000;
export const REPO = 'analytics-keiba';
const JST_OFFSET_MS = 9 * 3600 * 1000;

export class RevenueError extends Error {}

export function previousMonthJst(nowMs = Date.now()) {
  const d = new Date(nowMs + JST_OFFSET_MS);
  const y = d.getUTCMonth() === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  const m = d.getUTCMonth() === 0 ? 12 : d.getUTCMonth();
  return `${y}-${String(m).padStart(2, '0')}`;
}

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
      if (doc.schema === SCHEMA && typeof doc.month === 'string' && typeof doc.net_jpy === 'number') out.set(doc.month, doc.net_jpy);
    } catch { /* 壊れた file は連続月数に数えない */ }
  }
  return out;
}

export function buildDoc({ month, summary, previous = new Map(), nowMs = Date.now() }) {
  const quality = ['PayPal 決済は未計上（銀行振込の入金確認のみ）'];
  const unpriced = summary.confirmedCount - summary.pricedCount;
  if (unpriced > 0) quality.push(`入金確認 ${summary.confirmedCount} 件のうち ${unpriced} 件は金額の記録が無く未計上`);
  const monthStart = month.replace('-', '') + '01';
  if (summary.firstPricedDay === null || summary.firstPricedDay > monthStart) {
    quality.push('金額の記録はこの月の途中（または未開始）から — 月初からの全額ではない');
  }
  const net = summary.confirmedYen;
  return {
    schema: SCHEMA,
    repo: REPO,
    month,
    currency: 'JPY',
    generatedAt: new Date(nowMs).toISOString(),
    target_jpy: TARGET_JPY,
    gross_jpy: net,
    refunds_jpy: 0,
    net_jpy: net,
    by_channel: { bank_transfer: { net_jpy: net, payments: summary.pricedCount } },
    achieved: net >= TARGET_JPY,
    sustained_months: sustainedMonths(month, net, previous),
    data_quality: quality,
    next_tasks: [],
  };
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const month = arg('--month') ?? previousMonthJst();
  const out = arg('--out');
  const summary = await fetchRevenueMonth({
    siteUrl: process.env.SITE_URL || 'https://analytics.keiba.link/',
    secret: process.env.PAYMENT_FUNNEL_READ_SECRET,
    month,
  });
  const doc = buildDoc({ month, summary, previous: out ? readPrevious(dirname(out)) : new Map() });
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.log(JSON.stringify({ status: 'ok', month, out, achieved: doc.achieved }));
  } else {
    process.stdout.write(text);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(JSON.stringify({ status: 'error', reason: e instanceof RevenueError ? e.message : 'unexpected' }));
    process.exit(1);
  });
}
