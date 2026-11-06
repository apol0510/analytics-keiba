import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyBetPoints, summarizeLegacySimulation } from './legacySimulation.js';

const day = (payouts) => ({ totalRaces: payouts.length, races: payouts.map((p) => ({ isHit: p > 0, umatan: { payout: p } })) });

test('#113 で削除した閾値どおりに点数を選ぶ', () => {
  assert.equal(legacyBetPoints(14400, 12), 12);
  assert.equal(legacyBetPoints(14399, 12), 10);
  assert.equal(legacyBetPoints(12000, 12), 10);
  assert.equal(legacyBetPoints(9600, 12), 8);
  assert.equal(legacyBetPoints(7200, 12), 6);
  assert.equal(legacyBetPoints(0, 12), 6);
  assert.equal(legacyBetPoints(100, 0), 6);
});

test('分母は結果の払戻で変わる（事後シミュレーションであることの固定）', () => {
  const low = summarizeLegacySimulation([day([1200, 0])]);
  const high = summarizeLegacySimulation([day([2400, 0])]);
  assert.equal(low.investment, 2 * 6 * 100);
  assert.equal(high.investment, 2 * 12 * 100);
});

test('加重平均と単純平均を別々に返し、不的中の払戻は数えない', () => {
  const s = summarizeLegacySimulation([day([1200, 0]), day([0, 0])]);
  assert.equal(s.payout, 1200);
  assert.equal(s.investment, 1200 + 1200);
  assert.equal(s.weightedRate, 50);
  assert.equal(s.meanDailyRate, 50);
  assert.deepEqual(s.pointDays, { 6: 2, 8: 0, 10: 0, 12: 0 });
});

test('空の入力は null', () => {
  assert.equal(summarizeLegacySimulation([]).weightedRate, null);
});
