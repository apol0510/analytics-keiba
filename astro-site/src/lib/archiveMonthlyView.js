/**
 * 月別アーカイブページ用のビューを生成する。
 *
 * 現状のデータ配置:
 *   - src/data/archiveResults.json (配列)        ← importResults.js 自動更新（南関）
 *   - src/data/archiveResults_YYYY-MM.json (obj) ← 初期化 snapshot（南関、自動更新されない）
 *   - src/data/archiveResultsJra.json (配列)     ← importResultsJra.js 自動更新（中央）
 *
 * buildMergedMonthData は 3 つを統合して、アーカイブページが期待する月データを返す。
 * 同日に中央と南関がある場合は両方を保持（南関は "DD"、中央は "DDj" キー）。
 * 表示側はキーで sort（string 昇順）するので "09" < "09j" < "10" と自然に並ぶ。
 */

import { sortRacesByVenueAndNumber } from '../utils/sortRaces.js';

function normalizeRaceForTemplate(race) {
  // 旧 monthly snapshot は {hit, betType, betPoints, payout, raceNumber, raceName}
  // singular（南関/中央）は {isHit, bettingPoints, umatan:{payout}, bettingLines, ...}
  // archive ページが参照するキー（hit/betType/betPoints/payout）に揃える。
  if (race == null) return race;
  const hit = race.hit ?? race.isHit ?? false;
  const betPoints = Number(race.betPoints ?? race.bettingPoints ?? 0);
  const betType = race.betType || (race.umatan ? '馬単' : '');
  const payout = Number(
    race.payout ??
    race.umatan?.payout ??
    0
  );
  return {
    ...race,
    hit,
    betPoints,
    betType,
    payout,
  };
}

function buildVenueDisplay(venue, venues, category) {
  if (category === 'jra') {
    const list = (Array.isArray(venues) && venues.length > 0)
      ? venues
      : (venue ? String(venue).split('・') : []);
    return list.length > 0 ? `中央（${list.join('・')}）` : '中央競馬';
  }
  // nankan
  return venue ? `${venue}競馬` : '南関競馬';
}

function normalizeDayFromSingular(entry, category) {
  const totalRaces = Number(entry.totalRaces || 0);
  const hitRaces = Number(entry.hitRaces || 0);
  const perfectHit = totalRaces > 0 && hitRaces === totalRaces;
  const venues = Array.isArray(entry.venues) && entry.venues.length > 0
    ? entry.venues
    : (entry.venue ? String(entry.venue).split('・') : []);
  let races = Array.isArray(entry.races) ? entry.races : [];
  // 中央は raceNumber 昇順 × venue 固定順（ラウンドロビン）に並べ替え
  if (category === 'jra') {
    races = sortRacesByVenueAndNumber(races, venues);
  }
  return {
    category,
    venue: entry.venue,
    venues,
    venueDisplay: buildVenueDisplay(entry.venue, venues, category),
    totalRaces,
    hitRaces,
    perfectHit,
    totalPayout: Number(entry.totalPayout || 0),
    recoveryRate: entry.returnRate ?? entry.recoveryRate ?? 0,
    races: races.map(normalizeRaceForTemplate),
  };
}

function normalizeDayFromMonthly(dayObj) {
  return {
    ...dayObj,
    category: 'nankan',
    venueDisplay: buildVenueDisplay(dayObj.venue, dayObj.venues, 'nankan'),
    races: (Array.isArray(dayObj.races) ? dayObj.races : []).map(normalizeRaceForTemplate),
  };
}

/**
 * 指定年月のマージ済み monthData を返す。
 *
 * @param {Array} archiveArray     - archiveResults.json の中身（南関、配列）
 * @param {Object} monthlySnapshot - archiveResults_YYYY-MM.json（南関 snapshot）
 * @param {string} year
 * @param {string} month
 * @param {Array} [jraArchive]     - archiveResultsJra.json の中身（中央、配列）※オプション
 * @returns {Object} dayKey -> dayData のマップ
 */
export function buildMergedMonthData(archiveArray, monthlySnapshot, year, month, jraArchive) {
  const merged = {};

  // 1. 南関 monthly snapshot を展開（既存）
  const monthlyDays = monthlySnapshot?.[year]?.[month] || {};
  for (const [day, dayObj] of Object.entries(monthlyDays)) {
    merged[day] = normalizeDayFromMonthly(dayObj);
  }

  // 2. 南関 singular で上書き（自動更新側が勝つ）
  if (Array.isArray(archiveArray)) {
    for (const entry of archiveArray) {
      if (!entry?.date) continue;
      const [y, m, d] = entry.date.split('-');
      if (y !== year || m !== month) continue;
      merged[d] = normalizeDayFromSingular(entry, 'nankan');
    }
  }

  // 3. 中央（JRA）を追加。キーは "DDj" にして南関と衝突を避ける。
  if (Array.isArray(jraArchive)) {
    for (const entry of jraArchive) {
      if (!entry?.date) continue;
      const [y, m, d] = entry.date.split('-');
      if (y !== year || m !== month) continue;
      merged[`${d}j`] = normalizeDayFromSingular(entry, 'jra');
    }
  }

  return merged;
}

/**
 * dayKey（"10" | "10j" 等）から表示用の日数値を取り出す。
 * sort/表示で使う。
 */
export function dayKeyToInt(key) {
  const m = String(key).match(/^(\d{1,2})/);
  return m ? parseInt(m[1], 10) : 0;
}
