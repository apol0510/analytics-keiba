/**
 * JRA 結果データ（archiveResultsJra.json）から最新日付の1日分を取り出し、
 * レースを「raceNumber 昇順 → venue 固定順」のラウンドロビン順に並べ替えて返す。
 *
 * 例: 中山1R → 阪神1R → 福島1R → 中山2R → 阪神2R → 福島2R ...
 *
 * データ構造（archiveResultsJra.json の要素）:
 *   {
 *     date, venue, venues: [...],
 *     totalRaces, hitRaces, missRaces, hitRate, totalPayout, returnRate,
 *     races: [{ raceNumber, raceName, venue, result, isHit, umatan, ... }],
 *   }
 */

import { sortRacesByVenueAndNumber } from '../utils/sortRaces.js';

/**
 * archiveResultsJra.json から最新日の1日分を取得し、ラウンドロビン順に並べ替える。
 *
 * @param {Array} archiveJra - archiveResultsJra.json の中身（配列）
 * @returns {{date:string, venues:string[], races:Array, stats:object}|null}
 */
export function getLatestJraResults(archiveJra) {
  if (!Array.isArray(archiveJra) || archiveJra.length === 0) return null;

  // 日付降順（先頭が最新）: archiveResultsJra.json は importResultsJra.js が unshift する仕様だが
  // 念のため date で並べ替える
  const sorted = [...archiveJra].sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = sorted[0];
  if (!latest?.date) return null;

  const venues = Array.isArray(latest.venues) && latest.venues.length > 0
    ? latest.venues
    : (latest.venue ? String(latest.venue).split('・') : []);

  const races = sortRacesByVenueAndNumber(
    Array.isArray(latest.races) ? latest.races : [],
    venues,
  );

  return {
    date: latest.date,
    venues,
    races,
    stats: {
      totalRaces: latest.totalRaces || 0,
      hitRaces: latest.hitRaces || 0,
      missRaces: latest.missRaces || 0,
      hitRate: latest.hitRate || 0,
      totalPayout: latest.totalPayout || 0,
      returnRate: latest.returnRate || 0,
      verifiedAt: latest.verifiedAt || null,
    },
  };
}

/**
 * 指定年月のJRA日次エントリ配列を返す（archive 月別ページ用）。
 * 各エントリには races をラウンドロビン順にソート済み。
 *
 * @param {Array} archiveJra - archiveResultsJra.json の中身
 * @param {string} year - "2026"
 * @param {string} month - "04"
 * @returns {Array<{day:string, dayData:object}>}
 */
export function getJraMonthDays(archiveJra, year, month) {
  if (!Array.isArray(archiveJra)) return [];
  const result = [];
  for (const entry of archiveJra) {
    if (!entry?.date) continue;
    const [y, m, d] = entry.date.split('-');
    if (y !== year || m !== month) continue;
    const venues = Array.isArray(entry.venues) && entry.venues.length > 0
      ? entry.venues
      : (entry.venue ? String(entry.venue).split('・') : []);
    const races = sortRacesByVenueAndNumber(
      Array.isArray(entry.races) ? entry.races : [],
      venues,
    );
    result.push({
      day: d,
      dayData: { ...entry, venues, races },
    });
  }
  return result;
}
