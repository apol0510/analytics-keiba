#!/usr/bin/env node
/**
 * Airtable の行を **削除前に復元可能な形で** 書き出す（read-only）。
 *
 * 対象: `CampaignDeliveries` / `EmailEvents` / 完了済み `ScheduledEmails`
 *
 * ── 復元可能とは ────────────────────────────────────────────
 * recordId と**全フィールドをそのまま** NDJSON に落とす。行を作り直せる。
 * 退避後の集計（件数・SHA-256）も同じディレクトリへ残し、
 * 「消す前に確かに全部取れていた」を後から示せるようにする。
 *
 * ⚠️ **このファイルは PII を含む**（アドレス・氏名）。運用者のローカルに置き、
 *    repo へコミットしない。出力先の既定は `.migration-export/`（.gitignore 済み）。
 * ⚠️ 退避しただけでは消してよいことにならない。突合が PASS してから削除する。
 *
 *   node scripts/export-airtable-tables.mjs --out=.migration-export
 *   … --table=EmailEvents        個別に出す
 *
 * exit: 0=成功 / 2=読み取り失敗 / 3=設定不足
 */
import fs from 'node:fs';
import path from 'node:path';
import { requireEnv, parseArgs, makeAirtablePager, sha256 } from './migrate-lib.mjs';
import { readAllPages } from '../src/lib/migration/completeRead.js';

const { get } = parseArgs(process.argv);
const OUT = get('out', '.migration-export');
const ONLY = get('table', '');

requireEnv(['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID']);

/** 完了済みジョブだけ（実行中は消さない） */
const TARGETS = [
  { table: 'CampaignDeliveries', filterByFormula: null },
  { table: 'EmailEvents', filterByFormula: null },
  { table: 'ScheduledEmails', filterByFormula: "OR({Status}='SENT', {Status}='FAILED', {Status}='CANCELLED')" },
];

fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
const manifest = { exportedAt: new Date().toISOString(), tables: {} };

for (const t of TARGETS) {
  if (ONLY && t.table !== ONLY) continue;
  const file = path.join(OUT, `${t.table}-${stamp}.ndjson`);
  const fd = fs.openSync(file, 'w');
  let count = 0;
  const hash = [];

  try {
    const r = await readAllPages({
      table: t.table,
      // フィールドを絞らない = **そのまま復元できる**
      fetchPage: makeAirtablePager({ table: t.table, filterByFormula: t.filterByFormula }),
      onPage: (records) => {
        for (const rec of records) {
          const line = `${JSON.stringify({ id: rec.id, createdTime: rec.createdTime, fields: rec.fields })}\n`;
          fs.writeSync(fd, line);
          hash.push(sha256(line));
          count += 1;
        }
        process.stderr.write(`   ${t.table}: ${count} 件\r`);
      },
    });
    fs.closeSync(fd);
    const digest = sha256(hash.join(''));
    manifest.tables[t.table] = {
      file: path.basename(file), records: count, pages: r.pages, digest,
      filterByFormula: t.filterByFormula,
    };
    console.log(`✅ ${t.table.padEnd(22)} ${String(count).padStart(7)} 件  → ${path.basename(file)}`);
  } catch (e) {
    fs.closeSync(fd);
    console.error(`❌ ${t.table}: ${e.message}`);
    console.error('   途中のファイルは不完全です。削除して取り直してください');
    process.exit(e.name === 'IncompleteReadError' ? 2 : 1);
  }
}

const manifestPath = path.join(OUT, `manifest-${stamp}.json`);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
console.log('');
console.log(`📄 manifest: ${manifestPath}`);
console.log('⚠️  出力には PII が含まれます。repo へコミットしないでください');
console.log('⚠️  退避しただけでは消してよいことになりません。突合の PASS が先です');
process.exit(0);
