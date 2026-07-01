/**
 * importResultsBetPoints.test.js (analytics-keiba) — Phase 2 統合テスト（Node標準 assert）
 *
 * 南関 archive 生成が「案1（実買い目ユニーク組数）」に接続されたことを検証する。
 * 実行: node scripts/importResultsBetPoints.test.js （astro-site 直下から）
 *
 * 検証観点（AK/KI 共通の期待値を用いる = parity）:
 *   - 払戻を変えても購入点数は不変（払戻逆算していない）
 *   - 抑え・補欠が点数に含まれる / 複数行の重複組が dedup される
 *   - betPoints × 100 = betAmount / totalPayout ÷ betAmount = returnRate
 *   - 的中(isHit)・払戻(umatan)・hitLines は改変されない
 *   - 旧 getBetPoints が南関 archive 生成に残っていない
 *   - JRA(importResultsJra.js) の getBetPoints は保持（未変更）
 */
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeNankanUmatanArchiveTotals } from './importResults.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e && e.message}`); } };

// 抑え込み・双方向・dedup を含む決定的な raceResults（AK/KI 共通の parity fixture）
const makeRaces = () => ([
  { raceNumber: 1, venue: '大井', isHit: true,  hitLines: ['3↔5'], umatan: { combination: '3-5', payout: 1200 }, bettingLines: ['3↔5.7(抑え9)'] }, // 相手 5,7,9 → 6組
  { raceNumber: 2, venue: '大井', isHit: false, hitLines: [],       umatan: { combination: null, payout: null }, bettingLines: ['4↔1.2', '1↔4.2'] },   // 4-1/1-4 が両行で重複 → dedup 6組
  { raceNumber: 3, venue: '大井', isHit: true,  hitLines: ['6↔2'], umatan: { combination: '6-2', payout: 800 },  bettingLines: ['6↔2.8'] },            // 相手 2,8 → 4組
]);
// 期待: R1=6, R2=6, R3=4 → totalBetPoints=16, betAmount=1600
const EXPECTED = { r1: 6, r2: 6, r3: 4, total: 16, betAmount: 1600 };

t('per-race betPoints = 実買い目ユニーク組数（抑え込み・双方向・dedup）', () => {
  const { enrichedRaces } = computeNankanUmatanArchiveTotals(makeRaces(), 2000);
  assert.strictEqual(enrichedRaces[0].betPoints, EXPECTED.r1);
  assert.strictEqual(enrichedRaces[1].betPoints, EXPECTED.r2); // 重複行 dedup
  assert.strictEqual(enrichedRaces[2].betPoints, EXPECTED.r3);
});

t('totalBetPoints = Σ betPoints / betAmount = totalBetPoints × 100', () => {
  const totalPayout = 1200 + 800;
  const r = computeNankanUmatanArchiveTotals(makeRaces(), totalPayout);
  assert.strictEqual(r.totalBetPoints, EXPECTED.total);
  assert.strictEqual(r.betAmount, EXPECTED.total * 100);
  assert.strictEqual(r.betAmount, EXPECTED.betAmount);
});

t('returnRate = totalPayout ÷ betAmount × 100', () => {
  const totalPayout = 2000;
  const r = computeNankanUmatanArchiveTotals(makeRaces(), totalPayout);
  assert.strictEqual(r.returnRate, (totalPayout / r.betAmount) * 100);
  assert.strictEqual(Number(r.returnRate.toFixed(1)), 125.0); // 2000 / 1600 * 100
});

t('払戻額を変えても購入点数・投資額は不変（払戻逆算していない）', () => {
  const a = computeNankanUmatanArchiveTotals(makeRaces(), 500);
  const b = computeNankanUmatanArchiveTotals(makeRaces(), 999999);
  assert.strictEqual(a.totalBetPoints, b.totalBetPoints);
  assert.strictEqual(a.betAmount, b.betAmount);
  assert.notStrictEqual(a.returnRate, b.returnRate); // 分子(払戻)だけが回収率に効く
});

t('抑え・補欠を含めると点数が増える', () => {
  const withOsae = computeNankanUmatanArchiveTotals([{ bettingLines: ['3↔5.7(抑え9.11)'], umatan: {} }], 0);
  const without = computeNankanUmatanArchiveTotals([{ bettingLines: ['3↔5.7'], umatan: {} }], 0);
  assert.strictEqual(without.totalBetPoints, 4);
  assert.strictEqual(withOsae.totalBetPoints, 8); // 相手 5,7,9,11 × 双方向
});

t('的中(isHit)・払戻(umatan)・hitLines は改変されない', () => {
  const src = makeRaces();
  const { enrichedRaces } = computeNankanUmatanArchiveTotals(src, 2000);
  assert.strictEqual(enrichedRaces[0].isHit, true);
  assert.deepStrictEqual(enrichedRaces[0].hitLines, ['3↔5']);
  assert.deepStrictEqual(enrichedRaces[0].umatan, { combination: '3-5', payout: 1200 });
  assert.strictEqual(enrichedRaces[1].isHit, false);
  // 入力オブジェクトの hit 系フィールドは不変（spread なので新オブジェクト・値は保持）
  assert.strictEqual(src[0].isHit, true);
});

t('旧 getBetPoints が南関 archive 生成コードに残っていない', () => {
  const src = readFileSync(join(HERE, 'importResults.js'), 'utf-8');
  const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); // コメント除去
  assert.ok(!/getBetPoints/.test(codeOnly), 'getBetPoints がコード中に残存している');
  assert.ok(/countUmatanUniquePoints/.test(codeOnly), 'countUmatanUniquePoints へ接続されていない');
});

t('JRA(importResultsJra.js) の getBetPoints は保持（未変更）', () => {
  const jra = readFileSync(join(HERE, 'importResultsJra.js'), 'utf-8');
  assert.ok(/function getBetPoints/.test(jra), 'JRA の getBetPoints が失われている（JRAは対象外・変更禁止）');
});

console.log(`\nimportResultsBetPoints.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
