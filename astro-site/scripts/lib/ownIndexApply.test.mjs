// 独自指数（OWN_INDEX_V1）の取込（scripts/lib/ownIndexApply.mjs）と表示（getHorseAiIndex）・相手の選び方（partnerPt）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOwnIndex, computerHorseIndex, loadJockeyStats, ownIndexOn, OWN_INDEX_START } from './ownIndexApply.mjs';
import { getHorseAiIndex } from '../../src/lib/shared-prediction-logic.js';
import { getTop5Challengers } from '../../src/utils/mainRaceBetting.js';

const run = (corner, finish, f3) => ({ passingOrder: `${corner}-${corner}`, finish, final3F: String(f3) });
/** computer JSON（古い順の pastRaces）。2 番は 1 番と指数差 1 で、先行・前走・騎手・上がりすべて上 */
function computer() {
  return {
    venue: '船橋',
    races: [{
      raceNumber: 1,
      horses: Array.from({ length: 12 }, (_, i) => {
        const number = i + 1;
        const good = number === 2;
        const bad = number === 1;
        return {
          number, name: `テスト${number}`, computerIndex: number === 2 ? 89 : 90 - i * 3,
          jockey: good ? '好調騎手' : bad ? '不振騎手' : `騎手${number}`,
          pastRaces: [run(6, 6, 39), bad ? run(10, 9, 40.5) : good ? run(1, 1, 36) : run(6, 6, 39)],
        };
      }),
    }],
  };
}
/** adjustPrediction の結果の形（従来の役割は指数順） */
function adjusted() {
  const c = computer();
  const horses = c.races[0].horses.map((h) => ({ number: h.number, name: h.name, rawScore: h.computerIndex, sourceComputerIndex: h.computerIndex, displayScore: h.computerIndex + 70 }));
  [...horses].sort((a, b) => b.rawScore - a.rawScore).forEach((h, i) => { h.role = i === 0 ? '本命' : i === 1 ? '対抗' : '補欠'; });
  return { venue: '船橋', races: [{ raceNumber: 1, horses }] };
}
const stats = new Map([['好調騎', { rides: 50, wins: 15 }], ['不振騎', { rides: 50, wins: 1 }]]);

test('開催日 OWN_INDEX_START 以降だけ', () => {
  assert.equal(ownIndexOn('2026-11-27'), false);
  assert.equal(ownIndexOn(OWN_INDEX_START), true);
});

test('applyOwnIndex: 独自指数の順で役割を決め直し、pt = 独自指数 + 70・partnerPt = 指数 + 70', () => {
  const a = adjusted();
  const r = applyOwnIndex(a, computerHorseIndex({ venues: [computer()] }), stats);
  assert.deepEqual(r, { applied: 1, skipped: 0 });
  const h = a.races[0].horses;
  const honmei = h.find((x) => x.role === '本命');
  assert.equal(honmei.number, 2);
  assert.equal(honmei.mark, '◎');
  assert.equal(honmei.displayScore, honmei.ownIndex + 70);
  assert.equal(honmei.partnerPt, 89 + 70);
  assert.notEqual(h.find((x) => x.number === 1).role, '本命');
  assert.equal(a.races[0]._analyticsRule, 'OWN_INDEX_V1');
});

test('applyOwnIndex: computer JSON が無い会場は従来の役割のまま', () => {
  const a = adjusted();
  const r = applyOwnIndex(a, computerHorseIndex({ venues: [{ ...computer(), venue: '大井' }] }), stats);
  assert.deepEqual(r, { applied: 0, skipped: 1 });
  assert.equal(a.races[0].horses.find((x) => x.role === '本命').number, 1);
});

test('getHorseAiIndex: 表示は独自指数だけ（外部の指数・その加工値は出さない）', () => {
  assert.equal(getHorseAiIndex({ ownIndex: 91, computerIndex: 90, sourceComputerIndex: 90 }), 91);
  assert.equal(getHorseAiIndex({ computerIndex: 90, sourceComputerIndex: 90 }), null);
  assert.equal(getHorseAiIndex({ ownIndex: null, computerIndex: 90 }), null);
});

test('相手 5 頭: 同じ役割の中は partnerPt（指数）の順', () => {
  const horses = [
    { number: 1, role: '連下', pt: 200, partnerPt: 150 },
    { number: 2, role: '連下', pt: 150, partnerPt: 160 },
  ];
  assert.deepEqual(getTop5Challengers(horses).map((h) => h.number), [2, 1]);
});

test('loadJockeyStats: 開催日より前の開催（予想と結果の両方がある開催）だけを数える', async () => {
  const files = {
    'nankan/predictions/computer/2026/11': [['2026-11-20-OOI.json'], ['2026-11-21-OOI.json'], ['2026-11-22-OOI.json']],
    'nankan/results/2026/11': [['2026-11-20-OOI.json'], ['2026-11-22-OOI.json']],
  };
  const pred = { races: [{ raceNumber: 1, horses: [{ number: 1, jockey: '森 泰斗' }] }] };
  const res = { races: [{ raceNumber: 1, results: [{ number: 1, rank: 1 }] }] };
  const client = {
    async listDirectory(dir) { return (files[dir] ?? null)?.map(([name]) => ({ name, path: `${dir}/${name}`, type: 'file' })) ?? null; },
    async fetchJson(path) { return path.includes('/results/') ? res : pred; },
  };
  const s = await loadJockeyStats(client, 'nankan', '2026-11-22');
  assert.deepEqual(s.get('森泰斗'), { rides: 1, wins: 1 }); // 11-21 は結果が無い・11-22 は当日
});
