/**
 * loadHorseHistoriesJra.js
 *
 * astro-site/src/data/horseHistories/jra/YYYY/MM/YYYY-MM-DD-{VENUE_CODE}.json を読み込み、
 * **表示専用** の「過去走配列」(既存 horse.recentRaces 互換形) を生成する。
 *
 * 設計方針:
 *   - 既存 horse.recentRaces は一切上書きしない。注入先は別フィールド recentRacesFromHistories。
 *   - 計算系 (computeEvalPoints / computeImportance / detectRecentRunningStyle /
 *     AI 総合指数 / 印 / 買い目 / darkHorses) は引き続き horse.recentRaces を読むため、副作用ゼロ。
 *   - データ源は horseHistories.recent5。レース当日 date と一致する race は除外して最大 4 走。
 *   - 突合キーは horseName (prediction 側に horseId が無いため)。
 *     **結合規則の単一源は `src/lib/jra/horseHistoryJoin.js`**（完全一致優先 →
 *     既知接頭辞 `(地)`/`(外)` を外して再照合 → 衝突は fail closed）。本 module は判定結果を使うだけ。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { buildJoinIndex, joinRaceHorses } from './jra/horseHistoryJoin.js';

const JRA_VENUE_NAME_TO_CODE = {
  '東京': 'TOK',
  '中山': 'NAK',
  '京都': 'KYO',
  '阪神': 'HAN',
  '中京': 'CHU',
  '新潟': 'NII',
  '福島': 'FKS',
  '小倉': 'KOK',
  '札幌': 'SAP',
  '函館': 'HKD',
};

export function jraVenueCodeFromName(name) {
  if (!name) return null;
  return JRA_VENUE_NAME_TO_CODE[name] || null;
}

/**
 * 指定 date/venueCode の horseHistories JSON を読み込む。無ければ null。
 *
 * @param {string} date YYYY-MM-DD
 * @param {string} venueCode TOK / KYO / NII / ...
 * @param {string} [projectRoot] 既定: process.cwd()
 */
export function loadHorseHistoriesForVenue(date, venueCode, projectRoot = process.cwd()) {
  if (!date || !venueCode) return null;
  const m = String(date).match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  const [year, month] = [m[1], m[2]];
  const file = join(projectRoot, 'src', 'data', 'horseHistories', 'jra', year, month, `${date}-${venueCode}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 結合用の索引を作る。実体は `jra/horseHistoryJoin.js` の `buildJoinIndex()`。
 * `resolveRaceHistories()` とセットで使う。
 */
export function buildHistoryJoinIndex(historiesJson) {
  return buildJoinIndex(historiesJson);
}

/**
 * 1 レースぶんの馬配列に対応する履歴 entry を返す（入力と同じ長さ）。
 * 照合できなかった要素は null。判定規則は `jra/horseHistoryJoin.js` が単一源。
 *
 * @param {Array<object>} horses
 * @param {{exact: Map, normalized: Map}|null} joinIndex
 * @param {{nameOf?: (h: object) => unknown}} [opts]
 * @returns {Array<object|null>}
 */
export function resolveRaceHistories(horses, joinIndex, opts = {}) {
  if (!Array.isArray(horses) || !joinIndex) return (Array.isArray(horses) ? horses : []).map(() => null);
  return joinRaceHorses(horses, joinIndex, opts).map((r) => (r.matched ? r.entry : null));
}

/**
 * @deprecated 完全一致のみの旧索引。`(地)`/`(外)` 付きの馬が落ちるため新規利用は不可。
 * 既存呼び出しの互換のためだけに残す。
 *
 * horseHistories.horses (horseId keyed) を horseName -> entry の Map に変換。
 * 同名衝突は最初の1件のみ。
 */
export function buildHorseNameIndex(historiesJson) {
  const idx = new Map();
  if (!historiesJson || typeof historiesJson !== 'object') return idx;
  const horses = historiesJson.horses || {};
  for (const entry of Object.values(horses)) {
    if (!entry || typeof entry !== 'object') continue;
    const name = entry.horseName;
    if (!name) continue;
    if (!idx.has(name)) idx.set(name, entry);
  }
  return idx;
}

// horseHistories の race entry を既存 recentRaces 互換形に変換する。
//   既存: { venue, distance, rank, time, last3f, bodyWeight, jockey, passingOrder }
//   horseHistories には last3f / passingOrder が無いため空文字で埋める。
function convertHistoryRaceToRecentShape(h) {
  if (!h || typeof h !== 'object') return null;
  const rankNum = Number(h.finish);
  const rank = Number.isFinite(rankNum) ? rankNum : (h.finish ?? '');
  const venueDisplay = (() => {
    const v = h.venue || '';
    const d = h.date || '';
    const dm = String(d).match(/^\d{4}-(\d{2})-(\d{2})$/);
    if (v && dm) return `${v} ${Number(dm[1])}/${Number(dm[2])}`;
    if (v && d) return `${v} ${d}`;
    return v;
  })();
  const distance = h.displayDistance
    || (h.distanceMeters != null ? String(h.distanceMeters) : '')
    || '';
  const bodyWeightNum = Number(h.bodyWeight);
  const bodyWeight = Number.isFinite(bodyWeightNum) ? bodyWeightNum : (h.bodyWeight ?? null);
  return {
    venue: venueDisplay,
    distance,
    rank,
    time: h.time || '',
    last3f: '',
    bodyWeight,
    jockey: h.jockey || '',
    passingOrder: '',
  };
}

/**
 * 1頭ぶんの horseHistories から、表示用 recentRaces (最大 5 走) を生成する。
 * 入力は history (全レース履歴) を使用。excludeDate と一致する race は除外、最大 5 走。
 *
 * recent5 は仕様上 [0]=当日レース を含むため、当日除外後は最大 4 走しか取れず
 * 「最大 5 走表示」の目的を満たせない。よって全件保持の history を使う。
 *
 * @param {object|undefined} horseHistoryEntry historiesJson.horses[horseId]
 * @param {string} excludeDate YYYY-MM-DD (レース当日)
 * @returns {Array|null} 1件以上あれば配列、無ければ null
 */
export function pickRecentRacesFromHistories(horseHistoryEntry, excludeDate) {
  if (!horseHistoryEntry || typeof horseHistoryEntry !== 'object') return null;
  const source = Array.isArray(horseHistoryEntry.history)
    ? horseHistoryEntry.history
    : (Array.isArray(horseHistoryEntry.recent5) ? horseHistoryEntry.recent5 : null);
  if (!source) return null;
  const filtered = source.filter((r) => r && r.date !== excludeDate);
  const converted = filtered.slice(0, 5).map(convertHistoryRaceToRecentShape).filter(Boolean);
  return converted.length > 0 ? converted : null;
}

// 詳細表示（過去走データアコーディオン）用の race shape。
// 既存 recentRaces 互換の shape (convertHistoryRaceToRecentShape) とは別に、
// プロフィール／通算成績／条件別成績／競走成績の集計に必要な原値を保持する。
function convertHistoryRaceToDetailShape(h) {
  if (!h || typeof h !== 'object') return null;
  const dm = String(h.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dateStr = dm ? `${dm[1].slice(2)}/${dm[2]}/${dm[3]}` : '';
  const finishNum = Number(h.finish);
  const rank = Number.isFinite(finishNum) ? finishNum : null;
  const finishStatus = (typeof h.finish === 'string' && !Number.isFinite(finishNum)) ? h.finish : '';
  const distanceMetersNum = Number(h.distanceMeters);
  const distanceMeters = Number.isFinite(distanceMetersNum) ? distanceMetersNum : null;
  const time = h.time ? String(h.time).replace(/:/g, '.') : '';
  const displayDistance = h.displayDistance
    || (h.surface && distanceMeters != null ? `${h.surface}${distanceMeters}` : '');
  return {
    date: h.date || '',
    _dateStr: dateStr,
    venue: h.venue || '',
    raceName: h.raceName || '',
    surface: h.surface || '',
    distanceMeters,
    _displayDistance: displayDistance,
    trackCondition: h.trackCondition || '',
    entryCount: h.entryCount ?? '',
    popularity: h.popularity ?? '',
    finish: h.finish ?? '',
    rank,
    finishStatus,
    jockey: h.jockey || '',
    carryWeight: h.carryWeight ?? '',
    bodyWeight: h.bodyWeight ?? '',
    time,
    winnerName: h.winnerName || '',
    _fromHistories: true,
  };
}

/**
 * 1頭ぶんの horseHistories から、詳細表示（過去走データアコーディオン）用の配列を生成する。
 * 入力は history (全レース履歴) のみを使用。excludeDate と一致する race は除外、最大 maxCount 走。
 *
 * 表示専用。pickRecentRacesFromHistories とは独立しており、
 * 既存 5 走表示（recentRacesFromHistories）には一切影響しない。
 *
 * @param {object|undefined} horseHistoryEntry historiesJson.horses[horseId]
 * @param {string} excludeDate YYYY-MM-DD (レース当日)
 * @param {number} [maxCount=20] 最大件数
 * @returns {Array|null} 1件以上あれば配列、無ければ null
 */
export function pickHistoryForDetails(horseHistoryEntry, excludeDate, maxCount = 20) {
  if (!horseHistoryEntry || typeof horseHistoryEntry !== 'object') return null;
  const source = Array.isArray(horseHistoryEntry.history) ? horseHistoryEntry.history : null;
  if (!source) return null;
  const filtered = source.filter((r) => r && r.date !== excludeDate);
  const converted = filtered.slice(0, maxCount).map(convertHistoryRaceToDetailShape).filter(Boolean);
  return converted.length > 0 ? converted : null;
}

/**
 * venues 配列内の各 horse に対し、表示用 recentRacesFromHistories を注入する。
 * 既存 horse.recentRaces は触らない。
 *
 * 失敗してもサイレントに既存表示にフォールバックさせる前提のため、例外は呼び出し側で捕捉して握りつぶしてよい。
 *
 * @param {Array} venues  [{ venue, predictions: [{ horses: [...] }] }]
 * @param {string} date YYYY-MM-DD
 * @param {string} [projectRoot]
 */
export function injectHorseHistoriesIntoVenues(venues, date, projectRoot) {
  if (!Array.isArray(venues) || venues.length === 0 || !date) return;
  for (const venueData of venues) {
    const venueCode = jraVenueCodeFromName(venueData?.venue);
    if (!venueCode) continue;
    const historiesJson = loadHorseHistoriesForVenue(date, venueCode, projectRoot);
    if (!historiesJson) continue;
    const joinIndex = buildHistoryJoinIndex(historiesJson);
    if (joinIndex.exact.size === 0) continue;
    for (const race of (venueData.predictions || [])) {
      const horses = race?.horses || [];
      // 結合はレース単位で行う（レース内の衝突を検出して fail closed にするため）。
      const resolved = resolveRaceHistories(horses, joinIndex);
      horses.forEach((horse, hi) => {
        const histHorse = resolved[hi];
        if (!horse || !histHorse) return;
        const built = pickRecentRacesFromHistories(histHorse, date);
        if (built && built.length > 0) {
          horse.recentRacesFromHistories = built;
        }
        // 詳細表示（過去走データアコーディオン）用。
        // 既存 recentRacesFromHistories 注入とは独立しており、片方が空でも他方は機能する。
        const builtForDetails = pickHistoryForDetails(histHorse, date);
        if (builtForDetails && builtForDetails.length > 0) {
          horse.historyForDetails = builtForDetails;
        }
      });
    }
  }
}
