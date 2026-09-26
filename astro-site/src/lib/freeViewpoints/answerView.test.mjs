/**
 * answerView.test.mjs — `/free/` の「今日の無料予想」（2026-09-27 MK 確定）の振る舞い。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headlineMarksOf, pickMainRaceOf, shortReasonOf, buildAnswerPicks } from './answerView.js';

const row = (n, kind, extra = {}) => ({
  number: n, name: `ウマ${n}`, jockey: `騎手${n}`,
  isHeadline: !!kind, headlineMark: { main: '◎', sub: '○', tana: '▲', ren: '△' }[kind] || null,
  headlineKind: kind || null, ...extra,
});
const race = (n, rows = []) => ({ raceNumber: n, raceName: `${n}R名`, startTime: '15:00', horseRows: rows });

test('印は ◎ → ○ → ▲ → △ の順。印の無い馬は出さない', () => {
  const marks = headlineMarksOf([row(1, 'ren'), row(2, null), row(3, 'main'), row(4, 'tana'), row(5, 'sub')]);
  assert.deepEqual(marks.map((m) => `${m.mark}${m.number}`), ['◎3', '○5', '▲4', '△1']);
  assert.deepEqual(headlineMarksOf(undefined), []);
});

test('メインレースは 12R→11R / 10R→9R / 8R→7R、無ければ最終レース', () => {
  const mk = (len) => Array.from({ length: len }, (_, i) => race(i + 1));
  assert.equal(pickMainRaceOf(mk(12)).raceNumber, 11);
  assert.equal(pickMainRaceOf(mk(10)).raceNumber, 9);
  assert.equal(pickMainRaceOf(mk(8)).raceNumber, 7);
  assert.equal(pickMainRaceOf(mk(9)).raceNumber, 9);
  assert.equal(pickMainRaceOf([]), null);
});

test('理由は前走 1〜3 着のときだけ（盛らない）', () => {
  assert.equal(shortReasonOf({ prev: { finish: 2 } }), '前走2着');
  assert.equal(shortReasonOf({ prev: { finish: '1' } }), '前走1着');
  assert.equal(shortReasonOf({ prev: { finish: 4 } }), null);
  assert.equal(shortReasonOf({ prev: null }), null);
  assert.equal(shortReasonOf(undefined), null);
});

test('会場ごとにメインレースの印を返す。◎ が無い会場は出さない', () => {
  const races12 = Array.from({ length: 12 }, (_, i) => race(i + 1, i === 10
    ? [row(3, 'main', { prev: { finish: 1 } }), row(5, 'sub'), row(8, 'tana'), row(1, 'ren'), row(2, null)]
    : []));
  const view = { venues: [
    { venue: '浦和', races: races12 },
    { venue: '船橋', races: [race(1, [row(1, 'sub')])] },
  ] };
  const picks = buildAnswerPicks(view);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].venue, '浦和');
  assert.equal(picks[0].raceNumber, 11);
  assert.equal(picks[0].reason, '前走1着');
  assert.deepEqual(picks[0].marks.map((m) => m.mark + m.number), ['◎3', '○5', '▲8', '△1']);
  assert.deepEqual(buildAnswerPicks(null), []);
});

test('戻り値に公開 DTO 以外の値を持ち込まない', () => {
  const r = race(11, [row(3, 'main', { pt: 777, computerIndex: 91, role: '本命', bettingLines: ['3→5'], prev: { finish: 1 } })]);
  const json = JSON.stringify(buildAnswerPicks({ venues: [{ venue: 'X', races: [r] }] }));
  for (const bad of ['"pt"', '"computerIndex"', '"role"', '"bettingLines"', '777', '"prev"', '本命']) {
    assert.equal(json.includes(bad), false, `${bad} が漏れている`);
  }
});

test('競走名の仮名（第11レース）は出さない', () => {
  const r = { ...race(11, [row(3, 'main')]), raceName: '第11レース' };
  assert.equal(buildAnswerPicks({ venues: [{ venue: 'X', races: [r] }] })[0].raceName, '');
});
