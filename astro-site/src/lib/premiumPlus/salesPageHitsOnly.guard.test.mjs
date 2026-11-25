/**
 * 販売ページ /premium-plus-v2/ は的中が主役（MK 2026-11-25・共通 A-2）。
 * 不的中の投票控え・×・不的中を題材にした口コミ / FAQ を出さない。全件は /results-showcase/premium-plus/ に置く。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hitResults, latestCards } from '../premiumPlusResults.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, '..', '..', rel), 'utf8');

const sample = [
  { date: '2026-11-20', first: [1], second: [2, 3], third: [2, 3, 4], isHit: false, payout: 0 },
  { date: '2026-11-21', first: [5], second: [6], third: [7, 8], isHit: true, payout: 52300 },
  { date: '2026-11-22', first: [3], second: [1], third: [2], payout: 18000 },
  { date: '2026-11-23', first: [4], second: [5], third: [6], isHit: false },
];

test('hitResults は的中だけを最新順で返す（payout > 0 も的中）', () => {
  const r = hitResults(sample);
  assert.deepEqual(r.map((e) => e.date), ['2026-11-22', '2026-11-21']);
  assert.ok(r.every((e) => e.isHit && e.payout > 0));
  assert.deepEqual(hitResults(null), []);
});

test('販売ページのカードは的中した回だけから作る', () => {
  const cards = latestCards(hitResults(sample));
  assert.equal(cards.length, 2);
  assert.ok(cards.every((c) => c.isHit));
});

test('販売ページは的中だけを渡し、不的中の表示・口コミ・FAQ を持たない', () => {
  const page = read('pages/premium-plus-v2.astro');
  assert.match(page, /const ppHits = hitResults\(ppResultsRaw\)/);
  assert.match(page, /latestCards\(ppHits\)/);
  assert.match(page, /sortResults\(ppHits\)/);
  assert.ok(!page.includes('latestCards(ppResultsRaw)'), 'カードに全件を渡している');
  assert.ok(!page.includes('sortResults(ppResultsRaw)'), '帯に全件を渡している');
  // 本文（frontmatter と style を除く）に「不的中」「× の結果アイコン」を出さない
  const body = page.split('</style>').slice(1).join('</style>');
  assert.ok(!body.includes('不的中'), '販売ページ本文に「不的中」がある');
  assert.ok(!body.includes("'×'"), '帯に × のアイコンが残っている');
  assert.ok(!body.includes('正直'), '販売文言に「正直」がある');
  assert.ok(page.includes('/results-showcase/premium-plus/'), '全件の実績ページへの導線が無い');
});

test('全件は実績ページ /results-showcase/premium-plus/ に置く', () => {
  const p = read('pages/results-showcase/premium-plus.astro');
  assert.match(p, /premiumPlusResults\.json/);
  assert.match(p, /normalizeResult/);
  assert.ok(!p.includes('hitResults'), '実績ページは全件（的中だけに絞らない）');
});
