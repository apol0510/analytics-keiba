/**
 * verify-after-customer-deletion.mjs — 削除の前後で **Redis と配信の続きが変わっていない**ことを確かめる
 *
 *   基準を保存: ADMIN_SECRET=... node scripts/verify-after-customer-deletion.mjs --save <baseline.json>
 *   照合:       ADMIN_SECRET=... node scripts/verify-after-customer-deletion.mjs --compare <baseline.json>
 *
 * Customers を消しても、**prospect プールと 8/31 の配信結果は 1 も動いてはいけない**
 * （消すのは移し終わった重複行なので、動いたら移行が壊れている）。
 *
 * 読み取りだけ。Redis も Airtable も 1 バイトも書かない。
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { buildProspectVerificationVerdict } from '../src/lib/marketing/prospectVerification.js';

const ENDPOINT = 'https://analytics.keiba.link/.netlify/functions/admin-marketing';
const CAMPAIGN = 'campaign-discount-free';
const AT = '2026-08-31T09:00:00+09:00';
const LIMIT = 2000;

const SECRET = process.env.ADMIN_SECRET;
if (!SECRET) { console.error('✖ ADMIN_SECRET が要る'); process.exit(1); }
const args = process.argv.slice(2);
const save = args.includes('--save');
const compare = args.includes('--compare');
const FILE = args.find((a) => !a.startsWith('--'));
if ((!save && !compare) || !FILE) {
  console.error('✖ 使い方: --save <file> / --compare <file>');
  process.exit(1);
}

const call = async (body) => {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-secret': SECRET },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (r.status !== 200 || !j) {
    console.error('✖ HTTP', r.status, JSON.stringify(j || {}).slice(0, 200)); process.exit(1);
  }
  return j;
};
const sum = (a, b) => { for (const [k, v] of Object.entries(b || {})) a[k] = (a[k] || 0) + v; return a; };

const windows = [];
const snap = {
  indexSize: null, returned: 0, atDue: 0, atDueByStep: {}, atStopped: 0,
  nowDue: 0, nowStopped: 0, deliveredHist: {}, pool: null, digest: null,
};
let offset = 0; let digest = null;
for (let i = 0; i < 40; i += 1) {
  const body = {
    action: 'prospectSequenceCheck', campaignId: CAMPAIGN, at: AT, offset, limit: LIMIT,
  };
  if (digest) body.digest = digest;
  // eslint-disable-next-line no-await-in-loop -- 窓は前の応答に依存する
  const j = await call(body);
  digest = digest || j.window.digest;
  windows.push({
    offset: j.window.offset, scanned: j.window.scanned, returned: j.window.returned,
    missing: j.window.missing ?? 0, indexSize: j.window.indexSize, digest: j.window.digest, ok: true,
  });
  snap.indexSize = j.window.indexSize;
  snap.returned += j.window.returned;
  snap.pool = j.pool;
  snap.digest = j.window.digest;
  if (j.now) { snap.nowDue += j.now.due; snap.nowStopped += j.now.stopped; }
  if (j.at && j.at.summary) {
    snap.atDue += j.at.summary.due; snap.atStopped += j.at.summary.stopped;
    sum(snap.atDueByStep, j.at.summary.dueByStep);
  }
  sum(snap.deliveredHist, j.delivered.histogram);
  offset = j.window.nextOffset;
  if (offset === null || offset === undefined) break;
}

const verdict = buildProspectVerificationVerdict({ windows });
const out = { snap, verdict };
console.log(JSON.stringify(out, null, 1));

if (!verdict.customersDeletionAllowed) {
  console.error(`✖ 索引の検証が通らない: ${verdict.reasons.join(', ')}`);
  process.exit(1);
}

if (save) {
  writeFileSync(FILE, JSON.stringify(out, null, 1));
  console.log(`\n✅ 基準を保存: ${FILE}`);
  process.exit(0);
}

const base = JSON.parse(readFileSync(FILE, 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const diffs = [];
for (const k of ['indexSize', 'returned', 'atDue', 'atStopped', 'nowDue', 'nowStopped', 'digest']) {
  if (!same(base.snap[k], snap[k])) diffs.push(`${k}: ${JSON.stringify(base.snap[k])} → ${JSON.stringify(snap[k])}`);
}
for (const k of ['atDueByStep', 'deliveredHist', 'pool']) {
  if (!same(base.snap[k], snap[k])) diffs.push(`${k}: ${JSON.stringify(base.snap[k])} → ${JSON.stringify(snap[k])}`);
}
if (diffs.length === 0) {
  console.log('\n✅ 削除の前後で prospect プールも 8/31 の配信結果も**変わっていない**');
  process.exit(0);
}
console.error('\n✖ 削除の前後で値が動いた（移行が壊れている疑い）:');
for (const d of diffs) console.error(' ・' + d);
process.exit(1);
