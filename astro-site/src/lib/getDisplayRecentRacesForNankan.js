/**
 * 南関 recentHorseHistories の「表示用」recentRaces を返す wrapper。
 *
 * 方針（Phase 6 第4段階）:
 *   - 注入済み horse.recentRacesFromHistoriesNankan があればそれを優先（表示専用）
 *   - 無ければ従来の horse.recentRaces を「そのまま」返す（既存UI互換のため正規化しない）
 *   - horse.recentRaces は一切変更しない（本関数は新しい配列を返すだけ）
 *   - 注入元のみ whitelist 正規化＋ finish→rank マッピング（rank 不在時のみ）
 *   - Feature Importance / featureScores / generateAdvancedMetrics には一切接続しない
 *   - slice / reverse は呼び出し側（表示）の既存ロジックを維持する
 *
 * 並び順:
 *   注入元 recentRacesFromHistoriesNankan は「古→新」。
 *   AK の既存 recentRaces も「古→新」のため reverse しない。
 *   表示側 free=slice(-5).reverse() / premium=slice(0,5)（公式出馬表に合わせ最大5走）。
 */

// 注入元から表示へ渡してよい項目（内部・診断フィールドは落とす）
const DISPLAY_WHITELIST = [
  'date', 'venue', 'venueName', 'venueCode', 'raceNumber', 'raceName',
  'distance', 'distanceMeters', 'surface', 'trackCondition', 'headCount',
  'horseNumber', 'rank', 'finishStatus', 'popularity', 'bodyWeight',
  'jockey', 'carriedWeight', 'time', 'passingOrder', 'last3f', 'margin',
];

// 注入元1走を表示用に正規化（whitelist 抽出 ＋ finish→rank 補完）
function normalizeInjectedRace(r) {
  const out = {};
  for (const k of DISPLAY_WHITELIST) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  // 注入元は rank を持たず finish のみ。rank 不在時だけ finish を写す。
  if (out.rank === undefined && r.finish !== undefined) out.rank = r.finish;
  return out;
}

/**
 * @param {object} horse
 * @returns {Array} 表示用 recentRaces（horse.recentRaces は不変）
 */
export function getDisplayRecentRacesForNankan(horse) {
  const inj = horse && horse.recentRacesFromHistoriesNankan;
  if (Array.isArray(inj) && inj.length > 0) {
    const normalized = inj.map(normalizeInjectedRace);
    return normalized; // AK: 既存と同順（古→新）なので reverse しない
  }
  // 注入が無ければ既存 recentRaces を素通し（正規化しない）
  return (horse && Array.isArray(horse.recentRaces)) ? horse.recentRaces : [];
}

export default getDisplayRecentRacesForNankan;
