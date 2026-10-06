// 的中実績の点数・回収率は表示した買い目どおり（docs/BET_POINT_LOGIC.md 2026-10-06）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { umatanLinePoints, racePoints, honestDay, applyHonestBetting } from './honestBetting.js';

test('1 行の点数: → は相手数・↔ は相手数×2・抑えは含めない', () => {
  assert.equal(umatanLinePoints('3→5.7.8.10.12(抑え9.14)'), 5);
  assert.equal(umatanLinePoints('9↔1.2.3.6.12(抑え5.8.11)'), 10);
  assert.equal(umatanLinePoints('壊れた'), 0);
});

test('レース・日: 通常 20 点・メイン 5 点で投資額と回収率を出す／買い目が無い日は回収率を出さない', () => {
  const normal = { bettingLines: ['9↔1.2.3.6.12', '12↔1.2.3.6.9'], isHit: true, umatan: { payout: 1200 } };
  const main = { bettingLines: ['3→5.7.8.10.12(抑え9)'], isHit: false, umatan: { payout: 5000 } };
  assert.equal(racePoints(normal), 20);
  assert.equal(racePoints(main), 5);
  const h = honestDay({ races: [normal, main] });
  assert.deepEqual([h.totalBetPoints, h.totalInvestment, h.totalPayout, h.recoveryRate], [25, 2500, 1200, 48]);
  assert.equal(honestDay({ races: [normal, { isHit: true }] }).recoveryRate, null, '買い目の記録が無いレースがあれば出さない');
  const e = applyHonestBetting({ totalPayout: 1200, races: [normal, main], betPointsPerRace: 5, returnRate: 480 });
  assert.equal(e.honest, true); assert.equal(e.returnRate, 48); assert.equal(e.races[0].betPoints, 20); assert.equal(e.betAmount, 2500);
  assert.equal(applyHonestBetting({ races: [{}] }).honest, false);
});
