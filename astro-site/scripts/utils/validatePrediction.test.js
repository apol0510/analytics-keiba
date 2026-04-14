/**
 * validatePrediction.test.js
 *
 * データ検証のテストケース
 *
 * 実行方法:
 *   node scripts/utils/validatePrediction.test.js
 */

import { validateJRAPrediction } from './validatePrediction.js';

// テストデータ生成
function createTestRace(horses) {
  return {
    raceInfo: {
      raceNumber: 11,
      raceName: 'テストレース'
    },
    horses: horses.map(h => ({
      horseNumber: h.number,
      horseName: h.name,
      pt: h.pt,
      role: h.role
    }))
  };
}

function createTestData(races) {
  return {
    venues: [{
      venue: 'テスト',
      predictions: races
    }]
  };
}

// テストケース
const tests = [
  {
    name: '✅ 正常データ（本命1・対抗1・単穴1・連下最上位1）',
    data: createTestData([
      createTestRace([
        { number: 1, name: '本命馬', pt: 90, role: '本命' },
        { number: 2, name: '対抗馬', pt: 85, role: '対抗' },
        { number: 3, name: '単穴馬', pt: 80, role: '単穴' },
        { number: 4, name: '連下最上位馬', pt: 75, role: '連下最上位' },
        { number: 5, name: '連下馬', pt: 70, role: '連下' }
      ])
    ]),
    shouldPass: true
  },
  {
    name: '❌ 単穴2頭（再発防止テスト）',
    data: createTestData([
      createTestRace([
        { number: 1, name: '本命馬', pt: 90, role: '本命' },
        { number: 2, name: '対抗馬', pt: 85, role: '対抗' },
        { number: 3, name: '単穴馬1', pt: 80, role: '単穴' },
        { number: 4, name: '単穴馬2', pt: 80, role: '単穴' }, // ❌ 2頭目
        { number: 5, name: '連下馬', pt: 70, role: '連下' }
      ])
    ]),
    shouldPass: false,
    expectedError: '単穴が2頭'
  },
  {
    name: '❌ 連下最上位2頭（再発防止テスト）',
    data: createTestData([
      createTestRace([
        { number: 1, name: '本命馬', pt: 90, role: '本命' },
        { number: 2, name: '対抗馬', pt: 85, role: '対抗' },
        { number: 3, name: '単穴馬', pt: 80, role: '単穴' },
        { number: 4, name: '連下最上位馬1', pt: 75, role: '連下最上位' },
        { number: 5, name: '連下最上位馬2', pt: 75, role: '連下最上位' } // ❌ 2頭目
      ])
    ]),
    shouldPass: false,
    expectedError: '連下最上位が2頭'
  },
  {
    name: '❌ 本命0頭',
    data: createTestData([
      createTestRace([
        { number: 2, name: '対抗馬', pt: 85, role: '対抗' },
        { number: 3, name: '単穴馬', pt: 80, role: '単穴' }
      ])
    ]),
    shouldPass: false,
    expectedError: '本命が0頭'
  },
  {
    name: '❌ 対抗0頭',
    data: createTestData([
      createTestRace([
        { number: 1, name: '本命馬', pt: 90, role: '本命' },
        { number: 3, name: '単穴馬', pt: 80, role: '単穴' }
      ])
    ]),
    shouldPass: false,
    expectedError: '対抗が0頭'
  },
  {
    name: '❌ 不正な役割名',
    data: createTestData([
      createTestRace([
        { number: 1, name: '本命馬', pt: 90, role: '本命' },
        { number: 2, name: '対抗馬', pt: 85, role: '対抗' },
        { number: 3, name: '単穴馬', pt: 80, role: '不正な役割' } // ❌ 不正な値
      ])
    ]),
    shouldPass: false,
    expectedError: '不正な役割'
  }
];

// テスト実行
console.log('🧪 データ検証テスト開始\n');

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    validateJRAPrediction(test.data);

    if (test.shouldPass) {
      console.log(`✅ PASS: ${test.name}`);
      passed++;
    } else {
      console.log(`❌ FAIL: ${test.name}`);
      console.log(`   期待: エラーが発生するべき（${test.expectedError}）`);
      console.log(`   実際: エラーが発生しなかった`);
      failed++;
    }
  } catch (err) {
    if (!test.shouldPass) {
      // エラーメッセージに期待する文字列が含まれているかチェック
      if (err.message.includes(test.expectedError)) {
        console.log(`✅ PASS: ${test.name}`);
        console.log(`   エラーメッセージ: ${err.message.split('\n')[0]}`);
        passed++;
      } else {
        console.log(`❌ FAIL: ${test.name}`);
        console.log(`   期待: "${test.expectedError}" を含むエラー`);
        console.log(`   実際: ${err.message.split('\n')[0]}`);
        failed++;
      }
    } else {
      console.log(`❌ FAIL: ${test.name}`);
      console.log(`   期待: エラーなし`);
      console.log(`   実際: ${err.message.split('\n')[0]}`);
      failed++;
    }
  }
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`テスト結果: ${passed}/${tests.length} 成功`);

if (failed > 0) {
  console.log(`❌ ${failed}件のテストが失敗しました`);
  process.exit(1);
} else {
  console.log(`✅ 全テスト成功！`);
  process.exit(0);
}
