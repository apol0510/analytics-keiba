import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleUmatanByPayout, settleUmatanRace, settleSanrenpukuByPayout, normalizePayoutList } from './payoutHit.js';
import { checkUmatanHitWithOsae } from './umatanHit.js';

// 同着の結果ファイルの形（keiba-data-shared）: 同着の馬は results から 1 頭落ち、払戻表にだけ現れる
const deadHeatFirst = {
  results: [{ rank: 1, number: 3 }, { rank: 3, number: 9 }, { rank: 4, number: 2 }],
  payouts: { umatan: [{ combination: '3-6', payout: 3860 }, { combination: '6-3', payout: 1760 }], sanrenpuku: [{ combination: '3-6-9', payout: 31970 }] },
};

test('1 着同着: 着順では不的中だが、払戻表の 2 組とも買っていれば的中・払戻は合計', () => {
  const lines = ['6↔3.5.7(抑え1)'];
  assert.equal(checkUmatanHitWithOsae(lines[0], deadHeatFirst), false); // 従来の判定は 3-9 を 1-2 着と読む
  const r = settleUmatanByPayout(lines, deadHeatFirst.payouts.umatan);
  assert.equal(r.isHit, true);
  assert.equal(r.payout, 3860 + 1760);
  assert.deepEqual(r.hitLines, lines);
});

test('片方向（→）は買った向きの組だけを数える', () => {
  const r = settleUmatanByPayout(['6→3.5'], deadHeatFirst.payouts.umatan);
  assert.equal(r.payout, 1760);
  assert.deepEqual(r.matched.map((m) => m.combination), ['6-3']);
});

test('2 着同着: 払戻表の先頭でない組で的中しても、その組の払戻を載せる', () => {
  const payouts = [{ combination: '4-1', payout: 1390 }, { combination: '4-8', payout: 1730 }];
  assert.equal(settleUmatanByPayout(['8↔4.5'], payouts).payout, 1730);
  assert.equal(settleUmatanByPayout(['4↔1.8'], payouts).payout, 3120);
});

test('抑えは実績では含め、本線だけの判定では含めない', () => {
  const payouts = [{ combination: '2-7', payout: 900 }];
  assert.equal(settleUmatanByPayout(['2↔5(抑え7)'], payouts).isHit, true);
  assert.equal(settleUmatanByPayout(['2↔5(抑え7)'], payouts, { includeOsae: false }).isHit, false);
});

test('払戻表が無い・崩れているときは null（呼び出し側が着順で判定する）', () => {
  assert.equal(settleUmatanByPayout(['1↔2'], undefined), null);
  assert.equal(settleUmatanByPayout(['1↔2'], []), null);
  assert.equal(settleUmatanByPayout(['1↔2'], [{ combination: 'x', payout: 100 }]), null);
  assert.equal(normalizePayoutList([{ combination: '1-2', payout: '1,230' }], 2)[0].payout, 1230);
});

test('settleUmatanRace: 外れは払戻表の先頭の組を結果として残し、払戻表が 2 組以上（同着）のときだけ payoutTable を持つ', () => {
  const hit = settleUmatanRace(['6↔3'], deadHeatFirst, checkUmatanHitWithOsae);
  const table = [{ combination: '3-6', payout: 3860 }, { combination: '6-3', payout: 1760 }];
  assert.deepEqual(hit.umatan, { combination: '3-6', payout: 5620, payoutTable: table });
  const miss = settleUmatanRace(['1↔2'], deadHeatFirst, checkUmatanHitWithOsae);
  assert.equal(miss.isHit, false);
  assert.deepEqual(miss.umatan, { combination: '3-6', payout: 3860, payoutTable: table });
  const single = settleUmatanRace(['1↔2'], { results: [{ number: 1 }, { number: 2 }], payouts: { umatan: [{ combination: '1-2', payout: 500 }] } }, checkUmatanHitWithOsae);
  assert.deepEqual(single.umatan, { combination: '1-2', payout: 500 });
});

test('settleUmatanRace: 払戻表が無ければ従来の着順判定', () => {
  const r = settleUmatanRace(['1↔2'], { results: [{ number: 2 }, { number: 1 }] }, checkUmatanHitWithOsae);
  assert.equal(r.isHit, true);
  assert.deepEqual(r.umatan, { combination: null, payout: null });
});

test('三連複: 同着の馬を含む組でも払戻表にあれば的中・3 着同着で 2 組なら買った組の合計', () => {
  assert.equal(settleSanrenpukuByPayout([[6, 9, 3]], deadHeatFirst.payouts.sanrenpuku).payout, 31970);
  const two = [{ combination: '1-16-17', payout: 900 }, { combination: '7-16-17', payout: 1240 }];
  assert.equal(settleSanrenpukuByPayout([[16, 17, 1], [16, 17, 7], [16, 17, 2]], two).payout, 2140);
  assert.equal(settleSanrenpukuByPayout([[16, 17, 7]], two).payout, 1240);
  assert.equal(settleSanrenpukuByPayout([[1, 2, 3]], two).hit, false);
  assert.equal(settleSanrenpukuByPayout([[1, 2, 3]], null), null);
});

test('再判定スクリプト: 同着の払戻表を持つレースは着順でなく払戻表で判定し、再実行で訂正を戻さない', async () => {
  const { recomputeEntryWithOsae } = await import('../../../scripts/recalculate-umatan-archive-with-osae.mjs');
  const table = [{ combination: '3-6', payout: 3860 }, { combination: '6-3', payout: 1760 }];
  const entry = {
    betAmount: 1000,
    races: [
      // 保存した着順は 1 着 3・2 着 9（同着の 6 が落ちている）。3-9 を買っていても払戻は無い
      { bettingLines: ['3↔9'], result: { first: { number: 3 }, second: { number: 9 } }, isHit: false, hitLines: [], umatan: { combination: '3-6', payout: 3860, payoutTable: table } },
      { bettingLines: ['6↔3'], result: { first: { number: 3 }, second: { number: 9 } }, isHit: true, hitLines: ['6↔3'], umatan: { combination: '3-6', payout: 5620, payoutTable: table } },
    ],
  };
  const out = recomputeEntryWithOsae(entry);
  assert.equal(out.races[0].isHit, false);
  assert.equal(out.races[1].isHit, true);
  assert.equal(out.totalPayout, 5620);
  assert.deepEqual(recomputeEntryWithOsae(out), out);
});
