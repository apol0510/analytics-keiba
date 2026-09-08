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
 * 保存した `offset` で読み直せなかったときに、**先頭から読み直してよいか**（純粋）。
 *
 * ## なぜ要るか（2026-09-08 の障害）
 *
 * Airtable の `offset` は**短命**で、保存して 10 分後の tick で使うと失効しうる。
 * 失効した offset を渡すと 4xx が返り、旧実装はそこで throw していた。
 * throw はカーソルの更新より前なので **失効した offset が保存されたまま**になり、
 * 以後の tick は永久に同じ場所で落ち続ける（自力復帰できない）。
 *
 * 本番実測: `campaign-discount-free` の走査が **2026-08-27T20:50:48Z（pass 15）で凍結**し、
 * 以後 10 日間 1 度も進まなかった。台帳が小さく offset を持たない campaign
 * （light / premium）だけが無傷だったのが決め手。
 *
 * ## 先頭から読み直して安全な理由
 *
 * 走査は「誰がシーケンスに入っているか」を集めるだけで、**送信の冪等性は
 * `DeliveryKey`（campaign × version × step × 受信者）が持つ**。同じ人を 2 回読んでも
 * 2 通にはならない（このファイル冒頭の設計どおり）。読み直しの代償はページ数だけ。
 *
 * ⚠️ `offset` を渡していない失敗（＝先頭から読んで落ちた）は**リセットで直らない**。
 *    その場合は false を返し、従来どおり呼び出し側で失敗させる。
 */
export function shouldResetCursorOnFailure({ hadOffset, status } = {}) {
  if (hadOffset !== true) return false;
  const code = Number(status);
  // 5xx（Airtable 側の一時障害）は待てば直る。カーソルは触らない
  if (Number.isFinite(code) && code >= 500) return false;
  return true;
}

/** 失効した offset を捨てて先頭から読み直すカーソル（周回数は保つ） */
export function cursorAfterFailure({ pass } = {}) {
  return { offset: null, pass: Number(pass) || 0, completedPass: false };
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
