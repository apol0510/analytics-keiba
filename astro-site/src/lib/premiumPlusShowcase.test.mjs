import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeEntry,
  upsertEntry,
  removeEntry,
  sortEntries,
  computeStats,
  formatYen,
  formatShortDate,
  formatRaceLabel,
  MIN_RATE_SAMPLE,
} from './premiumPlusShowcase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function hit(date, payout, extra = {}) {
  return { date, venue: '大井', raceNumber: 6, stake: 16000, isHit: true, payout, ...extra };
}
function miss(date, extra = {}) {
  return { date, venue: '大井', raceNumber: 6, stake: 16000, isHit: false, payout: 0, ...extra };
}

test('normalizeEntry: date が不正なら null', () => {
  assert.equal(normalizeEntry({ date: '2026/07/15' }), null);
  assert.equal(normalizeEntry({ date: '' }), null);
  assert.equal(normalizeEntry(null), null);
  assert.equal(normalizeEntry({ date: '2026-07-15' }).date, '2026-07-15');
});

test('normalizeEntry: 払戻額が入っていれば isHit の入力漏れを補正する', () => {
  const entry = normalizeEntry({ date: '2026-07-15', isHit: false, payout: 277000 });
  assert.equal(entry.isHit, true);
  assert.equal(entry.payout, 277000);
});

test('normalizeEntry: 不的中なら払戻は 0 に潰す', () => {
  const entry = normalizeEntry({ date: '2026-07-15', isHit: false, payout: 0 });
  assert.equal(entry.isHit, false);
  assert.equal(entry.payout, 0);
});

test('normalizeEntry: 式別の既定は三連単フォーメーション', () => {
  assert.equal(normalizeEntry({ date: '2026-07-15' }).betType, '三連単フォーメーション');
});

test('sortEntries: 最新が index 0', () => {
  const sorted = sortEntries([hit('2026-07-10', 1), hit('2026-07-15', 2), hit('2026-07-12', 3)].map(normalizeEntry));
  assert.deepEqual(sorted.map((e) => e.date), ['2026-07-15', '2026-07-12', '2026-07-10']);
});

test('upsertEntry: 同じ日付は 1 件だけ（後勝ち = 撮り直しが上書きされる）', () => {
  let entries = [];
  entries = upsertEntry(entries, hit('2026-07-15', 100000));
  entries = upsertEntry(entries, miss('2026-07-15'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].isHit, false);
});

test('removeEntry: 指定日を消す', () => {
  const entries = removeEntry([hit('2026-07-15', 1), hit('2026-07-14', 2)].map(normalizeEntry), '2026-07-15');
  assert.deepEqual(entries.map((e) => e.date), ['2026-07-14']);
});

test('computeStats: legacy は的中率の母数に入らない（的中率100%を出さない恒久ガード）', () => {
  // 的中だけ 12 件の legacy → 的中率は算出されない
  const legacyOnly = Array.from({ length: 12 }, (_, i) =>
    normalizeEntry(hit(`2026-03-${String(i + 1).padStart(2, '0')}`, 300000, { legacy: true }))
  );
  const stats = computeStats(legacyOnly);
  assert.equal(stats.rate.available, false, 'legacy だけでは的中率を公開しない');
  assert.equal(stats.rate.races, 0);
  // 払戻実績（的中時の条件付き統計）には寄与する
  assert.equal(stats.payout.available, true);
  assert.equal(stats.payout.max, 300000);
});

test('computeStats: 新規分がサンプル数に満たない間は的中率を出さない', () => {
  const entries = Array.from({ length: MIN_RATE_SAMPLE - 1 }, (_, i) =>
    normalizeEntry(hit(`2026-07-${String(i + 1).padStart(2, '0')}`, 200000))
  );
  assert.equal(computeStats(entries).rate.available, false);
});

test('computeStats: 新規分が揃えば的中率・回収率を算出する', () => {
  const entries = [
    ...Array.from({ length: 6 }, (_, i) => normalizeEntry(hit(`2026-07-0${i + 1}`, 200000))),
    ...Array.from({ length: 4 }, (_, i) => normalizeEntry(miss(`2026-07-1${i}`))),
  ];
  const { rate } = computeStats(entries);
  assert.equal(rate.available, true);
  assert.equal(rate.races, 10);
  assert.equal(rate.hits, 6);
  assert.equal(rate.hitRate, 60);
  // 払戻 1,200,000 / 投票 160,000 = 750%
  assert.equal(rate.roi, 750);
});

test('computeStats: legacy と新規が混在しても的中率は新規のみ・払戻は全件', () => {
  const entries = [
    ...Array.from({ length: 10 }, (_, i) =>
      normalizeEntry(hit(`2026-03-${String(i + 1).padStart(2, '0')}`, 900000, { legacy: true }))
    ),
    ...Array.from({ length: 5 }, (_, i) => normalizeEntry(hit(`2026-07-0${i + 1}`, 100000))),
    ...Array.from({ length: 5 }, (_, i) => normalizeEntry(miss(`2026-07-1${i}`))),
  ];
  const { rate, payout } = computeStats(entries);
  assert.equal(rate.races, 10, '母数は新規 10 件のみ');
  assert.equal(rate.hitRate, 50);
  assert.equal(payout.max, 900000, '最高払戻は legacy も含む');
  assert.equal(payout.hits, 15);
});

test('computeStats: 空配列でも壊れない', () => {
  const stats = computeStats([]);
  assert.equal(stats.rate.available, false);
  assert.equal(stats.payout.available, false);
  assert.equal(stats.payout.max, 0);
});

test('seed データ（実測30枚）は的中率を公開せず、最高払戻 ¥888,700 を出す', () => {
  const file = path.join(__dirname, '..', '..', 'scripts', 'data', 'premium-plus-legacy.json');
  const { entries } = JSON.parse(readFileSync(file, 'utf8'));
  const normalized = entries.map((e) => normalizeEntry({ ...e, legacy: true }));
  assert.equal(normalized.length, 30);
  assert.ok(normalized.every(Boolean), '全件 normalize できる');

  const { rate, payout } = computeStats(normalized);
  assert.equal(rate.available, false, '的中日しか無い seed から的中率を出してはいけない');
  assert.equal(payout.max, 888700);
  assert.equal(payout.hits, 30);
  assert.ok(payout.avg > 300000 && payout.avg < 400000, `平均払戻が想定範囲外: ${payout.avg}`);
});

test('フォーマッタ', () => {
  assert.equal(formatYen(277000), '¥277,000');
  assert.equal(formatShortDate('2026-04-10'), '4/10');
  assert.equal(formatShortDate('bogus'), '');
  assert.equal(formatRaceLabel({ venue: '川崎', raceNumber: 6 }), '川崎6R');
  assert.equal(formatRaceLabel({ venue: '川崎', raceNumber: null }), '川崎');
  assert.equal(formatRaceLabel(null), '');
});
