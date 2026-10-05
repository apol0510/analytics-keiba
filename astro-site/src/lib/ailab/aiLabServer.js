/**
 * aiLabServer.js — AI ラボの画面データ（サーバー専用）。正本 docs/AI_LAB.md
 * 全員に同じデータなので、温まった関数の中では CACHE_MS だけメモリに持つ（自動更新で Redis を叩きすぎない）。
 */
import { loadRecentDays } from './aiLabStore.js';
import { dayView, labStats } from './aiLab.js';
import { loadResultIndex } from '../acquisition/acquiredResults.js';
import { makeRedisCmd } from '../premiumPlus/premiumPlusFunnelServer.js';
import { ALL_MEMBER_PLANS } from '../auth/pageAccess.js';

/** 自動更新を通す ak_session のプラン（無料は通さない） */
export const AILAB_POLL_PLANS = Object.freeze(ALL_MEMBER_PLANS.filter((p) => p !== 'free' && p !== 'free-registered'));

const CACHE_MS = 20 * 1000;
let cache = null;

/** @returns {Promise<null | { serverNow, days, stats }>} Redis が読めなければ null（0 件と区別する） */
export async function loadLabView({ env, nowMs = Date.now(), deps = {} } = {}) {
  if (!deps.redis && cache && nowMs - cache.at < CACHE_MS) return { ...cache.value, serverNow: new Date(nowMs).toISOString() };
  const redis = deps.redis || makeRedisCmd(env);
  if (!redis) return null;
  let days;
  try { days = await loadRecentDays(redis, { limit: 14 }); } catch (e) {
    console.error('[ailab] load failed:', e?.message || 'unknown');
    return null;
  }
  const results = deps.index || loadResultIndex();
  const views = days.map((d) => ({ ...dayView(d, { results, nowMs }), updatedAt: d.updatedAt || null }));
  const value = { days: views, stats: labStats(views) };
  if (!deps.redis) cache = { at: nowMs, value };
  return { ...value, serverNow: new Date(nowMs).toISOString() };
}
