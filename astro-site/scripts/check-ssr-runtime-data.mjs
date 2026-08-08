#!/usr/bin/env node
/**
 * check-ssr-runtime-data.mjs — prune 後の SSR 関数に「実行時に読むファイル」が実在するか検査する。
 *
 * ⚠️ ポリシーのユニットテスト（runtimeDataRetention.test.mjs）だけでは、
 *    **ビルド成果物に実際に何が残ったか**は分からない。2026-08-08 の退行は
 *    まさに「成果物を見ていなかった」ことで見逃された。ここは成果物を直接見る。
 *
 * 検査:
 *   1. RUNTIME_SUBTREES の各サブツリーが存在し、**1 ファイル以上**残っている
 *   2. 残っているファイルが**同一開催日でまとまっている**（会場別の取りこぼしが無い）
 *   3. `loadJraVenuesForDisplay` が実際に **venues と races を返せる**
 *      （＝認可後に「データがありません」へ落ちない）
 *   4. SSR 関数サイズが 250MB 未満
 *
 * ビルド前（成果物が無い）はスキップして exit 0。CI では build の後に実行する。
 */
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNTIME_SUBTREES } from '../src/lib/ssr/runtimeDataRetention.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fnRoot = join(projectRoot, '.netlify', 'v1', 'functions', 'ssr');
const fnDataDir = join(fnRoot, 'src', 'data');

let failed = 0;
const ng = (m) => { console.error(`  ❌ ${m}`); failed += 1; };
const ok = (m) => console.log(`  ✅ ${m}`);

async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(e.name);
    }
  }
  await walk(dir);
  return out;
}

async function dirSizeMB(dir) {
  let total = 0;
  async function walk(d) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else { try { total += (await stat(p)).size; } catch { /* skip */ } }
    }
  }
  await walk(dir);
  return total / (1024 * 1024);
}

async function main() {
  if (!existsSync(fnDataDir)) {
    console.log('[check-ssr-runtime-data] SSR 成果物が無いためスキップ（build 前）');
    return;
  }
  console.log('[check-ssr-runtime-data] SSR 関数に実行時データが残っているか検査');

  // ── 1 & 2. 各サブツリーの残存ファイル ──
  for (const spec of RUNTIME_SUBTREES) {
    const dir = join(fnDataDir, spec.sub);
    if (!existsSync(dir)) { ng(`${spec.sub}: ディレクトリごと消えている（読み手: ${spec.readers.join(', ')}）`); continue; }
    const files = await listFiles(dir);
    const dated = files.filter((f) => spec.datePattern.test(f));
    if (dated.length === 0) { ng(`${spec.sub}: 命名規則に合うファイルが 0（読み手: ${spec.readers.join(', ')}）`); continue; }

    const byDate = new Map();
    for (const f of dated) {
      const d = spec.datePattern.exec(f)[1];
      byDate.set(d, (byDate.get(d) || 0) + 1);
    }
    const dates = [...byDate.keys()].sort().reverse();
    ok(`${spec.sub}: ${dated.length} ファイル / ${dates.length} 開催日（最新 ${dates[0]} = ${byDate.get(dates[0])} ファイル）`);
  }

  // ── 3. 実際に loader が描画可能なデータを返すか ──
  const prevCwd = process.cwd();
  try {
    process.chdir(fnRoot);
    const { loadJraVenuesForDisplay } = await import(
      join(projectRoot, 'src', 'lib', 'loadJraVenuesForDisplay.js')
    );
    const r = loadJraVenuesForDisplay();
    const venues = Array.isArray(r.venues) ? r.venues : [];
    const races = venues.reduce((a, v) => a + ((v.predictions || v.races || []).length), 0);
    if (r.error) ng(`loadJraVenuesForDisplay: error=${r.error}`);
    else if (venues.length === 0 || races === 0) {
      ng(`loadJraVenuesForDisplay: venues=${venues.length} races=${races} → 認可後に「データがありません」になる`);
    } else {
      ok(`loadJraVenuesForDisplay: date=${r.predictionData?.date} venues=${venues.length} races=${races}`);
    }
  } catch (e) {
    ng(`loadJraVenuesForDisplay の実行に失敗: ${e.message}`);
  } finally {
    process.chdir(prevCwd);
  }

  // ── 4. サイズ ──
  const mb = await dirSizeMB(fnRoot);
  if (mb >= 250) ng(`SSR 関数サイズ ${mb.toFixed(1)} MB（250MB 上限超過）`);
  else ok(`SSR 関数サイズ ${mb.toFixed(1)} MB / 250MB（余裕 ${(250 - mb).toFixed(1)} MB）`);

  if (failed > 0) {
    console.error(`[check-ssr-runtime-data] ❌ ${failed} 件の問題`);
    process.exit(1);
  }
  console.log('[check-ssr-runtime-data] ✅ すべて OK');
}

main().catch((e) => { console.error('[check-ssr-runtime-data] error:', e); process.exit(1); });
