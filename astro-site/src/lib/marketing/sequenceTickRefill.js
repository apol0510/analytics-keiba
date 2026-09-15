/**
 * sequenceTickRefill.js — **1 tick の枠を「積める人」で埋める**（判定の単一源）
 *
 * ## なぜ要るか（2026-09-15 本番実測）
 *
 * `MARKETING_SEQUENCE_MAX_PER_TICK=50` は「**計画時に 50 人選ぶ**」の意味で効いていた。
 * ところが選んだ 50 人は、そのあとの安全条件（既に `queued` / `sent` の人を外す）で
 * 大きく削られる。後ろに未登録の due が何千人居ても**補充されない**。
 *
 * 実測（periodic 再開後の連続 3 tick / `campaign-discount-free` step2）:
 *
 * | 時刻 | 対象 | 登録 | 登録済みのため除外 |
 * |---|---|---|---|
 * | 04:30Z | 50 | **20** | 30 |
 * | 04:40Z | 50 | **13** | 37 |
 * | 04:50Z | 50 | **4**  | 46 |
 *
 * step2 の due は 1,800 人以上残っているのに、1 tick で 4 人しか進まない。
 * 送るほど先頭が既登録で埋まり、**進むほど遅くなる**。
 *
 * ## ここで決めること
 *
 * 候補を**塊で見て、積める人が上限に達するまで後ろから補充する**。
 *
 *   - 上限（`maxRecipients`）は **絶対に超えない**
 *   - 安全条件は**迂回しない**。「積めるか」の判定は呼び出し側が渡す
 *     （既登録の除外・出所フィルタ・許可リストは既存の単一源のまま）
 *   - 見る範囲は**有限**（`maxScan`）。無限に探しに行かない
 *   - 候補の**順序は変えない**（公平性は `sequenceAudiencePool` が担当）
 *
 * ⚠️ `DeliveryKey` を作り直さない。鍵の計算も予約もここではしない。
 */

/** 1 回の塊で見る人数（Airtable の名指し取得 1 回ぶん）*/
export const DEFAULT_CHUNK = 100;
/** 1 tick で見に行く候補の上限（これ以上は次の tick へ回す）*/
export const DEFAULT_MAX_SCAN = 1000;

/**
 * 候補を前から見て、**積める人**が `maxRecipients` に達するまで補充する。
 *
 * @param {{
 *   candidates: Array,            // 並び順そのままの候補（多いほどよく埋まる）
 *   maxRecipients: number,        // 1 tick の上限（超えない）
 *   isSendable: (chunk: Array) => Promise<Array>,  // 塊を渡すと「積める人」だけ返す
 *   chunkSize?: number, maxScan?: number,
 * }} input
 * @returns {Promise<{picked: Array, scanned: number, skipped: number,
 *                    exhausted: boolean, chunks: number}>}
 */
export async function refillSendable({
  candidates, maxRecipients, isSendable, chunkSize = DEFAULT_CHUNK, maxScan = DEFAULT_MAX_SCAN,
} = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const cap = Number.isInteger(maxRecipients) && maxRecipients > 0 ? maxRecipients : 0;
  if (cap === 0 || list.length === 0 || typeof isSendable !== 'function') {
    return { picked: [], scanned: 0, skipped: 0, exhausted: list.length === 0, chunks: 0 };
  }
  const size = Number.isInteger(chunkSize) && chunkSize > 0 ? chunkSize : DEFAULT_CHUNK;
  const limit = Number.isInteger(maxScan) && maxScan > 0 ? maxScan : DEFAULT_MAX_SCAN;

  const picked = [];
  let scanned = 0;
  let chunks = 0;
  while (picked.length < cap && scanned < list.length && scanned < limit) {
    // 残り必要数より多めに見る（削られる前提。ただし見る範囲は有限）
    const take = Math.min(size, list.length - scanned, limit - scanned);
    const chunk = list.slice(scanned, scanned + take);
    // eslint-disable-next-line no-await-in-loop -- 塊ごとに順番に確かめる（名指し取得の回数を抑える）
    const ok = await isSendable(chunk);
    const kept = Array.isArray(ok) ? ok : [];
    for (const t of kept) {
      if (picked.length >= cap) break;   // ⚠️ 上限は絶対に超えない
      picked.push(t);
    }
    scanned += take;
    chunks += 1;
  }
  return {
    picked,
    scanned,
    skipped: scanned - picked.length,
    /** 候補を見切ったか（false なら次の tick に続きがある）*/
    exhausted: scanned >= list.length,
    chunks,
  };
}

export default refillSendable;
