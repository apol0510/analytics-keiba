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
 * 【2026-05-24】馬データの sanitize / 安全化処理。
 *
 * keiba-data-shared (admin) 側で OCR / HTML パースに失敗した馬データ
 * (name === '' / sexAge === ')' 等) が後段の予想カードに昇格してしまう事故
 * (例: 2026-05-24 京都4R 馬番1 が単穴に昇格し AI総合指数 161 表示) を防ぐ。
 *
 * - 馬名が空文字 / null / 空白のみの馬は role を強制的に '無' に降格。
 *   → 本命・対抗・単穴・連下・補欠 などのカードに登場しない。
 * - age (性齢) が記号のみ (')', '(', ')(' 等) の場合は空文字に正規化。
 *
 * 注意: AK は keiba-data-shared 側を直接修正しない (admin 独立運用) ため、
 *       取込側でこの sanitize を必ず通す。表示側で隠す対応は禁止 (CLAUDE.md)。
 */
function sanitizeHorseName(name) {
  if (typeof name !== 'string') return '';
  return name.trim();
}
/**
 * 馬名が破損しているか判定。
 * - 空文字 / 空白のみ → 破損
 * - ひらがな / カタカナ / 漢字 (CJK) / ラテン英数を 1 文字も含まない → 破損
 *   (2026-05-24 京都4R 馬番1: name が U+E615 1 文字 = Private Use Area で
 *    "name === ''" だけでは検知できないケースがあった)
 */
function isHorseNameBroken(name) {
  const s = sanitizeHorseName(name);
  if (s === '') return true;
  // ひらがな (U+3040-309F) / カタカナ (U+30A0-30FF) / CJK (U+4E00-9FFF, 拡張A U+3400-4DBF) / 英数
  const hasValid = /[぀-ゟ゠-ヿ一-鿿㐀-䶿0-9A-Za-z]/.test(s);
  return !hasValid;
}
function sanitizeAge(age) {
  if (typeof age !== 'string') return '';
  const s = age.trim();
  if (s === '') return '';
  // 性齢の正規形は「牡3」「牝4」「セ5」「騙3」など。
  // それ以外で記号 / 空白のみの場合は空文字に正規化する。
  if (/^[牡牝セ騙][0-9]+$/.test(s)) return s;
  if (/^[\)\(\s\-_~・,\.]+$/.test(s)) return '';
  // それ以外は upstream に従う（不明な記号入りは目視確認のため保持）
  return s;
}

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
      // 2026-05-14 修正: rawScore 昇格の正規ソースを sourceComputerIndex に変更。
      //   - 旧仕様: predictions JSON の computerIndex（admin 編集系の値）で >=45 判定
      //   - 新仕様: importPrediction.js が computer JSON 併読みで付与した
      //            sourceComputerIndex（元 racebook 指数）で >=45 判定
      //   - sourceComputerIndex が無いデータ (旧 predictions JSON や computer JSON 取得失敗時)
      //     は従来通り computerIndex にフォールバック
      const COMPI_MIN = 45;
      let rawScore = horse.PT || horse.totalScore || horse.rawScore || 0;
      const sourceCi = (horse.sourceComputerIndex != null && Number.isFinite(Number(horse.sourceComputerIndex)))
        ? Number(horse.sourceComputerIndex)
        : null;
      // admin 編集系 computerIndex は 0-9 スケールに正規化されている場合があるため、
      // しきい値 10 未満なら指数として扱わず、sourceComputerIndex 由来の昇格に任せる。
      const fallbackCiRaw = parseInt(horse.computerIndex || '0') || 0;
      const fallbackCi = fallbackCiRaw >= 10 ? fallbackCiRaw : 0;
      const ciForFloor = sourceCi != null ? sourceCi : fallbackCi;
      // 2026-05-16 修正: 南関/JRA で pt スケールを揃えるため、
      // totalScore など低い値（< COMPI_MIN）の場合は ciForFloor(>=45) で昇格させる。
      // 旧仕様は rawScore === 0 のときだけ ciForFloor を採用していたため、
      // racebook の totalScore=19 程度が pt スケールに反映されず、JRA だけが低い pt 帯
      // (~80) で表示されていた。南関の挙動（pt~150 帯）に揃える。
      if (rawScore < COMPI_MIN && ciForFloor >= COMPI_MIN) {
        rawScore = ciForFloor;
      }
      // 【2026-05-24】馬データ破損ガード:
      //   馬名が空 / 性齢が記号のみ などの場合、上流側パース失敗が確実。
      //   役割を '無' に降格して予想カード（本命/対抗/単穴/連下系/補欠）に登場させない。
      //   さらに adjustPrediction が rawScore 降順で再分類するため、rawScore も 0 に潰す
      //   (これで活性馬群から外れ、本命/対抗/単穴 に昇格しなくなる)。
      const nameBroken = isHorseNameBroken(horse.name);
      const upstreamRole = horse.assignment || horse.role || '無';
      const role = nameBroken ? '無' : upstreamRole;
      if (nameBroken) {
        console.warn(`⚠️ [SANITIZE] 馬データ破損で '無' 降格 + rawScore=0: ${date} ${venue} R${raceNumber} 馬番${horse.number} (元role=${upstreamRole}, sexAge=${JSON.stringify(horse.sexAge)})`);
        rawScore = 0;
      }

      // 印1を取得（独自予想用）
      const mark1 = horse.marks?.['印1'] || '';

      return {
        number: horse.number,
        // 破損馬名 (PUA 文字 1 文字 等) は表示で `)` 様のゴミになるため空文字に正規化
        name: nameBroken ? '' : sanitizeHorseName(horse.name),
        rawScore: rawScore,
        displayScore: 0, // adjustPrediction()で計算
        role: role,
        mark: '', // adjustPrediction()で生成
        mark1: mark1, // 印1を保持（独自予想用）
        marks: horse.marks || {}, // adjustPredictionのcustomScore計算用（印1〜印N）
        // analytics-keiba 独自スコアリング用（PREDICTION_LOGIC.md 参照）
        computerIndex: fallbackCi,
        // 2026-05-14: 元 racebook 指数を後段にも流す（出力に保存して再生成・診断に使う）
        ...(sourceCi != null ? { sourceComputerIndex: sourceCi } : {}),
        jockey: horse.kisyu || horse.jockey || '', // 騎手
        trainer: horse.kyusya || horse.trainer || '', // 厩舎
        age: sanitizeAge(horse.seirei || horse.ageGender || horse.age || ''), // 馬齢（牡3、牝4など）
        weight: horse.kinryo || horse.weight || '', // 斤量
        // racebook由来の拡張フィールド（存在する場合のみ保持）
        ...(horse._pastRaces ? { _pastRaces: horse._pastRaces } : {}),
        ...(horse._training ? { _training: horse._training } : {}),
        ...(horse._shortComment ? { _shortComment: horse._shortComment } : {}),
        ...(horse._predictedOdds ? { _predictedOdds: horse._predictedOdds } : {}),
        ...(horse._sire ? { _sire: horse._sire } : {}),
        // 過去走（南関 racebook / JRA computer 由来）— 表示用に保持
        ...(Array.isArray(horse.recentRaces) && horse.recentRaces.length > 0 ? { recentRaces: horse.recentRaces } : {})
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
