/**
 * restore-customers-from-export.mjs — 控えから Customers を戻す（**rollback**）
 *
 *   下見: ADMIN_SECRET=... node scripts/restore-customers-from-export.mjs <export.json>
 *   実行: ADMIN_SECRET=... node scripts/restore-customers-from-export.mjs --apply <export.json>
 *
 * ⚠️ 同じアドレスの行が既に在れば作らない（二重作成しない）。
 * ⚠️ recordId は新しく振られる。prospect は hash（アドレス由来）で紐づくため配信に影響しない。
 */
import { readFileSync } from 'node:fs';

const ENDPOINT = 'https://analytics.keiba.link/.netlify/functions/admin-marketing';
const CONFIRM = 'RESTORE CUSTOMERS FROM EXPORT';
const CHUNK = 200;

const SECRET = process.env.ADMIN_SECRET;
if (!SECRET) { console.error('✖ ADMIN_SECRET が要る'); process.exit(1); }
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const FILE = args.find((a) => a !== '--apply');
if (!FILE) { console.error('✖ 控えファイルを渡してください'); process.exit(1); }

const data = JSON.parse(readFileSync(FILE, 'utf8'));
const records = data.records || [];
if (records.length === 0) { console.error('✖ 控えが空'); process.exit(1); }
if (data.count !== undefined && data.count !== records.length) {
  console.error(`✖ 控えの件数が壊れている（count ${data.count} / records ${records.length}）`);
  process.exit(1);
}
console.log(`控え: ${FILE}（${records.length} 件）`);

const call = async (body) => {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-secret': SECRET },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (r.status !== 200 || !j) {
    console.error('✖ HTTP', r.status, JSON.stringify(j || {}).slice(0, 200));
    process.exit(1);
  }
  return j;
};

const t = { created: 0, alreadyPresent: 0, toCreate: 0, failed: 0 };
for (let i = 0; i < records.length; i += CHUNK) {
  const chunk = records.slice(i, i + CHUNK).map((r) => ({ fields: r.fields }));
  const body = { action: 'customerDeletionRestore', records: chunk };
  if (apply) { body.apply = true; body.confirm = CONFIRM; }
  // eslint-disable-next-line no-await-in-loop -- 直列に戻す
  const j = await call(body);
  t.created += j.created || 0;
  t.alreadyPresent += j.alreadyPresent || 0;
  t.toCreate += j.toCreate || 0;
  t.failed += j.failed || 0;
  console.log(`  ${Math.min(i + CHUNK, records.length)}/${records.length} …`);
}
console.log(JSON.stringify(t));
console.log(apply ? '✅ 復元しました' : '\n下見です（1 件も作っていません）。--apply で実行します。');
