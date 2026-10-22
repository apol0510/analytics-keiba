/**
 * seoPages.test.mjs — 静的 SEO 記事（public/seo/<slug>/）のサイトマップ・旧 URL・canonical（2026-10-22）
 *   node --test src/lib/seo/*.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { listSeoSlugs, seoPageUrl } from './seoPages.mjs';
import { isSitemapExcluded } from './sitemapPolicy.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SEO_DIR = join(ROOT, 'public/seo');
const slugs = listSeoSlugs(SEO_DIR);

test('SEO 記事: public/seo の記事が 37 本見つかる（一覧が空になって素通りしない）', () => {
  assert.equal(slugs.length, 37);
  assert.ok(!slugs.includes('sitemap.xml'));
});

test('SEO 記事: canonical は自分自身の /seo/<slug>/ を 1 つだけ持つ', () => {
  for (const s of slugs) {
    const html = readFileSync(join(SEO_DIR, s, 'index.html'), 'utf8');
    const canon = html.match(/<link[^>]*rel="canonical"[^>]*>/gi) || [];
    assert.equal(canon.length, 1, `${s}: canonical の数`);
    assert.ok(canon[0].includes(`href="${seoPageUrl(s)}"`), `${s}: canonical が自己 URL でない`);
    const ogUrl = html.match(/<meta[^>]*property="og:url"[^>]*>/gi) || [];
    for (const m of ogUrl) assert.ok(m.includes(`content="${seoPageUrl(s)}"`), `${s}: og:url が自己 URL でない`);
    assert.ok(!/noindex/i.test(html), `${s}: noindex の記事をサイトマップに載せない`);
  }
});

test('SEO 記事: サイトマップの除外規則に掛からない（-demo の除外に巻き込まない）', () => {
  for (const s of slugs) assert.equal(isSitemapExcluded(seoPageUrl(s)), false, s);
  const config = readFileSync(join(ROOT, 'astro.config.mjs'), 'utf8');
  assert.match(config, /\.\.\.SEO_ARTICLE_URLS/);
  assert.match(config, /page\.includes\('-demo'\) && !page\.includes\('\/seo\/'\)/);
});

test('旧公開 URL: /<slug> と /<slug>/ を /seo/<slug>/ へ 301（37 本ちょうど・他の行は変えない）', () => {
  const lines = readFileSync(join(ROOT, 'public/_redirects'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const seoRules = lines.filter((l) => /\s\/seo\//.test(l));
  assert.equal(seoRules.length, slugs.length * 2);
  for (const s of slugs) {
    for (const from of [`/${s}`, `/${s}/`]) {
      const rule = lines.find((l) => l.split(/\s+/)[0] === from);
      assert.ok(rule, `${from} のリダイレクトが無い`);
      assert.deepEqual(rule.split(/\s+/), [from, `/seo/${s}/`, '301'], from);
    }
  }
  // 既存の 1 行（/api/*）は残っている
  assert.ok(lines.includes('/api/*  /.netlify/functions/ssr  200'));
});

test('旧公開 URL: AK の既存ルート・既存リダイレクトと重ならない', () => {
  const pages = join(ROOT, 'src/pages');
  const pub = join(ROOT, 'public');
  const tomls = [join(ROOT, 'netlify.toml'), join(ROOT, '../netlify.toml')]
    .filter(existsSync).map((p) => readFileSync(p, 'utf8'));
  // トップに動的ルート（[slug].astro / [...rest].astro）があると /<slug>/ を奪い合う
  assert.deepEqual(readdirSync(pages).filter((n) => n.startsWith('[')), []);
  for (const s of slugs) {
    for (const p of [`${s}.astro`, `${s}.md`, `${s}.ts`, `${s}.js`, s]) {
      assert.ok(!existsSync(join(pages, p)), `src/pages/${p} と重なる`);
    }
    assert.ok(!existsSync(join(pub, s)), `public/${s} と重なる`);
    assert.ok(!existsSync(join(pub, `${s}.html`)), `public/${s}.html と重なる`);
    for (const t of tomls) assert.ok(!t.includes(`from = "/${s}`), `netlify.toml に /${s} の既存ルールがある`);
  }
});
