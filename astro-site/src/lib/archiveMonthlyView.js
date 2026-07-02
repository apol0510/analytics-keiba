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
  // singular（南関/中央）は {isHit, bettingPoints, umatan:{payout}, bettingLines, raceNumber:number, ...}
  // archive ページが参照するキー（hit/betType/betPoints/payout/raceNumber/raceLabel）に揃える。
  if (race == null) return race;
  const hit = race.hit ?? race.isHit ?? false;

  // bettingPoints が未定義の日もある（南関 singular）。undefined のときは 0 にせず null のままにし、
  // テンプレート側で「点数が不明 / 0」の場合に非表示にできるようにする。
  const rawBetPoints = race.betPoints ?? race.bettingPoints;
  const betPoints = (rawBetPoints == null || rawBetPoints === '') ? null : Number(rawBetPoints);
  const betType = race.betType || (race.umatan ? '馬単' : '');
  const payout = Number(
    race.payout ??
    race.umatan?.payout ??
    0
  );

  // raceNumber を "1R" のような文字列に揃える（生の数値 1 や "1" を "1R" に）
  const rnRaw = race.raceNumber;
  let raceNumber;
  if (typeof rnRaw === 'number') {
    raceNumber = `${rnRaw}R`;
  } else if (typeof rnRaw === 'string') {
    raceNumber = /R$/.test(rnRaw) ? rnRaw : `${rnRaw}R`;
  } else {
    raceNumber = '';
  }
  const raceName = race.raceName || '';
  const raceLabel = raceNumber ? `${raceNumber}${raceName ? ' ' + raceName : ''}` : raceName;

  return {
    ...race,
    hit,
    betPoints,
    betType,
    payout,
    raceNumber,
    raceName,
    raceLabel,
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
    source: 'live', // archiveResults.json(=公開本線のみ判定済み) 由来
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
    source: 'snapshot', // 旧月別 snapshot(=旧「本線+抑え」基準)由来
    venueDisplay: buildVenueDisplay(dayObj.venue, dayObj.venues, 'nankan'),
    races: (Array.isArray(dayObj.races) ? dayObj.races : []).map(normalizeRaceForTemplate),
  };
}

/**
 * 指定年月のマージ済み monthData を返す。
 *
 * 優先順位:
 *   1. 南関 monthly snapshot を先に展開（fallback として残す）
 *   2. 南関 singular (archiveResults.json) で**上書き** → 新ロジックの数値が最終値
 *   3. 中央（JRA）を "DDj" キーで追加
 *
 * @param {Array} archiveArray     - archiveResults.json の中身（南関、配列）
 * @param {Object} monthlySnapshot - archiveResults_YYYY-MM.json（南関 snapshot）
 * @param {string} year
 * @param {string} month
 * @param {Array} [jraArchive]     - archiveResultsJra.json の中身（中央、配列）
 * @returns {Object} dayKey -> dayData のマップ
 */
export function buildMergedMonthData(archiveArray, monthlySnapshot, year, month, jraArchive) {
  const merged = {};

  // 1. 南関 monthly snapshot を先に展開（singular に無い日の fallback）
  const monthlyDays = monthlySnapshot?.[year]?.[month] || {};
  for (const [day, dayObj] of Object.entries(monthlyDays)) {
    merged[day] = normalizeDayFromMonthly(dayObj);
  }

  // 2. 南関 singular で上書き（公開本線のみ判定済みの最終値）。
  //    live(archiveResults.json)が「betPoints を持つ」または「公開本線判定済み(bettingLines保有)」
  //    または「snapshot に無い日」の場合は live を採用する。
  //    betPoints の有無だけで snapshot(旧「本線+抑え」判定)へ戻さない
  //    （2026-04-14 対策: live に公開本線判定済み値があるのに snapshot が上書きしていた不具合の解消）。
  if (Array.isArray(archiveArray)) {
    for (const entry of archiveArray) {
      if (!entry?.date) continue;
      const [y, m, d] = entry.date.split('-');
      if (y !== year || m !== month) continue;

      const races = Array.isArray(entry.races) ? entry.races : [];
      const hasRaceBetPoints = races.some(r => r && Number.isFinite(r.betPoints) && r.betPoints > 0);
      // 公開本線判定済み = bettingLines を持つ（=snapshot の旧判定より優先すべき表示可能データ）。
      const hasLiveDisplayData = races.length > 0
        && races.some(r => Array.isArray(r.bettingLines) && r.bettingLines.length > 0);
      const hasMonthly = Object.prototype.hasOwnProperty.call(merged, d);

      if (hasRaceBetPoints || hasLiveDisplayData || !hasMonthly) {
        merged[d] = normalizeDayFromSingular(entry, 'nankan');
      }
      // else: 最低限の表示データも持たない場合のみ monthly を維持
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

/**
 * 南関AK馬単「公開本線のみ」実績の集計開始日。
 * これ以前（2026-04-14 以前）の月別 snapshot は bettingLines/着順を持たず公開本線のみで再判定できないため、
 * 旧「本線＋抑え」基準のまま。年間・全期間の“現在基準”集計には混在させず、この日以降だけを対象とする。
 * 旧期間データ自体は削除せず、月別履歴として閲覧可能なまま維持する。
 */
export const CURRENT_BASIS_START = '2026-04-15';
export const CURRENT_BASIS_START_LABEL = '2026年4月15日';
export const LEGACY_BASIS_END_LABEL = '2026年4月14日';

/** dayKey("14"|"14j") と year,month から日付が現在基準期間（>= CURRENT_BASIS_START）か判定（日付のみ）。 */
export function isCurrentBasisDay(year, month, dayKey) {
  const d = String(dayKeyToInt(dayKey)).padStart(2, '0');
  return `${year}-${String(month).padStart(2, '0')}-${d}` >= CURRENT_BASIS_START;
}

/**
 * 1日分のマージ済みデータが「現在基準」か判定。
 * 現在基準 = live(archiveResults.json=公開本線のみ判定済み)由来 かつ 日付 >= CURRENT_BASIS_START。
 * snapshot 由来（旧「本線+抑え」基準）は、たとえ日付が 04-15 以降でも現在基準に含めない。
 */
export function isCurrentBasisEntry(year, month, dayKey, dayData) {
  return dayData?.source === 'live' && isCurrentBasisDay(year, month, dayKey);
}

/**
 * buildMergedMonthData の返り値（南関）を「現在基準」「旧基準」に分けて集計する共通 helper。
 * JRA 日（"DDj" / category==='jra'）は南関集計から除外。日付キー map のため二重計上は起きない。
 * 現在基準は live 由来かつ 2026-04-15 以降のみ（snapshot 由来は日付に関わらず legacy）。
 * @returns {{current:Object, legacy:Object}} 各 {days,hitRaces,totalRaces,payout,perfectDays}
 */
export function aggregateMonthByBasis(monthData, year, month) {
  const mk = () => ({ days: 0, hitRaces: 0, totalRaces: 0, payout: 0, perfectDays: 0 });
  const current = mk(), legacy = mk();
  for (const [key, d] of Object.entries(monthData || {})) {
    if (String(key).endsWith('j') || d?.category === 'jra') continue; // 南関のみ
    const bucket = isCurrentBasisEntry(year, month, key, d) ? current : legacy;
    bucket.days += 1;
    bucket.hitRaces += d.hitRaces || 0;
    bucket.totalRaces += d.totalRaces || 0;
    bucket.payout += d.totalPayout || 0;
    if (d.perfectHit) bucket.perfectDays += 1;
  }
  return { current, legacy };
}
