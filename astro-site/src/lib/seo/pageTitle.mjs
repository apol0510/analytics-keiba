/**
 * pageTitle.mjs — `<title>` の組み立て（純粋・BaseLayout から使う）
 *
 * BaseLayout は常に `｜KEIBA Analytics｜競馬アナリティクス` を付ける。ページ側が既に
 * `… - KEIBA Analytics` / `… | KEIBA Analytics` を付けていると
 * `2026-09-20 中央競馬 AI予想 - KEIBA Analytics｜KEIBA Analytics｜競馬アナリティクス` のように
 * **ブランドが二重**になり、検索結果で本文の語が切り詰められる（2026-09-28 監査）。
 * ページ側の末尾ブランドだけを落としてから付け直す。
 */

export const SITE_BRAND = 'KEIBA Analytics';
export const SITE_BRAND_JA = '競馬アナリティクス';

// 末尾の「区切り + ブランド」を繰り返し落とす（区切り: | ｜ - – — ・ 空白）
const TRAILING_BRAND = new RegExp(
  `(?:\\s*[|｜\\-–—・]\\s*(?:${SITE_BRAND}|${SITE_BRAND_JA}))+\\s*$`,
);

export function stripTrailingBrand(title) {
  return String(title ?? '').replace(TRAILING_BRAND, '').trim();
}

/** 最終タイトル: ページタイトル + ブランド（ページタイトルが空ならブランドのみ） */
export function buildFullTitle(title) {
  const page = stripTrailingBrand(title);
  return page ? `${page}｜${SITE_BRAND}｜${SITE_BRAND_JA}` : `${SITE_BRAND}｜${SITE_BRAND_JA}`;
}
