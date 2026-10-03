/**
 * usageStats.js — 取得履歴から利用状況を数える（純粋）
 *
 * 今月（JST の暦月）の取得数・利用日数（取得した JST 暦日の数）・中央/南関別・最近取得した予想。
 * 取得日時は ISO（UTC）で保存され、JST に直して数える。
 */
const JST_MS = 9 * 3600 * 1000;
const jstYmd = (ms) => new Date(ms + JST_MS).toISOString().slice(0, 10);

export function summarizeUsage(entries, { nowMs = Date.now(), recent = 5 } = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.at === 'string' && Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const month = jstYmd(nowMs).slice(0, 7);
  const thisMonth = list.filter((e) => jstYmd(Date.parse(e.at)).startsWith(month));
  const days = new Set(thisMonth.map((e) => jstYmd(Date.parse(e.at))));
  const byCategory = { jra: 0, nankan: 0 };
  for (const e of thisMonth) if (e.cat in byCategory) byCategory[e.cat] += 1;
  return {
    month,
    monthCount: thisMonth.length,
    activeDays: days.size,
    byCategory,
    totalCount: list.length,
    recent: list.slice(0, recent),
  };
}
