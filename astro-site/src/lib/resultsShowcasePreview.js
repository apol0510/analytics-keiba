// resultsShowcasePreview.js
// ─────────────────────────────────────────────────────────────
// トップページ上部の「有料版で実際に配信した買い目」プレビュー用ビュー。
//
// 方針:
//   - 集計は一切しない。単一源 resultsShowcase.js の buildLatestShowcase() の
//     戻り値から【選ぶだけ】の薄いアダプタ。
//     （新しい結果 JSON も独自集計も作らない = RESULTS_SHOWCASE.md の確定仕様）
//   - 買い目の公開範囲（メインのみ / 抑え非公開 / 旧 ↔ 裏目的中の畳み込み）は
//     buildMainRace() が決めたものをそのまま使う。ここで再実装しない。
//   - 代表メインは「最初にメインレースを持つ会場」を機械的に選ぶ。
//     的中した会場を優先的に選ぶ等の“良く見せる”選び方はしない（実績の誇張禁止）。
//   - 全レース一覧（✅/✗）も buildLatestShowcase() の venueGroups[].races[] をそのまま渡す。
//     非メインは正本どおり **的中の有無のみ**で、買い目・払戻は持たせない
//     （raceNumber / isHit / isMain の 3 キーだけ。ここで race レコードを触らない）。
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
 * 表示できる代表メインレース（＝実際に配信した買い目）が無い場合は null を返し、
 * 呼び出し側でカードごと非表示にする（空カードや作り物の数値を出さない）。
 *
 * @param {Array} archiveArray archiveResults.json / archiveResultsJra.json の中身
 * @param {'jra'|'nankan'} category
 */
export function buildShowcasePreview(archiveArray, category) {
  if (!SHOWCASE_CATEGORIES.includes(category)) return null;

  const view = buildLatestShowcase(archiveArray);
  if (!view) return null;

  const groupsWithMain = (view.venueGroups ?? []).filter((g) => g && g.mainRace);
  if (groupsWithMain.length === 0) return null;

  const representative = groupsWithMain[0];
  const recoveryRate = view.recoveryRate == null ? null : Number(view.recoveryRate);

  // 全会場・全レースの ✅/✗ 一覧（JRA の 1 日 3 会場開催も全会場ぶん渡す）。
  // buildShowcaseDay() が組んだ races をそのまま使い、ここでは集計も並べ替えもしない。
  const venueGroups = (view.venueGroups ?? []).map((g) => ({
    venue: g.venue,
    totalRaces: g.totalRaces,
    hasMain: !!g.mainRace,
    mainRaceNumber: g.mainRace ? g.mainRace.raceNumber : null,
    races: g.races,
  }));

  return {
    category,
    categoryLabel: CATEGORY_LABEL[category],
    categoryTag: CATEGORY_TAG[category],
    href: `/results-showcase/${category}/`,
    date: view.date,
    dateLabel: formatShowcaseDate(view.date),
    venueLabel: view.venueLabel,
    totalRaces: view.totalRaces,
    hitRaces: view.hitRaces,
    recoveryRate: Number.isFinite(recoveryRate) ? recoveryRate : null,
    // 代表メイン（買い目本体は buildMainRace の戻り値をそのまま使う）
    mainRace: representative.mainRace,
    mainVenue: representative.venue,
    // 同日に他会場のメインもある場合の件数（JRA の3会場開催など）
    otherVenueCount: groupsWithMain.length - 1,
    // 全会場・全レースの ✅/✗（非メインは的中の有無のみ）
    venueGroups,
  };
}
