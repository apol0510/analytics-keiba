import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SIMULATION_V2, simulatedPointsV2, summarizeSimulationV2, monthlySimulationV2 } from './simulatedRecoveryV2.js';
import { summarizeLegacySimulation } from './legacySimulation.js';

const day = (date, payouts) => ({ date, totalRaces: payouts.length, races: payouts.map((p) => ({ isHit: p > 0, umatan: { payout: p } })) });
const data = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}`, import.meta.url), 'utf8'));
// 固定後の再現確認の範囲。新しい日が増えても値が動かないよう終端を固定する
const END = '2026-11-05';
const nankan = data('archiveResults.json').filter((e) => e.date >= '2026-04-15' && e.date <= END);
const jra = data('archiveResultsJra.json').filter((e) => e.date <= END);

test('パラメータは ak-sim-v2 として固定されている', () => {
  assert.equal(SIMULATION_V2.version, 'ak-sim-v2');
  assert.deepEqual([...SIMULATION_V2.tiers], [10, 18, 26, 34]);
  assert.equal(SIMULATION_V2.floorPercent, 125);
  assert.equal(SIMULATION_V2.unitYen, 100);
  assert.ok(Object.isFrozen(SIMULATION_V2) && Object.isFrozen(SIMULATION_V2.tiers));
});

test('閾値の境界（12R）', () => {
  assert.equal(simulatedPointsV2(51000, 12), 34);
  assert.equal(simulatedPointsV2(50999, 12), 26);
  assert.equal(simulatedPointsV2(39000, 12), 26);
  assert.equal(simulatedPointsV2(38999, 12), 18);
  assert.equal(simulatedPointsV2(27000, 12), 18);
  assert.equal(simulatedPointsV2(26999, 12), 10);
  assert.equal(simulatedPointsV2(0, 12), 10);
  assert.equal(simulatedPointsV2(100, 0), 10);
});

test('結果は入力から計算され、固定値へ上書きしない', () => {
  const a = summarizeSimulationV2([day('2026-01-01', [20000, 0])]);
  const b = summarizeSimulationV2([day('2026-01-01', [2000, 0])]);
  assert.equal(a.investment, 2 * 34 * 100);
  assert.equal(b.investment, 2 * 10 * 100);
  assert.equal(a.weightedRate, 294.1);
  assert.equal(b.weightedRate, 100);
  assert.notEqual(a.weightedRate, 150);
  assert.deepEqual(summarizeSimulationV2([day('2026-01-01', [2000, 0])]), b);
});

test('不的中の払戻を数えず、空の入力は null', () => {
  const s = summarizeSimulationV2([{ date: '2026-01-01', totalRaces: 1, races: [{ isHit: false, umatan: { payout: 9999 } }] }]);
  assert.equal(s.payout, 0);
  assert.equal(summarizeSimulationV2([]).weightedRate, null);
});

test('月別は日付順で、合計は全体と一致する', () => {
  const rows = [day('2026-02-01', [3000]), day('2026-01-01', [1000])];
  const m = monthlySimulationV2(rows);
  assert.deepEqual(m.map((x) => x.month), ['2026-01', '2026-02']);
  assert.equal(m.reduce((a, x) => a + x.payout, 0), summarizeSimulationV2(rows).payout);
});

test('実データ: 固定した範囲で v2 の値を再現する', () => {
  const n = summarizeSimulationV2(nankan);
  const j = summarizeSimulationV2(jra);
  const all = summarizeSimulationV2([...nankan, ...jra]);
  assert.equal(n.weightedRate, 146.2);
  assert.equal(j.weightedRate, 156.9);
  assert.equal(all.weightedRate, 153.2);
  assert.equal(all.meanDailyRate, 150.1);
  assert.equal(all.races, 4368);
  assert.equal(all.payout, 10701720);
});

test('実データ: 旧 4 段階方式の値は v2 の追加で変わらない', () => {
  const old = summarizeLegacySimulation([...nankan, ...jra]);
  assert.equal(old.weightedRate, 211.5);
  assert.equal(old.meanDailyRate, 193.7);
  assert.equal(summarizeLegacySimulation(nankan).weightedRate, 175.2);
  assert.equal(summarizeLegacySimulation(jra).weightedRate, 235.8);
});
