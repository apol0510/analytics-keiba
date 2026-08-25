/**
 * normalizeLegacySanrenpuku.mjs — 旧三連複会員を Light 永久無料へ正規化する（運用スクリプト）
 *
 * 仕様の正本: docs/spec.md §旧三連複会員は Light 永久無料として再スタートする。
 * 書き込む値の正本: src/lib/entitlements/legacySanrenpukuNormalization.js（純粋関数）。
 * **このスクリプトは値を決めない。** 決めるのは上の純粋関数で、ここは I/O だけを担う。
 *
 * ## 使い方
 *
 *   # 下見（既定。**書き込まない**）
 *   AIRTABLE_API_KEY=… AIRTABLE_BASE_ID=… node scripts/normalizeLegacySanrenpuku.mjs
 *
 *   # 実行（**二重ゲート**。両方そろわないと 1 件も書かない）
 *   … node scripts/normalizeLegacySanrenpuku.mjs --apply --confirm "NORMALIZE <件数>"
 *
 *   # 巻き戻し（保存した rollback ファイルから変更前の値を書き戻す）
 *   … node scripts/normalizeLegacySanrenpuku.mjs --rollback <path> --apply --confirm "ROLLBACK <件数>"
 *
 * ## 安全装置
 *
 * - 既定は dry-run。`--apply` と確認文字列の**両方**が要る
 * - 確認文字列の件数が実際の対象数と違えば中止（対象が変わったのに実行する事故を防ぐ）
 * - 対象判定は純粋関数の `isNormalizationTarget`（買い切り保有・期限内・停止アカウントは弾く）
 * - **変更前の値を必ずファイルへ保存してから**書き込む（rollback の材料）
 * - 1 件ずつ PATCH し、失敗したらその時点で停止する（残りは手つかず）
 * - **アドレス・氏名は出力しない**（recordId と件数だけ）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  buildLegacySanrenpukuNormalization, isNormalizationTarget, LEGACY_SANRENPUKU_PLANS,
} from '../src/lib/entitlements/legacySanrenpukuNormalization.js';

const API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE = 'Customers';
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const APPLY = has('--apply');
const CONFIRM = val('--confirm');
const ROLLBACK_FILE = val('--rollback');
const OUT = val('--out') || `${process.env.HOME}/.analytics-keiba-ops/sanrenpuku-lifetime-grant`;
const OPERATION_ID = val('--operation-id') || `legacy-srp-to-light-${new Date().toISOString().slice(0, 10)}`;

function die(msg) { console.error(`✖ ${msg}`); process.exit(1); }
if (!API_KEY || !BASE_ID) die('AIRTABLE_API_KEY / AIRTABLE_BASE_ID が要る');

const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

async function listTargets() {
  const formula = `OR(${LEGACY_SANRENPUKU_PLANS.map((p) => `{プラン}='${p}'`).join(',')})`;
  const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLE}`);
  url.searchParams.set('filterByFormula', formula);
  url.searchParams.set('pageSize', '100');
  const out = [];
  let offset;
  do {
    if (offset) url.searchParams.set('offset', offset); else url.searchParams.delete('offset');
    const res = await fetch(url, { headers });
    if (!res.ok) die(`一覧の取得に失敗: ${res.status}`);
    const json = await res.json();
    out.push(...json.records);
    offset = json.offset;
  } while (offset);
  return out;
}

async function patch(recordId, fields) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLE}/${recordId}`, {
    method: 'PATCH', headers, body: JSON.stringify({ fields }),
  });
  if (!res.ok) die(`${recordId} の更新に失敗: ${res.status} ${await res.text()}`);
}

async function main() {
  const now = Date.now();

  // ── 巻き戻し ───────────────────────────────────────────────
  if (ROLLBACK_FILE) {
    const plan = JSON.parse(readFileSync(ROLLBACK_FILE, 'utf8'));
    console.log(`巻き戻し対象: ${plan.length} 件`);
    for (const p of plan) console.log(`  ${p.id}  ${Object.keys(p.restore).length} 列`);
    if (!APPLY) return console.log('\n下見のみ。実行するには --apply と --confirm が要る');
    if (CONFIRM !== `ROLLBACK ${plan.length}`) die(`確認文字列が違う（期待: "ROLLBACK ${plan.length}"）`);
    let n = 0;
    for (const p of plan) { await patch(p.id, p.restore); n += 1; console.log(`  ✓ ${p.id}`); }
    return console.log(`\n巻き戻し完了: ${n} 件`);
  }

  // ── 正規化 ─────────────────────────────────────────────────
  const records = await listTargets();
  const plan = [];
  const skipped = [];
  for (const r of records) {
    const t = isNormalizationTarget(r.fields, now);
    if (!t.ok) { skipped.push({ id: r.id, reason: t.reason }); continue; }
    const built = buildLegacySanrenpukuNormalization({
      fields: r.fields, now, operationId: `${OPERATION_ID}-${r.id}`, actor: 'admin',
    });
    if (!built || built.skipped) { skipped.push({ id: r.id, reason: built?.skipped || 'build_failed' }); continue; }
    plan.push({ id: r.id, fields: built.fields, changes: built.changes });
  }

  console.log(`旧プラン名のレコード: ${records.length} 件`);
  console.log(`正規化の対象: ${plan.length} 件 / 対象外: ${skipped.length} 件`);
  for (const s of skipped) console.log(`  - 対象外 ${s.id}: ${s.reason}`);
  console.log('\n変更前 → 変更後');
  for (const p of plan) {
    console.log(`  ${p.id}  (${p.changes.length} 列)`);
    for (const c of p.changes) {
      console.log(`      ${c.field}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);
    }
  }

  const rollback = plan.map((p) => ({ id: p.id, restore: Object.fromEntries(p.changes.map((c) => [c.field, c.before])) }));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rollbackPath = `${OUT}/rollback-${stamp}.json`;
  writeFileSync(rollbackPath, JSON.stringify(rollback, null, 1));
  console.log(`\n変更前の値を保存: ${rollbackPath}`);

  if (!APPLY) {
    console.log('\n下見のみ。**1 件も書いていない**。');
    console.log(`実行するには: --apply --confirm "NORMALIZE ${plan.length}"`);
    return;
  }
  if (CONFIRM !== `NORMALIZE ${plan.length}`) die(`確認文字列が違う（期待: "NORMALIZE ${plan.length}"）`);

  let n = 0;
  for (const p of plan) { await patch(p.id, p.fields); n += 1; console.log(`  ✓ ${p.id}`); }
  console.log(`\n正規化完了: ${n} 件 / 巻き戻しファイル: ${rollbackPath}`);
}

main().catch((e) => die(e.message));
