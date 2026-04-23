/**
 * normalizePrediction.js
 *
 * keiba-data-sharedのJSON（詳細/シンプル）を読み、NormalizedPredictionに変換
 *
 * フォーマット:
 * - 詳細: 全馬データ + assignments（本命/対抗/単穴/連下最上位/連下/補欠/無）
 * - シンプル: 買い目のみ、馬データなし
 *
 * 変換フロー:
 * 1. detectFormat(input) - フォーマット検出
 * 2. normalizeDetailed(input) or normalizeSimple(input) - 正規化
 * 3. normalizeAndAdjust(input) - 正規化 + 調整ルール適用
 */

import { adjustPrediction } from './adjustPrediction.js';

/**
 * 競馬場名から競馬場コードに変換
 *
 * @param {string} venueName - 競馬場名
 * @returns {string} 競馬場コード
 */
function getVenueCode(venueName) {
  const venueMap = {
    '大井': 'OI',
    '川崎': 'KA',
    '船橋': 'FU',
    '浦和': 'UR',
    '東京': 'TK',
    '中山': 'NA',
    '阪神': 'HN',
    '京都': 'KY',
    '中京': 'CK',
    '新潟': 'NG',
    '小倉': 'KO',
    '札幌': 'SP',
    '函館': 'HK',
    '福島': 'FK'
  };

  return venueMap[venueName] || venueName.toUpperCase().substring(0, 2);
}

/**
 * フォーマット検出
 *
 * @param {Object} input - 入力JSON
 * @returns {string} 'detailed' | 'simple'
 */
export function detectFormat(input) {
  // 詳細フォーマット: raceDate がある または races[0].raceInfo がある または races[0].horses がある
  if (input.raceDate ||
      (input.races && input.races.length > 0 && input.races[0].raceInfo) ||
      (input.races && input.races.length > 0 && input.races[0].horses && input.races[0].horses.length > 0)) {
    return 'detailed';
  }

  // シンプルフォーマット: date がある かつ horses が無い/空
  if (input.date && (!input.races || input.races.length === 0 ||
      !input.races[0].horses || input.races[0].horses.length === 0)) {
    return 'simple';
  }

  // デフォルト: シンプル
  return 'simple';
}

/**
 * 詳細フォーマット → NormalizedPrediction
 *
 * @param {Object} input - 詳細フォーマットJSON
 * @returns {Object} NormalizedPrediction
 */
export function normalizeDetailed(input) {
  const date = input.raceDate || input.date;
  const venue = input.track || input.venue;
  const venueCode = getVenueCode(venue);
  const totalRaces = input.totalRaces || (input.races ? input.races.length : 0);

  const normalizedRaces = (input.races || []).map(race => {
    // レース番号抽出（"10R" → 10）
    let raceNumber = race.raceInfo?.raceNumber || race.raceNumber;
    if (typeof raceNumber === 'string') {
      const match = raceNumber.match(/(\d+)/);
      raceNumber = match ? parseInt(match[1], 10) : 0;
    }

    const raceName = race.raceInfo?.raceName || race.raceName || '';

    // レース詳細情報を保持
    const raceInfo = {
      raceName: raceName,
      startTime: race.raceInfo?.startTime || race.startTime || '',
      distance: race.raceInfo?.distance || race.distance || '',
      surface: race.raceInfo?.surface || race.surface || '',
      raceType: race.raceInfo?.raceType || race.raceType || '',
      raceSubtitle: race.raceInfo?.raceSubtitle || race.raceSubtitle || ''
    };

    // 馬データ変換
    let horses = (race.horses || []).map(horse => {
      // computerIndex 44以下は「無」扱い（rawScore=0）
      const COMPI_MIN = 45;
      let rawScore = horse.PT || horse.totalScore || horse.rawScore || 0;
      if (rawScore === 0) {
        const ci = parseInt(horse.computerIndex || '0');
        rawScore = (ci >= COMPI_MIN) ? ci : 0;
      }
      const role = horse.assignment || horse.role || '無';

      // 印1を取得（独自予想用）
      const mark1 = horse.marks?.['印1'] || '';

      return {
        number: horse.number,
        name: horse.name,
        rawScore: rawScore,
        displayScore: 0, // adjustPrediction()で計算
        role: role,
        mark: '', // adjustPrediction()で生成
        mark1: mark1, // 印1を保持（独自予想用）
        marks: horse.marks || {}, // adjustPredictionのcustomScore計算用（印1〜印N）
        // analytics-keiba 独自スコアリング用（PREDICTION_LOGIC.md 参照）
        computerIndex: parseInt(horse.computerIndex || '0') || 0,
        jockey: horse.kisyu || horse.jockey || '', // 騎手
        trainer: horse.kyusya || horse.trainer || '', // 厩舎
        age: horse.seirei || horse.ageGender || horse.age || '', // 馬齢（牡3、牝4など）
        weight: horse.kinryo || horse.weight || '', // 斤量
        // racebook由来の拡張フィールド（存在する場合のみ保持）
        ...(horse._pastRaces ? { _pastRaces: horse._pastRaces } : {}),
        ...(horse._training ? { _training: horse._training } : {}),
        ...(horse._shortComment ? { _shortComment: horse._shortComment } : {}),
        ...(horse._predictedOdds ? { _predictedOdds: horse._predictedOdds } : {}),
        ...(horse._sire ? { _sire: horse._sire } : {})
      };
    });

    // computer/形式（assignmentがない）の場合、rawScore順に役割を自動割り当て
    const hasAssignment = horses.some(h => h.role !== '無');
    if (!hasAssignment && horses.length > 0) {
      // rawScore降順にソート
      // rawScore > 0 の馬のみ役割割り当て対象
      const scored = horses.filter(h => h.rawScore > 0);
      const sorted = [...scored].sort((a, b) => b.rawScore - a.rawScore);

      if (sorted.length >= 1) sorted[0].role = '本命';
      if (sorted.length >= 2) sorted[1].role = '対抗';
      if (sorted.length >= 3) sorted[2].role = '単穴';
      if (sorted.length >= 4) sorted[3].role = '連下最上位';
      for (let i = 4; i < sorted.length && i < 7; i++) {
        sorted[i].role = '連下';
      }
      for (let i = 7; i < sorted.length; i++) {
        sorted[i].role = '補欠';
      }
      // rawScore=0 の馬は role='無' のまま
    }

    // 買い目データ（存在する場合）
    const bettingLines = race.bettingLines || null;

    return {
      raceNumber,
      raceName,
      raceInfo, // レース詳細情報を追加
      horses,
      bettingLines,
      hasHorseData: horses.length > 0
    };
  });

  return {
    date,
    venue,
    venueCode,
    totalRaces,
    races: normalizedRaces
  };
}

/**
 * シンプルフォーマット → NormalizedPrediction
 *
 * @param {Object} input - シンプルフォーマットJSON
 * @returns {Object} NormalizedPrediction
 */
export function normalizeSimple(input) {
  const date = input.date;
  const venue = input.venue;
  const venueCode = input.venueCode || getVenueCode(venue);
  const totalRaces = input.totalRaces || (input.races ? input.races.length : 0);

  const normalizedRaces = (input.races || []).map(race => {
    return {
      raceNumber: race.raceNumber,
      raceName: race.raceName || '',
      horses: [], // 馬データなし
      bettingLines: race.bettingLines || null,
      hasHorseData: false
    };
  });

  return {
    date,
    venue,
    venueCode,
    totalRaces,
    races: normalizedRaces
  };
}

/**
 * 入力JSONをNormalizedPredictionに変換
 *
 * @param {Object} input - 詳細 or シンプルフォーマットJSON
 * @returns {Object} NormalizedPrediction
 */
export function normalizePrediction(input) {
  const format = detectFormat(input);

  if (format === 'detailed') {
    return normalizeDetailed(input);
  } else {
    return normalizeSimple(input);
  }
}

/**
 * 正規化 + 調整ルール適用
 * 南関競馬・中央競馬（JRA）共通のロジック
 *
 * hasHorseData=true の場合のみ adjustPrediction() を適用
 * assignmentをそのまま保持（元データでassignmentと印1は既に一致）
 *
 * @param {Object} input - 詳細 or シンプルフォーマットJSON
 * @returns {Object} Adjusted NormalizedPrediction
 */
export function normalizeAndAdjust(input) {
  const normalized = normalizePrediction(input);

  // hasHorseData=true のレースのみ調整ルール適用
  const hasAnyHorseData = normalized.races.some(race => race.hasHorseData);

  if (!hasAnyHorseData) {
    return normalized;
  }

  // 南関・JRA共通の調整ルール適用
  return adjustPrediction(normalized);
}
