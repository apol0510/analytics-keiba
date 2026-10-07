/**
 * aiLabStore.js — AI ラボの保存（Upstash Redis）。正本 docs/AI_LAB.md（2026-10-07）
 *   ak:ailab:v2:{market}:day:{YYYY-MM-DD}  STRING  1 日分（全レース・全頭の AI 勝率・単勝オッズ・期待値）。180 日で消える
 *   ak:ailab:v2:{market}:days              ZSET    保存済みの日付（score=YYYYMMDD）
 * 旧 ak:ailab:v1:jra:*（2026-10-05 版・AI 勝率と AK 上位 5 頭）は読まない（TTL で消える）。
 */
import { MARKETS } from './aiLab.js';

const DAY_TTL = 180 * 24 * 3600;
const assertMarket = (m) => { if (!MARKETS.includes(m)) throw new Error('unknown_market'); };
export const dayKey = (market, date) => { assertMarket(market); return `ak:ailab:v2:${market}:day:${date}`; };
export const daysKey = (market) => { assertMarket(market); return `ak:ailab:v2:${market}:days`; };
/**
 * 取込キーの照合値＝MK の PC にだけある 256bit 乱数キーの SHA-256（hex）。docs/AI_LAB.md
 * 🛑 キーそのものは commit しない（ここにあるのは逆算できないハッシュだけ）。env にも置かない（Lambda 4KB 上限）。
 * ローテーション: PC の ~/.analytics-keiba-ops/ailab-ingest-secret を作り直し、この値を差し替えて deploy。
 */
export const INGEST_KEY_SHA256 = '28eb3c32cb394a7aa2149266cc2b91620d59ce1d4a17e9e802bed132c0baf708';
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** 1 日分を保存する（KAP が毎回その日の全レースを送るので、丸ごと置き換える）。受信時刻を添える */
export async function saveDay(redis, day, { nowMs = Date.now() } = {}) {
  if (typeof redis !== 'function') throw new Error('redis_unavailable');
  const saved = { ...day, receivedAt: new Date(nowMs).toISOString() };
  await redis(['SET', dayKey(day.market, day.date), JSON.stringify(saved), 'EX', String(DAY_TTL)]);
  await redis(['ZADD', daysKey(day.market), String(Number(day.date.replace(/-/g, ''))), day.date]);
  return saved;
}

/** 保存済みの日付（新しい順に最大 limit 日） */
export async function listDates(redis, market, { limit = 14 } = {}) {
  if (typeof redis !== 'function') throw new Error('redis_unavailable');
  const dates = await redis(['ZREVRANGE', daysKey(market), '0', String(Math.max(0, limit - 1))]);
  return Array.isArray(dates) ? dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))) : [];
}

/** 1 日分（無ければ null） */
export async function loadDay(redis, market, date) {
  if (typeof redis !== 'function') throw new Error('redis_unavailable');
  const d = parse(await redis(['GET', dayKey(market, date)]));
  return d && d.date === date && d.market === market ? d : null;
}
