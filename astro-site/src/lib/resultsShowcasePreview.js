// resultsShowcasePreview.js
// ─────────────────────────────────────────────────────────────
// トップページ上部の「当日の実績」プレビュー用ビュー。
//
// 方針:
//   - 集計は一切しない。単一源 resultsShowcase.js の buildLatestShowcase() の
//     戻り値から【選ぶだけ】の薄いアダプタ。
//     （新しい結果 JSON も独自集計も作らない = RESULTS_SHOWCASE.md の確定仕様）
//   - トップでは **買い目・払戻を一切出さない**（2026-08-18 改訂）。
//     主役は「的中数 / 総レース数・回収率・全レースの ✅/✗」。
//     メインレースの実際の配信買い目は /results-showcase/{jra,nankan} 側だけで見せる。
//     → そもそも買い目・払戻を **戻り値に含めない**ことで、トップ側から漏れないようにする。
//   - 全レースは venueGroups[].races[] をそのまま渡す。非メインも含めて同列で、
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
 * 表示できるレースが 1 つも無い場合は null を返し、呼び出し側でカードごと
 * 非表示にする（空カードや作り物の数値を出さない）。
 *
 * @param {Array} archiveArray archiveResults.json / archiveResultsJra.json の中身
 * @param {'jra'|'nankan'} category
 */
export function buildShowcasePreview(archiveArray, category) {
  if (!SHOWCASE_CATEGORIES.includes(category)) return null;

  const view = buildLatestShowcase(archiveArray);
  if (!view) return null;

  // 全会場・全レースの ✅/✗（JRA の 1 日 3 会場開催も全会場ぶん）。
  // buildShowcaseDay() が組んだ races をそのまま使い、ここでは集計も並べ替えもしない。
  const venueGroups = (view.venueGroups ?? [])
    .filter((g) => g && Array.isArray(g.races) && g.races.length > 0)
    .map((g) => ({
      venue: g.venue,
      totalRaces: g.totalRaces,
      races: g.races,
    }));

  if (venueGroups.length === 0) return null;

  const recoveryRate = view.recoveryRate == null ? null : Number(view.recoveryRate);

  return {
    category,
    categoryLabel: CATEGORY_LABEL[category],
    categoryTag: CATEGORY_TAG[category],
    href: `/results-showcase/${category}/`,
    date: view.date,
    dateLabel: formatShowcaseDate(view.date),
    venueLabel: view.venueLabel,
    // 当日の全体実績（単一源の値をそのまま使う）
    totalRaces: view.totalRaces,
    hitRaces: view.hitRaces,
    recoveryRate: Number.isFinite(recoveryRate) ? recoveryRate : null,
    // 全会場・全レースの ✅/✗（買い目・払戻は持たせない）
    venueGroups,
  };
}
