// resultsShowcasePreview.js
// ─────────────────────────────────────────────────────────────
// トップページ上部の「当日の実績」プレビュー用ビュー。
//
// 方針:
//   - 集計は一切しない。単一源 resultsShowcase.js の buildLatestShowcase() の
//     戻り値から【選ぶだけ】の薄いアダプタ。
//     （新しい結果 JSON も独自集計も作らない = RESULTS_SHOWCASE.md の確定仕様）
//   - トップでは **買い目・払戻を一切出さない**（2026-08-18 改訂）。
//     メインレースの実際の配信買い目は /results-showcase/{jra,nankan} 側だけで見せる。
//     → そもそも買い目・払戻を **戻り値に含めない**ことで、トップ側から漏れないようにする。
//   - **トップは的中したレースだけを出す**（2026-11-25 MK 決定・全 repo 共通）。
//     不的中のレース・分母（総レース数・「全12R」）・0 件のカードを出さない。
//     外れも含めた全件の記録は /results-showcase/ と実績アーカイブにそのまま残す。
//     → 不的中のレースと総レース数を **戻り値に含めない**（マークアップで隠すのではなく持たない）。
//   - 的中レースは venueGroups[].races[] で渡す。非メインも含めて同列で、
//     各レースは raceNumber / isHit / isMain の 3 キーのみ（買い目・払戻を持たない）。
//     isMain は単一源の値をそのまま通すだけで、**表示上の強調には使わない**。
// ─────────────────────────────────────────────────────────────

import { buildLatestShowcase } from './resultsShowcase.js';

export const SHOWCASE_CATEGORIES = ['jra', 'nankan'];

const CATEGORY_LABEL = {
  jra: '中央競馬',
  nankan: '南関競馬',
};

const CATEGORY_TAG = {
  jra: 'JRA',
  nankan: 'NANKAN',
};

/** 'YYYY-MM-DD' → 'M月D日'（不正値はそのまま返す） */
export function formatShowcaseDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  if (!m) return String(date ?? '');
  return `${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`;
}

/**
 * アーカイブ配列（index 0 = 最新日）→ トップページ用プレビュー1枚。
 *
 * 的中したレースが 1 つも無い場合は null を返し、呼び出し側でカードごと
 * 非表示にする（空カード・0 件・作り物の数値を出さない）。
 *
 * @param {Array} archiveArray archiveResults.json / archiveResultsJra.json の中身
 * @param {'jra'|'nankan'} category
 */
export function buildShowcasePreview(archiveArray, category) {
  if (!SHOWCASE_CATEGORIES.includes(category)) return null;

  const view = buildLatestShowcase(archiveArray);
  if (!view) return null;

  // 的中したレースだけ（JRA の 1 日 3 会場開催も全会場ぶん）。
  // buildShowcaseDay() が組んだ races から isHit === true を選ぶだけで、集計も並べ替えもしない。
  // 的中が 1 つも無い会場は出さない。
  const venueGroups = (view.venueGroups ?? [])
    .filter((g) => g && Array.isArray(g.races))
    .map((g) => ({
      venue: g.venue,
      races: g.races.filter((r) => r && r.isHit === true),
    }))
    .filter((g) => g.races.length > 0);

  // 的中が 1 つも無い日はカードごと出さない（0 件のカードを作らない）
  if (venueGroups.length === 0 || !(Number(view.hitRaces) > 0)) return null;

  const recoveryRate = view.recoveryRate == null ? null : Number(view.recoveryRate);

  return {
    category,
    categoryLabel: CATEGORY_LABEL[category],
    categoryTag: CATEGORY_TAG[category],
    href: `/results-showcase/${category}/`,
    date: view.date,
    dateLabel: formatShowcaseDate(view.date),
    venueLabel: view.venueLabel,
    // 当日の的中数（単一源の値をそのまま使う。分母＝総レース数は持たない）
    hitRaces: view.hitRaces,
    recoveryRate: Number.isFinite(recoveryRate) ? recoveryRate : null,
    // 的中したレース（買い目・払戻・不的中のレースは持たせない）
    venueGroups,
  };
}
