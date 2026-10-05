/**
 * airtableCapacityWatch.js — Airtable の API 呼び出し・レコード数の判定（純粋）
 *
 * 閾値は運用目標（2026-10-05 MK 指示）: レコード 45,000 件以下・API 月 100,000 回以下。
 * API は余裕を見て月末見込み 90,000 回で失敗にする（超過してからでは遅い）。
 */

export const API_MONTHLY_LIMIT = 100000;
export const API_FAIL_AT = 90000;
export const RECORD_FAIL_AT = 45000;
export const RECORD_WARN_AT = 42000;

/** 数える table（読み取り専用トークンは meta API を読めないため固定の一覧。2026-10-05 実測の 13 table） */
export const AIRTABLE_TABLES = Object.freeze([
  'Customers', 'ScheduledEmails', 'EmailBlacklist', 'PointExchangeRequests', 'ProcessedWebhookEvents',
  'AuthTokens', 'StepEnrollments', 'CampaignDeliveries', 'CampaignDeliveries_M5A3LiveTest',
  'CampaignDeliveries_MarketingAutomation', 'PromotionalOffers', 'EmailEvents', 'CouponOperationHistory',
]);

function jstParts(now) {
  const d = new Date(now.getTime() + 9 * 3600000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return { ym: `${y}-${String(m + 1).padStart(2, '0')}`, day: d.getUTCDate(), monthDays: new Date(Date.UTC(y, m + 1, 0)).getUTCDate() };
}

/**
 * @param {{day:string,total:number,bySource:Record<string,number>}[]} days 新しい順（今日が先頭）
 */
export function evaluateApiUsage(days, { now = new Date() } = {}) {
  const { ym, day, monthDays } = jstParts(now);
  const list = Array.isArray(days) ? days : [];
  const thisMonth = list.filter((d) => String(d.day).startsWith(ym));
  const monthToDate = thisMonth.reduce((a, d) => a + (Number(d.total) || 0), 0);
  // 今日は途中なので除き、昨日までの 7 日で平均する
  const full = list.slice(1, 8).filter((d) => Number(d.total) > 0);
  const avg7 = full.length ? Math.round(full.reduce((a, d) => a + d.total, 0) / full.length) : 0;
  const remainingDays = Math.max(0, monthDays - day);
  const todaySoFar = Number(list[0] && String(list[0].day).startsWith(ym) ? list[0].total : 0) || 0;
  const projected = monthToDate + Math.max(0, avg7 - todaySoFar) + avg7 * remainingDays;
  const agg = {};
  for (const d of list.slice(1, 8)) for (const [s, n] of Object.entries(d.bySource || {})) agg[s] = (agg[s] || 0) + n;
  const topSources = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([source, calls]) => ({ source, calls }));
  // 丸 1 日分の計測が無いうちは判定しない（0 回の平均で「余裕あり」と言わない）
  if (full.length === 0) return { monthToDate, avg7, projected: null, topSources, level: 'pending' };
  return { monthToDate, avg7, projected, topSources, level: projected > API_FAIL_AT ? 'fail' : 'ok' };
}

/** @param {Record<string, number>} tables */
export function evaluateRecords(tables) {
  const entries = Object.entries(tables || {});
  const total = entries.reduce((a, [, n]) => a + (Number(n) || 0), 0);
  const largest = entries.sort((a, b) => b[1] - a[1]).slice(0, 4);
  return { total, largest, level: total > RECORD_FAIL_AT ? 'fail' : total > RECORD_WARN_AT ? 'warn' : 'ok' };
}
