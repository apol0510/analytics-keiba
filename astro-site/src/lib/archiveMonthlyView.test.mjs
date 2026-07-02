/**
 * archiveMonthlyView.test.mjs — buildMergedMonthData の2場開催venue保持テスト
 * commit 9ee92d7（venue badge表示）の回帰テスト
 *   node --test src/lib/archiveMonthlyView.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildMergedMonthData, aggregateMonthByBasis, isCurrentBasisDay, CURRENT_BASIS_START,
} from './archiveMonthlyView.js';

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

// ─────────────────────────────────────────────
// 現在基準（2026-04-15以降）集計 + 2026-04-14 live優先
// ─────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, '..', 'data');
const loadArchive = () => JSON.parse(readFileSync(join(DATA, 'archiveResults.json'), 'utf-8'));
const loadJra = () => JSON.parse(readFileSync(join(DATA, 'archiveResultsJra.json'), 'utf-8'));
const loadSnap = (ym) => JSON.parse(readFileSync(join(DATA, `archiveResults_${ym}.json`), 'utf-8'));

describe('現在基準カットオフ (2026-04-15)', () => {
  it('CURRENT_BASIS_START は 2026-04-15', () => {
    assert.equal(CURRENT_BASIS_START, '2026-04-15');
  });

  it('isCurrentBasisDay: 04-14以前は除外・15以降は現在基準', () => {
    assert.equal(isCurrentBasisDay('2026', '04', '14'), false);
    assert.equal(isCurrentBasisDay('2026', '04', '15'), true);
    assert.equal(isCurrentBasisDay('2026', '03', '31'), false);
    assert.equal(isCurrentBasisDay('2026', '07', '1'), true);
    assert.equal(isCurrentBasisDay('2025', '10', '31'), false);
  });

  it('現在基準 = live由来かつ04-15以降のみ / JRA・snapshotは除外', () => {
    const merged = {
      // live かつ 04-15以降 → 現在基準
      '15': { category: 'nankan', source: 'live', totalRaces: 12, hitRaces: 6, totalPayout: 1000, perfectHit: false },
      // live だが 04-14 → legacy
      '14': { category: 'nankan', source: 'live', totalRaces: 12, hitRaces: 8, totalPayout: 2000, perfectHit: false },
      // snapshot由来で04-18(>=15)でも旧基準 → legacy（回帰: snapshot日を現在基準へ混入させない）
      '18': { category: 'nankan', source: 'snapshot', totalRaces: 12, hitRaces: 7, totalPayout: 3000, perfectHit: false },
      // JRAは南関集計外
      '15j': { category: 'jra', source: 'live', totalRaces: 12, hitRaces: 9, totalPayout: 99999, perfectHit: false },
    };
    const { current, legacy } = aggregateMonthByBasis(merged, '2026', '04');
    assert.equal(current.totalRaces, 12);   // '15' のみ
    assert.equal(current.hitRaces, 6);
    assert.equal(current.payout, 1000);     // JRA(99999)・snapshot(3000)不算入
    assert.equal(legacy.totalRaces, 24);    // '14' + '18'（snapshot日を含む）
  });
});

describe('2026-04-14 live優先マージ（実データ）', () => {
  it('04-14 は snapshot でなく live(公開本線判定済み)が採用される', () => {
    const live = loadArchive();
    const live0414 = live.find((e) => e.date === '2026-04-14');
    assert.ok(live0414, 'live 2026-04-14 が存在');
    const merged = buildMergedMonthData(live, loadSnap('2026-04'), '2026', '04');
    assert.ok(merged['14'], '14日がマージ結果に存在');
    assert.equal(merged['14'].recoveryRate, live0414.returnRate);
    assert.equal(merged['14'].hitRaces, live0414.hitRaces);
    assert.equal(merged['14'].totalRaces, live0414.totalRaces);
  });

  it('同一日は二重計上されない（current+legacy = 南関日数）', () => {
    const merged = buildMergedMonthData(loadArchive(), loadSnap('2026-04'), '2026', '04');
    const keys = Object.keys(merged);
    assert.equal(keys.length, new Set(keys).size);
    const { current, legacy } = aggregateMonthByBasis(merged, '2026', '04');
    const nankanDays = keys.filter((k) => !k.endsWith('j')).length;
    assert.equal(current.days + legacy.days, nankanDays);
  });

  it('現在基準は04-15以降のみ・04-14以前はlegacyへ分離', () => {
    const merged = buildMergedMonthData(loadArchive(), loadSnap('2026-04'), '2026', '04');
    for (const k of Object.keys(merged)) {
      if (k.endsWith('j')) continue;
      assert.equal(isCurrentBasisDay('2026', '04', k), parseInt(k, 10) >= 15);
    }
    const { current } = aggregateMonthByBasis(merged, '2026', '04');
    assert.ok(current.totalRaces > 0);
  });
});

describe('旧月の閲覧維持 / 2026-07-01 維持', () => {
  it('2025-10 は snapshot から閲覧可能・現在基準集計は0', () => {
    const merged = buildMergedMonthData(loadArchive(), loadSnap('2025-10'), '2025', '10');
    assert.ok(Object.keys(merged).length > 0);
    const { current, legacy } = aggregateMonthByBasis(merged, '2025', '10');
    assert.equal(current.totalRaces, 0);
    assert.ok(legacy.totalRaces > 0);
  });

  it('2026-07-01 は現在基準・10/12・回収率368%相当を維持', () => {
    const merged = buildMergedMonthData(loadArchive(), {}, '2026', '07');
    const d1 = merged['01'];
    assert.ok(d1, '07-01(キー"01")が存在');
    assert.equal(d1.hitRaces, 10);
    assert.equal(d1.totalRaces, 12);
    assert.equal(Math.round(d1.recoveryRate), 368);
    const { current } = aggregateMonthByBasis(merged, '2026', '07');
    assert.ok(current.totalRaces >= 12);
  });

  it('JRA archive を渡してもキーは "DDj" で南関と衝突しない', () => {
    const merged = buildMergedMonthData(loadArchive(), {}, '2026', '06', loadJra());
    for (const k of Object.keys(merged)) {
      if (k.endsWith('j')) assert.equal(merged[k].category, 'jra');
      else assert.notEqual(merged[k].category, 'jra');
    }
  });
});
