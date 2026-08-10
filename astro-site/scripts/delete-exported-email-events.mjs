#!/usr/bin/env node
/**
 * `EmailEvents` の行を Airtable から削除する（**export 済み・Blob 退避済みのものだけ**）。
 *
 * ── 消してよい条件（**すべて満たしたものだけ消す**）────────────
 *  1. 削除前 export の NDJSON に recordId と全フィールドが入っている（復元できる）
 *  2. その `EventKey` が Blob 側の索引に**存在する**（監査記録が残る）
 *  3. `MARKETING_EVENT_SINK=blob`（Airtable へ新規追記が止まっている）
 *
 * ── 安全側の性質 ────────────────────────────────────────────
 *  - **既定は dry-run**。消すには `--apply` を明示する
 *  - **export に載っている recordId しか消さない**。export 後に増えた行は触らない
 *  - Blob に無い `EventKey` は **1 件でもあれば全体を中止**（部分削除しない）
 *  - 途中で落ちても、残りをもう一度流せばよい（消えた分は 404 で読み飛ばす）
 *  - 進捗をファイルへ残し、再開時に済んだ分を飛ばす
 *  - ログに PII を出さない（件数と recordId のみ。recordId は PII ではない）
 *
 * ⚠️ **元に戻せない操作**。export を確認してから実行すること。
 *
 *   node scripts/delete-exported-email-events.mjs --export=<path> --dry-run
 *   node scripts/delete-exported-email-events.mjs --export=<path> --apply
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = args.includes('--apply');
const DRY = !APPLY;
const EXPORT = arg('export', '');
const STATE = arg('state', '.migration-export/delete-emailevents-progress.json');
const BATCH = 10; // Airtable の 1 リクエスト上限

const KEY = process.env.AIRTABLE_API_KEY;
const BASE = process.env.AIRTABLE_BASE_ID;
const SEC = process.env.ADMIN_SECRET;
const SITE = process.env.SITE_URL || 'https://analytics.keiba.link';

if (!KEY || !BASE) { console.error('❌ AIRTABLE_API_KEY / AIRTABLE_BASE_ID が必要です'); process.exit(3); }
if (!SEC) { console.error('❌ ADMIN_SECRET が必要です（Blob 照合に使う）'); process.exit(3); }
if (!EXPORT || !fs.existsSync(EXPORT)) { console.error('❌ --export=<path> が必要です'); process.exit(3); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. export を読む ────────────────────────────────────────
const rows = [];
for (const line of fs.readFileSync(EXPORT, 'utf8').trim().split('\n')) {
  let o = null;
  try { o = JSON.parse(line); } catch { console.error('❌ export にパースできない行がある'); process.exit(1); }
  const id = String(o.id || '');
  const key = String((o.fields || {}).EventKey || '');
  if (!/^rec[A-Za-z0-9]{10,}$/.test(id)) { console.error('❌ export に recordId の無い行がある'); process.exit(1); }
  if (!key) { console.error('❌ export に EventKey の無い行がある'); process.exit(1); }
  rows.push({ id, key });
}
console.log(`📄 export: ${rows.length} 件（recordId 一意 ${new Set(rows.map((r) => r.id)).size}）`);

// ── 2. 送信モードの確認（Airtable へ追記が止まっているか）────
{
  const res = await fetch(`${SITE}/.netlify/functions/admin-migration-job`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': SEC },
    body: JSON.stringify({ action: 'status', jobType: 'email-events' }),
  });
  const j = await res.json().catch(() => null);
  const sink = (j && j.eventSink) || {};
  if (!sink.mode_blob) {
    console.error('❌ blob モードでの受信実績がありません（Airtable へ追記が続いている可能性）');
    process.exit(1);
  }
  console.log(`🔎 sink: mode_blob=${sink.mode_blob} blob_ok=${sink.blob_ok} airtable_skipped=${sink.airtable_skipped || 0}`);
}

// ── 3. **全件が Blob にあるか**を先に確認（1 件でも欠けたら中止）──
{
  let checked = 0; let missing = 0;
  const keys = rows.map((r) => r.key);
  for (let i = 0; i < keys.length; i += 500) {
    const res = await fetch(`${SITE}/.netlify/functions/admin-migration-job`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-secret': SEC },
      body: JSON.stringify({ action: 'verifyEvents', jobType: 'email-events', keys: keys.slice(i, i + 500) }),
    });
    const j = await res.json().catch(() => null);
    if (res.status !== 200 || !j) { console.error(`❌ Blob 照合に失敗 (${res.status})`); process.exit(1); }
    checked += j.checked; missing += j.missing;
    process.stderr.write(`   Blob 照合 ${checked}/${keys.length}\r`);
  }
  console.log(`\n🔎 Blob 照合: ${checked} 件 / 欠け ${missing}`);
  if (missing > 0) {
    console.error('❌ Blob に無い EventKey があります。**1 件も削除しません**');
    process.exit(1);
  }
}

if (DRY) {
  console.log('');
  console.log(`✅ dry-run: ${rows.length} 件が削除条件を満たしています（実際には消していません）`);
  console.log('   消すには --apply を付けてください');
  process.exit(0);
}

// ── 4. 削除 ─────────────────────────────────────────────────
const done = new Set();
if (fs.existsSync(STATE)) {
  try { for (const id of JSON.parse(fs.readFileSync(STATE, 'utf8')).deleted || []) done.add(id); } catch { /* 壊れていたら最初から */ }
}
const remaining = rows.filter((r) => !done.has(r.id));
console.log(`🗑️  削除開始: ${remaining.length} 件（済み ${done.size} 件は飛ばす）`);

let deleted = 0; let notFound = 0; let failed = 0;
for (let i = 0; i < remaining.length; i += BATCH) {
  const batch = remaining.slice(i, i + BATCH);
  const u = new URL(`https://api.airtable.com/v0/${BASE}/EmailEvents`);
  for (const r of batch) u.searchParams.append('records[]', r.id);

  let ok = false;
  for (let a = 0; a < 6; a += 1) {
    const res = await fetch(u, { method: 'DELETE', headers: { Authorization: `Bearer ${KEY}` } });
    if (res.status === 429) { await sleep(2000); continue; }
    const j = await res.json().catch(() => null);
    if (res.ok && j && Array.isArray(j.records)) {
      deleted += j.records.filter((x) => x.deleted).length;
      for (const r of batch) done.add(r.id);
      ok = true;
      break;
    }
    // 既に消えている行が混ざると 404 になる。1 件ずつ試して切り分ける
    if (res.status === 404) {
      for (const r of batch) {
        const one = await fetch(`https://api.airtable.com/v0/${BASE}/EmailEvents/${r.id}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${KEY}` },
        });
        if (one.ok) deleted += 1; else notFound += 1;
        done.add(r.id);
        await sleep(120);
      }
      ok = true;
      break;
    }
    await sleep(1000);
  }
  if (!ok) { failed += batch.length; console.error(`\n⚠️ バッチ失敗（${batch.length} 件）。続行`); }

  if ((i / BATCH) % 20 === 0) {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify({ deleted: [...done] }));
    process.stderr.write(`   削除 ${deleted} / 済み ${done.size} / ${rows.length}\r`);
  }
  await sleep(120);
}

fs.mkdirSync(path.dirname(STATE), { recursive: true });
fs.writeFileSync(STATE, JSON.stringify({ deleted: [...done] }));

console.log('');
console.log(`   削除: ${deleted} 件 / 既に無し: ${notFound} 件 / 失敗: ${failed} 件`);
console.log(failed === 0 ? '✅ 完了' : '⚠️ 失敗が残っています。もう一度流してください（済みは飛ばします）');
process.exit(failed === 0 ? 0 : 1);
