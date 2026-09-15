/**
 * sequenceTickRotation.js — **campaign を順番に先頭へ回す**（判定の単一源）
 *
 * ## なぜ要るか（2026-09-15 本番実測）
 *
 * 共有 cron は `MARKETING_SEQUENCE_CAMPAIGN_ID` の順に campaign を回すが、
 * 1 tick の実行時間には上限がある（実測 **60,000 / 60,340 ms** で打ち切り）。
 * 先頭の `campaign-discount-free` だけで時間を使い切るため、
 * **`campaign-discount-light` と `campaign-discount-premium` は 3 tick 連続で 1 度も走らなかった**
 * （両者の要約ログが 0 件。下見では light 2 名・premium 10 名が due）。
 *
 * 「先頭から順に」を続ける限り、後ろの campaign は永久に進まない。
 *
 * ## ここで決めること
 *
 *   1. tick ごとに**開始位置をずらす**（round-robin）。どの campaign も必ず順番が回る
 *   2. 残り時間が足りなければ**新しい campaign を始めない**。
 *      始めなかった campaign は**黙って落とさず**名前を返す
 *
 * ⚠️ 並べ替えるだけで、**campaign を増やさない・減らさない**。
 * ⚠️ 送信の判断には一切関与しない（除外・`DeliveryKey`・予約は `runSequenceTick` のまま）。
 */

/** 新しい campaign を始めてよい残り時間（ミリ秒）。実測 1 campaign ≒ 45 秒 */
export const MIN_MS_FOR_NEXT_CAMPAIGN = 50 * 1000;
/** 1 tick 全体の時間予算（ミリ秒）。実測の打ち切りより少し手前 */
export const TICK_TIME_BUDGET_MS = 55 * 1000;

/**
 * 開始位置をずらした campaign の並びを返す（純粋）。
 *
 * ⚠️ `nowMs` と tick の間隔から**決定論的に**決める。乱数は使わない
 *    （同じ時刻なら同じ並び＝再現できる）。
 *
 * @param {{ids: string[], nowMs: number, intervalMs?: number}} input
 * @returns {string[]} 同じ要素を並べ替えたもの
 */
export function rotateCampaigns({ ids, nowMs, intervalMs = 10 * 60 * 1000 } = {}) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (list.length <= 1) return [...list];
  const iv = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 10 * 60 * 1000;
  const n = Number.isFinite(nowMs) ? Math.floor(nowMs / iv) : 0;
  const start = ((n % list.length) + list.length) % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
}

/**
 * 残り時間で新しい campaign を始めてよいか（純粋）。
 *
 * @param {{startedAtMs: number, nowMs: number, budgetMs?: number, minMs?: number}} input
 */
export function hasTimeForAnother({
  startedAtMs, nowMs, budgetMs = TICK_TIME_BUDGET_MS, minMs = MIN_MS_FOR_NEXT_CAMPAIGN,
} = {}) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return true;
  const elapsed = nowMs - startedAtMs;
  return (budgetMs - elapsed) >= minMs;
}

export default rotateCampaigns;
