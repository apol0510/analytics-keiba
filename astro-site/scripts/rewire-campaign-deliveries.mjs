/**
 * rewire-campaign-deliveries.mjs — 復元後の配信台帳を張り直す（**既定は下見**）
 *
 *   下見: ADMIN_SECRET=... node scripts/rewire-campaign-deliveries.mjs <mapping.json> <export.json>
 *   実行: ADMIN_SECRET=... node scripts/rewire-campaign-deliveries.mjs --apply <mapping.json> <export.json>
 *
 * `mapping.json` … `customerDeletionRestore` が返した `[{oldId,newId}]`
 * `export.json`  … 削除前の控え（`oldId` → アドレスの対応に使う）
 *
 * ## 途中から再開できる
 *
 * 進捗を `<mapping.json>.progress.json` に書く。落ちたら**同じコマンドをもう一度**流せば、
 * 終わったぶんは飛ばして続きから走る。既に新しい id を指している行は
 * `alreadyRewired` として数えるだけなので、**二重実行しても壊れない**。
 *
 * ⚠️ Customers も Redis も触らない。書き換えるのは `CampaignDeliveries.CustomerRecordId` だけ。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ENDPOINT = 'https://analytics.keiba.link/.netlify/functions/admin-marketing';
const CONFIRM = 'REWIRE CAMPAIGN DELIVERIES';
const CHUNK = 100;

const SECRET = process.env.ADMIN_SECRET;
if (!SECRET) { console.error('✖ ADMIN_SECRET が要る'); process.exit(1); }
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const files = args.filter((a) => a !== '--apply');
if (files.length < 2) {
  console.error('✖ 使い方: [--apply] <mapping.json> <export.json>'); process.exit(1);
}
const [MAP_FILE, EXPORT_FILE] = files;
const PROGRESS = `${MAP_FILE}.progress.json`;

const mappingRaw = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
const pairs = Array.isArray(mappingRaw) ? mappingRaw : (mappingRaw.mapping || []);
const exported = JSON.parse(readFileSync(EXPORT_FILE, 'utf8')).records || [];
const emailByOldId = new Map(exported.map((r) => [r.id, String(r.fields?.Email || '')]));

// oldId / newId / email を揃える（アドレスが引けないものは**対象にしない**）
const entries = [];
for (const p of pairs) {
  const email = emailByOldId.get(p.oldId);
  if (!email) { console.error(`⚠️ 控えにアドレスが無い: ${p.oldId} → 対象外`); continue; }
  entries.push({ oldId: p.oldId, newId: p.newId, email });
}
console.log(`対応表: ${entries.length} 件（mapping ${pairs.length} / 控え ${exported.length}）`);
if (entries.length === 0) { console.error('✖ 対象が無い'); process.exit(1); }

let done = 0;
if (existsSync(PROGRESS)) {
  const p = JSON.parse(readFileSync(PROGRESS, 'utf8'));
  done = Number(p.done) || 0;
  console.log(`途中から再開: ${done}/${entries.length} 済み`);
}

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

const t = {
  entries: 0, updates: 0, already: 0, refused: 0, updated: 0, failed: 0,
  oldRefsBefore: 0, oldRefsAfter: 0, newRefsAfter: 0, verifyNg: 0,
};
for (let i = done; i < entries.length; i += CHUNK) {
  const chunk = entries.slice(i, i + CHUNK);
  const body = { action: 'campaignDeliveryRewire', entries: chunk };
  if (apply) { body.apply = true; body.confirm = CONFIRM; }
  // eslint-disable-next-line no-await-in-loop -- 直列に流す（同時に走らせない）
  const j = await call(body);

  t.entries += j.entries || 0;
  t.updates += j.counts?.updates || 0;
  t.already += j.counts?.already || 0;
  t.refused += j.counts?.refused || 0;
  t.updated += j.updated || 0;
  t.failed += j.failed || 0;
  t.oldRefsBefore += j.before?.oldRefs || 0;
  if (j.after) { t.oldRefsAfter += j.after.oldRefs || 0; t.newRefsAfter += j.after.newRefs || 0; }
  if (apply && j.verdict && j.verdict.ok !== true) {
    t.verifyNg += 1;
    console.error(`⚠️ 検算が通らない（${i}〜）: ${(j.verdict.reasons || []).join(', ')}`);
  }
  if ((j.counts?.refused || 0) > 0) {
    console.error(`⚠️ 触らなかった行: ${j.counts.refused}`, JSON.stringify(j.refusedSample || []).slice(0, 200));
  }

  if (apply) writeFileSync(PROGRESS, JSON.stringify({ done: i + chunk.length, at: null }));
  console.log(`  ${Math.min(i + CHUNK, entries.length)}/${entries.length} …`);
}

console.log(`\n${JSON.stringify(t, null, 1)}`);
if (!apply) {
  console.log('\n下見です（1 行も書き換えていません）。実行するには --apply を付けてください。');
  process.exit(0);
}
if (t.verifyNg > 0 || t.failed > 0) {
  console.error('\n✖ 張り替えが完了していない。**rollback 完了扱いにしない**');
  process.exit(1);
}
if (t.oldRefsAfter !== 0) {
  console.error(`\n✖ 古い recordId を指す行が ${t.oldRefsAfter} 件残っている`);
  process.exit(1);
}
console.log('\n✅ 張り替え完了（古い参照 0 / 新しい参照が期待どおり）');
