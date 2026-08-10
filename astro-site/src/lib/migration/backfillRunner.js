/**
 * 既存データを Redis / Blob へ移す本体（**IO は全部注入**）。
 *
 * 実 Airtable / 実 Redis / 実 Blob を知らないので、同じコードを
 *  - 本番スクリプト（実 IO を注入）
 *  - リハーサル（メモリ上の偽 store を注入して 14,416 / 18,793 件規模で通す）
 * の両方で走らせられる。**リハーサルで通った経路と本番の経路が同一**であることが要点。
 *
 * ── 安全側の約束 ────────────────────────────────────────────
 *  - 読み取りは打ち切らない（`completeRead` が例外にする）
 *  - 書き込みは冪等（Redis=SADD / Blob=内容ハッシュのキー）。何度流しても増えない
 *  - 途中で落ちても、もう一度最初から流して安全
 *  - `dryRun` では 1 バイトも書かない
 *  - ログに DeliveryKey / EventKey / アドレスの実値を出さない（件数と理由コードだけ）
 */

import { readAllPages } from './completeRead.js';
import {
  createCheckpoint, advanceCheckpoint, finishCheckpoint, verifyCheckpointBalance,
} from './migrationCheckpoint.js';

const nowIso = (clock) => (typeof clock === 'function' ? clock() : new Date(0).toISOString());

/**
 * CampaignDeliveries → Redis の DeliveryKey 集合。
 *
 * @param {{
 *   fetchPage: (offset: string|null) => Promise<{records: object[], offset?: string|null}>,
 *   sadd: (scope: object, keys: string[]) => Promise<{added: number}>,
 *   scopeOf: (row: object) => object|null,     // row → {brand, campaignId, version}
 *   keyOf: (row: object) => string|null,       // row → DeliveryKey
 *   dryRun?: boolean,
 *   chunkSize?: number,
 *   onProgress?: (cp: object) => void,
 *   clock?: () => string,
 * }} deps
 */
export async function backfillDeliveryKeys({
  fetchPage, sadd, scopeOf, keyOf, dryRun = false, chunkSize = 200, onProgress, clock,
} = {}) {
  let cp = createCheckpoint({ job: 'delivery-key-backfill', startedAt: nowIso(clock) });
  // scope（campaign×version）ごとに溜めてから SADD する
  const buckets = new Map();
  const seen = new Set();
  let duplicates = 0;

  const flush = async (force = false) => {
    for (const [k, entry] of [...buckets.entries()]) {
      if (!force && entry.keys.length < chunkSize) continue;
      const keys = entry.keys.splice(0, entry.keys.length);
      if (keys.length === 0) continue;
      if (!dryRun) await sadd(entry.scope, keys);
      cp = advanceCheckpoint(cp, { recordsWritten: keys.length, batchesWritten: 1 }, nowIso(clock));
      if (entry.keys.length === 0) buckets.delete(k);
      if (typeof onProgress === 'function') onProgress(cp);
    }
  };

  const read = await readAllPages({
    table: 'CampaignDeliveries',
    fetchPage,
    onPage: async (records) => {
      cp = advanceCheckpoint(cp, { pagesRead: 1, recordsRead: records.length }, nowIso(clock));
      for (const row of records) {
        const key = keyOf(row);
        const scope = scopeOf(row);
        if (!key || !scope) {
          // 鍵か宛先が分からない行は**移さずに数える**（黙って捨てない）
          cp = advanceCheckpoint(cp, { recordsSkipped: 1 }, nowIso(clock));
          continue;
        }
        const dedupeKey = `${scope.campaignId}:v${scope.version}:${key}`;
        if (seen.has(dedupeKey)) {
          duplicates += 1;
          cp = advanceCheckpoint(cp, { recordsSkipped: 1 }, nowIso(clock));
          continue;
        }
        seen.add(dedupeKey);
        const bucketKey = `${scope.brand}|${scope.campaignId}|${scope.version}`;
        if (!buckets.has(bucketKey)) buckets.set(bucketKey, { scope, keys: [] });
        buckets.get(bucketKey).keys.push(key);
      }
      await flush(false);
    },
  });

  await flush(true);
  const balance = verifyCheckpointBalance(cp);
  if (!balance.balanced) {
    throw new Error(`backfill:unbalanced:read=${balance.read}:accounted=${balance.accounted}`);
  }
  cp = finishCheckpoint(cp, nowIso(clock));
  return {
    checkpoint: cp,
    pages: read.pages,
    read: read.records,
    written: cp.recordsWritten,
    skipped: cp.recordsSkipped,
    duplicates,
    dryRun,
  };
}

/**
 * EmailEvents → Blob（NDJSON・immutable キー）。
 *
 * @param {{
 *   fetchPage: Function,
 *   writeBatch: (input: {events: object[], receivedAtMs: number}) => Promise<{key: string, written: number}>,
 *   toEvent: (row: object) => object|null,
 *   batchSize?: number,
 *   receivedAtMs: number,
 *   dryRun?: boolean,
 *   onProgress?: Function,
 *   clock?: () => string,
 * }} deps
 */
export async function backfillEmailEvents({
  fetchPage, writeBatch, toEvent, batchSize = 500, receivedAtMs, dryRun = false, onProgress, clock,
} = {}) {
  let cp = createCheckpoint({ job: 'email-event-backfill', startedAt: nowIso(clock) });
  const pending = [];
  const blobKeys = new Set();
  const seenEventKeys = new Set();
  let duplicates = 0;

  const flush = async (force = false) => {
    while (pending.length >= batchSize || (force && pending.length > 0)) {
      const batch = pending.splice(0, batchSize);
      if (!dryRun) {
        const r = await writeBatch({ events: batch, receivedAtMs });
        if (r && r.key) {
          if (blobKeys.has(r.key)) {
            // 同じ内容のバッチ = 同じキー。**二重 blob にならない**
            cp = advanceCheckpoint(cp, { recordsWritten: batch.length, batchId: r.key }, nowIso(clock));
          } else {
            blobKeys.add(r.key);
            cp = advanceCheckpoint(cp, { recordsWritten: batch.length, batchesWritten: 1, batchId: r.key }, nowIso(clock));
          }
        } else {
          cp = advanceCheckpoint(cp, { recordsWritten: batch.length }, nowIso(clock));
        }
      } else {
        cp = advanceCheckpoint(cp, { recordsWritten: batch.length }, nowIso(clock));
      }
      if (typeof onProgress === 'function') onProgress(cp);
      if (!force) break;
    }
  };

  const read = await readAllPages({
    table: 'EmailEvents',
    fetchPage,
    onPage: async (records) => {
      cp = advanceCheckpoint(cp, { pagesRead: 1, recordsRead: records.length }, nowIso(clock));
      for (const row of records) {
        let ev = null;
        try { ev = toEvent(row); } catch { ev = null; }
        if (!ev || !ev.eventKey) {
          cp = advanceCheckpoint(cp, { recordsSkipped: 1 }, nowIso(clock));
          continue;
        }
        if (seenEventKeys.has(ev.eventKey)) {
          duplicates += 1;
          cp = advanceCheckpoint(cp, { recordsSkipped: 1 }, nowIso(clock));
          continue;
        }
        seenEventKeys.add(ev.eventKey);
        pending.push(ev);
      }
      await flush(false);
    },
  });

  await flush(true);
  const balance = verifyCheckpointBalance(cp);
  if (!balance.balanced) {
    throw new Error(`backfill:unbalanced:read=${balance.read}:accounted=${balance.accounted}`);
  }
  cp = finishCheckpoint(cp, nowIso(clock));
  return {
    checkpoint: cp,
    pages: read.pages,
    read: read.records,
    written: cp.recordsWritten,
    skipped: cp.recordsSkipped,
    duplicates,
    blobKeys: [...blobKeys],
    eventKeys: seenEventKeys,
    dryRun,
  };
}
