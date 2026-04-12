#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// メンテナンススクリプト: 信頼度データと古いデータを完全削除

function cleanObjectRecursively(obj) {
  if (Array.isArray(obj)) {
    return obj.map(item => cleanObjectRecursively(item));
  }
  
  if (obj !== null && typeof obj === 'object') {
    const cleaned = {};
    
    for (const [key, value] of Object.entries(obj)) {
      // 信頼度関連フィールドを削除
      if (key === 'confidence') {
        console.log(`削除: confidence フィールド (値: ${value})`);
        continue;
      }
      
      // factors内の信頼度エントリを削除
      if (key === 'factors' && Array.isArray(value)) {
        cleaned[key] = value.filter(factor => {
          if (factor.text && factor.text.includes('信頼度')) {
            console.log(`削除: factors内信頼度エントリ (${factor.text})`);
            return false;
          }
          return true;
        }).map(factor => cleanObjectRecursively(factor));
        continue;
      }
      
      // 古い不要フィールドを削除 (必要に応じて追加)
      const obsoleteFields = [
        'oldConfidence',
        'legacyData',
        'deprecatedField'
      ];
      
      if (obsoleteFields.includes(key)) {
        console.log(`削除: 古いフィールド ${key}`);
        continue;
      }
      
      // 残りのフィールドは再帰的にクリーン
      cleaned[key] = cleanObjectRecursively(value);
    }
    
    return cleaned;
  }
  
  return obj;
}

function cleanJsonFile(filePath) {
  console.log(`\n🔧 クリーニング開始: ${filePath}`);
  
  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  ファイルが見つかりません: ${filePath}`);
    return;
  }
  
  try {
    // JSONファイルを読み込み
    const rawData = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(rawData);
    
    // データをクリーン
    const cleanedData = cleanObjectRecursively(data);
    
    // バックアップを作成
    const backupPath = filePath + '.backup.' + Date.now();
    fs.writeFileSync(backupPath, rawData);
    console.log(`💾 バックアップ作成: ${backupPath}`);
    
    // クリーンなデータを書き戻し
    fs.writeFileSync(filePath, JSON.stringify(cleanedData, null, 2));
    console.log(`✅ クリーニング完了: ${filePath}`);
    
  } catch (error) {
    console.error(`❌ エラー: ${filePath}`, error.message);
  }
}

// メインの実行
console.log('🧹 大掛かりメンテナンス開始: 信頼度データ・古いデータ削除');
console.log('='.repeat(60));

// クリーンアップ対象のファイル
const targetFiles = [
  '../src/data/allRacesPrediction.json',
  '../src/data/raceResults.json'
];

targetFiles.forEach(file => {
  const fullPath = path.resolve(__dirname, file);
  cleanJsonFile(fullPath);
});

console.log('\n🎉 メンテナンス完了!');
console.log('✅ 全ての信頼度データを削除');
console.log('✅ 古い不要データを削除');
console.log('✅ バックアップファイル作成済み');