/**
 * nankanDateArchive.test.mjs — 南関「日付 × 競馬場 × 予想・結果」恒久ページの重要仕様を固定する
 *   node --test src/lib/seo/*.test.mjs
 *
 * 固定する仕様: 公開範囲（新しい公開を作らない）/ raw−1（指数を出さない）/ 4 領域（予想ロジックに触れない）/
 * canonical / sitemap / 内部リンク / SSR・indexability（静的生成・noindex なし）/ 過去データの恒久 URL 化
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildAllNankanDatePages, buildNankanDatePage, listNankanArchiveDates,
  nankanDatePath, NANKAN_ARCHIVE_HUB_PATH, neighborDates, formatJpDate,
} from '../nankanDateArchive.js';
import { isSitemapExcluded } from './sitemapPolicy.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');
const PAGE = 'src/pages/free-prediction/nankan/[date].astro';
const HUB = 'src/pages/free-prediction/nankan/archive.astro';

// ── 合成データ（リポジトリのデータ更新に左右されない判定）──────────
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'nda-'));
  mkdirSync(join(root, 'src', 'data', 'predictions'), { recursive: true });
  const horse = (n, role, extra = {}) => ({
    horseNumber: n, horseName: `馬${n}`, role, computerIndex: 88, sourceComputerIndex: 88, pt: 77, jockey: 'J', ...extra,
  });
  const pred = (date, venue, races) => ({
    eventInfo: { date, venue, totalRaces: races },
    predictions: Array.from({ length: races }, (_, i) => ({
      raceInfo: { date, venue, raceNumber: i + 1, raceName: `${venue}${i + 1}R特別`, startTime: '15:00', distance: 1200, horseCount: 4 },
      horses: [horse(1, '連下最上位'), horse(2, '本命'), horse(3, '対抗'), horse(4, '単穴'), horse(5, '補欠')],
    })),
  });
  const w = (name, data) => writeFileSync(join(root, 'src', 'data', 'predictions', name), JSON.stringify(data));
  w('2026-05-01-ooi.json', pred('2026-05-01', '大井', 12));
  w('2026-05-02-ooi.json', pred('2026-05-02', '大井', 10));
  w('2026-05-02-urawa.json', pred('2026-05-02', '浦和', 12));
  w('2026-05-04-kawasaki.json', pred('2026-05-04', '川崎', 12)); // 結果なし（当日）
  const race = (venue, n, isHit) => ({
    raceNumber: n, raceName: `${venue}${n}R特別`, venue,
    result: { first: { number: 2, name: '馬2' }, second: { number: 3, name: '馬3' }, third: { number: 1, name: '馬1' } },
    bettingLines: [n === 11 || (venue === '大井' && n === 9) ? '2→3.4.1.6.7(抑え5)' : '2↔1.3.4(抑え5)'],
    isHit, umatan: { combination: '2-3', payout: 1230 },
  });
  const archive = [
    { date: '2026-05-03', venue: '船橋', races: Array.from({ length: 12 }, (_, i) => race('船橋', i + 1, i % 2 === 0)) }, // 予想なし
    { date: '2026-05-02', venue: '大井', venues: ['大井', '浦和'], races: [
      ...Array.from({ length: 10 }, (_, i) => race('大井', i + 1, i === 8)),
      ...Array.from({ length: 12 }, (_, i) => race('浦和', i + 1, i === 10)),
    ] },
    { date: '2026-05-01', venue: '大井', races: Array.from({ length: 12 }, (_, i) => race('大井', i + 1, i < 3)) },
  ];
  writeFileSync(join(root, 'src', 'data', 'archiveResults.json'), JSON.stringify(archive));
  return root;
}

test('過去データの恒久 URL 化: 予想か結果のどちらかがある日は全部ページになる（新しい順）', () => {
  const root = fixtureRoot();
  assert.deepEqual(listNankanArchiveDates(root), ['2026-05-04', '2026-05-03', '2026-05-02', '2026-05-01']);
  const pages = buildAllNankanDatePages(root);
  assert.equal(pages.length, 4);
  assert.equal(nankanDatePath('2026-05-01'), '/free-prediction/nankan/2026-05-01/');
});

test('同日複数会場・結果のみ・予想のみを正しく組み立てる', () => {
  const root = fixtureRoot();
  const two = buildNankanDatePage('2026-05-02', root);
  assert.equal(two.summary.venueLabel, '大井・浦和');
  assert.deepEqual(two.venues.map((v) => v.totalRaces), [10, 12]);
  assert.equal(two.venues[0].mainRace.raceNumber, 9, '10R 開催のメインは 9R（会場別に数える）');
  assert.equal(two.venues[1].mainRace.raceNumber, 11);
  assert.equal(two.summary.hitRaces, 2);

  const resultsOnly = buildNankanDatePage('2026-05-03', root);
  assert.equal(resultsOnly.venues[0].races[0].marks.length, 0);
  assert.equal(resultsOnly.summary.hitRaces, 6);

  const predOnly = buildNankanDatePage('2026-05-04', root);
  assert.equal(predOnly.summary.hasResults, false);
  assert.equal(predOnly.venues[0].mainRace, null, '結果前はメインの買い目も出さない');
  assert.equal(predOnly.venues[0].races[0].isHit, null);
  assert.equal(buildNankanDatePage('2026-05-05', root), null);
});

test('公開範囲: 印（◎○▲△・馬番・馬名）と着順・的中だけ。指数・pt・役割・生データ・抑えを出さない', () => {
  const root = fixtureRoot();
  const page = buildNankanDatePage('2026-05-01', root);
  const r1 = page.venues[0].races[0];
  assert.deepEqual(r1.marks.map((m) => m.mark), ['◎', '○', '▲', '△']);
  assert.deepEqual(Object.keys(r1.marks[0]).sort(), ['kind', 'mark', 'name', 'number']);
  assert.deepEqual(r1.top3.map((t) => t.number), [2, 3, 1]);
  const json = JSON.stringify(buildAllNankanDatePages(root));
  for (const banned of ['computerIndex', 'sourceComputerIndex', '"pt"', '_horse', '"role"', 'aiIndex', '抑え', '88', '77']) {
    assert.equal(json.includes(banned), false, `${banned} が出力に混ざっている`);
  }
  // メイン以外の買い目は出さない（bettingLines をそのまま載せない）
  assert.equal(json.includes('bettingLines'), false);
  assert.equal(json.includes('↔'), false);
});

test('本番データでも公開範囲を守り、的中数は結果アーカイブと一致する', () => {
  const pages = buildAllNankanDatePages(ROOT);
  assert.ok(pages.length >= 120, `ページ数 ${pages.length}`);
  assert.equal(new Set(pages.map((p) => p.date)).size, pages.length, '日付の重複');
  const json = JSON.stringify(pages);
  for (const banned of ['computerIndex', 'sourceComputerIndex', '"pt"', '_horse', '"role"', '抑え', 'bettingLines']) {
    assert.equal(json.includes(banned), false, banned);
  }
  const archive = JSON.parse(read('src/data/archiveResults.json'));
  for (const e of archive.slice(0, 30)) {
    const p = pages.find((x) => x.date === e.date);
    assert.ok(p, `${e.date} のページが無い`);
    assert.equal(p.summary.hitRaces, e.races.filter((r) => r.isHit).length, `${e.date} の的中数`);
  }
});

test('raw−1: 恒久ページは指数を表示しない（元指数も getHorseAiIndex も参照しない）', () => {
  for (const f of [PAGE, HUB, 'src/lib/nankanDateArchive.js']) {
    const src = read(f).replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const w of ['computerIndex', 'sourceComputerIndex', 'getHorseAiIndex', 'getDisplayComputerIndex', '.pt']) {
      assert.equal(src.includes(w), false, `${f}: ${w}`);
    }
  }
});

test('4 領域: 予想ロジック・判定の単一源を書き換えない／自前で再実装しない（公開 DTO と showcase だけを使う）', () => {
  const src = read('src/lib/nankanDateArchive.js');
  assert.match(src, /from '\.\/freePublicView\.js'/);
  assert.match(src, /from '\.\/resultsShowcase\.js'/);
  for (const w of ['osaeClassification', 'mainRaceBetting', 'shared-prediction-logic', 'featureScores', 'isOsaeCandidate']) {
    assert.equal(src.includes(w), false, w);
  }
});

test('SSR / indexability: 静的生成・noindex なし・canonical は BaseLayout の自己 URL（末尾スラッシュ）', () => {
  for (const f of [PAGE, HUB]) {
    const src = read(f);
    assert.match(src, /export const prerender = true;/, f);
    assert.match(src, /<BaseLayout /, f);
    assert.equal(/noindex/.test(src), false, `${f}: noindex`);
    assert.equal(/canonical=/.test(src), false, `${f}: canonical を上書きしない（自己 URL を使う）`);
  }
  assert.match(read(PAGE), /export function getStaticPaths\(\)/);
  assert.match(read(PAGE), /buildAllNankanDatePages\(\)/);
  assert.equal(NANKAN_ARCHIVE_HUB_PATH, '/free-prediction/nankan/archive/');
});

test('sitemap: 日付ページと一覧は載る（除外されない）', () => {
  for (const u of [nankanDatePath('2026-09-25'), NANKAN_ARCHIVE_HUB_PATH]) {
    assert.equal(isSitemapExcluded(`https://analytics.keiba.link${u}`), false, u);
  }
});

test('内部リンク: 一覧→全日付、日付→前後・一覧、既存ページ→一覧', () => {
  assert.match(read(HUB), /href=\{nankanDatePath\(p\.date\)\}/);
  const page = read(PAGE);
  assert.match(page, /href=\{NANKAN_ARCHIVE_HUB_PATH\}/);
  assert.match(page, /rel="prev"/);
  assert.match(page, /rel="next"/);
  for (const f of [
    'src/pages/free-prediction/nankan.astro',
    'src/pages/free-prediction/jra/archive.astro',
    'src/pages/archive/nankan/index.astro',
    'src/pages/results-showcase/nankan.astro',
  ]) assert.ok(read(f).includes('/free-prediction/nankan/archive/'), `${f} から一覧へのリンクが無い`);
  assert.deepEqual(neighborDates(['2026-05-04', '2026-05-02', '2026-05-01'], '2026-05-02'), { newer: '2026-05-04', older: '2026-05-01' });
  assert.equal(formatJpDate('2026-09-05'), '2026年9月5日');
});
