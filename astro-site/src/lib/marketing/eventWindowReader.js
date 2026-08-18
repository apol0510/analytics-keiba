/**
 * eventWindowReader.js — 配信イベント台帳（Blob）から**窓のぶんだけ**読む
 *
 * ⚠️ 正本は `emailEventBlobStore.js` が書く NDJSON。
 *    **1 webhook バッチ = 1 blob**（本文は 1 行 1 イベント・最大 1000 イベント）。
 *    blob の数はイベント数ではない。`EmailBlacklist` は**アドレス 1 行の upsert 台帳**
 *    なのでイベント数には使わない（既存行は PATCH で `BounceCount+1` / `AddedAt` 据え置き）。
 * ⚠️ 読み方は既存の backfill（`admin-marketing` の `eventBackfill*`）と同じ
 *    `list({prefix}) → get(key) → parseNdjson`。**新しい経路を作らない**。
 * ⚠️ **読むだけ**。台帳へは書かない（書くのは Event Webhook だけ）。
 *    append-only / manifest 無しの設計は変更しない（日次 1 blob への
 *    read-modify-write のような multi-writer 競合を作らない）。
 *
 * ── 2026-08-18 の事故: 日全体の blob 数で上限判定していた ──────────
 * 旧実装は `list({prefix})`（**その UTC 日全体**）の件数を `MAX_EVENT_BLOBS` と比べ、
 * **実際のバッチ窓で絞る前に** `null` を返していた。
 * 送信量が増えるほど当日の blob が増えるので、健全性を**永久に読めなくなる**
 * （本番実測: 2026-08-18 の日合計 523 blob に対し上限 200 → 常に null →
 *   `batch_stats_unreadable` で自動停止）。
 *
 * 直し方は「上限を上げる」ではない（blob ごとに `get()` するので Function 時間が悪化する）。
 * **実際に読む候補まで先に絞り、その候補数へ上限を当てる**。
 *
 * ── どこまで安全に事前除外できるか（推測で捨てない）────────────────
 * 鍵は `buildBatchBlobKey()` が作る `ak/email-events/YYYY/MM/DD/HHMMSS-<hash12>.ndjson` で、
 * 日付・時刻部は **`receivedAtMs` の UTC・秒精度**（`emailEventBlobStore.js`）。
 * 一方、窓で切りたいのは **`eventAtMs`（provider 発行の発生時刻）** で、両者は別物:
 *
 *   `receivedAtMs` … こちらの受信時刻（`sendgrid-webhook.js` の `Date.now()`）
 *   `eventAtMs`    … provider の payload 由来（`EventAt` を `Date.parse`）
 *
 * ここから**証明できるのは片側だけ**:
 *
 *   - **上限側は言える**: イベントは起きてから送られてくるので、受信時刻 `r` の blob に
 *     入るイベントは `eventAtMs <= r + (provider 時計のずれ)`。
 *     鍵は秒で切り捨てられているので実際の `r ∈ [R, R + 1000)`。よって
 *     **その blob の最大 eventAtMs < R + 1000 + SKEW**。
 *     → `R + 1000 + SKEW <= sinceMs` なら、窓内のイベントは**構造的に入り得ない**ので捨ててよい。
 *
 *   - **下限側は言えない**: provider の再送・遅延や過去データの移送
 *     (`admin-migration-job.js` は `receivedAtMs: Date.now()` で**古い `eventAtMs`** を書く)
 *     があるため、「新しく受信した blob に古いイベントは入らない」とは言えない。
 *     → 受信が新しい blob は**捨てない**。中身を読んでから `summarizeEventWindow` が
 *       `eventAtMs` で正しく落とす。
 *
 * したがって事前除外は**「古すぎて窓に届かない blob」だけ**。鍵を読めない blob も捨てない。
 */

import { parseNdjson, blobDatePrefix } from '../webhooks/deliveryEventBackfill.js';
import { windowDates, summarizeEventWindow } from './batchEventWindow.js';

/**
 * 1 回の判定で **実際に読む（get する）** blob の数の上限。
 * ⚠️ これは「その日の blob 数」ではなく**窓に関係する候補数**に当てる。
 *    日全体へ当てると、送信量が増えるだけで永久に読めなくなる（2026-08-18 の事故）。
 */
export const MAX_EVENT_BLOBS = 200;

/** blob store の名前（既存 backfill と同一） */
export const EVENT_STORE = 'ak-email-events';

/**
 * 鍵の時刻は**秒まで**（`buildBatchBlobKey` が `HHMMSS`）。
 * 実際の受信時刻は `[R, R + 1000)` の幅を持つ。
 */
export const KEY_TIME_GRANULARITY_MS = 1000;

/**
 * provider の時計がこちらより**進んでいる**場合の許容幅。
 *
 * `eventAtMs` は SendGrid の `timestamp`、`receivedAtMs` は当方の `Date.now()` なので、
 * 厳密には `eventAtMs <= receivedAtMs` を保証できない（別々の時計）。
 * 事前除外は**安全側にだけ効かせたい**ので、広めに取る。
 * 広く取っても、健全性の窓はバッチ 1 回ぶん（通常は数分）なので候補数は十分絞れる。
 */
export const RECEIVE_CLOCK_SKEW_MS = 15 * 60 * 1000;

/** `ak/email-events/YYYY/MM/DD/HHMMSS-<hash>.ndjson` （`buildBatchBlobKey` の逆） */
const KEY_RE = /(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})(\d{2})-[a-f0-9]{8,64}\.ndjson$/;

/**
 * blob の鍵から**受信時刻（UTC・秒精度の下限）**を取り出す。
 *
 * @returns {number|null} 読めなければ `null`（＝**時刻で除外してはいけない**）
 */
export function parseBlobKeyReceivedAtMs(key) {
  const m = KEY_RE.exec(String(key ?? ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  // 桁は正規表現で保証済み。範囲外（月 13 など）は Date.UTC が繰り上げるので明示的に弾く
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(t) ? t : null;
}

/**
 * この blob を**読む必要があるか**（＝窓に関係し得るか）。
 *
 * 捨ててよいのは「古すぎて窓に届かない」と**証明できる**ものだけ:
 *   その blob の最大 eventAtMs < R + 粒度 + skew  なので、
 *   `R + 粒度 + skew <= sinceMs` のとき窓内イベントは入り得ない。
 *
 * @returns {boolean} 読むなら true（**判断できないものは true**）
 */
export function isBlobInWindow({
  key, sinceMs,
  granularityMs = KEY_TIME_GRANULARITY_MS, skewMs = RECEIVE_CLOCK_SKEW_MS,
} = {}) {
  const since = Number(sinceMs);
  if (!Number.isFinite(since)) return true;      // 窓が無いなら絞らない
  const received = parseBlobKeyReceivedAtMs(key);
  if (received === null) return true;            // 鍵を読めない＝**推測で捨てない**
  return received + granularityMs + skewMs > since;
}

/**
 * @param {{sinceMs: number, untilMs: number, campaignId: string,
 *          deliveryKeys?: Set<string>|null, getStoreImpl?: Function,
 *          maxBlobs?: number}} input
 * @returns {Promise<object|null>} `summarizeEventWindow` の戻り。読めなければ null
 */
export async function readEventWindow({
  sinceMs, untilMs, campaignId, deliveryKeys = null, getStoreImpl = null,
  maxBlobs = MAX_EVENT_BLOBS,
} = {}) {
  const dates = windowDates(sinceMs, untilMs);
  if (!dates || dates.length === 0) return null;
  let store;
  try {
    if (getStoreImpl) {
      store = getStoreImpl(EVENT_STORE);
    } else {
      const { getStore } = await import('@netlify/blobs');
      store = getStore(EVENT_STORE);
    }
  } catch {
    return null;
  }
  if (!store || typeof store.list !== 'function' || typeof store.get !== 'function') return null;

  // ── ① 候補を決める（**まだ 1 つも get しない**）──────────────────
  const candidates = [];
  let listedCount = 0;
  for (const date of dates) {
    const prefix = blobDatePrefix(date);
    if (!prefix) return null;
    let listed;
    try {
      // eslint-disable-next-line no-await-in-loop -- 日付ごとに 1 回
      listed = await store.list({ prefix });
    } catch {
      return null;
    }
    // ⚠️ `@netlify/blobs` の `list()` は paginate 無しなら内部で `next_cursor` を
    //    追い切って**全件**返す（v10: `collectIterator`）。取り切れないときは throw する。
    //    それでも「1 ページだけ」の形が渡ってきたら**成功扱いにしない**（暗黙の truncate 防止）。
    if (!listed || !Array.isArray(listed.blobs)) return null;
    if (listed.next_cursor || listed.cursor) return null;
    listedCount += listed.blobs.length;
    for (const b of listed.blobs) {
      const key = b && b.key;
      if (!key) continue;
      // 窓に関係し得ない blob は**候補にも入れない**（= get しない）
      if (!isBlobInWindow({ key, sinceMs })) continue;
      candidates.push(key);
    }
  }

  // ── ② 上限は「実際に読む候補」へ当てる ─────────────────────────
  //    候補が多すぎる＝数え切れない → **0 と言わずに null**（呼び出し側が fail closed）
  if (candidates.length > maxBlobs) return null;

  // ── ③ 候補だけ読む ─────────────────────────────────────────
  const records = [];
  let scanned = 0;
  for (const key of candidates) {
    let text;
    try {
      // eslint-disable-next-line no-await-in-loop -- blob ごとに 1 回
      text = await store.get(key);
    } catch {
      return null;
    }
    scanned += 1;
    if (!text) continue;
    records.push(...parseNdjson(text));
  }

  // ⚠️ campaign / DeliveryKey / eventAtMs 窓 / providerEventId 重複排除は
  //    `summarizeEventWindow` が単一源。ここでは**一切判定しない**。
  const summary = summarizeEventWindow({ records, campaignId, sinceMs, deliveryKeys });
  return summary ? { ...summary, blobsScanned: scanned, blobsListed: listedCount } : null;
}

export default readEventWindow;
