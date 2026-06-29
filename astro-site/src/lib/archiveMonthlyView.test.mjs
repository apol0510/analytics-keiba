/**
 * archiveMonthlyView.test.mjs — buildMergedMonthData の2場開催venue保持テスト
 * commit 9ee92d7（venue badge表示）の回帰テスト
 *   node --test src/lib/archiveMonthlyView.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMergedMonthData } from './archiveMonthlyView.js';

// fixture helpers
function makeRaces(count, venue, allHit = true) {
  return Array.from({ length: count }, (_, i) => ({
    raceNumber: i + 1,
    venue,
    isHit: allHit || i % 2 === 0,
    umatan: { payout: 500 },
    bettingLines: [],
  }));
}

const TWO_VENUE_ARCHIVE = [
  {
    date: '2026-06-29',
    venue: '大井・船橋',
    venues: ['大井', '船橋'],
    totalRaces: 24,
    hitRaces: 16,
    races: [...makeRaces(12, '大井'), ...makeRaces(12, '船橋', false)],
  },
];

const SINGLE_VENUE_ARCHIVE = [
  {
    date: '2026-06-25',
    venue: '浦和',
    venues: ['浦和'],
    totalRaces: 12,
    hitRaces: 8,
    races: makeRaces(12, '浦和'),
  },
];

// ─────────────────────────────────────────────
// 2場開催
// ─────────────────────────────────────────────
describe('buildMergedMonthData — 2場開催', () => {
  it('venues.length が 2 になる', () => {
    const data = buildMergedMonthData(TWO_VENUE_ARCHIVE, {}, '2026', '06');
    assert.equal(data['29'].venues.length, 2);
  });

  it('venues に 大井・船橋 が含まれる', () => {
    const data = buildMergedMonthData(TWO_VENUE_ARCHIVE, {}, '2026', '06');
    assert.deepEqual(data['29'].venues, ['大井', '船橋']);
  });

  it('race[0].venue が 大井', () => {
    const data = buildMergedMonthData(TWO_VENUE_ARCHIVE, {}, '2026', '06');
    assert.equal(data['29'].races[0].venue, '大井');
  });

  it('race[12].venue が 船橋', () => {
    const data = buildMergedMonthData(TWO_VENUE_ARCHIVE, {}, '2026', '06');
    assert.equal(data['29'].races[12].venue, '船橋');
  });

  it('大井1R と 船橋1R を識別可能（raceNumber重複でも venue で区別）', () => {
    const data = buildMergedMonthData(TWO_VENUE_ARCHIVE, {}, '2026', '06');
    const r1s = data['29'].races.filter(
      r => r.raceNumber === '1R' || r.raceNumber === 1
    );
    const venues = r1s.map(r => r.venue);
    assert.ok(venues.includes('大井'), '大井1R が存在しない');
    assert.ok(venues.includes('船橋'), '船橋1R が存在しない');
  });

  it('venues.length > 1 → badge 条件が成立する', () => {
    const data = buildMergedMonthData(TWO_VENUE_ARCHIVE, {}, '2026', '06');
    assert.ok(data['29'].venues?.length > 1, 'badge 条件が不成立');
  });
});

// ─────────────────────────────────────────────
// 単一会場
// ─────────────────────────────────────────────
describe('buildMergedMonthData — 単一会場', () => {
  it('venues.length が 1 → badge 条件が不成立', () => {
    const data = buildMergedMonthData(SINGLE_VENUE_ARCHIVE, {}, '2026', '06');
    assert.ok(!(data['25'].venues?.length > 1), 'badge 条件が成立してしまっている');
  });

  it('単一会場日の race.venue が保持される', () => {
    const data = buildMergedMonthData(SINGLE_VENUE_ARCHIVE, {}, '2026', '06');
    assert.equal(data['25'].races[0].venue, '浦和');
  });
});

// ─────────────────────────────────────────────
// null 安全性
// ─────────────────────────────────────────────
describe('buildMergedMonthData — null 安全性', () => {
  it('race.venue 欠損でも crash しない', () => {
    const noVenueRaces = [
      {
        date: '2026-06-20',
        venue: '大井・船橋',
        venues: ['大井', '船橋'],
        totalRaces: 4,
        hitRaces: 2,
        races: Array.from({ length: 4 }, (_, i) => ({
          raceNumber: i + 1,
          // venue フィールドなし
          isHit: true,
          umatan: { payout: 300 },
          bettingLines: [],
        })),
      },
    ];
    assert.doesNotThrow(() => buildMergedMonthData(noVenueRaces, {}, '2026', '06'));
  });

  it('venues フィールド欠損でも crash しない', () => {
    const noVenuesField = [
      {
        date: '2026-06-15',
        venue: '大井',
        // venues フィールドなし
        totalRaces: 12,
        hitRaces: 6,
        races: makeRaces(12, '大井'),
      },
    ];
    assert.doesNotThrow(() => buildMergedMonthData(noVenuesField, {}, '2026', '06'));
  });

  it('venues が空配列でも crash しない', () => {
    const emptyVenues = [
      {
        date: '2026-06-10',
        venue: '川崎',
        venues: [],
        totalRaces: 12,
        hitRaces: 5,
        races: makeRaces(12, '川崎'),
      },
    ];
    assert.doesNotThrow(() => buildMergedMonthData(emptyVenues, {}, '2026', '06'));
    const data = buildMergedMonthData(emptyVenues, {}, '2026', '06');
    assert.ok(!(data['10'].venues?.length > 1), 'badge 条件が成立してしまっている');
  });

  it('3会場でも venues.length > 1 → badge 条件成立', () => {
    const threeVenue = [
      {
        date: '2026-06-05',
        venue: '大井・船橋・川崎',
        venues: ['大井', '船橋', '川崎'],
        totalRaces: 36,
        hitRaces: 20,
        races: [
          ...makeRaces(12, '大井'),
          ...makeRaces(12, '船橋'),
          ...makeRaces(12, '川崎'),
        ],
      },
    ];
    const data = buildMergedMonthData(threeVenue, {}, '2026', '06');
    assert.ok(data['05'].venues?.length > 1, '3会場で badge 条件が不成立');
    assert.equal(data['05'].venues.length, 3);
  });
});
