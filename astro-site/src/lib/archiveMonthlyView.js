/**
 * 月別アーカイブページ用のビューを生成する。
 *
 * 現状のデータ配置:
 *   - src/data/archiveResults.json (配列)   ← importResults.js が自動更新。直近のみ。
 *   - src/data/archiveResults_YYYY-MM.json (ネストobj) ← 初期化時のスナップショット。自動更新されない。
 *
 * どちらか一方だけだと日付が欠ける（例: 2026/04 は singular に 4/14-22、monthly に 4/1-10）。
 * そこで両方を **マージ** し、monthlyArchive の期待シェイプ
 *   { [year]: { [month]: { [day]: {venue, totalRaces, hitRaces, perfectHit, totalPayout, recoveryRate, races} } } }
 * に正規化して返す。
 * 同日に両方のデータがある場合は singular (自動更新側) を優先。
 */

const PASS = (v) => v;

function normalizeDayFromSingular(entry) {
  // 的中率計算用（singular: totalRaces / hitRaces / totalPayout / returnRate）
  const totalRaces = Number(entry.totalRaces || 0);
  const hitRaces = Number(entry.hitRaces || 0);
  const perfectHit = totalRaces > 0 && hitRaces === totalRaces;
  return {
    venue: entry.venue,
    venues: entry.venues,
    totalRaces,
    hitRaces,
    perfectHit,
    totalPayout: Number(entry.totalPayout || 0),
    recoveryRate: entry.returnRate ?? entry.recoveryRate ?? 0,
    races: Array.isArray(entry.races) ? entry.races : [],
  };
}

function normalizeDayFromMonthly(dayObj) {
  // 既存 monthly シェイプはそのまま通す（フィールド名は互換）
  return {
    ...dayObj,
    races: Array.isArray(dayObj.races) ? dayObj.races : [],
  };
}

/**
 * 指定年月のマージ済み monthData を返す。
 *
 * @param {Array} archiveArray - archiveResults.json の中身（配列）
 * @param {Object} monthlySnapshot - archiveResults_YYYY-MM.json の中身（{year:{month:{...}}}）
 * @param {string} year - 例 "2026"
 * @param {string} month - 例 "04"
 * @returns {Object} dayKey -> dayData のマップ（新しい日降順表示は呼出側で）
 */
export function buildMergedMonthData(archiveArray, monthlySnapshot, year, month) {
  const merged = {};

  // 1. 先に monthly snapshot を展開（古い既存データ）
  const monthlyDays = monthlySnapshot?.[year]?.[month] || {};
  for (const [day, dayObj] of Object.entries(monthlyDays)) {
    merged[day] = normalizeDayFromMonthly(dayObj);
  }

  // 2. singular array で上書き（自動更新側が勝つ）
  if (Array.isArray(archiveArray)) {
    for (const entry of archiveArray) {
      if (!entry?.date) continue;
      const [y, m, d] = entry.date.split('-');
      if (y !== year || m !== month) continue;
      merged[d] = normalizeDayFromSingular(entry);
    }
  }

  return merged;
}
