/**
 * prospectScanWindow.js — prospect 索引を **tick をまたいで走査する**（純粋 + 小さな保存層）
 *
 * ## なぜ要るか（2026-09-17 本番実測）
 *
 * live の tick は prospect 索引を**無制限に**読む（`loadProspectSequenceInputs` に
 * `maxRecipients` を渡していない ＝ 全 11,799 件）。これが 1 campaign の**支配項**だった。
 *
 * 下見で窓を変えて測った実測（`campaign-discount-free`・台帳 2 ページ固定）:
 *
 * | 索引の窓 | 所要 | 送る |
 * |---|---|---|
 * | 500 | **8.2 秒** | 50 |
 * | 1,000 | **10.1 秒** | 50 |
 * | 2,000 | **12.7 秒** | 50 |
 * | 4,000 | **19.0 秒** | 50 |
 *
 * ⚠️ **live の全件（11,799）は測れていない。** 下見は 4,000 で頭打ち
 *    （`cron-campaign-sequence` が `Math.min(4000, …)` で切っている）ため、
 *    **全件の所要時間は未測定**。ここで「約 N 秒」と外挿してはいけない
 *    （2026-09-17 に外挿で 3 回続けて見積りを外した）。
 *
 * 確かなのは次の 2 点だけ:
 *
 *   1. 索引の件数に比例して伸びる（500 → 4,000 で 8.2 → 19.0 秒）
 *   2. live は測定できた最大（4,000）の**約 3 倍**を無制限に読む
 *
 * ## ここで決めること
 *
 * **「測っていない無制限」から「測った有限」へ変える。**
 * 速くなる幅は主張しない。**上限が決まっていること**が目的。
 *
 * 仕組みは配信台帳の走査（`sequenceLedgerScan.js`）と**同じ**:
 *
 *   - 1 tick が読むのは決まった件数だけ（実行時間に収まる）
 *   - 前回の続き（`offset`）を保存し、次の tick はそこから読む
 *   - 読み切ったら次の周回を先頭から始める
 *   - 周回を重ねれば **全員が必ず対象になる**（取りこぼさない）
 *
 * ⚠️ **同じ人を二度送らないのは `DeliveryKey`（campaign × version × step × 受信者）が保証する。**
 *    走査の窓が重なっても送信は重複しない。窓を変えても二重送信の防御は一切変わらない。
 * ⚠️ **1 tick の送信人数は変わらない**（`SYNC_TICK_MAX_RECIPIENTS` = 50 のまま）。
 *    変わるのは「何人を候補として見るか」だけ。
 */

/**
 * 1 tick で読む prospect の件数。
 *
 * **2,000 は実測値**（12.7 秒 / `送る` は 50 のまま）。
 * 増やすときは live の実測を添えること。**外挿で決めない。**
 */
export const DEFAULT_PROSPECT_PER_TICK = 2000;

/** 走査カーソルの置き場所（キャンペーンごと。1 キーだけ） */
export const PROSPECT_CURSOR_KEY_PREFIX = 'ak:marketing:prospect-scan:v1:';

export const prospectCursorKey = (campaignType) =>
  `${PROSPECT_CURSOR_KEY_PREFIX}${String(campaignType || '').trim()}`;

/** env から 1 tick の件数を読む（壊れた値は既定へ） */
export function resolveProspectPerTick(env = process.env) {
  const n = Number(env?.MARKETING_SEQUENCE_PROSPECT_PER_TICK);
  return Number.isInteger(n) && n > 0 && n <= 4000 ? n : DEFAULT_PROSPECT_PER_TICK;
}

/**
 * 次に読み始める位置を決める（純粋）。
 *
 * ⚠️ **読めた件数ではなく「索引を何件消費したか」で進める**
 *    （値を読めなかった hash があると、読めた件数で進めた分だけ窓が巻き戻る）。
 * ⚠️ 索引が縮んで位置が末尾を越えたら**先頭へ戻す**（空振りを続けない）。
 *
 * @param {{offset?: number, scanned?: number, indexSize?: number, pass?: number}} input
 * @returns {{offset: number, pass: number, completedPass: boolean}}
 */
export function nextProspectCursor({ offset, scanned, indexSize, pass } = {}) {
  const from = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const took = Number.isInteger(scanned) && scanned > 0 ? scanned : 0;
  const size = Number.isInteger(indexSize) && indexSize > 0 ? indexSize : 0;
  const round = Number.isInteger(pass) && pass > 0 ? pass : 0;
  const nextRaw = from + took;
  // 1 件も消費できなかった / 末尾まで来た / 索引が縮んだ → 先頭へ戻して次の周回
  if (took === 0 || size === 0 || nextRaw >= size) {
    return { offset: 0, pass: round + 1, completedPass: true };
  }
  return { offset: nextRaw, pass: round, completedPass: false };
}

/**
 * カーソルの読み書き（Redis が無ければ**窓を使わない**＝従来どおり先頭から）。
 *
 * ⚠️ カーソルが読めないことを理由に**送信を止めない**。
 *    位置が分からなければ先頭から読む（＝従来の挙動に戻るだけ）。
 */
export function createProspectScanStore({ redisCmd } = {}) {
  const usable = typeof redisCmd === 'function';
  return {
    usable,
    async read(campaignType) {
      if (!usable) return { offset: 0, pass: 0 };
      try {
        const raw = await redisCmd(['GET', prospectCursorKey(campaignType)]);
        if (!raw) return { offset: 0, pass: 0 };
        const v = JSON.parse(String(raw));
        return {
          offset: Number.isInteger(v.offset) && v.offset > 0 ? v.offset : 0,
          pass: Number.isInteger(v.pass) && v.pass > 0 ? v.pass : 0,
        };
      } catch {
        return { offset: 0, pass: 0 };
      }
    },
    async write(campaignType, cursor) {
      if (!usable) return { ok: false, reason: 'redis_not_configured' };
      try {
        await redisCmd([
          'SET', prospectCursorKey(campaignType),
          JSON.stringify({
            offset: Number.isInteger(cursor?.offset) && cursor.offset > 0 ? cursor.offset : 0,
            pass: Number.isInteger(cursor?.pass) && cursor.pass > 0 ? cursor.pass : 0,
          }),
        ]);
        return { ok: true };
      } catch {
        // ⚠️ 書けなくても送信は済んでいる。次の tick は同じ位置から読み直すだけ
        //    （`DeliveryKey` が二重送信を防ぐので、重なっても害はない）
        return { ok: false, reason: 'write_failed' };
      }
    },
  };
}

export default nextProspectCursor;
