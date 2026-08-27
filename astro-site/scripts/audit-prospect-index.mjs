/**
 * audit-prospect-index.mjs — 投入したはずの hash が**索引に居るか**を突き合わせる（read-only）
 *
 *   ADMIN_SECRET=... node scripts/audit-prospect-index.mjs <hashes.json>
 *
 * `<hashes.json>` は **hash の配列**、または `{prospects:[{hash}]}` 形式。
 * ⚠️ **アドレスは読み込まないし送らない**（hash だけ取り出して捨てる）。
 *
 * ## なぜ要るか
 *
 * `verify-prospect-migration.mjs` は**索引に居る人しか見ない**ので、
 * 索引から丸ごと欠けている人を検出できない。2026-08-27 の本番検証で
 * `indexSize = 11,975`（投入 11,976）となり 1 件足りなかった原因を特定するために使う。
 *
 * 読み取りだけ。Redis も Airtable も 1 バイトも書かない。
 */
import { readFileSync } from 'node:fs';
import { normalizeHashes } from '../src/lib/marketing/prospectIndexAudit.js';

const ENDPOINT = 'https://analytics.keiba.link/.netlify/functions/admin-marketing';
const CHUNK = 6000;

const SECRET = process.env.ADMIN_SECRET;
if (!SECRET) { console.error('✖ ADMIN_SECRET が要る'); process.exit(1); }
const FILE = process.argv[2];
if (!FILE) { console.error('✖ 使い方: node scripts/audit-prospect-index.mjs <hashes.json>'); process.exit(1); }

const raw = JSON.parse(readFileSync(FILE, 'utf8'));
const source = Array.isArray(raw) ? raw : (raw.prospects || raw.hashes || []);
// ⚠️ hash だけ取り出す（アドレスはここで捨てる）
const hashes = normalizeHashes(source.map((x) => (typeof x === 'string' ? x : x && x.hash)));
if (hashes.length === 0) { console.error('✖ hash が 1 件も取れなかった'); process.exit(1); }
console.log(`期待一覧: ${hashes.length} 件（hash のみ・アドレスは送らない）`);

const call = (body) => fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-admin-secret': SECRET },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const totals = {
  checked: 0, active: 0, engaged: 0, blocked: 0, nowhere: 0,
};
const details = [];
let indexSizes = null;

for (let i = 0; i < hashes.length; i += CHUNK) {
  const chunk = hashes.slice(i, i + CHUNK);
  // eslint-disable-next-line no-await-in-loop -- 分割して直列に問い合わせる
  const r = await call({ action: 'prospectIndexAudit', hashes: chunk });
  if (r.status !== 200 || !r.json) {
    console.error('✖ HTTP', r.status, JSON.stringify(r.json || {}).slice(0, 300));
    process.exit(1);
  }
  const j = r.json;
  if (JSON.stringify(j).includes('@')) { console.error('✖ 応答にアドレスが混ざっている'); process.exit(1); }
  totals.checked += j.checked;
  for (const k of ['active', 'engaged', 'blocked', 'nowhere']) totals[k] += j.counts[k];
  details.push(...j.details);
  indexSizes = j.indexSizes;
}

console.log(JSON.stringify({ totals, indexSizes }, null, 1));

const nowhere = details.filter((d) => d.place === 'nowhere');
const other = details.filter((d) => d.place !== 'nowhere');

if (other.length) {
  console.log(`\n送信候補ではないが索引には居る: ${other.length} 件`);
  for (const d of other.slice(0, 20)) {
    console.log(` ・${d.hash.slice(0, 12)}… place=${d.place} ${JSON.stringify(d.record || {})}`);
  }
}

if (nowhere.length === 0) {
  console.log('\n✅ どの索引にも居ない hash は 0 件');
  process.exit(0);
}

console.log(`\n⚠️ どの索引にも居ない hash: ${nowhere.length} 件`);
for (const d of nowhere) {
  console.log(` ・${d.hash} hasRecord=${d.hasRecord} ${JSON.stringify(d.record || {})}`);
}
console.error('\n✖ 索引から欠けている hash がある。Customers は削除できない。');
process.exit(1);
