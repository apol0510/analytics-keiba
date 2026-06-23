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
 *
 * fallback 優先順位（表示の正本）:
 *   1. recentRacesFromEntriesNankan（呼び出し側でインライン判定・最優先）
 *   2. recentRacesFromHistoriesNankan（本関数 ① 注入正規化）
 *   3. horseStatsNankan.recentRacesDetailed（本関数 ② uma_info 正本・最大5走へ正規化）
 *   4. recentRaces（legacy・racebook 由来・素通し）
 *   entries / histories が無い日でも、保存済み horseStats(5走) を使い racebook の
 *   不完全な4走へ落とさない（horse.recentRaces / horseStatsNankan は破壊しない）。
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

// passingOrder を配列・文字列どちらでも表示用文字列へ安全化（推測補完はしない）。
function normalizePassingOrderNankan(v) {
  if (Array.isArray(v)) {
    const parts = v.filter((x) => x !== null && x !== undefined && x !== '');
    return parts.length > 0 ? parts.join('-') : undefined;
  }
  return v;
}

// horseStats(recentRacesDetailed) 1走 → 表示用 whitelist shape。
//   finish → rank（order は順序であり着順ではないので使わない）
//   horseNumberInRace → horseNumber、passingOrder は配列/文字列を安全化。
//   実体が無い（全項目欠落）の場合は null。
function mapHorseStatsRecentRaceNankan(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {};
  const put = (k, val) => { if (val !== undefined && val !== null && val !== '') out[k] = val; };
  put('date', r.date);
  put('venue', r.venue);
  put('raceName', r.raceName);
  put('distance', r.distance);
  put('surface', r.surface);
  put('trackCondition', r.trackCondition);
  put('headCount', r.headCount);
  put('popularity', r.popularity);
  put('bodyWeight', r.bodyWeight);
  put('jockey', r.jockey);
  put('carriedWeight', r.carriedWeight);
  put('time', r.time);
  put('last3f', r.last3f);
  put('margin', r.margin);
  put('passingOrder', normalizePassingOrderNankan(r.passingOrder));
  put('rank', r.finish);                    // finish → rank（order は使わない）
  put('finishStatus', r.finishStatus);      // 非完走があれば（無ければ付けない）
  put('horseNumber', r.horseNumberInRace);  // horseNumberInRace → horseNumber
  for (const k of Object.keys(out)) { if (!DISPLAY_WHITELIST.includes(k)) delete out[k]; }
  return Object.keys(out).length > 0 ? out : null;
}

// horse.horseStatsNankan.recentRacesDetailed → 表示用配列（最大5走）。
//   recentRacesDetailed は「新→古」(order 1=前走)。AK の表示契約「古→新」へ揃えるため
//   最新5走を取って reverse する。不正/空なら [] を返し legacy へ fallback させる。
function horseStatsRecentRacesNankan(horse) {
  const detailed = horse && horse.horseStatsNankan && horse.horseStatsNankan.recentRacesDetailed;
  if (!Array.isArray(detailed) || detailed.length === 0) return [];
  const mapped = detailed.map(mapHorseStatsRecentRaceNankan).filter(Boolean);
  if (mapped.length === 0) return [];
  return mapped.slice(0, 5).reverse(); // AK: 古→新 に揃える
}

/**
 * @param {object} horse
 * @returns {Array} 表示用 recentRaces（horse.recentRaces / horseStatsNankan は不変）
 */
export function getDisplayRecentRacesForNankan(horse) {
  const inj = horse && horse.recentRacesFromHistoriesNankan;
  if (Array.isArray(inj) && inj.length > 0) {
    const normalized = inj.map(normalizeInjectedRace);
    return normalized; // AK: 既存と同順（古→新）なので reverse しない
  }
  // histories が無ければ horseStats 正本（uma_info）の近走を最大5走で採用（racebook4走へ落とさない）。
  const fromHorseStats = horseStatsRecentRacesNankan(horse);
  if (fromHorseStats.length > 0) return fromHorseStats;
  // どれも無ければ既存 recentRaces を素通し（正規化しない）
  return (horse && Array.isArray(horse.recentRaces)) ? horse.recentRaces : [];
}

export default getDisplayRecentRacesForNankan;
