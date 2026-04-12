#!/usr/bin/env node

/**
 * アーカイブフォーマット検証スクリプト
 *
 * 旧フォーマット混入を検出し、ビルドを停止する
 *
 * 検証対象:
 * - src/data/archiveResults.json（南関）
 * - src/data/archiveResultsJra.json（中央）
 *
 * 禁止キー:
 * - raceResults（旧: races）
 * - honmeiHit（旧: isHit）
 * - umatanHit（旧: isHit）
 * - sanrenpukuHit（旧: isHit）
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// 禁止キー（旧フォーマット）
const FORBIDDEN_KEYS = ['raceResults', 'honmeiHit', 'umatanHit', 'sanrenpukuHit'];

/**
 * アーカイブファイルを検証
 */
function validateArchive(filePath, label) {
  console.log(`\n🔍 検証中: ${label}`);
  console.log(`   ファイル: ${filePath}`);

  // ファイル存在チェック
  if (!existsSync(filePath)) {
    console.log(`   ⏭️  スキップ（ファイルなし）`);
    return true;
  }

  // ファイル読み込み
  const content = readFileSync(filePath, 'utf-8');

  // 禁止キー検出
  const detectedKeys = [];
  for (const key of FORBIDDEN_KEYS) {
    if (content.includes(`"${key}"`)) {
      detectedKeys.push(key);
    }
  }

  // 結果判定
  if (detectedKeys.length > 0) {
    console.error(`\n❌ アーカイブフォーマットエラー！`);
    console.error(`   旧フォーマット検出: ${detectedKeys.join(', ')}`);
    console.error(`   ファイル: ${filePath}`);
    console.error(`\n   【対処方法】`);
    console.error(`   1. scripts/importResults.js を使って該当日付を再処理`);
    console.error(`   2. 旧フォーマットのエントリを手動削除\n`);
    return false;
  }

  console.log(`   ✅ フォーマット検証: 正常`);
  return true;
}

/**
 * メイン処理
 */
function main() {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📋 アーカイブフォーマット検証`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  const archives = [
    {
      path: join(projectRoot, 'src', 'data', 'archiveResults.json'),
      label: '南関競馬アーカイブ'
    },
    {
      path: join(projectRoot, 'src', 'data', 'archiveResultsJra.json'),
      label: '中央競馬アーカイブ'
    }
  ];

  let allValid = true;

  for (const archive of archives) {
    const isValid = validateArchive(archive.path, archive.label);
    if (!isValid) {
      allValid = false;
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (allValid) {
    console.log(`✅ 全てのアーカイブが正常です`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    process.exit(0);
  } else {
    console.error(`❌ アーカイブフォーマットエラーが検出されました`);
    console.error(`   ビルドを中断します\n`);
    console.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    process.exit(1);
  }
}

main();
