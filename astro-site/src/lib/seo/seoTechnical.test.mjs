/**
 * seoTechnical.test.mjs — 2026-09-28 の技術 SEO 監査で直したものが戻らないよう固定する
 *   node --test src/lib/seo/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildFullTitle, stripTrailingBrand } from './pageTitle.mjs';
import { isSitemapExcluded } from './sitemapPolicy.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, 'utf8');

test('タイトル: ページ側の末尾ブランドを落として二重にしない', () => {
  assert.equal(
    buildFullTitle('2026-09-20 中央競馬 AI予想 - KEIBA Analytics'),
    '2026-09-20 中央競馬 AI予想｜KEIBA Analytics｜競馬アナリティクス',
  );
  assert.equal(buildFullTitle('ログイン | KEIBA Analytics'), 'ログイン｜KEIBA Analytics｜競馬アナリティクス');
  assert.equal(buildFullTitle('ブログ | KEIBA Analytics｜KEIBA Analytics'), 'ブログ｜KEIBA Analytics｜競馬アナリティクス');
  assert.equal(buildFullTitle('料金プラン'), '料金プラン｜KEIBA Analytics｜競馬アナリティクス');
  assert.equal(buildFullTitle(''), 'KEIBA Analytics｜競馬アナリティクス');
  // 文中のブランドは消さない
  assert.equal(stripTrailingBrand('KEIBA Analytics の使い方'), 'KEIBA Analytics の使い方');
});

test('サイトマップ: 301/302・noindex・会員限定・個人向けは載せない', () => {
  for (const u of [
    '/results/', '/results-jra/', '/today/', '/offer/', '/login/', '/dashboard/', '/welcome/',
    '/free-prediction/archive/', '/premium-prediction/nankan/', '/premium-prediction/jra/',
    '/archive-sanrenpuku/2026/', '/auth/verify/', '/premium-plus/', '/admin/x/',
  ]) assert.equal(isSitemapExcluded(`https://analytics.keiba.link${u}`), true, u);
});

test('サイトマップ: 正規の公開ページは消さない（前方一致の巻き込み防止）', () => {
  for (const u of [
    '/', '/free/', '/free/nankan/', '/free/jra/', '/free-prediction/nankan/', '/free-prediction/jra/',
    '/free-prediction/jra/2026-09-20/', '/free-prediction/jra/archive/', '/results-showcase/nankan/',
    '/archive/', '/archive/nankan/', '/archive/jra/', '/pricing/', '/blog/course/ooi-1650m/', '/course/',
  ]) assert.equal(isSitemapExcluded(`https://analytics.keiba.link${u}`), false, u);
});

test('astro.config: サイトマップ方針を読み、lastmod を毎ビルド「今」にしない', () => {
  const cfg = read('astro.config.mjs');
  assert.match(cfg, /isSitemapExcluded\(page\)/);
  assert.equal(/^\s*lastmod:\s*new Date\(\)/m.test(cfg), false);
  assert.equal(cfg.includes("'https://analytics.keiba.link/free-prediction/archive/'"), false);
});

test('コース攻略ページ: canonical / og:url / @id は末尾スラッシュ付きの自分自身', () => {
  const dir = 'src/pages/blog/course/';
  const files = readdirSync(`${ROOT}${dir}`).filter((f) => f.endsWith('.astro'));
  assert.ok(files.length >= 20);
  for (const f of files) {
    const slug = f.replace(/\.astro$/, '');
    const src = read(`${dir}${f}`);
    assert.equal(src.includes('example.com'), false, `${f}: example.com が残っている`);
    const urls = [...src.matchAll(/https:\/\/analytics\.keiba\.link\/blog\/course\/([a-z0-9-]+)(\/?)(?=["'])/g)];
    for (const m of urls) {
      assert.equal(m[2], '/', `${f}: 末尾スラッシュ無しの URL ${m[0]}`);
    }
    const canon = [...src.matchAll(/rel="canonical"\s+href="([^"]+)"/g)].map((m) => m[1]);
    for (const c of canon) assert.equal(c, `https://analytics.keiba.link/blog/course/${slug}/`, `${f}: canonical が自分ではない`);
    const constCanon = src.match(/const canonical = "([^"]+)"/);
    if (constCanon) assert.equal(constCanon[1], `https://analytics.keiba.link/blog/course/${slug}/`, f);
  }
});

test('/dark-horse-picks/ の canonical は末尾スラッシュ付き', () => {
  const src = read('src/pages/dark-horse-picks.astro');
  assert.match(src, /rel="canonical" href="https:\/\/analytics\.keiba\.link\/dark-horse-picks\/"/);
});

test('/free-prediction/[...slug] は SSR で 500 にせず 404 を返す', () => {
  const src = read('src/pages/free-prediction/[...slug].astro');
  const guard = src.indexOf("if (!allRacesData)");
  const thrower = src.indexOf("throw new Error('メインレースが見つかりません");
  assert.ok(guard > 0, '404 ガードが無い');
  assert.ok(guard < thrower, '404 ガードが throw より後ろにある');
  assert.match(src.slice(guard, guard + 300), /status:\s*404/);
});

test('旧 南関無料予想アーカイブは /archive/nankan/ へ 301（内部リンクも直接そちらへ）', () => {
  const toml = read('../netlify.toml');
  assert.match(toml, /from = "\/free-prediction\/archive\/"\s*\n\s*to = "\/archive\/nankan\/"\s*\n\s*status = 301\s*\n\s*force = true/);
  assert.equal(read('src/pages/free-prediction/nankan.astro').includes('href="/free-prediction/archive/"'), false);
});

test('トップの title は検索語（中央競馬・南関競馬・AI予想・無料）を先頭側に持つ', () => {
  // 2026-09-28 GSC: 最大表示クエリ「中央南関東競馬予想」で平均 5.6 位なのに CTR 0.3%（364 表示 / 1 クリック）。
  // 旧 title「AI競馬予想で投資効率を最大化」は検索語と一致していなかった。
  const m = read('src/pages/index.astro').match(/<BaseLayout title="([^"]+)"/);
  assert.ok(m);
  for (const w of ['中央競馬', '南関競馬', 'AI予想', '無料']) assert.ok(m[1].includes(w), w);
  assert.ok(m[1].indexOf('中央競馬') < 5, '検索語が後ろに追いやられている');
});
