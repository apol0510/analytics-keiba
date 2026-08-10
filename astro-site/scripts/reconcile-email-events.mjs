#!/usr/bin/env node
/**
 * Airtable `EmailEvents` と Blob 退避分を突合する（**read-only**）。
 *
 * **件数だけ一致で PASS にしない。** `EventKey` の集合そのものを比べたうえで、
 * 種別ごとの件数も併せて見る（集合が合っていても種別が壊れていれば気づける）。
 *
 * Blob 側は list で全 NDJSON を舐める。**読むだけで書き戻さない。**
 *
 *   node scripts/reconcile-email-events.mjs
 *   … --store=ak-email-events
 *
 * exit: 0=切替可 / 1=切替不可 / 2=片側を読めない / 3=設定不足
 */
import { requireEnv, parseArgs, makeAirtablePager } from './migrate-lib.mjs';
import { readAllPages } from '../src/lib/migration/completeRead.js';
import { reconcileEventKeys, RECON_STATUS } from '../src/lib/marketing/deliveryStoreReconcile.js';

const { get } = parseArgs(process.argv);
const STORE_NAME = get('store', 'ak-email-events');
requireEnv(['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID']);

// ── Airtable 側 ─────────────────────────────────────────────────
let airtableKeys = null;
let airtableCounts = null;
try {
  const keys = new Set();
  const counts = {};
  await readAllPages({
    table: 'EmailEvents',
    fetchPage: makeAirtablePager({ table: 'EmailEvents', fields: ['EventKey', 'EventType'] }),
    onPage: (records) => {
      for (const r of records) {
        const k = String(r.fields?.EventKey || '');
        if (k) keys.add(k);
        const t = String(r.fields?.EventType || '');
        if (t) counts[t] = (counts[t] || 0) + 1;
      }
      process.stderr.write(`   Airtable: ${keys.size} 件\r`);
    },
  });
  airtableKeys = keys;
  airtableCounts = counts;
} catch (e) {
  console.error(`   Airtable 読み取り失敗: ${e.message}`);
}

// ── Blob 側 ─────────────────────────────────────────────────────
let blobKeys = null;
let blobCounts = null;
try {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN;
  if (!siteID || !token) throw new Error('netlify_blobs_not_configured');
  const store = getStore({ name: STORE_NAME, siteID, token });

  const keys = new Set();
  const counts = {};
  const { blobs } = await store.list({ prefix: 'ak/email-events/' });
  for (const b of blobs || []) {
    const body = await store.get(b.key); // ⚠️ 読むだけ。書き戻さない
    if (!body) continue;
    for (const line of String(body).split('\n')) {
      if (!line.trim()) continue;
      let o = null;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.eventKey) keys.add(o.eventKey);
      if (o.eventType) counts[o.eventType] = (counts[o.eventType] || 0) + 1;
    }
    process.stderr.write(`   Blob: ${keys.size} 件\r`);
  }
  blobKeys = keys;
  blobCounts = counts;
} catch (e) {
  console.error(`   Blob 読み取り失敗: ${e.message}`);
}

const recon = reconcileEventKeys({ airtableKeys, blobKeys, airtableCounts, blobCounts });

console.log('📊 EmailEvents 突合');
console.log(`   Airtable EventKey : ${airtableKeys ? recon.airtable : '読めず'}`);
console.log(`   Blob     EventKey : ${blobKeys ? recon.blob : '読めず'}`);
console.log(`   Blob に無い（危険）: ${recon.missingInBlob}`);
console.log(`   Blob に余分       : ${recon.extraInBlob}`);
console.log('   種別ごとの件数:');
for (const [t, v] of Object.entries(recon.counts.byType || {})) {
  const mark = v.diff === 0 ? '✅' : (v.diff < 0 ? '❌ 不足' : '⚠️ 余分');
  console.log(`     ${t.padEnd(14)} Airtable ${String(v.airtable).padStart(7)} / Blob ${String(v.blob).padStart(7)}  ${mark}`);
}
console.log(`   判定: ${recon.status} / counts=${recon.counts.status}`);
console.log('');

if (recon.status === RECON_STATUS.UNAVAILABLE || recon.counts.status === RECON_STATUS.UNAVAILABLE) {
  console.error('❌ 片側を読めていません。「一致」とは扱いません');
  process.exit(2);
}
if (!recon.safeToSwitch) {
  console.error('❌ 切替不可。Blob 側に欠けがあります（監査記録が失われる）');
  process.exit(1);
}
console.log('✅ 切替可（Blob が Airtable を包含し、種別件数も一致）');
process.exit(0);
