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
 */
import { rm, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fnDataDir = join(projectRoot, '.netlify', 'v1', 'functions', 'ssr', 'src', 'data');

// 関数バンドルから削除する「ビルド専用の重いサブツリー」（src/data からの相対）。
const HEAVY_SUBTREES = [
  'horseHistories',
  'horseStats',
  'featureScores',
  'computer',
  join('predictions', 'jra'),
];

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

  for (const sub of HEAVY_SUBTREES) {
    const target = join(fnDataDir, sub);
    if (!existsSync(target)) {
      console.log(`[prune-ssr] (無し) ${sub}`);
      continue;
    }
    const mb = await dirSizeMB(target);
    await rm(target, { recursive: true, force: true });
    console.log(`[prune-ssr] 削除: src/data/${sub} (${mb.toFixed(1)} MB)`);
  }

  const afterFn = await dirSizeMB(join(projectRoot, '.netlify', 'v1', 'functions', 'ssr'));
  console.log(`[prune-ssr] 削除後 SSR 関数サイズ: ${afterFn.toFixed(1)} MB（250MB 上限）`);

  if (afterFn >= 250) {
    console.error(`[prune-ssr] ⚠️ 削除後も 250MB 以上。追加の削除対象が必要です。`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('[prune-ssr] error:', e); process.exit(1); });
