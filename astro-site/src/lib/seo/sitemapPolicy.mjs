/**
 * sitemapPolicy.mjs — サイトマップに**載せない** URL の単一源（純粋・astro.config から読む）
 *
 * ## なぜ要るか（2026-09-28 本番 read-only 監査）
 *
 * サイトマップ 165 件を Googlebot UA で全件取得したところ、**200 で index 可能ではない URL** が混ざっていた:
 *   - 301 / 302（会員限定ページのログイン誘導・旧 URL）… 17 件
 *   - noindex（`/offer/`）… 1 件
 * さらに、ログイン・マイページなど検索者に意味の無いページも載っていた。
 * サイトマップは「index してほしい正規 URL の一覧」なので、これらを載せると Google への信号がぶれる。
 *
 * ⚠️ 除外は**完全一致**（末尾スラッシュ付きパス）を基本にする。前方一致だと
 *    `/results/` を消すつもりで `/results-showcase/` まで消す事故が起きる。
 */

/** 完全一致で除外するパス（末尾スラッシュ付き） */
export const SITEMAP_EXCLUDE_EXACT = Object.freeze([
  // 302/301（会員限定・旧 URL。検索者が開いても本文に着地しない）
  '/archive-sanrenpuku/',
  '/archive-sanrenpuku/2025/',
  '/archive-sanrenpuku/2026/',
  '/archive-sanrenpuku-all/',
  '/archive-sanrenpuku-jra/',
  '/light-predictions/',
  '/light-predictions-jra/',
  '/premium-sanrenpuku/',
  '/premium-sanrenpuku-jra/',
  '/premium-select/',
  '/results/',
  '/results-jra/',
  '/today/',
  '/free-prediction/archive/', // 2026-09-28 から /archive/nankan/ へ 301
  // noindex / 個人向け（検索者に意味が無い）
  '/offer/',
  '/login/',
  '/dashboard/',
  '/welcome/',
  '/withdrawal-upsell/',
]);

/** 前方一致で除外するパス（配下すべてが対象のもの） */
export const SITEMAP_EXCLUDE_PREFIX = Object.freeze([
  '/admin/',
  '/auth/',
  '/premium-prediction/', // 会員限定（未ログインは 302）
  '/premium-plus',        // Premium Sanrenpuku 会員限定の非公開商品。存在を知らせない
]);

const pathOf = (page) => {
  try { return new URL(page).pathname; } catch { return String(page || ''); }
};

/** サイトマップに載せてよいか */
export function isSitemapExcluded(page) {
  const p = pathOf(page);
  const withSlash = p.endsWith('/') ? p : `${p}/`;
  if (SITEMAP_EXCLUDE_EXACT.includes(withSlash)) return true;
  return SITEMAP_EXCLUDE_PREFIX.some((x) => p.startsWith(x));
}
