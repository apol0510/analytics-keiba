/**
 * aiLabStore.js — AI ラボの保存（Upstash Redis）。正本 docs/AI_LAB.md
 *   ak:ailab:v1:jra:day:{YYYY-MM-DD}  STRING  1 日分（KAP の全頭期待値＋AK 上位 5 頭）。180 日で消える
 *   ak:ailab:v1:jra:days              ZSET    保存済みの日付（score=YYYYMMDD）
 */
const DAY_TTL = 180 * 24 * 3600;
export const dayKey = (date) => `ak:ailab:v1:jra:day:${date}`;
export const DAYS_KEY = 'ak:ailab:v1:jra:days';
/**
 * 取込キーの照合値＝MK の PC にだけある 256bit 乱数キーの SHA-256（hex）。docs/AI_LAB.md
 * 🛑 キーそのものは commit しない（ここにあるのは逆算できないハッシュだけ）。env にも置かない（Lambda 4KB 上限）。
 * ローテーション: PC の ~/.analytics-keiba-ops/ailab-ingest-secret を作り直し、この値を差し替えて deploy。
 */
export const INGEST_KEY_SHA256 = '28eb3c32cb394a7aa2149266cc2b91620d59ce1d4a17e9e802bed132c0baf708';
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** 1 日分を保存する。新しいデータに AK 上位 5 頭が無いレース（AK 側の予想が既に無い等）は保存済みの値を残す */
export async function saveDay(redis, day) {
  if (typeof redis !== 'function') throw new Error('redis_unavailable');
  const prev = parse(await redis(['GET', dayKey(day.date)]));
  const prevBy = new Map((prev?.races || []).map((r) => [r.raceId, r]));
  const merged = {
    ...day,
    updatedAt: new Date().toISOString(),
    races: day.races.map((r) => {
      const p = prevBy.get(r.raceId);
      return { ...r, akTop5: r.akTop5 || p?.akTop5 || null, startTime: r.startTime || p?.startTime || null };
    }),
  };
  await redis(['SET', dayKey(day.date), JSON.stringify(merged), 'EX', String(DAY_TTL)]);
  await redis(['ZADD', DAYS_KEY, String(Number(day.date.replace(/-/g, ''))), day.date]);
  return merged;
}

/** 新しい順に最大 limit 日 */
export async function loadRecentDays(redis, { limit = 14 } = {}) {
  if (typeof redis !== 'function') throw new Error('redis_unavailable');
  const dates = await redis(['ZREVRANGE', DAYS_KEY, '0', String(Math.max(0, limit - 1))]);
  if (!Array.isArray(dates) || dates.length === 0) return [];
  const got = await redis(['MGET', ...dates.map(dayKey)]);
  return (Array.isArray(got) ? got : []).map(parse).filter((d) => d && d.date);
}
