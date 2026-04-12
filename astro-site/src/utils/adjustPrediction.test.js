/**
 * adjustPrediction.test.js
 *
 * adjustPrediction関数のテスト
 * Node標準のassertを使用
 */

import assert from 'assert';
import { adjustPrediction } from './adjustPrediction.js';

/**
 * テストケース1: 差4点以上で役割入れ替えが起きる
 */
function testRoleSwapOn4PointDifference() {
  console.log('\n━━━ Test 1: 差4点以上で役割入れ替えが起きる ━━━');

  const input = {
    date: '2026-01-30',
    venue: '大井',
    venueCode: 'OI',
    totalRaces: 1,
    races: [
      {
        raceNumber: 1,
        raceName: 'テストレース',
        horses: [
          { number: 1, name: '本命馬', rawScore: 18, role: '本命' },
          { number: 2, name: '対抗馬', rawScore: 13, role: '対抗' },      // 差5点 → 連下最上位へ
          { number: 3, name: '単穴馬', rawScore: 12, role: '単穴' },      // 対抗へ昇格
          { number: 4, name: '連下最上位馬', rawScore: 10, role: '連下最上位' }, // 単穴へ昇格
          { number: 5, name: '連下馬1', rawScore: 8, role: '連下' },
          { number: 6, name: '連下馬2', rawScore: 7, role: '連下' }
        ]
      }
    ]
  };

  const result = adjustPrediction(input);
  const race = result.races[0];

  // 検証: 本命はそのまま
  const honmei = race.horses.find(h => h.number === 1);
  assert.strictEqual(honmei.role, '本命', '本命はそのまま維持');

  // 検証: 対抗 → 連下最上位
  const exTaikou = race.horses.find(h => h.number === 2);
  assert.strictEqual(exTaikou.role, '連下最上位', '対抗が連下最上位に降格');

  // 検証: 単穴 → 対抗
  const exTanana = race.horses.find(h => h.number === 3);
  assert.strictEqual(exTanana.role, '対抗', '単穴が対抗に昇格');

  // 検証: 連下最上位 → 単穴
  const exRenkaTop = race.horses.find(h => h.number === 4);
  assert.strictEqual(exRenkaTop.role, '単穴', '連下最上位が単穴に昇格');

  // 検証: 絶対軸判定
  assert.strictEqual(race.isAbsoluteAxis, true, '差4点以上で絶対軸判定');

  console.log('✅ Test 1 PASSED');
}

/**
 * テストケース2: 本命15点以下で本命↔対抗の入れ替えが起きる
 */
function testHonmeiDemotionOn15OrLess() {
  console.log('\n━━━ Test 2: 本命15点以下で本命↔対抗の入れ替えが起きる ━━━');

  const input = {
    date: '2026-01-30',
    venue: '川崎',
    venueCode: 'KA',
    totalRaces: 1,
    races: [
      {
        raceNumber: 2,
        raceName: 'テストレース2',
        horses: [
          { number: 1, name: '本命馬', rawScore: 14, role: '本命' },   // 15点以下 → 単穴へ
          { number: 2, name: '対抗馬', rawScore: 12, role: '対抗' },   // 本命へ昇格
          { number: 3, name: '単穴馬', rawScore: 10, role: '単穴' },
          { number: 4, name: '連下最上位馬', rawScore: 9, role: '連下最上位' },
          { number: 5, name: '連下馬', rawScore: 7, role: '連下' }
        ]
      }
    ]
  };

  const result = adjustPrediction(input);
  const race = result.races[0];

  // 検証: 元本命 → 単穴
  const exHonmei = race.horses.find(h => h.number === 1);
  assert.strictEqual(exHonmei.role, '単穴', '本命が単穴に降格');

  // 検証: 元対抗 → 本命
  const exTaikou = race.horses.find(h => h.number === 2);
  assert.strictEqual(exTaikou.role, '本命', '対抗が本命に昇格');

  // 検証: displayScore計算
  assert.strictEqual(exHonmei.displayScore, 84, 'displayScore = 14 + 70');
  assert.strictEqual(exTaikou.displayScore, 82, 'displayScore = 12 + 70');

  console.log('✅ Test 2 PASSED');
}

/**
 * テストケース3: 連下が5頭以上でも連下は最大3頭、残り補欠
 */
function testRenkaLimitTo3Horses() {
  console.log('\n━━━ Test 3: 連下が5頭以上でも連下は最大3頭、残り補欠 ━━━');

  const input = {
    date: '2026-01-30',
    venue: '船橋',
    venueCode: 'FU',
    totalRaces: 1,
    races: [
      {
        raceNumber: 3,
        raceName: 'テストレース3',
        horses: [
          { number: 1, name: '本命馬', rawScore: 18, role: '本命' },
          { number: 2, name: '対抗馬', rawScore: 15, role: '対抗' },
          { number: 3, name: '単穴馬', rawScore: 12, role: '単穴' },
          { number: 4, name: '連下最上位馬', rawScore: 10, role: '連下最上位' },
          { number: 5, name: '連下馬1', rawScore: 9, role: '連下' },   // 連下維持
          { number: 6, name: '連下馬2', rawScore: 8, role: '連下' },   // 連下維持
          { number: 7, name: '連下馬3', rawScore: 7, role: '連下' },   // 連下維持
          { number: 8, name: '連下馬4', rawScore: 6, role: '連下' },   // 補欠へ
          { number: 9, name: '連下馬5', rawScore: 5, role: '連下' }    // 補欠へ
        ]
      }
    ]
  };

  const result = adjustPrediction(input);
  const race = result.races[0];

  // 検証: 連下最上位は1頭維持
  const renkaTopList = race.horses.filter(h => h.role === '連下最上位');
  assert.strictEqual(renkaTopList.length, 1, '連下最上位は1頭');

  // 検証: 連下は最大3頭
  const renkaList = race.horses.filter(h => h.role === '連下');
  assert.strictEqual(renkaList.length, 3, '連下は最大3頭');

  // 検証: 補欠は2頭（元連下5頭 - 連下3頭 = 2頭）
  const hosekiList = race.horses.filter(h => h.role === '補欠');
  assert.strictEqual(hosekiList.length, 2, '補欠は2頭');

  // 検証: 連下は得点順（9, 8, 7点の3頭）
  assert.strictEqual(renkaList[0].rawScore >= renkaList[1].rawScore, true, '連下は得点順');
  assert.strictEqual(renkaList[1].rawScore >= renkaList[2].rawScore, true, '連下は得点順');

  // 検証: 補欠は低得点（6, 5点の2頭）
  const hoseki1 = race.horses.find(h => h.number === 8);
  const hoseki2 = race.horses.find(h => h.number === 9);
  assert.strictEqual(hoseki1.role, '補欠', '連下馬4は補欠');
  assert.strictEqual(hoseki2.role, '補欠', '連下馬5は補欠');

  console.log('✅ Test 3 PASSED');
}

/**
 * テストケース4: 連下最上位がいない場合でも落ちない（安全に処理）
 * ※ただし本命と対抗の差が5点あるため、対抗が連下最上位に降格される
 */
function testSafeHandlingWithoutRenkaTop() {
  console.log('\n━━━ Test 4: 連下最上位がいない場合でも落ちない（差5点で役割入れ替え発動） ━━━');

  const input = {
    date: '2026-01-30',
    venue: '浦和',
    venueCode: 'UR',
    totalRaces: 1,
    races: [
      {
        raceNumber: 4,
        raceName: 'テストレース4',
        horses: [
          { number: 1, name: '本命馬', rawScore: 20, role: '本命' },      // 20点 → 絶対軸
          { number: 2, name: '対抗馬', rawScore: 15, role: '対抗' },      // 差5点 → 連下最上位へ
          { number: 3, name: '単穴馬', rawScore: 12, role: '単穴' },      // 対抗へ昇格
          // 連下最上位なし
          { number: 5, name: '連下馬1', rawScore: 8, role: '連下' },
          { number: 6, name: '連下馬2', rawScore: 7, role: '連下' }
        ]
      }
    ]
  };

  const result = adjustPrediction(input);
  const race = result.races[0];

  // 検証: エラーが発生しない
  assert.ok(result, '結果が返される');
  assert.ok(race, 'レースデータが存在');

  // 検証: 本命20点で絶対軸判定
  assert.strictEqual(race.isAbsoluteAxis, true, '本命20点で絶対軸');

  // 検証: 対抗が連下最上位に降格（差5点のため）
  const exTaikou = race.horses.find(h => h.number === 2);
  assert.strictEqual(exTaikou.role, '連下最上位', '対抗が連下最上位に降格');

  // 検証: 単穴が対抗に昇格
  const exTanana = race.horses.find(h => h.number === 3);
  assert.strictEqual(exTanana.role, '対抗', '単穴が対抗に昇格');

  // 検証: 連下最上位は1頭（元対抗）
  const renkaTopList = race.horses.filter(h => h.role === '連下最上位');
  assert.strictEqual(renkaTopList.length, 1, '連下最上位は1頭（元対抗）');

  // 検証: displayScore計算が正しい
  const honmei = race.horses.find(h => h.number === 1);
  assert.strictEqual(honmei.displayScore, 90, 'displayScore = 20 + 70');

  // 検証: mark付与が正しい
  assert.strictEqual(honmei.mark, '◎', '本命の印は◎');

  console.log('✅ Test 4 PASSED');
}

/**
 * テストケース5: rawScore=0の場合displayScore=0
 */
function testZeroRawScoreHandling() {
  console.log('\n━━━ Test 5: rawScore=0の場合displayScore=0 ━━━');

  const input = {
    date: '2026-01-30',
    venue: '大井',
    venueCode: 'OI',
    totalRaces: 1,
    races: [
      {
        raceNumber: 5,
        raceName: 'テストレース5',
        horses: [
          { number: 1, name: '本命馬', rawScore: 18, role: '本命' },
          { number: 2, name: '対抗馬', rawScore: 14, role: '対抗' },
          { number: 3, name: '単穴馬', rawScore: 10, role: '単穴' },
          { number: 4, name: '無印馬', rawScore: 0, role: '無' }  // 0点
        ]
      }
    ]
  };

  const result = adjustPrediction(input);
  const race = result.races[0];

  // 検証: rawScore=0の場合displayScore=0
  const muHorse = race.horses.find(h => h.number === 4);
  assert.strictEqual(muHorse.displayScore, 0, 'rawScore=0の場合displayScore=0');
  assert.strictEqual(muHorse.mark, '-', '無印の印は-');

  console.log('✅ Test 5 PASSED');
}

/**
 * テストケース6: 馬データがない場合（シンプルフォーマット）
 */
function testNoHorseData() {
  console.log('\n━━━ Test 6: 馬データがない場合（シンプルフォーマット） ━━━');

  const input = {
    date: '2026-01-23',
    venue: '船橋',
    venueCode: 'FU',
    totalRaces: 1,
    races: [
      {
        raceNumber: 11,
        raceName: '鯛ノ浦特別',
        horses: [],  // 馬データなし
        bettingLines: {
          umatan: {
            main: ['3-10', '10-3'],
            sub: ['7-9', '9-10']
          }
        }
      }
    ]
  };

  const result = adjustPrediction(input);
  const race = result.races[0];

  // 検証: hasHorseData=false
  assert.strictEqual(race.hasHorseData, false, 'hasHorseData=false');

  // 検証: isAbsoluteAxis=null
  assert.strictEqual(race.isAbsoluteAxis, null, 'isAbsoluteAxis=null');

  // 検証: 買い目はそのまま
  assert.ok(race.bettingLines, '買い目データは保持される');

  console.log('✅ Test 6 PASSED');
}

/**
 * 全テスト実行
 */
function runAllTests() {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║   adjustPrediction.js テスト実行                      ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  try {
    testRoleSwapOn4PointDifference();
    testHonmeiDemotionOn15OrLess();
    testRenkaLimitTo3Horses();
    testSafeHandlingWithoutRenkaTop();
    testZeroRawScoreHandling();
    testNoHorseData();

    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║   ✅ 全テスト成功！ (6/6 PASSED)                      ║');
    console.log('╚═══════════════════════════════════════════════════════╝\n');
  } catch (error) {
    console.error('\n❌ テスト失敗:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// テスト実行
runAllTests();
