/**
 * seoPages.mjs — `public/seo/<slug>/index.html`（静的な SEO 記事）の単一源
 *
 * ## なぜ要るか（2026-10-22）
 *
 * 37 本の SEO 記事は `public/seo/<slug>/` に置かれた**静的 HTML** で、本番では
 * `https://analytics.keiba.link/seo/<slug>/` が 200 を返す。しかし:
 *
 *   1. `@astrojs/sitemap` は `src/pages` 由来のページしか拾わないため、**サイトマップに 1 本も載っていなかった**
 *   2. 旧公開 URL `nankan-analytics.keiba.link/<slug>/` は `analytics.keiba.link/<slug>/` へ 301 され、そこが **404** だった
 *   3. 記事に canonical が無かった
 *
 * サイトマップ（astro.config.mjs の customPages）・リダイレクト（public/_redirects）・canonical の
 * 検査（seoPages.test.mjs）は、すべてこのファイルの一覧を使う。手で 37 行を書き写さない。
 *
 * ⚠️ 記事の本文は生成元（generated-sites）の出力のコピー。ここでは**読むだけ**で、本文を書き換えない。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SITE_ORIGIN = 'https://analytics.keiba.link';
export const SEO_BASE_PATH = '/seo/';

/** `public/seo/` 配下で `index.html` を持つディレクトリ名（slug）を名前順で返す。 */
export function listSeoSlugs(publicSeoDir) {
  if (!existsSync(publicSeoDir)) return [];
  return readdirSync(publicSeoDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(d.name))
    .filter((d) => existsSync(join(publicSeoDir, d.name, 'index.html')))
    .map((d) => d.name)
    .sort();
}

/** 記事の正規 URL（canonical・サイトマップ・リダイレクト先で共通）。 */
export function seoPageUrl(slug) {
  return `${SITE_ORIGIN}${SEO_BASE_PATH}${slug}/`;
}
