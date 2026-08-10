#!/usr/bin/env node
/**
 * 既存 `EmailEvents` を Netlify Blobs へ NDJSON で退避する。
 *
 * ── 安全側の性質 ────────────────────────────────────────────
 *  - **打ち切らない**（`completeRead` が例外にする）
 *  - **二重 blob を作らない**。キーは内容ハッシュ由来なので、同じバッチを
 *    もう一度書いても同じキーに上書きされる（内容が等しいので害が無い）
 *  - **read-modify-write をしない**。既存 blob を読まない
 *  - 生アドレス・URL・UA・IP を書かない（`emailEventBlobStore` の allow-list）
 *  - `EventKey` を保つので、退避後も idempotency を再構成できる
 *  - `--dry-run` が既定
 *
 *   node scripts/backfill-email-events.mjs --dry-run
 *   … --apply
 *   … --batch=500
 *
 * exit: 0=成功 / 1=不整合 / 2=読み取り失敗 / 3=設定不足
 */
import fs from 'node:fs';
import {
  requireEnv, parseArgs, makeAirtablePager, makeBlobSetter,
  saveCheckpoint, progressLogger, sha256,
} from './migrate-lib.mjs';
import { backfillEmailEvents } from '../src/lib/migration/backfillRunner.js';
import { createEmailEventBlobStore } from '../src/lib/webhooks/emailEventBlobStore.js';

const JOB = 'email-event-backfill';
const { get, has } = parseArgs(process.argv);
const APPLY = has('apply');
const DRY = !APPLY;
const BATCH = Number(get('batch', '500'));
const STORE_NAME = get('store', 'ak-email-events');
const KEYS_OUT = get('keys-out', '');

requireEnv(['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID']);

/** Airtable の行 → 保存形（allow-list は Blob store 側が最終判断する） */
function toEvent(row) {
  const f = (row && row.fields) || {};
  if (!f.EventKey || !f.EventType) return null;
  return {
    eventKey: f.EventKey,
    eventType: f.EventType,
    eventAtMs: f.EventAt ? Date.parse(f.EventAt) : undefined,
    campaignId: f.CampaignId,
    campaignVersion: f.CampaignVersion,
    deliveryKey: f.DeliveryKey,
    campaignDeliveryRecordId: f.CampaignDeliveryRecordId,
    customerRecordId: f.CustomerRecordId,
    emailHash: f.EmailHash,
    bounceClass: f.BounceClass,
    reasonText: f.ReasonText,
    providerEventId: f.ProviderEventId,
    providerMessageId: f.ProviderMessageId,
    resolutionStatus: f.ResolutionStatus,
  };
}

let blobStore = null;
if (APPLY) {
  let setBlob;
  try {
    setBlob = await makeBlobSetter(STORE_NAME);
  } catch (e) {
    console.error(`❌ Blobs へ接続できません (${e.message})`);
    console.error('   NETLIFY_SITE_ID と NETLIFY_AUTH_TOKEN が要ります');
    process.exit(3);
  }
  blobStore = createEmailEventBlobStore({ setBlob, hashFn: sha256 });
}

console.log(`🚚 EmailEvents backfill  mode=${DRY ? 'DRY-RUN（書きません）' : 'APPLY'}`
  + `  store=${STORE_NAME}  batch=${BATCH}`);

let result;
try {
  result = await backfillEmailEvents({
    fetchPage: makeAirtablePager({
      table: 'EmailEvents',
      fields: [
        'EventKey', 'EventType', 'EventAt', 'CampaignId', 'CampaignVersion', 'DeliveryKey',
        'CampaignDeliveryRecordId', 'CustomerRecordId', 'EmailHash', 'BounceClass',
        'ReasonText', 'ProviderEventId', 'ProviderMessageId', 'ResolutionStatus',
      ],
    }),
    writeBatch: (input) => blobStore.writeBatch(input),
    toEvent,
    batchSize: BATCH,
    // バッチ内容から鍵が決まるので、この時刻はキーの日付階層にしか効かない
    receivedAtMs: Date.now(),
    dryRun: DRY,
    onProgress: progressLogger('events'),
    clock: () => new Date().toISOString(),
  });
} catch (e) {
  console.error(`❌ 中断: ${e.message}`);
  console.error('   キーは内容ハッシュ由来なので二重 blob にはなりません。再実行してください');
  process.exit(e.name === 'IncompleteReadError' ? 2 : 1);
}

saveCheckpoint(JOB, result.checkpoint);

// 突合のため EventKey 集合をローカルへ書き出せるようにする（**中身は鍵のみ・PII なし**）
if (KEYS_OUT) {
  fs.writeFileSync(KEYS_OUT, [...result.eventKeys].join('\n'));
  console.log(`   EventKey 集合を ${KEYS_OUT} へ出力（突合用）`);
}

console.log('');
console.log(`   ページ数   : ${result.pages}`);
console.log(`   読み取り   : ${result.read}`);
console.log(`   退避       : ${result.written}${DRY ? '（dry-run）' : ''}`);
console.log(`   skip       : ${result.skipped}`);
console.log(`   blob 個数  : ${result.blobKeys.length}`);
console.log(`   重複 EventKey: ${result.duplicates}`);
console.log('');
console.log(DRY ? '✅ dry-run 完了。書き込むには --apply' : '✅ 退避完了');
process.exit(0);
