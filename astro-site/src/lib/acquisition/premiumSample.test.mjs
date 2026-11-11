/**
 * Premium 画面の見本（2026-11-11 MK）: 選び方は「今日より前の直近の開催日のメインレース」だけで、結果を見ない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pickSampleRace, jstToday } from './premiumSample.js';

const race = (n) => ({ raceInfo: { raceNumber: n } });
const venue = (id, total = 12) => ({ venueName: id, venueId: id, totalRaces: total, races: Array.from({ length: total }, (_, i) => race(i + 1)) });
const main = (t) => (t >= 12 ? 11 : t);

test('今日のレースは出さない・今日より前の直近の開催日のメインレース', () => {
  const days = { '2026-11-11': [venue('kawasaki')], '2026-11-10': [venue('kawasaki')], '2026-11-06': [venue('ooi')] };
  const p = pickSampleRace({ cat: 'nankan', todayJst: '2026-11-11', dates: Object.keys(days), loadDay: (_c, d) => days[d], mainRaceNumber: main });
  assert.equal(p.date, '2026-11-10');
  assert.equal(p.venue.venueId, 'kawasaki');
  assert.equal(p.race.raceInfo.raceNumber, 11);
});

test('その日にメインレースの予想が無ければ前の開催日へ・何も無ければ null', () => {
  const days = { '2026-11-10': [{ ...venue('kawasaki'), races: [race(1)] }], '2026-11-06': [venue('ooi', 10)] };
  const p = pickSampleRace({ cat: 'nankan', todayJst: '2026-11-11', dates: Object.keys(days), loadDay: (_c, d) => days[d], mainRaceNumber: main });
  assert.equal(p.date, '2026-11-06');
  assert.equal(p.race.raceInfo.raceNumber, 10);
  assert.equal(pickSampleRace({ cat: 'jra', todayJst: '2026-11-11', dates: ['2026-11-11'], loadDay: () => [venue('x')], mainRaceNumber: main }), null);
});

test('結果で選ばない: 選び方に結果・払戻を渡す引数が無く、見本ページは結果を描画しない', () => {
  const src = readFileSync(fileURLToPath(new URL('./premiumSample.js', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /result|hit|payout|的中|払戻|archive/i);
  const page = readFileSync(fileURLToPath(new URL('../../pages/free-prediction/sample.astro', import.meta.url)), 'utf8');
  assert.doesNotMatch(page, /judgeAcquired|loadResultIndex|result=\{/, '見本に結果（的中・不的中）を出さない');
  assert.match(page, /noindex/);
  assert.match(page, /setPublicCdnCache/);
  assert.doesNotMatch(page, /Astro\.cookies|ak_session|gatePaidPage/, '公開ページ（Cookie・会員判定なし）');
});

test('jstToday は JST の日付', () => {
  assert.equal(jstToday(Date.parse('2026-11-10T15:00:00Z')), '2026-11-11');
  assert.equal(jstToday(Date.parse('2026-11-10T14:59:59Z')), '2026-11-10');
});
