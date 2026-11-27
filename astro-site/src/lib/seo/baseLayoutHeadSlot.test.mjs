/**
 * baseLayoutHeadSlot.test.mjs — ページの slot="head" が <head> に出力されること
 *   node --test src/lib/seo/*.test.mjs
 *
 * BaseLayout に <slot name="head" /> が無いと、ページ側の slot="head" の要素
 * （コース解説・比較ページの Article / BreadcrumbList / FAQPage の JSON-LD）は
 * 黙って捨てられる（2026-11-28 本番で /course/compare/ 等の構造化データが 0 件だった）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const walk = (dir) =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = join(dir, name);
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : rel.endsWith('.astro') ? [rel] : [];
  });

const pagesUsingHeadSlot = () =>
  walk('src/pages').filter((p) => /slot="head"/.test(read(p)) && /import BaseLayout /.test(read(p)));

test('BaseLayout の <head> に名前付き slot "head" がある', () => {
  const layout = read('src/layouts/BaseLayout.astro');
  const head = layout.slice(layout.indexOf('<head>'), layout.indexOf('</head>'));
  assert.match(head, /<slot name="head"\s*\/>/);
});

test('slot="head" を使うページがある（検査の対象が空でない）', () => {
  assert.ok(pagesUsingHeadSlot().length >= 10);
});

test('slot="head" で canonical・og・twitter の meta を重複して出さない（BaseLayout の props で渡す）', () => {
  for (const p of pagesUsingHeadSlot()) {
    const src = read(p);
    assert.doesNotMatch(src, /<link[^>]*slot="head"[^>]*rel="canonical"|<link[^>]*rel="canonical"[^>]*slot="head"/, `${p}: canonical が二重になる`);
    assert.doesNotMatch(src, /<meta[^>]*slot="head"[^>]*(property="og:|name="twitter:|name="robots")/, `${p}: og / twitter / robots が二重になる`);
  }
});
