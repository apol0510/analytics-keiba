import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFreeLiveBoard, headline, hitMapFor, jstToIso, nextRace, raceStatus } from './freeLiveBoard.js';

const model = {
  date: '2026-11-03',
  venues: [
    { venueName: '船橋', races: [
      { listing: { raceNumber: 1, startTime: '12:10', isMainRace: false } },
      { listing: { raceNumber: 2, startTime: '12:45', isMainRace: false } },
      { listing: { raceNumber: 11, startTime: '20:15', isMainRace: true } },
      { listing: { raceNumber: 12, startTime: '', isMainRace: false } },
    ] },
  ],
};
const archive = [
  { date: '2026-11-03', venue: '船橋', races: [
    { venue: '船橋', raceNumber: 1, isHit: true, bettingLines: ['1↔2.3'], umatan: { combination: '1-2', payout: 1200 } },
    { venue: '船橋', raceNumber: 2, isHit: false, bettingLines: ['4↔5.6'] },
    { venue: '船橋', raceNumber: 11, isHit: true, bettingLines: ['3→5.7.8.10.12(抑え9)'], umatan: { combination: '3-5', payout: 5000 } },
  ] },
  { date: '2026-11-02', venue: '船橋', races: [{ venue: '船橋', raceNumber: 1, isHit: false }] },
];
const at = (hm) => Date.parse(`2026-11-03T${hm}:00+09:00`);

test('jstToIso: JST 時刻を ISO に・読めなければ null', () => {
  assert.equal(jstToIso('2026-11-03', '12:10'), '2026-11-03T03:10:00.000Z');
  assert.equal(jstToIso('2026-11-03', ''), null);
  assert.equal(jstToIso('2026-11-03', '25:00'), null);
  assert.equal(jstToIso('bad', '12:10'), null);
});

test('🛑 買い目・払戻・メイン判定をブラウザ向けモデルへ写さない', () => {
  const b = buildFreeLiveBoard({ cat: 'nankan', model, archiveArray: archive });
  const json = JSON.stringify(b);
  for (const banned of ['bettingLines', 'umatan', 'payout', 'combination', 'isMainRace', '↔', '→', '抑え', '1200', '5000']) {
    assert.ok(!json.includes(banned), `leaked: ${banned}`);
  }
  for (const r of b.races) assert.deepEqual(Object.keys(r).sort(), ['hit', 'raceNumber', 'startAt', 'venueName']);
});

test('結果が入った日は ✅/✗ を全部出し、累計は正直に数える', () => {
  const b = buildFreeLiveBoard({ cat: 'nankan', model, archiveArray: archive });
  assert.deepEqual(b.races.map((r) => r.hit), [true, false, true, null]);
  assert.deepEqual(b.tally, { hit: 2, total: 3 });
  assert.equal(raceStatus(b.races[0], at('21:30'), true).text, '的中');
  assert.equal(raceStatus(b.races[1], at('21:30'), true).text, '不的中');
});

test('結果が無い日は ✅/✗ を付けない（推測しない）', () => {
  const b = buildFreeLiveBoard({ cat: 'nankan', model, archiveArray: archive.slice(1) });
  assert.equal(b.resultsIn, false);
  assert.equal(b.tally, null);
  assert.equal(raceStatus(b.races[0], at('13:00'), false).text, '結果待ち');
  assert.equal(raceStatus(b.races[2], at('13:00'), false).text, '20:15 発走');
  assert.equal(raceStatus(b.races[3], at('13:00'), false).text, '発走時刻未定');
  assert.equal(hitMapFor(archive, '2026-11-04'), null);
});

test('カウントダウンは全レース共通（メインを優先しない）・時刻未定は飛ばす', () => {
  const b = buildFreeLiveBoard({ cat: 'nankan', model, archiveArray: [] });
  assert.equal(nextRace(b.races, at('12:00')).raceNumber, 1);
  assert.equal(nextRace(b.races, at('12:20')).raceNumber, 2);
  assert.equal(nextRace(b.races, at('13:00')).raceNumber, 11);
  assert.equal(nextRace(b.races, at('20:20')), null);
  const h = headline(b, at('12:44'));
  assert.equal(h.state, 'countdown');
  assert.equal(h.label, '船橋 2R');
  assert.equal(h.at, '12:45');
});

test('全レース発走後: 結果前は反映予定、結果後は終了', () => {
  const pending = buildFreeLiveBoard({ cat: 'nankan', model, archiveArray: [] });
  assert.match(headline(pending, at('20:30')).text, /本日の発走はすべて終了.*21 時台/);
  const done = buildFreeLiveBoard({ cat: 'nankan', model, archiveArray: archive });
  assert.equal(headline(done, at('21:30')).text, '本日のレースはすべて終了しました');
  // 過去日を表示しているときは「本日」と書かない
  assert.equal(headline(done, Date.parse('2026-11-05T10:00:00+09:00')).text, '11/3のレースはすべて終了しました');
});

test('レースが無ければ何も出さない', () => {
  const b = buildFreeLiveBoard({ cat: 'jra', model: { date: null, venues: [] }, archiveArray: archive });
  assert.equal(b.races.length, 0);
  assert.equal(headline(b, at('12:00')).state, 'none');
});

test('guard: 部品は単一源だけを使い、買い目系フィールドを参照しない', () => {
  const src = readFileSync(new URL('../components/FreeLiveRaceBoard.astro', import.meta.url), 'utf-8');
  assert.match(src, /from '\.\.\/lib\/freeLiveBoard\.js'/);
  for (const banned of ['bettingLines', 'umatan', 'payout', 'isMainRace', 'mainRace']) assert.ok(!src.includes(banned), banned);
  for (const page of ['jra', 'nankan']) {
    const p = readFileSync(new URL(`../pages/free-prediction/${page}.astro`, import.meta.url), 'utf-8');
    assert.match(p, new RegExp(`<FreeLiveRaceBoard cat="${page}" model=\\{model\\} />`));
  }
});
