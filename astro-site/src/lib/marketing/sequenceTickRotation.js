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

/**
 * 観測が無いときに使う保守的な見積り（ミリ秒）。
 *
 * ⚠️ この 50 秒は「実測 1 campaign ≒ 45 秒」という**古い前提**に基づく値で、
 *    予算 55 秒との差が **5 秒**しかない。1 本目が 5 秒を超えて終わると
 *    `hasTimeForAnother` が必ず false になり、**実質 1 tick = 1 campaign** になっていた
 *    （2026-09-17 本番実測。campaign は 7 本あるので 1 本の番は 70 分に 1 回）。
 *
 *    いまは**同じ tick で実際に掛かった時間**から見積もるので、この値は
 *    「まだ 1 本も走っていない」ときの保険としてだけ残す（呼び出し側が
 *    `observedMs` を渡さなければ従来どおりの挙動）。
 */
export const MIN_MS_FOR_NEXT_CAMPAIGN = 50 * 1000;
/** 1 tick 全体の時間予算（ミリ秒）。実測の打ち切りより少し手前 */
export const TICK_TIME_BUDGET_MS = 55 * 1000;
/**
 * scheduled function が打ち切られる実測値（ミリ秒）。
 * 予算はここから 5 秒手前に置いてある。**予算より緩い判定は絶対にしない。**
 */
export const TICK_HARD_LIMIT_MS = 60 * 1000;
/**
 * 実測の最大値に掛ける安全率。
 *
 * ⚠️ **打ち切られると実害が残る。** 予約（`claimDelivered`）は取れたのに
 *    キュー登録の前で殺されると、その鍵は配信済み集合に残り
 *    **その人へは二度と送られない**（送信漏れ）。だから「だいたい足りる」ではなく
 *    **実測の 1.5 倍**を要求する。
 */
export const NEXT_CAMPAIGN_SAFETY_FACTOR = 1.5;
/**
 * 実測が速くても、これ未満には見積もらない（ミリ秒）。
 *
 * ⚠️ 1 本目がたまたま 2 秒で終わっても「次も 3 秒で終わる」とは限らない。
 *    下限を置かないと、**軽い campaign が続いた直後に重い campaign を残り数秒で始めて**
 *    打ち切りに突っ込む（＝予約だけ取れて送信漏れ）。
 *
 * ## この値の決め方（2026-09-17 本番実測）
 *
 * 下限を `F` にすると、新しい campaign を始められる最も遅い時点は `予算 - F`。
 * そこから最も重い campaign が走ると、終了は **`(予算 - F) + 最遅`**。
 * これが**打ち切り（60 秒）以内**でなければならない:
 *
 * ```
 * (TICK_TIME_BUDGET_MS - MIN_NEXT_CAMPAIGN_ESTIMATE_MS) + MAX_CAMPAIGN_MS <= TICK_HARD_LIMIT_MS
 * (55 - 25) + 23 = 53 秒 <= 60 秒   ✅
 * ```
 *
 * 実測（2026-09-17 / 7 本）: 2 / 3 / 7 / 8 / 11 / 13 / 21 秒。live の送信ぶんを足した
 * 想定でも最遅は **23 秒**。下限 25 秒なら **7 秒の余裕**が残る。
 *
 * ⚠️ 20 秒でも本数は同じだが理論最悪が 58 秒（余裕 2 秒）まで詰まる。
 *    **本数が変わらないなら余裕の大きい 25 秒を採る。**
 */
export const MIN_NEXT_CAMPAIGN_ESTIMATE_MS = 25 * 1000;
/**
 * どの campaign もこれを超えてはいけない上限（ミリ秒・**不変条件**）。
 *
 * 上の式が成り立つ前提。超える campaign が出たら下限か予算を見直すこと
 * （`sequenceTickBudget.test.mjs` が式を固定している）。
 */
export const MAX_CAMPAIGN_MS = 30 * 1000;

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
 * **次の campaign にどれくらい掛かりそうか**を、同じ tick の実測から見積もる（純粋）。
 *
 * ⚠️ 平均ではなく**最大**を使う。平均だと遅い campaign を過小評価して踏む。
 * ⚠️ 実測が 1 件も無ければ、従来どおり保守的な `fallbackMs` を返す
 *    （呼び出し側が `observedMs` を渡さないときは挙動が変わらない）。
 *
 * @param {{observedMs: number[], factor?: number, floorMs?: number, fallbackMs?: number}} input
 * @returns {number} ミリ秒
 */
export function estimateNextCampaignMs({
  observedMs,
  factor = NEXT_CAMPAIGN_SAFETY_FACTOR,
  floorMs = MIN_NEXT_CAMPAIGN_ESTIMATE_MS,
  fallbackMs = MIN_MS_FOR_NEXT_CAMPAIGN,
} = {}) {
  /**
   * ⚠️ `null` / `undefined` / `''` を `Number()` に通すと **0 になる**（= 0 ミリ秒で
   *    終わったことにされ、見積りが下限まで落ちる）。**欠測は 0 ではない**ので捨てる。
   */
  const list = (Array.isArray(observedMs) ? observedMs : [])
    .map((n) => (n === null || n === undefined || n === '' ? NaN : Number(n)))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (list.length === 0) return fallbackMs;
  const f = Number.isFinite(factor) && factor > 0 ? factor : NEXT_CAMPAIGN_SAFETY_FACTOR;
  const floor = Number.isFinite(floorMs) && floorMs >= 0 ? floorMs : 0;
  return Math.max(floor, Math.ceil(Math.max(...list) * f));
}

/**
 * 残り時間で新しい campaign を始めてよいか（純粋）。
 *
 * ── 判定 ────────────────────────────────────────────────────
 *   1. **予算内に終わる見込みがある**こと … `elapsed + 見積り <= budgetMs`
 *   2. **打ち切りまでに終わる見込みがある**こと … `elapsed + 見積り <= hardLimitMs`
 *
 * 見積りは同じ tick で実際に掛かった時間の**最大 × 安全率**（`estimateNextCampaignMs`）。
 * `observedMs` を渡さなければ `minMs` 固定＝**従来と同じ挙動**。
 *
 * @param {{startedAtMs: number, nowMs: number, budgetMs?: number, minMs?: number,
 *          observedMs?: number[]|null, hardLimitMs?: number}} input
 */
export function hasTimeForAnother({
  startedAtMs, nowMs, budgetMs = TICK_TIME_BUDGET_MS, minMs = MIN_MS_FOR_NEXT_CAMPAIGN,
  observedMs = null, hardLimitMs = TICK_HARD_LIMIT_MS,
} = {}) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return true;
  const elapsed = nowMs - startedAtMs;
  /** ⚠️ 渡されなければ従来どおり（`minMs` 固定） */
  const estimate = observedMs === null
    ? minMs
    : estimateNextCampaignMs({ observedMs, fallbackMs: minMs });
  if ((budgetMs - elapsed) < estimate) return false;
  /** 予算が打ち切りより手前にある限り冗長だが、**予算を緩めたときの歯止め**として残す */
  return (elapsed + estimate) <= hardLimitMs;
}

export default rotateCampaigns;
