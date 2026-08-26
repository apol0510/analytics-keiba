/**
 * sequenceLedgerScan.js — 配信台帳を **tick をまたいで走査する**（純粋 + 小さな保存層）
 *
 * ## なぜ要るか（2026-08-26 に発見）
 *
 * 連続配信の tick は「誰が既にシーケンスに入っているか」を配信台帳から読む。
 * ところが 1 通目を 15,491 通送ったことで台帳の行数が **4,000 行の読み取り上限**を
 * 大きく超え、`assertFetchComplete` が例外を投げて **2 通目が 1 通も送れない**状態だった。
 *
 * ### 単純に「上限で打ち切る」ではダメ
 *
 * Airtable のページ順は安定しているので、毎回**先頭 N ページ**だけを読むと
 * **いつも同じ人しか見えない**。N ページ目より後ろの人は永久に進まない。
 *
 * ### だから「続きから読む」
 *
 * 前回どこまで読んだか（Airtable の `offset`）を保存し、次の tick はそこから続ける。
 * 最後まで読み切ったら次の周回を先頭から始める。
 *
 *   - 1 tick が読むのは決まったページ数だけ（実行時間に収まる）
 *   - 周回を重ねれば **全員が必ず対象になる**（取りこぼさない）
 *   - 同じ人を二度送らないのは `DeliveryKey`（campaign × version × step × 受信者）が保証する。
 *     走査が重複しても送信は重複しない
 *
 * ⚠️ **黙って打ち切らない**。読み残しがあることを `partial` で返し、
 *    次の tick へ続きを渡す（`assertFetchComplete` の意図は保つ）。
 */

/** 1 tick で読むページ数（1 ページ 100 行）。実行時間に収まる範囲 */
export const DEFAULT_PAGES_PER_TICK = 20;

/** 走査カーソルの置き場所（キャンペーンごと。1 キーだけ） */
export const SCAN_CURSOR_KEY_PREFIX = 'ak:marketing:seq-scan:v1:';

export const scanCursorKey = (campaignType) => `${SCAN_CURSOR_KEY_PREFIX}${String(campaignType || '').trim()}`;

/** env から 1 tick のページ数を読む（壊れた値は既定へ） */
export function resolvePagesPerTick(env = process.env) {
  const n = Number(env?.MARKETING_SEQUENCE_SCAN_PAGES);
  return Number.isInteger(n) && n > 0 && n <= 100 ? n : DEFAULT_PAGES_PER_TICK;
}

/**
 * 次のカーソル値を決める（純粋）。
 *
 * @param {{ offset: string|null|undefined, pass?: number }} input
 *   offset … Airtable が返した続きの位置。無ければ読み切った
 * @returns {{ offset: string|null, pass: number, completedPass: boolean }}
 *   読み切ったら offset=null（次は先頭から）で `completedPass: true`
 */
export function nextScanCursor({ offset, pass = 0 } = {}) {
  const o = typeof offset === 'string' && offset.trim() ? offset.trim() : null;
  if (o) return { offset: o, pass: Number(pass) || 0, completedPass: false };
  return { offset: null, pass: (Number(pass) || 0) + 1, completedPass: true };
}

/**
 * カーソルの保存層。Redis が無ければ**毎回先頭から**読む
 * （進まなくなるだけで、誤送信にはならない）。
 */
export function createSequenceScanStore({ redisCmd } = {}) {
  const usable = typeof redisCmd === 'function';
  return {
    usable,
    async read(campaignType) {
      if (!usable) return { offset: null, pass: 0 };
      try {
        const raw = await redisCmd(['GET', scanCursorKey(campaignType)]);
        if (!raw) return { offset: null, pass: 0 };
        const v = JSON.parse(String(raw));
        return {
          offset: typeof v.offset === 'string' && v.offset ? v.offset : null,
          pass: Number.isInteger(v.pass) ? v.pass : 0,
        };
      } catch {
        return { offset: null, pass: 0 };
      }
    },
    async write(campaignType, cursor) {
      if (!usable) return { ok: false, reason: 'redis_not_configured' };
      try {
        await redisCmd(['SET', scanCursorKey(campaignType),
          JSON.stringify({ offset: cursor.offset ?? null, pass: cursor.pass ?? 0 })]);
        return { ok: true };
      } catch {
        return { ok: false, reason: 'write_failed' };
      }
    },
  };
}
