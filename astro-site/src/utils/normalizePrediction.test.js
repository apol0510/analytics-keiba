/**
 * normalizePrediction.test.js
 *
 * normalizePrediction関数のテスト
 * Node標準のassertを使用
 */

import assert from 'assert';
import {
  detectFormat,
  normalizeDetailed,
  normalizeSimple,
  normalizePrediction,
  normalizeAndAdjust
} from './normalizePrediction.js';

/**
 * テストケース1: フォーマット検出（詳細フォーマット）
 */
function testDetectFormatDetailed() {
  console.log('\n━━━ Test 1: フォーマット検出（詳細フォーマット） ━━━');

  const input = {
    raceDate: '2026-01-30',
    track: '大井',
    totalRaces: 1,
    races: [
      {
        raceInfo: {
          raceNumber: '10R',
          raceName: 'テストレース'
        },
        horses: [
          { number: 1, name: 'テスト馬', totalScore: 17, assignment: '本命' }
        ]
      }
    ]
  };

  const format = detectFormat(input);
  assert.strictEqual(format, 'detailed', 'フォーマットは詳細');

  console.log('✅ Test 1 PASSED');
}

/**
 * テストケース2: フォーマット検出（シンプルフォーマット）
 */
function testDetectFormatSimple() {
  console.log('\n━━━ Test 2: フォーマット検出（シンプルフォーマット） ━━━');

  const input = {
    date: '2026-01-23',
    venue: '船橋',
    venueCode: 'FU',
    races: [
      {
        raceNumber: 11,
        raceName: '鯛ノ浦特別',
        bettingLines: {
          umatan: {
            main: ['3-10', '10-3']
          }
        }
      }
    ]
  };

  const format = detectFormat(input);
  assert.strictEqual(format, 'simple', 'フォーマットはシンプル');

  console.log('✅ Test 2 PASSED');
}

/**
 * テストケース3: 詳細フォーマット→NormalizedPrediction（roleが保持されること）
 */
function testNormalizeDetailedKeepsRoles() {
  console.log('\n━━━ Test 3: 詳細フォーマット→NormalizedPrediction（roleが保持されること） ━━━');

  const input = {
    raceDate: '2026-01-30',
    track: '大井',
    totalRaces: 1,
    races: [
      {
        raceInfo: {
          raceNumber: '10R',
          raceName: '初凪特別競走'
        },
        horses: [
          {
            number: 13,
            name: 'ボラボラフレイバー',
            totalScore: 17,
            assignment: '本命',
            marks: { '印3': '○', '印2': '◎', '印1': '○', '印0': '○' } // 秘匿される
          },
          {
            number: 9,
            name: 'デスタン',
            totalScore: 13,
            assignment: '対抗',
            marks: { '印3': '◎', '印2': 'svg', '印1': '△', '印0': '◎' }
          },
          {
            number: 2,
            name: 'グリスタン',
            totalScore: 12,
            assignment: '単穴',
            marks: { '印3': '△', '印2': '▲', '印1': '◎', '印0': '▲' }
          },
          {
            number: 11,
            name: 'トクシーティグレ',
            totalScore: 9,
            assignment: '連下最上位',
            marks: { '印3': '△', '印2': '○', '印1': 'svg', '印0': 'svg' }
          },
          {
            number: 12,
            name: 'フタバサクセス',
            totalScore: 8,
            assignment: '連下',
            marks: { '印3': '▲', '印2': '△', '印1': '▲', '印0': '△' }
          },
          {
            number: 7,
            name: 'メイショウカジボウ',
            totalScore: 2,
            assignment: '補欠',
            marks: { '印3': '△', '印2': '-', '印1': '-', '印0': '△' }
          }
        ]
      }
    ]
  };

  const result = normalizeDetailed(input);

  // 検証: メタデータ
  assert.strictEqual(result.date, '2026-01-30', '日付が正しい');
  assert.strictEqual(result.venue, '大井', '競馬場が正しい');
  assert.strictEqual(result.venueCode, 'OI', '競馬場コードが正しい');
  assert.strictEqual(result.totalRaces, 1, 'レース数が正しい');

  // 検証: レースデータ
  const race = result.races[0];
  assert.strictEqual(race.raceNumber, 10, 'レース番号が正しい（"10R"→10）');
  assert.strictEqual(race.raceName, '初凪特別競走', 'レース名が正しい');
  assert.strictEqual(race.hasHorseData, true, 'hasHorseData=true');

  // 検証: 馬データ
  assert.strictEqual(race.horses.length, 6, '馬データは6頭');

  // 検証: roleが保持されていること
  const honmei = race.horses.find(h => h.number === 13);
  assert.strictEqual(honmei.role, '本命', '本命のroleが保持');
  assert.strictEqual(honmei.rawScore, 17, 'rawScoreが正しい');

  const taikou = race.horses.find(h => h.number === 9);
  assert.strictEqual(taikou.role, '対抗', '対抗のroleが保持');

  const tanana = race.horses.find(h => h.number === 2);
  assert.strictEqual(tanana.role, '単穴', '単穴のroleが保持');

  const renkaTop = race.horses.find(h => h.number === 11);
  assert.strictEqual(renkaTop.role, '連下最上位', '連下最上位のroleが保持（潰されていない）');

  const renka = race.horses.find(h => h.number === 12);
  assert.strictEqual(renka.role, '連下', '連下のroleが保持');

  const hoseki = race.horses.find(h => h.number === 7);
  assert.strictEqual(hoseki.role, '補欠', '補欠のroleが保持');

  // 検証: marks（記者印）は含まれていない
  assert.strictEqual(honmei.marks, undefined, 'marks（記者印）は秘匿される');
  assert.strictEqual(taikou.marks, undefined, 'marks（記者印）は秘匿される');

  console.log('✅ Test 3 PASSED');
}

/**
 * テストケース4: シンプルフォーマット→NormalizedPrediction（horses=[]、hasHorseData=false）
 */
function testNormalizeSimpleNoHorseData() {
  console.log('\n━━━ Test 4: シンプルフォーマット→NormalizedPrediction（horses=[]、hasHorseData=false） ━━━');

  const input = {
    date: '2026-01-23',
    venue: '船橋',
    venueCode: 'FU',
    races: [
      {
        raceNumber: 11,
        raceName: '鯛ノ浦特別',
        bettingLines: {
          umatan: {
            main: ['3-10', '10-3'],
            sub: ['7-9', '9-10']
          }
        }
      }
    ]
  };

  const result = normalizeSimple(input);

  // 検証: メタデータ
  assert.strictEqual(result.date, '2026-01-23', '日付が正しい');
  assert.strictEqual(result.venue, '船橋', '競馬場が正しい');
  assert.strictEqual(result.venueCode, 'FU', '競馬場コードが正しい');

  // 検証: レースデータ
  const race = result.races[0];
  assert.strictEqual(race.raceNumber, 11, 'レース番号が正しい');
  assert.strictEqual(race.raceName, '鯛ノ浦特別', 'レース名が正しい');
  assert.strictEqual(race.hasHorseData, false, 'hasHorseData=false');
  assert.strictEqual(race.isAbsoluteAxis, null, 'isAbsoluteAxis=null（判定不可）');

  // 検証: 馬データは空配列
  assert.strictEqual(Array.isArray(race.horses), true, 'horsesは配列');
  assert.strictEqual(race.horses.length, 0, '馬データは空配列');

  // 検証: 買い目はそのまま保持
  assert.ok(race.bettingLines, '買い目データが保持される');
  assert.ok(race.bettingLines.umatan, '馬単買い目が保持される');

  console.log('✅ Test 4 PASSED');
}

/**
 * テストケース5: normalizePrediction（自動検出）
 */
function testNormalizePredictionAutoDetect() {
  console.log('\n━━━ Test 5: normalizePrediction（自動検出） ━━━');

  // 詳細フォーマット
  const detailedInput = {
    raceDate: '2026-01-30',
    track: '大井',
    totalRaces: 1,
    races: [
      {
        raceInfo: { raceNumber: '5R', raceName: 'テストレース' },
        horses: [
          { number: 1, name: 'テスト馬', totalScore: 18, assignment: '本命' }
        ]
      }
    ]
  };

  const detailedResult = normalizePrediction(detailedInput);
  assert.strictEqual(detailedResult.races[0].hasHorseData, true, '詳細フォーマットを検出');
  assert.strictEqual(detailedResult.races[0].horses[0].role, '本命', 'roleが保持される');

  // シンプルフォーマット
  const simpleInput = {
    date: '2026-01-23',
    venue: '船橋',
    venueCode: 'FU',
    races: [
      {
        raceNumber: 11,
        raceName: '鯛ノ浦特別',
        bettingLines: { umatan: { main: ['3-10'] } }
      }
    ]
  };

  const simpleResult = normalizePrediction(simpleInput);
  assert.strictEqual(simpleResult.races[0].hasHorseData, false, 'シンプルフォーマットを検出');
  assert.strictEqual(simpleResult.races[0].horses.length, 0, '馬データは空');

  console.log('✅ Test 5 PASSED');
}

/**
 * テストケース6: normalizeAndAdjust（hasHorseData=true の場合だけ役割調整が走る）
 */
function testNormalizeAndAdjustAppliesRules() {
  console.log('\n━━━ Test 6: normalizeAndAdjust（hasHorseData=true の場合だけ役割調整が走る） ━━━');

  // hasHorseData=true: 役割調整が走る
  const detailedInput = {
    raceDate: '2026-01-30',
    track: '川崎',
    totalRaces: 1,
    races: [
      {
        raceInfo: { raceNumber: '3R', raceName: 'テストレース' },
        horses: [
          { number: 1, name: '本命馬', totalScore: 18, assignment: '本命' },
          { number: 2, name: '対抗馬', rawScore: 14, assignment: '対抗' },
          { number: 3, name: '単穴馬', totalScore: 12, assignment: '単穴' },
          { number: 4, name: '連下馬1', totalScore: 9, assignment: '連下' },
          { number: 5, name: '連下馬2', totalScore: 8, assignment: '連下' },
          { number: 6, name: '連下馬3', totalScore: 7, assignment: '連下' },
          { number: 7, name: '連下馬4', totalScore: 6, assignment: '連下' },
          { number: 8, name: '連下馬5', totalScore: 5, assignment: '連下' }
        ]
      }
    ]
  };

  const adjustedResult = normalizeAndAdjust(detailedInput);
  const race = adjustedResult.races[0];

  // 検証: displayScoreが計算されている（adjustPredictionが実行された証拠）
  const honmei = race.horses.find(h => h.number === 1);
  assert.strictEqual(honmei.displayScore, 88, 'displayScoreが計算されている（18+70）');

  // 検証: markが生成されている
  assert.strictEqual(honmei.mark, '◎', 'markが生成されている');

  // 検証: 連下が最大3頭に制限されている
  const renkaList = race.horses.filter(h => h.role === '連下');
  assert.strictEqual(renkaList.length, 3, '連下は最大3頭に制限');

  // 検証: 残りの連下は補欠に降格
  const hosekiList = race.horses.filter(h => h.role === '補欠');
  assert.strictEqual(hosekiList.length, 2, '残りの連下2頭は補欠に降格');

  // hasHorseData=false: 役割調整は走らない
  const simpleInput = {
    date: '2026-01-23',
    venue: '船橋',
    venueCode: 'FU',
    races: [
      {
        raceNumber: 11,
        raceName: '鯛ノ浦特別',
        bettingLines: { umatan: { main: ['3-10'] } }
      }
    ]
  };

  const simpleResult = normalizeAndAdjust(simpleInput);
  const simpleRace = simpleResult.races[0];

  // 検証: 馬データがないため調整は走らない
  assert.strictEqual(simpleRace.hasHorseData, false, 'hasHorseData=false');
  assert.strictEqual(simpleRace.horses.length, 0, '馬データは空のまま');
  assert.strictEqual(simpleRace.isAbsoluteAxis, null, 'isAbsoluteAxis=null（判定不可）');

  console.log('✅ Test 6 PASSED');
}

/**
 * 全テスト実行
 */
function runAllTests() {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║   normalizePrediction.js テスト実行                   ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  try {
    testDetectFormatDetailed();
    testDetectFormatSimple();
    testNormalizeDetailedKeepsRoles();
    testNormalizeSimpleNoHorseData();
    testNormalizePredictionAutoDetect();
    testNormalizeAndAdjustAppliesRules();

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
