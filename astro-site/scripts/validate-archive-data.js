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
// 1. 馬単アーカイブチェック
// ========================================
console.log(`${colors.blue}📊 馬単アーカイブチェック${colors.reset}`);

// src/dataにある馬単データファイル一覧
const umatanFiles = fs.readdirSync(path.join(rootDir, 'src/data'))
  .filter(f => f.startsWith('archiveResults_') && f.endsWith('.json'))
  .map(f => f.replace('.json', ''));

console.log(`  データファイル: ${umatanFiles.length}件`);
umatanFiles.forEach(f => console.log(`    - ${f}.json`));

// archive/index.astroの内容確認
const archiveIndexPath = path.join(rootDir, 'src/pages/archive/index.astro');
const archiveIndexContent = fs.readFileSync(archiveIndexPath, 'utf-8');

// インポート文を抽出
const umatanImports = [];
const umatanImportRegex = /import\s+(\w+)\s+from\s+['"].*\/(archiveResults_[\w-]+\.json)['"]/g;
let match;
while ((match = umatanImportRegex.exec(archiveIndexContent)) !== null) {
  umatanImports.push(match[2].replace('.json', ''));
}

console.log(`\n  archive/index.astroのインポート: ${umatanImports.length}件`);
umatanImports.forEach(f => console.log(`    - ${f}.json`));

// チェック1: データファイルが全てインポートされているか
console.log(`\n  ${colors.yellow}チェック1: 未インポートファイル${colors.reset}`);
const umatanMissing = umatanFiles.filter(f => !umatanImports.includes(f));
if (umatanMissing.length > 0) {
  console.log(`  ${colors.red}❌ 以下のデータファイルがインポートされていません:${colors.reset}`);
  umatanMissing.forEach(f => console.log(`    ${colors.red}- ${f}.json${colors.reset}`));
  hasError = true;
} else {
  console.log(`  ${colors.green}✅ 全データファイルがインポート済み${colors.reset}`);
}

// チェック2: 存在しないファイルへのインポートがないか
console.log(`\n  ${colors.yellow}チェック2: 存在しないファイルへのインポート${colors.reset}`);
const umatanExtra = umatanImports.filter(f => !umatanFiles.includes(f));
if (umatanExtra.length > 0) {
  console.log(`  ${colors.red}❌ 存在しないファイルへのインポートがあります:${colors.reset}`);
  umatanExtra.forEach(f => console.log(`    ${colors.red}- ${f}.json${colors.reset}`));
  hasError = true;
} else {
  console.log(`  ${colors.green}✅ 不正なインポートなし${colors.reset}`);
}

// チェック3: 年データが統合されているか
console.log(`\n  ${colors.yellow}チェック3: 年データ統合確認${colors.reset}`);
const years = new Set(umatanFiles.map(f => f.split('_')[1].split('-')[0]));
console.log(`  検出された年: ${Array.from(years).join(', ')}`);

years.forEach(year => {
  const yearPattern = new RegExp(`['"]${year}['"]:\\s*{`);
  if (yearPattern.test(archiveIndexContent)) {
    console.log(`  ${colors.green}✅ ${year}年データが統合済み${colors.reset}`);
  } else {
    console.log(`  ${colors.red}❌ ${year}年データが統合されていません${colors.reset}`);
    hasError = true;
  }
});

// ========================================
// 2. 三連複アーカイブチェック
// ========================================
console.log(`\n${colors.blue}📊 三連複アーカイブチェック${colors.reset}`);

// src/dataにある三連複データファイル一覧（10月除外）
const sanrenpukuFiles = fs.readdirSync(path.join(rootDir, 'src/data'))
  .filter(f => f.startsWith('archiveSanrenpukuResults_') && f.endsWith('.json'))
  .map(f => f.replace('.json', ''));

console.log(`  データファイル: ${sanrenpukuFiles.length}件`);
sanrenpukuFiles.forEach(f => console.log(`    - ${f}.json`));

// archive-sanrenpuku/index.astroの内容確認
const sanrenpukuIndexPath = path.join(rootDir, 'src/pages/archive-sanrenpuku/index.astro');
const sanrenpukuIndexContent = fs.readFileSync(sanrenpukuIndexPath, 'utf-8');

// インポート文を抽出
const sanrenpukuImports = [];
const sanrenpukuImportRegex = /import\s+(\w+)\s+from\s+['"].*\/(archiveSanrenpukuResults_[\w-]+\.json)['"]/g;
while ((match = sanrenpukuImportRegex.exec(sanrenpukuIndexContent)) !== null) {
  sanrenpukuImports.push(match[2].replace('.json', ''));
}

console.log(`\n  archive-sanrenpuku/index.astroのインポート: ${sanrenpukuImports.length}件`);
sanrenpukuImports.forEach(f => console.log(`    - ${f}.json`));

// チェック1: データファイルが全てインポートされているか
console.log(`\n  ${colors.yellow}チェック1: 未インポートファイル${colors.reset}`);
const sanrenpukuMissing = sanrenpukuFiles.filter(f => !sanrenpukuImports.includes(f));
if (sanrenpukuMissing.length > 0) {
  console.log(`  ${colors.red}❌ 以下のデータファイルがインポートされていません:${colors.reset}`);
  sanrenpukuMissing.forEach(f => console.log(`    ${colors.red}- ${f}.json${colors.reset}`));
  hasError = true;
} else {
  console.log(`  ${colors.green}✅ 全データファイルがインポート済み${colors.reset}`);
}

// チェック2: 存在しないファイルへのインポートがないか
console.log(`\n  ${colors.yellow}チェック2: 存在しないファイルへのインポート${colors.reset}`);
const sanrenpukuExtra = sanrenpukuImports.filter(f => !sanrenpukuFiles.includes(f));
if (sanrenpukuExtra.length > 0) {
  console.log(`  ${colors.red}❌ 存在しないファイルへのインポートがあります:${colors.reset}`);
  sanrenpukuExtra.forEach(f => console.log(`    ${colors.red}- ${f}.json${colors.reset}`));
  hasError = true;
} else {
  console.log(`  ${colors.green}✅ 不正なインポートなし${colors.reset}`);
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
