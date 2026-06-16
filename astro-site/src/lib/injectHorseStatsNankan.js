/**
 * injectHorseStatsNankan.js (analytics-keiba)
 *
 * 南関 horseStats（uma_info 元表統計）を読み、対象馬に
 * `horse.horseStatsNankan` を「別フィールドとして」追加する。
 *
 * 設計: keiba-data-shared-admin docs/nankan-uma-info-horse-stats-schema.md。
 *   既存 injectEntriesRecentRacesNankan.js の構造を踏襲。
 *
 * 絶対方針:
 *   - horse.recentRaces / recentRacesFromEntriesNankan / recentRacesFromHistoriesNankan /
 *     featureScores / importance / aiIndex / marks / odds を一切上書きしない。
 *   - 注入先は horse.horseStatsNankan のみ。result.ok のときだけ注入。
 *   - featureScores / AI指数 / 印 / 買い目 / EV / dark-horse には接続しない。
 *   - 失敗は非致命（何もしない・既存表示維持）。
 *
 * マッチング: raceNo（race.raceNumber）+ horseNumber 主、horseName 補助。
 */

import { loadHorseStatsNankan } from './loadHorseStatsNankan.js';

const NANKAN_NAME_TO_CODE = { '大井': 'OOI', '川崎': 'KAW', '船橋': 'FUN', '浦和': 'URA' };
const NANKAN_SLUG_TO_CODE = { ooi: 'OOI', kawasaki: 'KAW', funabashi: 'FUN', urawa: 'URA' };

function resolveVenueCode(venue) {
  const slug = venue?.venueSlug && String(venue.venueSlug).toLowerCase();
  if (slug && NANKAN_SLUG_TO_CODE[slug]) return NANKAN_SLUG_TO_CODE[slug];
  const name = String(venue?.track || '').replace('競馬場', '').replace('競馬', '').trim();
  return NANKAN_NAME_TO_CODE[name] || null;
}

function flattenRoleHorses(horsesByRole) {
  if (!horsesByRole || typeof horsesByRole !== 'object') return [];
  const out = [];
  for (const v of Object.values(horsesByRole)) {
    if (!v) continue;
    if (Array.isArray(v)) out.push(...v.filter(Boolean));
    else out.push(v);
  }
  return out;
}

/**
 * @param {Array} venues  pickLatestNankanVenuesAndAdapt の venues
 * @param {string} date   YYYY-MM-DD
 * @param {string} [projectRoot]
 */
export function injectHorseStatsNankan(venues, date, projectRoot = process.cwd()) {
  if (!Array.isArray(venues) || venues.length === 0 || !date) return venues;
  for (const venue of venues) {
    const code = resolveVenueCode(venue);
    if (!code) continue;
    for (const race of (venue?.races || [])) {
      const rn = parseInt(String(race?.raceNumber), 10);
      if (!Number.isFinite(rn)) continue;
      const objs = [
        ...(Array.isArray(race.allHorses) ? race.allHorses : []),
        ...flattenRoleHorses(race.horses),
      ];
      const cache = new Map(); // number|name -> horseStats|null（馬ごと loader 1回）
      for (const horse of objs) {
        if (!horse) continue;
        const num = horse.number ?? horse.horseNumber;
        const nm = horse.name ?? horse.horseName;
        const key = `${num}|${nm}`;
        let stats = cache.get(key);
        if (stats === undefined) {
          const r = loadHorseStatsNankan(
            { date, venue: code, raceNo: rn, horseNumber: num, horseName: nm },
            { projectRoot }
          );
          stats = (r.ok && r.horseStats) ? r.horseStats : null;
          cache.set(key, stats);
        }
        if (stats) horse.horseStatsNankan = stats; // 別フィールドのみ
      }
    }
  }
  return venues;
}

export default injectHorseStatsNankan;
