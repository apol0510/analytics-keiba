import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUmatanHit, checkUmatanHitWithOsae, umatanTickets } from '../src/lib/results/umatanHit.js';
import { summarize } from './report-umatan-with-osae.mjs';
import { recomputeEntryWithOsae } from './recalculate-umatan-archive-with-osae.mjs';

const res = (a, b) => ({ results: [{ number: a }, { number: b }] });

test('2026-11-05 船橋 10R: 抑えの 2 着は公開判定で外れ、含める判定で的中', () => {
  const line = '6↔5.8.10.12.14(抑え1.2.7.9.11.13)';
  assert.equal(checkUmatanHit(line, res(6, 9)), false);
  assert.equal(checkUmatanHitWithOsae(line, res(6, 9)), true);
});

test('2026-11-05 船橋 12R: 対抗軸の行の抑えで的中', () => {
  assert.equal(checkUmatanHitWithOsae('10↔2.4.5.11.13(抑え1.3.6.7.12.14)', res(10, 3)), true);
});

test('一方向 → は抑えでも裏目を的中にしない。全角括弧も読む', () => {
  assert.equal(checkUmatanHitWithOsae('4→2.5(抑え14)', res(14, 4)), false);
  assert.equal(checkUmatanHitWithOsae('4→2.5（抑え14）', res(4, 14)), true);
});

test('行に無い馬（不要馬）は的中にしない', () => {
  assert.equal(checkUmatanHitWithOsae('6↔5.8(抑え1)', res(6, 9)), false);
});

test('実点数: 双方向は 2 点、行をまたぐ同じ組は 1 点、抑えは指定時だけ数える', () => {
  const lines = ['1↔2.3(抑え4)', '2↔1.3(抑え4)'];
  assert.equal(umatanTickets(lines).size, 6);
  assert.equal(umatanTickets(lines, { includeOsae: true }).size, 10);
  assert.equal(umatanTickets(['1→2.3(抑え4)'], { includeOsae: true }).size, 3);
});

test('集計: 欠損レースは数えず、回収率は 2 つの分母で出す', () => {
  const s = summarize([{ races: [
    { bettingLines: ['1→2(抑え3)'], aiBet: { points: 1 }, result: { first: { number: 1 }, second: { number: 3 } }, umatan: { payout: 1000 } },
    { bettingLines: [], result: {} },
  ] }]);
  assert.equal(s.races, 1);
  assert.equal(s.hitHonsen, 0);
  assert.equal(s.hitWithOsae, 1);
  assert.equal(s.recoveryOnAiPoints, 1000);
  assert.equal(s.recoveryOnActualTickets, 500);
});

test('再計算: 全レースに同じ規則を当て、再実行しても変わらず、買い目行の無い開催は据え置く', () => {
  const race = (first, second, payout) => ({ bettingLines: ['1→2(抑え3)'], isHit: false, hitLines: [], result: { first: { number: first }, second: { number: second } }, umatan: { payout } });
  const entry = { betAmount: 1000, hitRaces: 0, totalPayout: 0, races: [race(1, 3, 500), race(9, 8, 900)] };
  const once = recomputeEntryWithOsae(entry);
  assert.equal(once.hitRaces, 1);
  assert.equal(once.missRaces, 1);
  assert.equal(once.totalPayout, 500);
  assert.equal(once.races[1].isHit, false);
  assert.deepEqual(recomputeEntryWithOsae(once), once);
  const legacy = { races: [{ isHit: true, payout: 100 }] };
  assert.equal(recomputeEntryWithOsae(legacy), legacy);
});

test('少点数の収支: 買った組に当たり組があるときだけ払戻を数え、分母は買った組の点数', async () => {
  const { settle, total } = await import('./report-umatan-narrow.mjs');
  const rows = [settle(new Set(['1>2', '2>1']), { combination: '1-2', payout: 900 }), settle(new Set(['1>2']), { combination: '2-1', payout: 5000 })];
  assert.deepEqual(rows[1], { points: 1, hit: false, payout: 0 });
  const t = total(rows);
  assert.equal(t.points, 3);
  assert.equal(t.payout, 900);
  assert.equal(t.recovery, 300);
});
