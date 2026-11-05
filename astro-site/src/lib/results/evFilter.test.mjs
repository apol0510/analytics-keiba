import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  asOfOdds, exactaProbs, fitConditionalLogit, fitLambda, forwardVerdict, selectTickets,
  settleTickets, summarize, ticketEvs, winProbs, zscore,
} from './evFilter.js';
import { buildSpecs, chooseOnDev, MIN_DEV_RACES } from '../../../scripts/verify-ev-filter.mjs';

const tick = (selection, odds, observedAt, ok = true) => ({ selection, odds, observedAt, ok });

test('判定時刻より後のオッズは使わない', () => {
  const odds = asOfOdds([tick('1>2', 10, 100), tick('1>2', 3, 201), tick('2>1', 8, 200)], 200);
  assert.equal(odds.get('1>2'), 10);
  assert.equal(odds.get('2>1'), 8);
});

test('判定時刻までの最新が取消なら、古いオッズへ戻らない', () => {
  assert.equal(asOfOdds([tick('1>2', 10, 100), tick('1>2', 0, 150, false)], 200).has('1>2'), false);
});

test('馬単の確率は全組の合計が 1 で、λ を下げると 2 着の穴を厚くする', () => {
  const nums = [1, 2, 3];
  const p = [0.6, 0.3, 0.1];
  const total = [...exactaProbs(nums, p, 0.8).values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(exactaProbs(nums, p, 0.5).get('1>3') > exactaProbs(nums, p, 1).get('1>3'));
});

test('勝率の学習は勝ち馬に効く特徴量の向きを当てる', () => {
  const races = Array.from({ length: 40 }, () => ({ features: [[1], [0], [-1]], winner: 0 }));
  const beta = fitConditionalLogit(races);
  assert.ok(beta[0] > 0);
  const p = winProbs([[1], [0], [-1]], beta);
  assert.ok(p[0] > p[1] && p[1] > p[2]);
});

test('λ は実際の着順に合う値を選ぶ', () => {
  const r = { numbers: [1, 2, 3], pWin: [0.7, 0.2, 0.1], first: 1, second: 3 };
  assert.equal(fitLambda([r], [0.5, 1.2]), 0.5);
});

test('欠損はレース平均として扱う', () => {
  assert.deepEqual(zscore([NaN, NaN]), [0, 0]);
  assert.equal(zscore([1, NaN, 3])[1], 0);
});

test('ticket 規則は閾値と上下限で組を選び、race 規則は平均 EV で全組を買う', () => {
  const evs = ticketEvs(['1>2', '2>1', '3>1'], new Map([['1>2', 0.2], ['2>1', 0.001], ['3>1', 0.05]]), new Map([['1>2', 7], ['2>1', 2000], ['3>1', 10]]));
  assert.deepEqual(selectTickets(evs, { rule: 'ticket', threshold: 1.2, pMin: 0.005, oddsMax: 100 }), ['1>2']);
  assert.equal(selectTickets(evs, { rule: 'race', threshold: 1.2 }).length, 3);
  assert.deepEqual(selectTickets(evs, { rule: 'race', threshold: 10 }), []);
});

test('オッズの無い組は判定しない', () => {
  assert.equal(ticketEvs(['1>2'], new Map([['1>2', 0.5]]), new Map()).length, 0);
});

test('精算は実払戻で、買わなかった組の的中を含めない', () => {
  const pay = new Map([['1>2', 2500]]);
  assert.deepEqual(settleTickets(['1>2', '2>1'], pay), { points: 2, invest: 200, payout: 2500, hit: true });
  assert.deepEqual(settleTickets(['2>1'], pay), { points: 1, invest: 100, payout: 0, hit: false });
});

test('集計は見送りを分母に含めず、最大ドローダウンを出す', () => {
  const rows = [
    { points: 1, invest: 100, payout: 0, hit: false },
    { points: 0, invest: 0, payout: 0, hit: false },
    { points: 1, invest: 100, payout: 0, hit: false },
    { points: 1, invest: 100, payout: 500, hit: true },
  ];
  const s = summarize(rows, { bootstrap: 100 });
  assert.equal(s.races, 3);
  assert.equal(s.net, 200);
  assert.equal(s.maxDrawdown, 200);
  assert.deepEqual(summarize(rows, { bootstrap: 100 }).roiCi95, s.roiCi95);
});

test('閾値の選定は開発期間だけを見る', () => {
  const dev = (races, hits, roi) => ({ races, hits, roi });
  const a = { dev: dev(MIN_DEV_RACES, 5, 1.1), holdout: dev(50, 5, 0.1) };
  const b = { dev: dev(MIN_DEV_RACES, 5, 1.0), holdout: dev(50, 5, 9) };
  const tiny = { dev: dev(MIN_DEV_RACES - 1, 9, 5), holdout: dev(50, 5, 9) };
  assert.equal(chooseOnDev([a, b, tiny]), a);
  assert.equal(chooseOnDev([tiny]), null);
});

test('forward は標本が足りない間は高い回収率でも合格にしない', () => {
  const cp = { minRaces: 150, minHits: 15, minRoi: 1.2, minRoiCi95Low: 1 };
  assert.equal(forwardVerdict({ races: 40, hits: 6, roi: 3, roiCi95: [1.5, 5] }, cp), 'COLLECTING');
  assert.equal(forwardVerdict({ races: 150, hits: 15, roi: 1.3, roiCi95: [0.9, 1.8] }, cp), 'FAIL');
  assert.equal(forwardVerdict({ races: 150, hits: 15, roi: 1.3, roiCi95: [1.05, 1.8] }, cp), 'PASS');
});

test('事前登録の規則は検証した格子の 1 つで、顧客表示は閉じている', () => {
  const prereg = JSON.parse(readFileSync(new URL('../../../docs/prereg/ak-ev-filter-jra-v1.json', import.meta.url), 'utf8'));
  assert.equal(prereg.customerDisplay, false);
  assert.ok(buildSpecs().some((s) => JSON.stringify(s) === JSON.stringify(prereg.rule)));
  assert.equal(buildSpecs().length, 36);
});
