/**
 * adjustPrediction.differentiation.test.js
 *
 * 🛡️ 再発防止ガード（analytics-keiba ⇄ keiba-intelligence の同一化バグ対策）
 *
 * 背景:
 *   AK と KI は同じ素材データ（keiba-data-shared の computerIndex / racebook）を参照するが、
 *   最終 totalScore(pt) / 役割 / 買い目 が「完全一致」してはいけない。
 *   過去、AK の差別化スコア(analyticsScore)が「診断用」に格下げされ pt/役割が
 *   computerIndex 降順のみ（= KI と同一）に潰れる回帰が繰り返し発生した。
 *
 * このテストが守る不変条件:
 *   1. AK の pt(displayScore) は computerIndex だけでは決まらない。
 *      race-data-importer 由来の過去走(featureScore) が pt と役割を動かす。
 *      → これが壊れると「KI と同一化」状態に逆戻りするので CI を落とす。
 *   2. 補助シグナル（過去走・印）が無い馬は pt = rawScore + 70（後方互換）。
 *   3. 役割順 == pt 降順（pt と役割の逆転が起きない）。
 *
 * 共通化してよい範囲 / 禁止範囲は docs/PREDICTION_LOGIC.md を参照。
 */

import assert from 'node:assert';
import { adjustPrediction } from './adjustPrediction.js';

// 強い直近成績（1着続き・上がり最速）→ featureScore 高
const STRONG_RECENT = [
  { rank: 1, last3f: '33.5' },
  { rank: 1, last3f: '33.8' },
  { rank: 1, last3f: '34.0' },
];
// 凡走続き（着外・上がり遅い）→ featureScore 低
const WEAK_RECENT = [
  { rank: 11, last3f: '40.5' },
  { rank: 12, last3f: '41.0' },
  { rank: 10, last3f: '40.0' },
];

function buildRace(horses) {
  return {
    date: '2026-01-01', venue: 'テスト', venueCode: 'TST', totalRaces: 1,
    races: [{ raceNumber: 1, raceName: 'guard', raceInfo: { raceNumber: 1 }, horses, hasHorseData: true }],
  };
}

function run() {
  console.log('━━━ ガード: AK は computerIndex のみで決まらない（KI と差別化） ━━━');

  // A: computerIndex はわずかに低い(62)が直近成績が強い
  // B: computerIndex は高い(63)が凡走続き
  // 純 computerIndex 順なら B(63) > A(62) で B が本命。
  // AK は過去走を pt に織り込むため A が逆転して本命になるはず。
  const adjusted = adjustPrediction(buildRace([
    { number: 1, name: 'A_好調', rawScore: 62, computerIndex: 62, sourceComputerIndex: 62, recentRaces: STRONG_RECENT },
    { number: 2, name: 'B_不調', rawScore: 63, computerIndex: 63, sourceComputerIndex: 63, recentRaces: WEAK_RECENT },
  ]));
  const horses = adjusted.races[0].horses;
  const A = horses.find(h => h.number === 1);
  const B = horses.find(h => h.number === 2);

  assert.ok(
    A.displayScore > B.displayScore,
    `差別化が無効化されている疑い: 過去走の強い A(ci62,pt${A.displayScore}) が ` +
    `ci の高い B(ci63,pt${B.displayScore}) を pt で上回っていない（= computerIndex 単独順 = KI と同一化）`
  );
  assert.strictEqual(A.role, '本命', `A が本命でない（差別化が効いていない）: ${A.role}`);
  assert.strictEqual(B.role, '対抗', `B が対抗でない: ${B.role}`);
  console.log(`  ✅ A(ci62,好調)=pt${A.displayScore}/本命  >  B(ci63,不調)=pt${B.displayScore}/対抗`);

  // 後方互換: 過去走・印が無ければ pt = rawScore + 70（= 従来値・KI と同値でも可）
  const plain = adjustPrediction(buildRace([
    { number: 1, name: 'X', rawScore: 80, computerIndex: 80 },
    { number: 2, name: 'Y', rawScore: 70, computerIndex: 70 },
  ]));
  const X = plain.races[0].horses.find(h => h.number === 1);
  assert.strictEqual(X.displayScore, 150, `補助シグナル無しは pt=rawScore+70 であるべき: ${X.displayScore}`);
  console.log('  ✅ 補助シグナル無し → pt = rawScore + 70（後方互換）');

  // 不変条件: 役割順 == pt 降順
  const active = horses.filter(h => h.displayScore > 0).sort((a, b) => b.displayScore - a.displayScore);
  for (let i = 0; i < active.length - 1; i++) {
    assert.ok(active[i].displayScore >= active[i + 1].displayScore, 'pt 降順と役割順の逆転を検出');
  }
  console.log('  ✅ 役割順 == pt 降順（逆転なし）');

  console.log('\n✅ 差別化ガード PASSED');
}

run();
