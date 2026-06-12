/**
 * injectEntriesRecentRacesNankan.js (analytics-keiba) — PR-F5e-1
 *
 * 南関 entries(出馬表) 由来の近走を読み取り、対象馬に
 * `horse.recentRacesFromEntriesNankan` を「別フィールドとして」追加する。
 *
 * 設計: keiba-data-shared-admin docs/nankan-horse-detail-display-plan.md §32（馬詳細専用）。
 *   既存 injectRecentHorseHistoriesNankan.js の構造を踏襲。
 *
 * 絶対方針（§32）:
 *   - **`horse.recentRaces` を一切上書きしない**（注入先は別フィールドのみ）。
 *   - **`horse.recentRacesFromHistoriesNankan` を一切上書きしない**（recentHorseHistories と独立）。
 *   - **entries は recentHorseHistories の fallback にしない**（getDisplayRecentRacesForNankan を import しない・変更しない）。
 *   - result.ok === true かつ recentRaces.length > 0 の馬だけ注入。fallback 時は何もしない。
 *   - full venue guard（R01-only/partial skip）は loadEntriesNankan に委譲。
 *   - **record は触らない**（mapper が record を除外済み）。
 *   - featureScores / AI指数 / 印 / 買い目 / 穴馬 / dark-horse / adjustPrediction には接続しない。
 *   - debug/meta（source/matchedBy/warnings）は horse に永続化しない。
 *
 * AK の南関 race は描画側が `race.horses`（役割別 horsesByRole）を読むため、
 * `race.allHorses`（配列）と `race.horses`（役割別 conv オブジェクト群）は別インスタンス。
 * 両方に同じ recentRaces を反映する（番号一致で一度だけ loader 取得）。
 */

import { loadEntriesNankan } from './loadEntriesNankan.js';

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
 * @param {string} [projectRoot]
 */
export function injectEntriesRecentRacesNankan(venues, date, projectRoot = process.cwd()) {
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
      const cache = new Map(); // number|name -> recentRaces|null（loader を馬ごと1回に）
      for (const horse of objs) {
        if (!horse) continue;
        const num = horse.number;
        const nm = horse.name;
        const key = `${num}|${nm}`;
        let recent = cache.get(key);
        if (recent === undefined) {
          const r = loadEntriesNankan(
            date, code,
            { raceNumber: rn, horseNumber: num, horseName: nm },
            { projectRoot }
          );
          recent = (r.ok && Array.isArray(r.recentRaces) && r.recentRaces.length > 0) ? r.recentRaces : null;
          cache.set(key, recent);
        }
        // 別フィールドのみ・recentRaces / recentRacesFromHistoriesNankan は不変
        if (recent) horse.recentRacesFromEntriesNankan = recent;
      }
    }
  }
  return venues;
}

export default injectEntriesRecentRacesNankan;
