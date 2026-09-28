/**
 * categoryParity.test.mjs — 日付別恒久ページの導線と中身を「中央・南関で同じ水準」に固定する
 *
 * 2026-09-28: 南関の日付ページ・一覧だけに結果・導線を付け、中央（JRA）の一覧が
 * どこからもリンクされず（旧 URL の 301 経由のみ）、日付ページに結果も無いまま残っていた。
 * 4 領域横断ルールの再発防止として、片方だけ直すと落ちるようにする。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDayResultsView, loadResultsByDate } from '../dayResultsView.js';
import { isSitemapExcluded } from './sitemapPolicy.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

const CATS = [
  { cat: 'jra', hub: '/free-prediction/jra/archive/', page: 'src/pages/free-prediction/jra/[date].astro', hubFile: 'src/pages/free-prediction/jra/archive.astro' },
  { cat: 'nankan', hub: '/free-prediction/nankan/archive/', page: 'src/pages/free-prediction/nankan/[date].astro', hubFile: 'src/pages/free-prediction/nankan/archive.astro' },
];

for (const { cat, hub, page, hubFile } of CATS) {
  test(`${cat}: 一覧へは 有料版プレビュー・的中実績・昨日の買い目 から直接リンクされる`, () => {
    for (const f of [`src/pages/free-prediction/${cat}.astro`, `src/pages/archive/${cat}/index.astro`, `src/pages/results-showcase/${cat}.astro`]) {
      assert.ok(read(f).includes(`href="${hub}"`), `${f} → ${hub} の直接リンクが無い`);
    }
  });

  test(`${cat}: 日付ページは静的生成・結果あり・パンくず・前後日・一覧リンク・title に「AI予想と結果」`, () => {
    const src = read(page);
    assert.match(src, /export const prerender = true;/);
    assert.match(src, /BreadcrumbList/);
    assert.match(src, /rel="prev"/);
    assert.match(src, /rel="next"/);
    assert.ok(src.includes(hub) || src.includes('NANKAN_ARCHIVE_HUB_PATH'), '一覧へのリンクが無い');
    assert.ok(src.includes('AI予想と結果'), 'title / h1 に「AI予想と結果」が無い');
    assert.ok(/buildDayResultsView|buildShowcaseDay|buildAllNankanDatePages/.test(src + read('src/lib/nankanDateArchive.js')), '結果の組み立てが無い');
    assert.equal(/noindex/.test(src), false);
  });

  test(`${cat}: 一覧は各日付の的中を出し、sitemap に載る`, () => {
    const src = read(hubFile);
    assert.match(src, /的中/);
    assert.equal(isSitemapExcluded(`https://analytics.keiba.link${hub}`), false);
  });

  test(`${cat}: 結果ビューは結果アーカイブと的中数が一致し、抑え・メイン以外の買い目を出さない`, () => {
    const byDate = loadResultsByDate(cat, ROOT);
    assert.ok(byDate.size > 30, `${cat} の結果が少なすぎる`);
    for (const [date, e] of [...byDate].slice(0, 20)) {
      const v = buildDayResultsView(e);
      assert.equal(v.hitRaces, e.races.filter((r) => r.isHit).length, `${cat} ${date}`);
      const json = JSON.stringify(v);
      for (const banned of ['抑え', 'bettingLines', 'computerIndex', '"pt"']) assert.equal(json.includes(banned), false, `${cat} ${date}: ${banned}`);
    }
  });
}

test('旧 URL /free-prediction-jra/archive/（301 経由）へのリンクを残さない', () => {
  const walk = (dir) => readdirSync(`${ROOT}${dir}`, { withFileTypes: true }).flatMap((d) => (
    d.isDirectory() ? walk(`${dir}${d.name}/`) : d.name.endsWith('.astro') ? [`${dir}${d.name}`] : []));
  const hits = walk('src/pages/').filter((f) => read(f).includes('href="/free-prediction-jra/archive/"'));
  assert.deepEqual(hits, []);
});

test('結果表示の単一源は dayResultsView（中央・南関で同じ関数）', () => {
  assert.match(read('src/lib/nankanDateArchive.js'), /from '\.\/dayResultsView\.js'/);
  assert.match(read('src/pages/free-prediction/jra/[date].astro'), /from '\.\.\/\.\.\/\.\.\/lib\/dayResultsView\.js'/);
  for (const f of ['src/lib/dayResultsView.js', 'src/components/DayResultsSummary.astro']) {
    const src = read(f).replace(/\/\*\*[\s\S]*?\*\//g, '');
    for (const w of ['computerIndex', 'sourceComputerIndex', 'getHorseAiIndex', 'osaeClassification', 'mainRaceBetting']) {
      assert.equal(src.includes(w), false, `${f}: ${w}`);
    }
  }
});
