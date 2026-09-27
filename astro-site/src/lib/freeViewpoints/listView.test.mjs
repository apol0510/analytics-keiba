/**
 * listView.test.mjs — `/free/` 全レース予想一覧の小さな純粋関数（2026-09-27 MK 確定）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headlineMarksOf, isMainRaceIn, raceRangeLabel } from './listView.js';

const row = (n, kind, extra = {}) => ({
  number: n, name: `ウマ${n}`, isHeadline: !!kind,
  headlineMark: { main: '◎', sub: '○', tana: '▲', ren: '△' }[kind] || null, headlineKind: kind || null, ...extra,
});

test('印は ◎ → ○ → ▲ → △ の順。印の無い馬は出さない', () => {
  const marks = headlineMarksOf([row(1, 'ren'), row(2, null), row(3, 'main'), row(4, 'tana'), row(5, 'sub')]);
  assert.deepEqual(marks.map((m) => `${m.mark}${m.number}`), ['◎3', '○5', '▲4', '△1']);
  assert.deepEqual(headlineMarksOf(undefined), []);
});

test('戻り値は印・馬番・馬名だけ（公開 DTO 以外を持ち込まない）', () => {
  const [m] = headlineMarksOf([row(3, 'main', { pt: 777, computerIndex: 91, role: '本命', jockey: 'X' })]);
  assert.deepEqual(Object.keys(m).sort(), ['kind', 'mark', 'name', 'number']);
});

test('メインレースは会場のレース数で決める（12R→11R / 10R→9R / 8R→7R / その他は最終）', () => {
  const mk = (len) => Array.from({ length: len }, (_, i) => ({ raceNumber: i + 1 }));
  for (const [len, main] of [[12, 11], [10, 9], [8, 7], [9, 9], [7, 7]]) {
    const races = mk(len);
    const flagged = races.filter((r) => isMainRaceIn(races, r)).map((r) => r.raceNumber);
    assert.deepEqual(flagged, [main], `${len}R 開催`);
  }
  assert.equal(isMainRaceIn([], { raceNumber: 1 }), false);
});

test('会場のレース範囲は「1R〜12R」（最終レース番号だけにしない）', () => {
  const mk = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => ({ raceNumber: a + i }));
  assert.equal(raceRangeLabel(mk(1, 12)), '1R〜12R');
  assert.equal(raceRangeLabel(mk(1, 10)), '1R〜10R');
  assert.equal(raceRangeLabel([{ raceNumber: 5 }]), '5R');
  assert.equal(raceRangeLabel([]), '');
});
