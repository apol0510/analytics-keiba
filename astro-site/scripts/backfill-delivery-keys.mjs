#!/usr/bin/env node
/**
 * 既存 `CampaignDeliveries` の `DeliveryKey` を Redis の集合へ移す。
 *
 * ── 安全側の性質 ────────────────────────────────────────────
 *  - **打ち切らない**。壊れた応答・ページ上限到達は例外（`completeRead`）
 *  - **冪等**。SADD なので何度流しても集合は同じ。途中で落ちても再実行でよい
 *  - `--dry-run` は 1 バイトも書かない（既定は dry-run）
 *  - ログに DeliveryKey / アドレスの実値を出さない（件数だけ）
 *  - checkpoint はローカルファイル。**Airtable の offset は保存しない**
 *    （期限切れ offset で再開すると取りこぼすため。再開は「全部読み直して冪等で素通り」）
 *
 * ── 使い方 ────────────────────────────────────────────────
 *   AIRTABLE_API_KEY=… AIRTABLE_BASE_ID=… \
 *   UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=… \
 *   node scripts/backfill-delivery-keys.mjs --dry-run
 *   … --apply        実際に書く
 *   … --brand=analytics-keiba
 *
 * exit: 0=成功 / 1=不整合 / 2=読み取り失敗 / 3=設定不足
 */
import {
  requireEnv, parseArgs, makeAirtablePager, makeRedisCmdFromEnv,
  loadCheckpoint, saveCheckpoint, progressLogger,
} from './migrate-lib.mjs';
import { backfillDeliveryKeys } from '../src/lib/migration/backfillRunner.js';
import { isResumable } from '../src/lib/migration/migrationCheckpoint.js';
import { createDeliveryKeyStore } from '../src/lib/marketing/deliveryKeyStore.js';

const JOB = 'delivery-key-backfill';
const { get, has } = parseArgs(process.argv);
const APPLY = has('apply');
const DRY = !APPLY; // **既定は dry-run**。書くには明示的に --apply
const BRAND = get('brand', 'analytics-keiba');

requireEnv(['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID']);
if (APPLY) requireEnv(['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']);

const prev = loadCheckpoint(JOB);
if (prev) {
  const r = isResumable(prev, { job: JOB });
  console.log(`ℹ️  前回の checkpoint: ${r.ok ? '再開可' : `使わない (${r.reason})`}`
    + ` / read=${prev.recordsRead} written=${prev.recordsWritten}`);
  console.log('   ※ 書き込みは冪等なので、常に最初から読み直します（取りこぼし防止）');
}

/** `CampaignType` = `<campaignId>:v<version>` から scope を作る */
function scopeOf(row) {
  const ct = String(row?.fields?.CampaignType || '');
  const m = ct.match(/^([A-Za-z0-9_.-]+):v(\d+)$/);
  if (!m) return null;
  return { brand: BRAND, campaignId: m[1], version: Number(m[2]) };
}
const keyOf = (row) => {
  const k = String(row?.fields?.DeliveryKey || '');
  return /^[a-f0-9]{64}$/.test(k) ? k : null;
};

let store = null;
if (APPLY) store = createDeliveryKeyStore({ redisCmd: makeRedisCmdFromEnv() });

console.log(`🚚 DeliveryKey backfill  mode=${DRY ? 'DRY-RUN（書きません）' : 'APPLY'}  brand=${BRAND}`);

let result;
try {
  result = await backfillDeliveryKeys({
    fetchPage: makeAirtablePager({
      table: 'CampaignDeliveries',
      fields: ['DeliveryKey', 'CampaignType', 'Status'],
      // sent / queued だけが「送った or 送る」。他は冪等性の対象外
      filterByFormula: "OR({Status}='sent', {Status}='queued')",
    }),
    sadd: (scope, keys) => store.markDelivered({ ...scope, keys }),
    scopeOf,
    keyOf,
    dryRun: DRY,
    onProgress: progressLogger('delivery'),
    clock: () => new Date().toISOString(),
  });
} catch (e) {
  console.error(`❌ 中断: ${e.message}`);
  console.error('   書き込みは冪等です。原因を直してもう一度同じコマンドを流してください');
  process.exit(e.name === 'IncompleteReadError' ? 2 : 1);
}

saveCheckpoint(JOB, result.checkpoint);

console.log('');
console.log(`   ページ数     : ${result.pages}`);
console.log(`   読み取り     : ${result.read}`);
console.log(`   投入         : ${result.written}${DRY ? '（dry-run。実際には書いていません）' : ''}`);
console.log(`   skip         : ${result.skipped}（鍵/宛先が読めない行・重複）`);
console.log(`   CSV 内重複   : ${result.duplicates}`);
console.log('');
if (DRY) {
  console.log('✅ dry-run 完了。書き込むには --apply を付けてください');
} else {
  console.log('✅ 投入完了。次は突合してください:');
  console.log('   npm run reconcile:delivery-stores -- --campaign=<id> --version=<n>');
}
process.exit(0);
