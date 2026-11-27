/**
 * nankanCourseCompare.test.mjs — 南関4場の横断比較ページの数字が各コース記事の表と一致すること
 *   node --test src/lib/seo/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  VENUES, COURSES, OTHER_COURSES, courseSlug, courseUrl, fmt,
  mostReliableFavorite, leastReliableFavorite, strongestGate,
} from './nankanCourseCompare.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');
const ARTICLE_DIR = 'src/pages/blog/course/';

const cellsOf = (tr) =>
  [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
const rowsOf = (html) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => cellsOf(m[1])).filter((c) => c.length);

test('29 本のコース記事をすべて、1 回ずつ載せる', () => {
  const articles = readdirSync(`${ROOT}${ARTICLE_DIR}`).filter((f) => f.endsWith('.astro')).map((f) => f.replace(/\.astro$/, '')).sort();
  const listed = [...COURSES, ...OTHER_COURSES].map(courseSlug).sort();
  assert.deepEqual(listed, articles);
  for (const c of [...COURSES, ...OTHER_COURSES]) assert.ok(VENUES.some((v) => v.id === c.venue), c.venue);
});

test('1番人気の成績は記事の人気別成績表の「1番人気」行と一致する', () => {
  for (const c of COURSES) {
    const row = rowsOf(read(`${ARTICLE_DIR}${courseSlug(c)}.astro`)).find((r) => r[0] === '1番人気');
    assert.ok(row, `${courseSlug(c)}: 1番人気の行が無い`);
    assert.deepEqual(row.slice(1, 4), [c.favorite.win, c.favorite.top2, c.favorite.top3].map((n) => `${fmt(n)}%`), courseSlug(c));
  }
});

test('勝率の高い馬番は記事の馬番別成績表の出走数 30 以上の行で勝率が最大のもの', () => {
  for (const c of COURSES) {
    const src = read(`${ARTICLE_DIR}${courseSlug(c)}.astro`);
    const table = src.match(/<th>馬番<\/th>([\s\S]*?)<\/table>/);
    assert.ok(table, `${courseSlug(c)}: 馬番別の表が無い`);
    const rows = rowsOf(table[1]).filter((r) => /^\d+番$/.test(r[0]) && r.length > 4);
    const big = rows.filter((r) => parseInt(r[4], 10) >= 30);
    const best = big.reduce((a, b) => (parseFloat(b[1]) > parseFloat(a[1]) ? b : a));
    assert.deepEqual([best[0], best[1], parseInt(best[4], 10)], [`${c.bestGate.gate}番`, `${fmt(c.bestGate.win)}%`, c.bestGate.starts], courseSlug(c));
  }
});

test('その他の距離は馬番別の表に出走数 30 以上の行が無い距離だけ', () => {
  for (const c of OTHER_COURSES) {
    const table = read(`${ARTICLE_DIR}${courseSlug(c)}.astro`).match(/<th>馬番<\/th>([\s\S]*?)<\/table>/);
    if (!table) continue;
    const big = rowsOf(table[1]).filter((r) => /^\d+番$/.test(r[0]) && r.length > 4 && parseInt(r[4], 10) >= 30);
    assert.equal(big.length, 0, courseSlug(c));
  }
});

test('見どころの 3 件はデータから決まる', () => {
  assert.equal(courseSlug(mostReliableFavorite()), 'ooi-1400m');
  assert.equal(courseSlug(leastReliableFavorite()), 'funabashi-1500m');
  assert.equal(courseSlug(strongestGate()), 'ooi-1800m');
});

test('比較ページは全記事へリンクし、ハブ・各場・ブログ一覧・各記事から比較ページへリンクする', () => {
  const page = read('src/pages/course/compare.astro');
  assert.match(page, /courseUrl\(/);
  for (const c of [...COURSES, ...OTHER_COURSES]) assert.ok(courseUrl(c).startsWith('/blog/course/') && courseUrl(c).endsWith('/'));
  for (const p of ['src/pages/course.astro', 'src/pages/blog.astro', ...VENUES.map((v) => `src/pages/course/${v.id}.astro`)]) {
    assert.ok(read(p).includes('href="/course/compare/"'), `${p}: 比較ページへのリンクが無い`);
  }
  for (const c of [...COURSES, ...OTHER_COURSES]) {
    assert.ok(read(`${ARTICLE_DIR}${courseSlug(c)}.astro`).includes('href="/course/compare/"'), `${courseSlug(c)}: 比較ページへのリンクが無い`);
  }
});

test('コース記事に古い「【2025年最新版】」表記を残さない', () => {
  for (const f of readdirSync(`${ROOT}${ARTICLE_DIR}`).filter((x) => x.endsWith('.astro'))) {
    assert.equal(read(`${ARTICLE_DIR}${f}`).includes('2025年最新版'), false, f);
  }
  assert.equal(read('src/pages/blog.astro').includes('2025年最新版'), false, 'blog.astro');
});
