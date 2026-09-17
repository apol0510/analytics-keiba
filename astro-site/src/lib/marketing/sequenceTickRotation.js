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
 * 予算はここから手前に置いてある。**予算より緩い判定は絶対にしない。**
 */
export const TICK_HARD_LIMIT_MS = 60 * 1000;
/**
 * 打ち切りまでに必ず残す余裕（ミリ秒）。**ぎりぎりを安全と呼ばない。**
 *
 * ⚠️ 打ち切りの実測は 60,000 / 60,340 ms とブレる。後始末（鍵の解放・ログ）にも時間が要る。
 *    **「ちょうど 60 秒で終わる」計画は安全ではない。**
 */
export const HARD_LIMIT_SAFETY_MARGIN_MS = 5 * 1000;
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
 * ## この値の位置づけ
 *
 * ⚠️ **安全の保証はここではなく `LATEST_START_MS` が持つ。**
 *    下限は「見積りが小さくなりすぎないようにする」ためのもので、
 *    打ち切りに対する余裕は**契約値だけで決めた絶対条件**（`LATEST_START_MS`）で担保する。
 *
 * 実測（2026-09-17 / 7 本）: 2 / 3 / 7 / 8 / 11 / 13 / 21 秒。
 * live の送信ぶんを足した想定でも最遅は 23 秒。**ただしこの実測を安全条件に使わない**
 * （契約は `MAX_CAMPAIGN_MS` = 30 秒）。
 */
export const MIN_NEXT_CAMPAIGN_ESTIMATE_MS = 25 * 1000;
/**
 * **契約として**どの campaign もこれを超えてはいけない上限（ミリ秒）。
 *
 * ⚠️ **実測値（最遅 23 秒）と混同しない。** 安全余裕は「いま何秒か」ではなく
 *    「**契約上どこまで許すか**」で計算する。実測だけを根拠に安全上限を狭めると、
 *    次に重い campaign が増えた瞬間に前提が崩れる。
 */
export const MAX_CAMPAIGN_MS = 30 * 1000;

/**
 * **新しい campaign を始めてよい最も遅い時点**（ミリ秒・安全の要）。
 *
 * ## 導出（契約値だけで決める）
 *
 * 最も遅く始めた campaign が**契約上の最大**まで掛かっても、
 * 打ち切りまでに**余裕を残して**終わっていなければならない:
 *
 * ```
 * LATEST_START_MS + MAX_CAMPAIGN_MS + HARD_LIMIT_SAFETY_MARGIN_MS <= TICK_HARD_LIMIT_MS
 *          25     +       30        +            5                 =        60      ✅
 * ```
 *
 * ⚠️ **これを実測（23 秒）で計算してはいけない。** 契約が 30 秒なら 30 秒で計算する。
 * ⚠️ これは見積り（`estimateNextCampaignMs`）とは**独立の絶対条件**。
 *    見積りが外れても、この時刻を過ぎたら新しい campaign は始めない。
 */
export const LATEST_START_MS = TICK_HARD_LIMIT_MS
  - MAX_CAMPAIGN_MS - HARD_LIMIT_SAFETY_MARGIN_MS;

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
 * ── 判定（**3 つすべて**を満たしたときだけ true）─────────────────
 *   1. **契約上の絶対条件** … `elapsed <= LATEST_START_MS`
 *      契約上の最大（`MAX_CAMPAIGN_MS`）まで掛かっても、余裕を残して打ち切り前に終わる
 *   2. **予算内に終わる見込み** … `elapsed + 見積り <= budgetMs`
 *   3. **打ち切りまでに余裕を残して終わる見込み**
 *      … `elapsed + 見積り <= hardLimitMs - HARD_LIMIT_SAFETY_MARGIN_MS`
 *
 * ⚠️ 1 は**見積りと独立**。見積りが外れても、この時刻を過ぎたら新しい campaign を始めない。
 *    これが「timeout 直前に予約だけ残る（＝送信漏れ）」を防ぐ最後の歯止め。
 * ⚠️ 3 は**ぎりぎりを許さない**ための条件。`<= hardLimitMs` では余裕 0 秒を許してしまう。
 *
 * 見積りは同じ tick で実際に掛かった時間の**最大 × 安全率**（`estimateNextCampaignMs`）。
 * `observedMs` を渡さなければ `minMs` 固定＝**従来と同じ挙動**。
 *
 * @param {{startedAtMs: number, nowMs: number, budgetMs?: number, minMs?: number,
 *          observedMs?: number[]|null, hardLimitMs?: number,
 *          latestStartMs?: number, marginMs?: number}} input
 */
export function hasTimeForAnother({
  startedAtMs, nowMs, budgetMs = TICK_TIME_BUDGET_MS, minMs = MIN_MS_FOR_NEXT_CAMPAIGN,
  observedMs = null, hardLimitMs = TICK_HARD_LIMIT_MS,
  latestStartMs = LATEST_START_MS, marginMs = HARD_LIMIT_SAFETY_MARGIN_MS,
} = {}) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return true;
  const elapsed = nowMs - startedAtMs;
  /**
   * ① 契約上の絶対条件。**見積りより先に効かせる**（見積りが外れても守られる）。
   */
  if (Number.isFinite(latestStartMs) && elapsed > latestStartMs) return false;
  /** ⚠️ 渡されなければ従来どおり（`minMs` 固定） */
  const estimate = observedMs === null
    ? minMs
    : estimateNextCampaignMs({ observedMs, fallbackMs: minMs });
  // ② 予算内に終わる見込み
  if ((budgetMs - elapsed) < estimate) return false;
  // ③ 打ち切りまでに**余裕を残して**終わる見込み（ぎりぎりを安全と呼ばない）
  const margin = Number.isFinite(marginMs) && marginMs >= 0 ? marginMs : 0;
  return (elapsed + estimate) <= (hardLimitMs - margin);
}

export default rotateCampaigns;
