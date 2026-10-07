/**
 * aiLabServer.js — AI ラボの画面データ（サーバー専用）。正本 docs/AI_LAB.md（2026-10-07）
 * 全員に同じデータなので、温まった関数の中では CACHE_MS だけメモリに持つ（自動更新で Redis を叩きすぎない）。
 */
import { listDates, loadDay } from './aiLabStore.js';
import { MARKETS, jstDate } from './aiLab.js';
import { makeRedisCmd } from '../premiumPlus/premiumPlusFunnelServer.js';
import { loadResultIndex } from '../acquisition/acquiredResults.js';
import { ALL_MEMBER_PLANS } from '../auth/pageAccess.js';

/** 自動更新を通す ak_session のプラン（無料は通さない） */
export const AILAB_POLL_PLANS = Object.freeze(ALL_MEMBER_PLANS.filter((p) => p !== 'free' && p !== 'free-registered'));

const CACHE_MS = 15 * 1000;
const cache = new Map();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 1 market の画面データ。日付の指定が無ければ「今日（JST）があれば今日・無ければ直近」。
 * @returns {Promise<null | { market, dates, date, day, serverNow }>} Redis が読めなければ null（0 件と区別する）
 */
export async function loadMarketView({ env, market, date = null, nowMs = Date.now(), deps = {} } = {}) {
  if (!MARKETS.includes(market)) return null;
  const want = DATE_RE.test(String(date || '')) ? date : null;
  const key = `${market}|${want || ''}`;
  const hit = !deps.redis && cache.get(key);
  if (hit && nowMs - hit.at < CACHE_MS) return { ...hit.value, serverNow: new Date(nowMs).toISOString() };
  const redis = deps.redis || makeRedisCmd(env);
  if (!redis) return null;
  let value;
  try {
    const dates = await listDates(redis, market, { limit: 14 });
    const today = jstDate(nowMs);
    const chosen = want && dates.includes(want) ? want : (dates.includes(today) ? today : (dates[0] || null));
    const day = chosen ? await loadDay(redis, market, chosen) : null;
    value = { market, dates, date: chosen, day: day ? withResults(day, deps.index || safeResultIndex()) : null };
  } catch (e) {
    console.error('[ailab] load failed:', e?.message || 'unknown');
    return null;
  }
  if (!deps.redis) cache.set(key, { at: nowMs, value });
  return { ...value, serverNow: new Date(nowMs).toISOString() };
}

function safeResultIndex() {
  try { return loadResultIndex(); } catch { return null; }
}

/** 結果アーカイブ（AK の結果・1〜3 着）を添える。払戻は添えない */
export function withResults(day, index) {
  if (!index || typeof index.get !== 'function') return day;
  return {
    ...day,
    races: day.races.map((r) => {
      const hit = index.get(`${day.date}|${r.venueName}|${r.raceNumber}`);
      return hit ? { ...r, result: { first: hit.first, second: hit.second, third: hit.third ?? null } } : r;
    }),
  };
}

/**
 * 最初に開く market: 今日（JST）これから発走するレースがある market（早い方）→ 今日のデータがある market → 直近のデータの market。
 * 指定（?market=）があればそれ。
 */
export function pickInitialMarket(views, { nowMs = Date.now(), requested = null } = {}) {
  if (MARKETS.includes(requested)) return requested;
  const today = jstDate(nowMs);
  let best = null;
  for (const v of views || []) {
    if (!v || v.date !== today || !v.day) continue;
    const next = v.day.races.map((r) => Date.parse(r.startAt)).filter((t) => t > nowMs).sort((a, b) => a - b)[0];
    if (next != null && (!best || next < best.next)) best = { market: v.market, next };
  }
  if (best) return best.market;
  const withToday = (views || []).find((v) => v && v.date === today);
  if (withToday) return withToday.market;
  const latest = (views || []).filter((v) => v && v.date).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  return latest ? latest.market : 'jra';
}
