/**
 * boundedBatchWrite.js — 書き込みを**上限つき並行**で流す（純粋・I/O は注入）
 *
 * ## なぜ要るか（2026-09-17 の構造解析）
 *
 * キュー登録の `CampaignDeliveries` upsert は **10 件ずつ・完全逐次**で、
 * 往復回数が人数に比例する（500 名なら 50 回）。実測では 1 往復 **約 1.1 秒**かかっており、
 * **待ち時間が支配的**（Airtable の上限 5 req/秒 = 1 往復 0.2 秒よりずっと遅い）。
 * つまり**並行にすれば縮む余地がある**。
 *
 * | | 逐次 | 上限つき並行（3）|
 * |---|---|---|
 * | 50 名（9 往復）| 約 10 秒 | 約 3〜4 秒 |
 * | 200 名（34 往復）| 約 37 秒 | 約 13 秒 |
 *
 * ## 守ること（速さより優先）
 *
 * ⚠️ **Airtable は 1 base あたり 5 req/秒**。並行度を上げすぎると 429 を踏む。
 *    既定の並行度は **3**（上限に対して余裕を残す）。
 * ⚠️ **429 / 5xx は「失敗」ではなく「待って再試行」**。現在の実装は 1 回でも失敗すると
 *    tick 全体を中止し、作ったジョブを取り消して予約も戻す。**再試行があれば無駄な巻き戻しが減る**。
 * ⚠️ **締め切りを越えたら新しい batch を始めない**。予約（`claimDelivered`）は
 *    キュー登録の**前**に取るので、登録の途中で打ち切られると鍵だけが残り
 *    **その人へは二度と送られない**。時間が無いなら**始めない**方が安全。
 * ⚠️ **1 つでも最終的に失敗したら、呼び出し側は全体を失敗として扱う**こと
 *    （部分成功を成功と呼ばない）。巻き戻しは既存の経路（ジョブ取消＋予約解放）のまま。
 * ⚠️ 冪等性は呼び出し側の `performUpsert`（`DeliveryKey` で突合）が担保する。
 *    **同じ batch を 2 回送っても行は増えない**ので、再試行は安全。
 */

/** 既定の並行度（Airtable 5 req/秒 に対して余裕を持たせる） */
export const DEFAULT_CONCURRENCY = 3;
/** 再試行する回数（429 / 5xx のみ） */
export const DEFAULT_MAX_RETRIES = 2;
/** 再試行の待ち（ミリ秒）。`Retry-After` があればそちらを優先 */
export const DEFAULT_RETRY_BASE_MS = 500;

/**
 * 再試行してよい状態か（429 と 5xx だけ。4xx は直らないので再試行しない）。
 *
 * ⚠️ `null` / `undefined` を `Number()` に通すと **0 になる**（= 再試行しない側へ倒れる）。
 *    状態が分からないのは**ネットワーク断**なので、**再試行してよい**側へ倒す。
 */
export function isRetryable(status) {
  if (status === null || status === undefined || status === '') return true;
  const n = Number(status);
  if (!Number.isFinite(n)) return true;          // ネットワーク断は再試行してよい
  return n === 429 || (n >= 500 && n < 600);
}

const wait = (ms) => new Promise((r) => { setTimeout(r, Math.max(0, ms)); });

/**
 * batch 群を上限つき並行で流す。
 *
 * @param {{
 *   batches: Array,                  // 送る単位（中身は呼び出し側の自由）
 *   send: (batch, index) => Promise<{ok: boolean, status?: number, retryAfterMs?: number}>,
 *   concurrency?: number,
 *   maxRetries?: number,
 *   retryBaseMs?: number,
 *   nowMs?: () => number,            // テスト用（既定は Date.now）
 *   deadlineMs?: number|null,        // これを過ぎたら**新しい batch を始めない**
 *   sleep?: (ms) => Promise<void>,   // テスト用
 * }} input
 * @returns {Promise<{ok: boolean, sent: number, failed: number, attempted: number,
 *                    notStarted: number, retries: number, abort: string|null,
 *                    firstFailure: {index: number, status: number|null}|null}>}
 */
export async function runBoundedBatches({
  batches, send,
  concurrency = DEFAULT_CONCURRENCY,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  nowMs = Date.now,
  deadlineMs = null,
  sleep = wait,
} = {}) {
  const list = Array.isArray(batches) ? batches : [];
  const total = list.length;
  if (total === 0) {
    return { ok: true, sent: 0, failed: 0, attempted: 0, notStarted: 0, retries: 0, abort: null, firstFailure: null };
  }
  if (typeof send !== 'function') {
    return { ok: false, sent: 0, failed: 0, attempted: 0, notStarted: total, retries: 0, abort: 'no_sender', firstFailure: null };
  }
  const width = Math.max(1, Math.min(Number(concurrency) || DEFAULT_CONCURRENCY, 10));
  const tries = Math.max(0, Number(maxRetries) ?? DEFAULT_MAX_RETRIES);

  let next = 0;
  let sent = 0;
  let failed = 0;
  let attempted = 0;
  let retries = 0;
  let abort = null;
  let firstFailure = null;

  const outOfTime = () => deadlineMs !== null && Number.isFinite(deadlineMs) && nowMs() >= deadlineMs;

  const runOne = async (batch, index) => {
    for (let attempt = 0; attempt <= tries; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- 再試行は順番に待つ
      const res = await send(batch, index).catch(() => ({ ok: false, status: null }));
      if (res && res.ok === true) return { ok: true };
      const status = res && res.status !== undefined ? res.status : null;
      const canRetry = attempt < tries && isRetryable(status);
      if (!canRetry) return { ok: false, status };
      /** ⚠️ 待ってから再試行する。締め切りを越えるなら**再試行しない**（延長しない） */
      const backoff = (res && Number(res.retryAfterMs)) || retryBaseMs * (attempt + 1);
      if (deadlineMs !== null && Number.isFinite(deadlineMs) && nowMs() + backoff >= deadlineMs) {
        return { ok: false, status, reason: 'deadline' };
      }
      retries += 1;
      // eslint-disable-next-line no-await-in-loop -- 意図的な待ち
      await sleep(backoff);
    }
    return { ok: false, status: null };
  };

  const worker = async () => {
    for (;;) {
      if (abort) return;
      const index = next;
      if (index >= total) return;
      /**
       * ⚠️ **締め切りを越えたら新しい batch を始めない。**
       *    始めてしまうと、書いている途中で打ち切られて予約だけが残る。
       */
      if (outOfTime()) { abort = abort || 'deadline_reached'; return; }
      next += 1;
      attempted += 1;
      // eslint-disable-next-line no-await-in-loop -- 並行はワーカー数で担保
      const r = await runOne(list[index], index);
      if (r.ok) { sent += 1; continue; }
      failed += 1;
      if (!firstFailure) firstFailure = { index, status: r.status ?? null };
      /** ⚠️ 1 つでも失敗したら**新しい batch を始めない**（傷口を広げない） */
      abort = abort || 'write_failed';
      return;
    }
  };

  await Promise.all(Array.from({ length: Math.min(width, total) }, () => worker()));

  return {
    ok: failed === 0 && abort === null && sent === total,
    sent,
    failed,
    attempted,
    notStarted: Math.max(0, total - attempted),
    retries,
    abort,
    firstFailure,
  };
}

export default runBoundedBatches;
