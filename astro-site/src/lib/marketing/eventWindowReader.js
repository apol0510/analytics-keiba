/**
 * eventWindowReader.js — 配信イベント台帳（Blob）から**窓のぶんだけ**読む
 *
 * ⚠️ 正本は `emailEventBlobStore.js` が書く NDJSON（**1 行 1 イベント**）。
 *    `EmailBlacklist` は**アドレス 1 行の upsert 台帳**なのでイベント数には使わない
 *    （既存行は PATCH で `BounceCount+1` / `AddedAt` 据え置き ＝ 履歴が残らない）。
 * ⚠️ 読み方は既存の backfill（`admin-marketing` の `eventBackfill*`）と同じ
 *    `list({prefix}) → get(key) → parseNdjson`。**新しい経路を作らない**。
 * ⚠️ 走査上限つき。超えたら **null**（数え切れていないので 0 と言わない）。
 * ⚠️ **読むだけ**。台帳へは書かない（書くのは Event Webhook だけ）。
 */

import { parseNdjson, blobDatePrefix } from '../webhooks/deliveryEventBackfill.js';
import { windowDates, summarizeEventWindow } from './batchEventWindow.js';

/** 1 回の判定で走査してよい blob の数（既存 backfill と同じ考え方） */
export const MAX_EVENT_BLOBS = 200;

/** blob store の名前（既存 backfill と同一） */
export const EVENT_STORE = 'ak-email-events';

/**
 * @param {{sinceMs: number, untilMs: number, campaignId: string,
 *          deliveryKeys?: Set<string>|null, getStoreImpl?: Function}} input
 * @returns {Promise<object|null>} `summarizeEventWindow` の戻り。読めなければ null
 */
export async function readEventWindow({
  sinceMs, untilMs, campaignId, deliveryKeys = null, getStoreImpl = null,
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

  const records = [];
  let scanned = 0;
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
    const blobs = (listed && listed.blobs) || [];
    // 数え切れないなら**黙って少なく数えない**
    if (scanned + blobs.length > MAX_EVENT_BLOBS) return null;
    for (const b of blobs) {
      let text;
      try {
        // eslint-disable-next-line no-await-in-loop -- blob ごとに 1 回
        text = await store.get(b.key);
      } catch {
        return null;
      }
      scanned += 1;
      if (!text) continue;
      records.push(...parseNdjson(text));
    }
  }
  const summary = summarizeEventWindow({ records, campaignId, sinceMs, deliveryKeys });
  return summary ? { ...summary, blobsScanned: scanned } : null;
}

export default readEventWindow;
