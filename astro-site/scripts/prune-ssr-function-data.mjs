#!/usr/bin/env node
/**
 * prune-ssr-function-data.mjs — SSR 関数バンドルから「ビルド専用の重い src/data 群」を削除する。
 *
 * 背景（2026-07-18 本番デプロイ復旧）:
 *   @astrojs/netlify 6.6.3 は SSR 関数を `.netlify/v1/functions/ssr/` に生成し、
 *   ssr.mjs の config で `includedFiles: ['**\/*'], nodeBundler: 'none'` を指定する。
 *   これにより adapter が nft トレースで関数ディレクトリへコピーした src/data が丸ごと
 *   デプロイされる。日次自動取込で src/data が積み上がり関数が 250MB を超え、本番デプロイが
 *   連続失敗した（Failed to upload file: ssr / exceeds 250 MB）。
 *
 *   下記の重いサブツリーは **prerender=true ページがビルド時に読むだけ**で、runtime SSR
 *   （prediction/[slug]・results-showcase・results・archive 等）は一切参照しない。
 *   `nodeBundler: 'none'` のため Netlify は再トレースせず、この postbuild で削除すれば
 *   そのまま zip される（＝関数から確実に外れる）。ビルド時の prerender は
 *   リポジトリ実体（/opt/build/repo/astro-site/src/data）を読むため影響しない。
 *
 * 維持（runtime SSR が参照するため削除しない）:
 *   - src/data/predictions/*.json（root=南関予想。prediction/[slug] が実行時に読む）
 *   - src/data/archiveResults*.json（results / results-showcase が実行時に読む）
 *   - src/data 直下の archiveResults_YYYY-MM.json スナップショット等
 *   - **RUNTIME_SUBTREES の直近 KEEP_DATES 日分**（2026-08-08 追加。下記）
 *
 * ⚠️ 2026-08-08 の退行と対処:
 *   有料ページを SSR 化したことで、ビルド時に読んでいた src/data を**実行時**に読むようになった。
 *   ところが本スクリプトが該当サブツリーを**丸ごと削除**していたため、認可を通った有料会員に
 *   「本日の予想データがありません」が出ていた（500 にならないので外形監視では気づけない）。
 *   そこで「全削除」をやめ、**各 loader が実際に開くファイル集合＝直近 KEEP_DATES 日分**を残す。
 *   保持は日付単位で、同じ日の会場別ファイルは全部残す（会場ごとに 1 ファイル必要なため）。
 *   データ schema / consumer contract / 自動 import フローは変更していない。
 */
import { rm, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fnDataDir = join(projectRoot, '.netlify', 'v1', 'functions', 'ssr', 'src', 'data');

import {
  RUNTIME_SUBTREES,
  BUILD_ONLY_SUBTREES,
  KEEP_DATES,
  pickKeepDates,
  shouldKeepFile,
} from '../src/lib/ssr/runtimeDataRetention.js';

/** サブツリー配下の全ファイルを再帰列挙する（{ path, name }）。 */
async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push({ path: p, name: e.name });
    }
  }
  await walk(dir);
  return out;
}

/**
 * 実行時に読むサブツリーを「直近 KEEP_DATES 日分だけ残して」間引く。
 * 残す日付は**バンドル内に実在するファイル名から導出**する（決め打ちしない）。
 */
async function thinRuntimeSubtree(spec) {
  const target = join(fnDataDir, spec.sub);
  if (!existsSync(target)) {
    console.log(`[prune-ssr] (無し) ${spec.sub}`);
    return;
  }
  const before = await dirSizeMB(target);
  const files = await listFiles(target);
  const keep = pickKeepDates(files.map((f) => f.name), spec.datePattern, KEEP_DATES);
  const keepSet = new Set(keep);

  let removed = 0;
  for (const f of files) {
    if (shouldKeepFile(f.name, spec.datePattern, keepSet)) continue;
    await rm(f.path, { force: true });
    removed += 1;
  }
  const after = await dirSizeMB(target);
  const kept = files.length - removed;
  console.log(
    `[prune-ssr] 間引き: src/data/${spec.sub} ${before.toFixed(1)}→${after.toFixed(1)} MB`
    + ` / 保持 ${kept} ファイル（${keep.join(', ') || '対象日なし'}）/ 削除 ${removed}`
  );
  if (kept === 0) {
    console.error(`[prune-ssr] ⚠️ ${spec.sub} が 0 ファイルになった。runtime loader が読めなくなる。`);
    process.exit(1);
  }
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
    // SSR 関数がまだ生成されていない場合は何もしない（ビルド未実行 or 構成変更）。
    console.log(`[prune-ssr] SSR 関数の data ディレクトリが無いためスキップ: ${fnDataDir}`);
    return;
  }

  const beforeFn = await dirSizeMB(join(projectRoot, '.netlify', 'v1', 'functions', 'ssr'));
  console.log(`[prune-ssr] 削除前 SSR 関数サイズ: ${beforeFn.toFixed(1)} MB`);

  // ① 実行時に読まないものは従来どおり丸ごと削除
  for (const sub of BUILD_ONLY_SUBTREES) {
    const target = join(fnDataDir, sub);
    if (!existsSync(target)) {
      console.log(`[prune-ssr] (無し) ${sub}`);
      continue;
    }
    const mb = await dirSizeMB(target);
    await rm(target, { recursive: true, force: true });
    console.log(`[prune-ssr] 削除: src/data/${sub} (${mb.toFixed(1)} MB)`);
  }

  // ② 実行時に読むものは直近 KEEP_DATES 日分だけ残す
  for (const spec of RUNTIME_SUBTREES) {
    await thinRuntimeSubtree(spec);
  }

  const afterFn = await dirSizeMB(join(projectRoot, '.netlify', 'v1', 'functions', 'ssr'));
  console.log(`[prune-ssr] 削除後 SSR 関数サイズ: ${afterFn.toFixed(1)} MB（250MB 上限）`);

  if (afterFn >= 250) {
    console.error(`[prune-ssr] ⚠️ 削除後も 250MB 以上。追加の削除対象が必要です。`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('[prune-ssr] error:', e); process.exit(1); });
