#!/usr/bin/env node
/**
 * アーカイブデータ整合性チェック
 *
 * 目的：
 * - src/dataにあるデータファイルが全てインポートされているか確認
 * - 存在しないデータファイルへのインポートがないか確認
 * - ビルド前に実行して事故を防止
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// ANSI色コード
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

console.log(`${colors.blue}🔍 アーカイブデータ整合性チェック開始...${colors.reset}\n`);

let hasError = false;

// ========================================
// 共通: src/pages 配下の全ページから import を集める
// ========================================
//
// 【2026-09-02 改修】以前は「archive/index.astro」「archive-sanrenpuku/index.astro」の
// 2 ファイルだけを見ていたが、どちらも実態と合わなくなっていた。
//   - archive/index.astro … per-month JSON を import せず、combined JSON を実行時に読む形へ変更済み
//     → 「7 件が未インポート」で **恒常的に失敗** していた（本チェックが常に赤＝誰も見なくなる状態）
//   - archive-sanrenpuku/index.astro … 無条件 301 のランディングになり、本文ごと削除
// そこで **ページを固定で決め打ちせず、src/pages 配下を走査して import 元を探す**方式にした。
// ページの移動・分割で自動的に追従する。
function collectAstroFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectAstroFiles(full));
    else if (entry.name.endsWith('.astro')) out.push(full);
  }
  return out;
}
const pagesRoot = path.join(rootDir, 'src/pages');
const allPages = collectAstroFiles(pagesRoot).map((f) => ({
  rel: path.relative(pagesRoot, f),
  src: fs.readFileSync(f, 'utf-8'),
}));

/** prefix（例 archiveSanrenpukuResults_）の per-month JSON を import しているページを返す */
function findImporters(prefix) {
  const re = new RegExp(`import\\s+\\w+\\s+from\\s+['"].*\\/(${prefix}[\\w-]+\\.json)['"]`, 'g');
  const byFile = new Map(); // json 名 -> [ページ]
  const pages = [];
  for (const pg of allPages) {
    let m, found = false;
    re.lastIndex = 0;
    while ((m = re.exec(pg.src)) !== null) {
      const json = m[1].replace('.json', '');
      if (!byFile.has(json)) byFile.set(json, []);
      byFile.get(json).push(pg.rel);
      found = true;
    }
    if (found) pages.push(pg.rel);
  }
  return { byFile, pages };
}

/**
 * per-month JSON を **fs 読み込み**で使っているページを探す。
 *
 * ⚠️ `import` していない ＝ 未使用ではない。馬単の per-month snapshot は
 * `src/pages/archive/nankan/**` が `readFileSync` / `readdirSync` で読んでいる
 * （月一覧は combined の日付と snapshot の **union**）。
 * ここを見落とすと「未参照だから消してよい」と誤読され、その月の実績が消える。
 */
function findFsReaders(prefix) {
  const needle = new RegExp(`${prefix}(\\$\\{|\\(|\\\\d)`);
  return allPages
    .filter((pg) => /readFileSync|readdirSync/.test(pg.src) && needle.test(pg.src))
    .map((pg) => pg.rel);
}

/** 共通チェック本体。per-month JSON が「どこからも使われていない」状態を検出する */
function checkArchive(label, prefix, { requireImport }) {
  console.log(`\n${colors.blue}📊 ${label}${colors.reset}`);
  const files = fs.readdirSync(path.join(rootDir, 'src/data'))
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));
  console.log(`  データファイル: ${files.length}件`);

  const { byFile, pages } = findImporters(prefix);
  const fsReaders = findFsReaders(prefix);
  console.log(`  import しているページ: ${pages.length}件`);
  pages.forEach((f) => console.log(`    - src/pages/${f}`));
  console.log(`  fs 読み込みで使っているページ: ${fsReaders.length}件`);
  fsReaders.forEach((f) => console.log(`    - src/pages/${f}`));

  console.log(`\n  ${colors.yellow}チェック1: import 漏れ${colors.reset}`);
  const missing = files.filter((f) => !byFile.has(f));
  if (missing.length === 0) {
    console.log(`  ${colors.green}✅ 全データファイルが import 済み${colors.reset}`);
  } else if (requireImport) {
    console.log(`  ${colors.red}❌ 以下が import されていません（月別ページからその月が消えます）:${colors.reset}`);
    missing.forEach((f) => console.log(`    ${colors.red}- ${f}.json${colors.reset}`));
    hasError = true;
  } else if (fsReaders.length > 0) {
    // ⚠️ 「import されていない」＝「未使用」ではない。
    //    馬単 snapshot は archive/nankan/** が fs で読む設計。**消してはいけない。**
    console.log(`  ${colors.yellow}ℹ️  import なし ${missing.length}件 — ただし上記ページが fs で読んでいる（設計どおり）${colors.reset}`);
    console.log(`  ${colors.yellow}    → これらのファイルを「未使用」と判断して削除しないこと${colors.reset}`);
  } else {
    console.log(`  ${colors.red}❌ import も fs 読み込みも無い ${missing.length}件（本当に未使用の可能性）:${colors.reset}`);
    missing.forEach((f) => console.log(`    ${colors.red}- ${f}.json${colors.reset}`));
    hasError = true;
  }

  console.log(`\n  ${colors.yellow}チェック2: 存在しないファイルへの import${colors.reset}`);
  const extra = [...byFile.keys()].filter((f) => !files.includes(f));
  if (extra.length > 0) {
    console.log(`  ${colors.red}❌ 存在しないファイルを import しています:${colors.reset}`);
    extra.forEach((f) => console.log(`    ${colors.red}- ${f}.json （${byFile.get(f).join(', ')}）${colors.reset}`));
    hasError = true;
  } else {
    console.log(`  ${colors.green}✅ 不正な import なし${colors.reset}`);
  }
}

// 馬単: archive/index.astro は combined（archiveResults.json）を実行時に読み、
//       per-month snapshot は archive/nankan/** が fs で読む（import はしない）。
//       月一覧は combined の日付と snapshot の union なので、snapshot が無い月も欠けない。
checkArchive('馬単アーカイブチェック', 'archiveResults_', { requireImport: false });

// 三連複: 2025/ ・ 2026/ ・ [year]/[month].astro が per-month JSON を実際に import している。
//         ここで参照漏れが出ると月別ページからその月が消えるので **エラー**にする。
checkArchive('三連複アーカイブチェック', 'archiveSanrenpukuResults_', { requireImport: true });

// combined（自動取込の正本）が読めること
console.log(`\n${colors.blue}📊 combined JSON（自動取込の正本）${colors.reset}`);
for (const f of ['archiveResults.json', 'archiveResultsJra.json',
  'archiveSanrenpukuResults.json', 'archiveSanrenpukuResultsJra.json']) {
  const full = path.join(rootDir, 'src/data', f);
  if (!fs.existsSync(full)) {
    console.log(`  ${colors.red}❌ ${f} が存在しません${colors.reset}`);
    hasError = true;
    continue;
  }
  try {
    JSON.parse(fs.readFileSync(full, 'utf-8'));
    console.log(`  ${colors.green}✅ ${f}${colors.reset}`);
  } catch (e) {
    console.log(`  ${colors.red}❌ ${f} が JSON として壊れています: ${e.message}${colors.reset}`);
    hasError = true;
  }
}

// ========================================
// 3. 最終結果
// ========================================
console.log(`\n${'='.repeat(60)}`);
if (hasError) {
  console.log(`${colors.red}❌ 整合性チェック失敗 - 修正が必要です${colors.reset}`);
  process.exit(1);
} else {
  console.log(`${colors.green}✅ 整合性チェック成功 - 全て正常です${colors.reset}`);
  process.exit(0);
}
