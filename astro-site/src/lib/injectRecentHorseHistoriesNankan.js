/**
 * injectRecentHorseHistoriesNankan.js (analytics-keiba)
 *
 * Phase 6 第3段階: 南関 recentHorseHistories を読み取り、対象馬に
 * `horse.recentRacesFromHistoriesNankan` を「別フィールドとして」追加する。
 *
 * 絶対方針:
 *   - horse.recentRaces は一切上書きしない（注入先は別フィールドのみ）
 *   - result.ok === true の馬だけ注入。fallback 時は何もしない
 *   - Feature Importance / featureScores / generateAdvancedMetrics /
 *     horseEnrichment / adjustPrediction には接続しない（このフィールドは表示候補専用）
 *   - debug/meta（source/matchedBy/warnings）は horse に永続化しない
 *
 * AK の南関 race は描画側が `race.horses`（役割別 horsesByRole）を読むため、
 * `race.allHorses`（配列）と `race.horses`（役割別の conv オブジェクト群）は
 * 別インスタンス。両方に同じ recentRaces を反映する（番号一致で一度だけ helper 取得）。
 */

import { loadRecentHorseHistoriesNankan } from './loadRecentHorseHistoriesNankan.js';

const NANKAN_NAME_TO_CODE = { '大井': 'OOI', '川崎': 'KAW', '船橋': 'FUN', '浦和': 'URA' };
const NANKAN_SLUG_TO_CODE = { ooi: 'OOI', kawasaki: 'KAW', funabashi: 'FUN', urawa: 'URA' };

function resolveVenueCode(venue) {
  const slug = venue?.venueSlug && String(venue.venueSlug).toLowerCase();
  if (slug && NANKAN_SLUG_TO_CODE[slug]) return NANKAN_SLUG_TO_CODE[slug];
  const name = String(venue?.track || '').replace('競馬場', '').replace('競馬', '').trim();
  return NANKAN_NAME_TO_CODE[name] || null;
}

// 役割別 horsesByRole（main/sub/hole1/hole2/connectTop/connect[]/reserve[]）を平坦化
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
 * @param {string} projectRoot
 */
export function injectRecentHorseHistoriesNankan(venues, date, projectRoot) {
  if (!Array.isArray(venues) || venues.length === 0 || !date) return;
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
      const cache = new Map(); // number|name -> recentRaces|null（helper を馬ごと1回に）
      for (const horse of objs) {
        if (!horse) continue;
        const num = horse.number;
        const nm = horse.name;
        const key = `${num}|${nm}`;
        let recent = cache.get(key);
        if (recent === undefined) {
          const r = loadRecentHorseHistoriesNankan(
            date, code,
            { raceNumber: rn, horseNumber: num, horseName: nm },
            { projectRoot }
          );
          recent = (r.ok && Array.isArray(r.recentRaces) && r.recentRaces.length > 0) ? r.recentRaces : null;
          cache.set(key, recent);
        }
        if (recent) horse.recentRacesFromHistoriesNankan = recent; // 別フィールドのみ・recentRaces 不変
      }
    }
  }
}

export default injectRecentHorseHistoriesNankan;
