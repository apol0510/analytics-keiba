#!/usr/bin/env node

/**
 * アーカイブインポート自動更新スクリプト
 * 新しい月のデータファイルを各indexファイルに自動追加
 *
 * 使い方:
 *   node scripts/update-archive-imports.js 2026 03
 *   node scripts/update-archive-imports.js        （引数なし = 今月）
 */

const fs = require('fs');
const path = require('path');

// 引数から年月を取得、なければ今月
const args = process.argv.slice(2);
let year, month;

if (args.length >= 2) {
  year = args[0];
  month = args[1].padStart(2, '0');
} else {
  const now = new Date();
  year = now.getFullYear().toString();
  month = (now.getMonth() + 1).toString().padStart(2, '0');
}

console.log(`\n🔧 ${year}年${parseInt(month)}月のインポートを各indexファイルに追加します...\n`);

// ============================================================
// 1. archive/index.astro 更新
// ============================================================

const archiveIndexPath = path.join(__dirname, '../src/pages/archive/index.astro');
let archiveIndexContent = fs.readFileSync(archiveIndexPath, 'utf-8');

// インポート文を追加
const importStatement = `import archiveData${year}_${month} from '../../data/archiveResults_${year}-${month}.json';`;
if (!archiveIndexContent.includes(importStatement)) {
  // 最後のimport文の後に追加
  const lastImportMatch = archiveIndexContent.match(/(import archiveData\d+_\d+ from '.*?';)\n/g);
  if (lastImportMatch) {
    const lastImport = lastImportMatch[lastImportMatch.length - 1];
    archiveIndexContent = archiveIndexContent.replace(lastImport, lastImport + importStatement + '\n');
  }

  // yearDataオブジェクトに追加
  const yearDataMatch = archiveIndexContent.match(/('${year}':\s*\{[\s\S]*?\})/);
  if (yearDataMatch) {
    const yearDataBlock = yearDataMatch[0];
    const newYearDataBlock = yearDataBlock.replace(/\}$/, `    ...archiveData${year}_${month}['${year}'],\n  }`);
    archiveIndexContent = archiveIndexContent.replace(yearDataBlock, newYearDataBlock);
  } else {
    // 年がまだない場合は新規追加
    const archiveDataMatch = archiveIndexContent.match(/(const archiveData = \{[\s\S]*?\};)/);
    if (archiveDataMatch) {
      const archiveDataBlock = archiveDataMatch[0];
      const newArchiveDataBlock = archiveDataBlock.replace(/\};$/, `,\n  '${year}': {\n    ...archiveData${year}_${month}['${year}']\n  }\n};`);
      archiveIndexContent = archiveIndexContent.replace(archiveDataBlock, newArchiveDataBlock);
    }
  }

  fs.writeFileSync(archiveIndexPath, archiveIndexContent, 'utf-8');
  console.log('✅ 更新: src/pages/archive/index.astro');
} else {
  console.log('⚠️  既存: src/pages/archive/index.astro（既にインポート済み）');
}

// ============================================================
// 2. archive/YEAR/index.astro 更新
// ============================================================

const archiveYearIndexPath = path.join(__dirname, `../src/pages/archive/${year}/index.astro`);
if (fs.existsSync(archiveYearIndexPath)) {
  let archiveYearIndexContent = fs.readFileSync(archiveYearIndexPath, 'utf-8');

  // インポート文を追加
  const importStatement2 = `import archiveData${month} from '../../../data/archiveResults_${year}-${month}.json';`;
  if (!archiveYearIndexContent.includes(importStatement2)) {
    const lastImportMatch = archiveYearIndexContent.match(/(import archiveData\d+ from '.*?';)\n/g);
    if (lastImportMatch) {
      const lastImport = lastImportMatch[lastImportMatch.length - 1];
      archiveYearIndexContent = archiveYearIndexContent.replace(lastImport, lastImport + importStatement2 + '\n');
    }

    // yearDataオブジェクトに追加
    const yearDataMatch = archiveYearIndexContent.match(/(const yearData = \{[\s\S]*?\};)/);
    if (yearDataMatch) {
      const yearDataBlock = yearDataMatch[0];
      const newYearDataBlock = yearDataBlock.replace(/\};$/, `,\n  ...archiveData${month}['${year}']\n};`);
      archiveYearIndexContent = archiveYearIndexContent.replace(yearDataBlock, newYearDataBlock);
    }

    fs.writeFileSync(archiveYearIndexPath, archiveYearIndexContent, 'utf-8');
    console.log(`✅ 更新: src/pages/archive/${year}/index.astro`);
  } else {
    console.log(`⚠️  既存: src/pages/archive/${year}/index.astro（既にインポート済み）`);
  }
}

// ============================================================
// 3. archive-sanrenpuku/index.astro 更新
// ============================================================

const sanrenpukuIndexPath = path.join(__dirname, '../src/pages/archive-sanrenpuku/index.astro');
let sanrenpukuIndexContent = fs.readFileSync(sanrenpukuIndexPath, 'utf-8');

// インポート文を追加
const importStatement3 = `import archiveData${year}_${month} from '../../data/archiveSanrenpukuResults_${year}-${month}.json';`;
if (!sanrenpukuIndexContent.includes(importStatement3)) {
  const lastImportMatch = sanrenpukuIndexContent.match(/(import archiveData\d+_\d+ from '.*?';)\n/g);
  if (lastImportMatch) {
    const lastImport = lastImportMatch[lastImportMatch.length - 1];
    sanrenpukuIndexContent = sanrenpukuIndexContent.replace(lastImport, lastImport + importStatement3 + '\n');
  }

  // archiveSanrenpukuResultsオブジェクトに追加
  const yearDataMatch = sanrenpukuIndexContent.match(/('${year}':\s*\{[\s\S]*?\})/);
  if (yearDataMatch) {
    const yearDataBlock = yearDataMatch[0];
    const newYearDataBlock = yearDataBlock.replace(/\}$/, `    ...archiveData${year}_${month}['${year}'],\n  }`);
    sanrenpukuIndexContent = sanrenpukuIndexContent.replace(yearDataBlock, newYearDataBlock);
  } else {
    // 年がまだない場合は新規追加
    const archiveDataMatch = sanrenpukuIndexContent.match(/(const archiveSanrenpukuResults = \{[\s\S]*?\};)/);
    if (archiveDataMatch) {
      const archiveDataBlock = archiveDataMatch[0];
      const newArchiveDataBlock = archiveDataBlock.replace(/\};$/, `,\n  '${year}': {\n    ...archiveData${year}_${month}['${year}']\n  }\n};`);
      sanrenpukuIndexContent = sanrenpukuIndexContent.replace(archiveDataBlock, newArchiveDataBlock);
    }
  }

  fs.writeFileSync(sanrenpukuIndexPath, sanrenpukuIndexContent, 'utf-8');
  console.log('✅ 更新: src/pages/archive-sanrenpuku/index.astro');
} else {
  console.log('⚠️  既存: src/pages/archive-sanrenpuku/index.astro（既にインポート済み）');
}

// ============================================================
// 4. archive-sanrenpuku/YEAR/index.astro 更新
// ============================================================

const sanrenpukuYearIndexPath = path.join(__dirname, `../src/pages/archive-sanrenpuku/${year}/index.astro`);
if (fs.existsSync(sanrenpukuYearIndexPath)) {
  let sanrenpukuYearIndexContent = fs.readFileSync(sanrenpukuYearIndexPath, 'utf-8');

  // インポート文を追加
  const importStatement4 = `import archiveData${year}_${month} from '../../../data/archiveSanrenpukuResults_${year}-${month}.json';`;
  if (!sanrenpukuYearIndexContent.includes(importStatement4)) {
    const lastImportMatch = sanrenpukuYearIndexContent.match(/(import archiveData\d+_\d+ from '.*?';)\n/g);
    if (lastImportMatch) {
      const lastImport = lastImportMatch[lastImportMatch.length - 1];
      sanrenpukuYearIndexContent = sanrenpukuYearIndexContent.replace(lastImport, lastImport + importStatement4 + '\n');
    }

    // yearDataオブジェクトに追加
    const yearDataMatch = sanrenpukuYearIndexContent.match(/(const yearData = \{[\s\S]*?\};)/);
    if (yearDataMatch) {
      const yearDataBlock = yearDataMatch[0];
      const newYearDataBlock = yearDataBlock.replace(/\};$/, `,\n  ...archiveData${year}_${month}['${year}']\n};`);
      sanrenpukuYearIndexContent = sanrenpukuYearIndexContent.replace(yearDataBlock, newYearDataBlock);
    }

    fs.writeFileSync(sanrenpukuYearIndexPath, sanrenpukuYearIndexContent, 'utf-8');
    console.log(`✅ 更新: src/pages/archive-sanrenpuku/${year}/index.astro`);
  } else {
    console.log(`⚠️  既存: src/pages/archive-sanrenpuku/${year}/index.astro（既にインポート済み）`);
  }
}

// ============================================================
// 5. archive-sanrenpuku/YEAR/MONTH.astro 作成（前月をコピー）
// ============================================================

const prevMonth = (parseInt(month) - 1).toString().padStart(2, '0');
const prevMonthPagePath = path.join(__dirname, `../src/pages/archive-sanrenpuku/${year}/${prevMonth}.astro`);
const newMonthPagePath = path.join(__dirname, `../src/pages/archive-sanrenpuku/${year}/${month}.astro`);

if (fs.existsSync(prevMonthPagePath) && !fs.existsSync(newMonthPagePath)) {
  let prevMonthContent = fs.readFileSync(prevMonthPagePath, 'utf-8');

  // 前月の内容を今月に置き換え
  let newMonthContent = prevMonthContent
    .replace(new RegExp(`archiveData${year}_${prevMonth}`, 'g'), `archiveData${year}_${month}`)
    .replace(new RegExp(`archiveSanrenpukuResults_${year}-${prevMonth}`, 'g'), `archiveSanrenpukuResults_${year}-${month}`)
    .replace(new RegExp(`const month = '${prevMonth}'`, 'g'), `const month = '${month}'`)
    .replace(new RegExp(`${year}年${parseInt(prevMonth)}月`, 'g'), `${year}年${parseInt(month)}月`)
    .replace(new RegExp(`${parseInt(prevMonth)}月`, 'g'), `${parseInt(month)}月`)
    .replace(new RegExp(`/${year}/${prevMonth}`, 'g'), `/${year}/${month}`);

  fs.writeFileSync(newMonthPagePath, newMonthContent, 'utf-8');
  console.log(`✅ 作成: src/pages/archive-sanrenpuku/${year}/${month}.astro（${prevMonth}月をコピー）`);
} else if (fs.existsSync(newMonthPagePath)) {
  console.log(`⚠️  既存: src/pages/archive-sanrenpuku/${year}/${month}.astro`);
} else {
  console.log(`⚠️  スキップ: src/pages/archive-sanrenpuku/${year}/${month}.astro（前月ファイルが見つかりません）`);
}

console.log('');
console.log(`✅ 完了！\n`);
console.log(`📝 次のステップ:\n`);
console.log(`1. git add . && git commit -m "📊 ${year}年${parseInt(month)}月アーカイブ準備"`);
console.log(`2. git push origin main`);
console.log('');
