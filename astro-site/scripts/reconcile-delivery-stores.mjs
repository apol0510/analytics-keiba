#!/usr/bin/env node
/**
 * Airtable `CampaignDeliveries` と Redis の `DeliveryKey` 集合を突合する（**read-only**）。
 *
 * ── なぜ Function ではなくスクリプトか ────────────────────────
 * 14,416 行の全件読み取りは 145 ページ ≒ 30 秒以上かかり、Netlify Function の
 * 26 秒に収まらない。途中で打ち切ると **偽の「一致」** を出して、
 * 切り替え可と誤判定する。運用者の手元で時間制限なく走らせる。
 *
 * ── 判定 ────────────────────────────────────────────────────
 * **件数一致では足りない。** 件数が同じでも中身が違えば二重送信になるので、
 * 集合そのものを比べる。Redis に足りない鍵が 1 つでもあれば切替不可。
 *
 * ── 出力 ────────────────────────────────────────────────────
 * 件数と状態だけ。**DeliveryKey もアドレスも出さない。**
 *
 *   AIRTABLE_API_KEY=... AIRTABLE_BASE_ID=... \
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
 *   node scripts/reconcile-delivery-stores.mjs --campaign=dormant-reactivation --version=2
 *
 * exit: 0=切替可 / 1=切替不可（差分あり）/ 2=片側を読めない / 3=引数不正
 */
import { createDeliveryKeyStore, makeRedisCmd } from '../src/lib/marketing/deliveryKeyStore.js';
import { reconcileDeliveryKeys, RECON_STATUS } from '../src/lib/marketing/deliveryStoreReconcile.js';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const CAMPAIGN = arg('campaign', '');
const VERSION = Number(arg('version', ''));
const BRAND = arg('brand', 'analytics-keiba');
const KEY = process.env.AIRTABLE_API_KEY;
const BASE = process.env.AIRTABLE_BASE_ID;

if (!CAMPAIGN || !Number.isInteger(VERSION)) {
  console.error('使い方: --campaign=<id> --version=<n> [--brand=analytics-keiba]');
  process.exit(3);
}
if (!KEY || !BASE) {
  console.error('AIRTABLE_API_KEY / AIRTABLE_BASE_ID が必要です');
  process.exit(3);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const campaignType = `${CAMPAIGN}:v${VERSION}`;

/**
 * Airtable 側を **打ち切らずに**読む。
 * ⚠️ ここで上限を設けて break すると、少ない集合を「一致」と誤判定する。
 *    ページ数の上限は安全弁としてだけ置き、**到達したら例外**にする。
 */
async function readAirtableKeys() {
  const keys = new Set();
  let off = null;
  let pages = 0;
  const MAX_PAGES = 1000; // 100,000 行ぶん。到達＝異常
  do {
    const u = new URL(`https://api.airtable.com/v0/${BASE}/CampaignDeliveries`);
    u.searchParams.set('pageSize', '100');
    u.searchParams.set(
      'filterByFormula',
      `AND({CampaignType}='${campaignType}', OR({Status}='sent', {Status}='queued'))`,
    );
    u.searchParams.append('fields[]', 'DeliveryKey');
    if (off) u.searchParams.set('offset', off);

    let j = null;
    for (let a = 0; a < 8; a += 1) {
      const res = await fetch(u, { headers: { Authorization: `Bearer ${KEY}` } });
      if (res.status === 429) { await sleep(2000); continue; }
      j = await res.json().catch(() => null);
      if (j && Array.isArray(j.records)) break;
      j = null; await sleep(1200);
    }
    if (!j) throw new Error('airtable_read_failed');

    for (const r of j.records) {
      const k = String(r.fields?.DeliveryKey || '');
      if (k) keys.add(k);
    }
    off = j.offset;
    pages += 1;
    if (off && pages >= MAX_PAGES) throw new Error('airtable_pagination_not_converging');
    await sleep(210);
  } while (off);
  return keys;
}

let airtableKeys = null;
let redisKeys = null;
let airtableError = null;
let redisError = null;

try {
  airtableKeys = await readAirtableKeys();
} catch (e) {
  airtableError = e.message;
}

try {
  const store = createDeliveryKeyStore({ redisCmd: makeRedisCmd(process.env) });
  redisKeys = await store.members({ brand: BRAND, campaignId: CAMPAIGN, version: VERSION });
} catch (e) {
  redisError = e.reason || e.message;
}

const recon = reconcileDeliveryKeys({ airtableKeys, redisKeys });

console.log(`📊 DeliveryKey 突合  ${campaignType}  (brand=${BRAND})`);
console.log(`   Airtable : ${airtableError ? `読み取り失敗 (${airtableError})` : `${recon.airtable} 件`}`);
console.log(`   Redis    : ${redisError ? `読み取り失敗 (${redisError})` : `${recon.redis} 件`}`);
console.log(`   Redis に無い（危険・再送になる）: ${recon.missingInRedis}`);
console.log(`   Redis に余分（安全側）          : ${recon.extraInRedis}`);
console.log(`   判定: ${recon.status}`);
console.log('');

if (recon.status === RECON_STATUS.UNAVAILABLE) {
  console.error('❌ 片側を読めていません。「一致」とは扱いません');
  process.exit(2);
}
if (!recon.safeToSwitch) {
  console.error('❌ 切替不可。Redis に足りない鍵があります（その相手へ再送してしまう）');
  process.exit(1);
}
console.log('✅ 切替可（Redis が Airtable を包含している）');
process.exit(0);
