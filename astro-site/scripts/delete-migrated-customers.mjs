/**
 * delete-migrated-customers.mjs — 移行済み Customers を消す（**既定は下見**）
 *
 *   下見（**書かない**）:
 *     ADMIN_SECRET=... node scripts/delete-migrated-customers.mjs
 *   実行（**承認を得てから**）:
 *     ADMIN_SECRET=... node scripts/delete-migrated-customers.mjs --apply
 *
 * ## 手順（この順でしか進まない）
 *
 *   1. 全ページを走査して**いまの live 状態から**削除対象を数える
 *   2. 対象の**全フィールドを控える**（`--out` / 既定 `~/.analytics-keiba-ops/prospect-migration/`）
 *   3. 控えが保存できて初めて削除へ進む（`--apply` のとき）
 *   4. 200 件ずつ、**サーバ側で判定を作り直して**消す
 *
 * ⚠️ 控えファイルには**アドレスが入る**。リポジトリへ置かない・ログへ出さない。
 * ⚠️ 削除は元に戻せない。rollback は控えファイルからの再作成（`--rollback`）。
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENDPOINT = 'https://analytics.keiba.link/.netlify/functions/admin-marketing';
const CONFIRM = 'DELETE MIGRATED CUSTOMERS';
const CHUNK = 200;
const MAX_PAGES = 400;

const SECRET = process.env.ADMIN_SECRET;
if (!SECRET) { console.error('✖ ADMIN_SECRET が要る'); process.exit(1); }

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const outArg = args.indexOf('--out');
const OUT_DIR = outArg >= 0 ? args[outArg + 1]
  : join(homedir(), '.analytics-keiba-ops', 'prospect-migration');

const call = async (body) => {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-secret': SECRET },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => null);
  if (r.status !== 200 || !j) {
    console.error('✖ HTTP', r.status, JSON.stringify(j || {}).slice(0, 300));
    process.exit(1);
  }
  return j;
};

const sum = (a, b) => { for (const [k, v] of Object.entries(b || {})) a[k] = (a[k] || 0) + v; return a; };

/* ── 1) いまの live 状態から数え直す ─────────────────────── */
const totals = { checked: 0, deletable: 0, blocked: {}, decisions: {} };
const ids = [];
const exportRows = [];
let offset;
let pages = 0;

for (let i = 0; i < MAX_PAGES; i += 1) {
  const body = { action: 'customerDeletionPlan', withExport: true };
  if (offset) body.offset = offset;
  // eslint-disable-next-line no-await-in-loop -- 次ページは前ページの応答に依存する
  const j = await call(body);
  if (j.ok === false) {
    console.error(`✖ 判定の材料が読めない（${j.abort}）。**1 件も消せない**`);
    process.exit(1);
  }
  pages += 1;
  totals.checked += j.checked;
  totals.deletable += j.deletable;
  sum(totals.blocked, j.blocked);
  sum(totals.decisions, j.decisions);
  ids.push(...j.deletableIds);
  exportRows.push(...(j.export || []));
  offset = j.page.nextOffset;
  if (!offset) break;
}
if (offset) { console.error(`✖ ${MAX_PAGES} ページで読み切れなかった。**中止**`); process.exit(1); }

const uniqueIds = [...new Set(ids)];
if (uniqueIds.length !== ids.length) { console.error('✖ recordId が重複している。中止'); process.exit(1); }
if (exportRows.length !== uniqueIds.length) {
  console.error(`✖ 控えの件数(${exportRows.length}) と対象(${uniqueIds.length}) が合わない。中止`);
  process.exit(1);
}

console.log(JSON.stringify({
  pages, checked: totals.checked, deletable: uniqueIds.length,
  blocked: totals.blocked, decisions: totals.decisions,
}, null, 1));

/* ── 2) 控えを保存する（消す前に必ず）───────────────────── */
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
const payload = JSON.stringify({ table: 'Customers', count: exportRows.length, records: exportRows });
const digest = createHash('sha256').update(payload).digest('hex').slice(0, 16);
const OUT = join(OUT_DIR, `customers-delete-export-${digest}.json`);
writeFileSync(OUT, payload, { mode: 0o600 });
const back = JSON.parse(readFileSync(OUT, 'utf8'));
if (back.count !== exportRows.length || back.records.length !== exportRows.length) {
  console.error('✖ 控えを読み戻せなかった。**消さない**'); process.exit(1);
}
console.log(`\n控え: ${OUT}（${back.count} 件 / digest ${digest} / 読み戻し確認済み）`);

if (!apply) {
  console.log('\n下見です（1 件も消していません）。実行するには --apply を付けてください。');
  process.exit(0);
}

/* ── 3) 実削除（200 件ずつ・サーバ側で判定を作り直す）──── */
const res = { deleted: 0, alreadyDeleted: 0, refused: 0, failed: 0 };
for (let i = 0; i < uniqueIds.length; i += CHUNK) {
  const chunk = uniqueIds.slice(i, i + CHUNK);
  // eslint-disable-next-line no-await-in-loop -- 直列に消す（同時に走らせない）
  const j = await call({
    action: 'customerDeletionApply', recordIds: chunk,
    apply: true, confirm: CONFIRM, exportSaved: true,
  });
  res.deleted += j.deleted || 0;
  res.alreadyDeleted += j.alreadyDeleted || 0;
  res.refused += j.refused || 0;
  res.failed += j.failed || 0;
  if (j.refused > 0) console.error(`⚠️ 状態が変わって消さなかった: ${j.refused} 件`, j.refusedIds);
  console.log(`  ${Math.min(i + CHUNK, uniqueIds.length)}/${uniqueIds.length} …`);
}
console.log(`\n${JSON.stringify(res)}`);
console.log(`✅ 削除しました。復元は: node scripts/restore-customers-from-export.mjs ${OUT}`);
