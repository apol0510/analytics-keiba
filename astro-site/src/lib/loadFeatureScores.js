/**
 * loadFeatureScores.js
 *
 * astro-site/src/data/featureScores/{category}/YYYY/MM/YYYY-MM-DD-{VENUE}.json を読み込み、
 * **表示専用** の 6項目 featureScores（Layer B）+ normalizedPastRaces（Layer A）を返す。
 *
 * 設計方針:
 *   - 読むだけ。算出・書込なし。値（value=null/insufficient 含む）は改変せずそのまま返す。
 *   - throw しない。ファイルなし/parse失敗/engine不一致/race・horse欠落は null / false を返し、
 *     SSR ページから呼んでも例外でページを落とさない。
 *   - engine 受信側ガード: jra→'jra-v1' / nankan→'nankan-v1' と category に一致しなければ null。
 *   - AI総合指数 / 印 / 買い目 / 予想本文 / 過去走 / computeImportance には一切関与しない。
 *   - loadHorseHistoriesJra.js とは独立（import も改変もしない）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED_ENGINE = { jra: 'jra-v1', nankan: 'nankan-v1' };

const VENUE_NAME_TO_CODE = {
  jra: {
    '東京': 'TOK', '中山': 'NAK', '京都': 'KYO', '阪神': 'HAN', '中京': 'CHU',
    '新潟': 'NII', '福島': 'FKS', '小倉': 'KOK', '札幌': 'SAP', '函館': 'HKD',
  },
  nankan: {
    '大井': 'OOI', '川崎': 'KAW', '船橋': 'FUN', '浦和': 'URA',
  },
};

const FEATURE_KEYS = ['speedIndex', 'staminaRating', 'formTrend', 'trackCompatibility', 'distanceFitness', 'jockeyFactor'];

/**
 * 競馬場名 → venueCode（jra / nankan）。未知/不正は null。
 */
export function venueCodeFromName(category, venueName) {
  if (!category || !venueName) return null;
  const map = VENUE_NAME_TO_CODE[category];
  if (!map) return null;
  const clean = String(venueName).replace('競馬場', '').replace('競馬', '').trim();
  return map[clean] || map[venueName] || null;
}

/**
 * 指定 category/date/venueCode の featureScores JSON を読み込む。
 * 無ければ null。engine が category と不一致でも null（受信側ガード）。
 *
 * @param {string} category 'jra' | 'nankan'
 * @param {string} date 'YYYY-MM-DD'
 * @param {string} venueCode 'TOK' / 'URA' / ...
 * @param {string} [projectRoot] 既定: process.cwd()
 * @returns {object|null}
 */
export function loadFeatureScores(category, date, venueCode, projectRoot = process.cwd()) {
  if (!category || !EXPECTED_ENGINE[category]) return null;
  if (!date || !venueCode) return null;
  const m = String(date).match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  const [year, month] = [m[1], m[2]];
  const code = String(venueCode).toUpperCase();
  const file = join(projectRoot, 'src', 'data', 'featureScores', category, year, month, `${date}-${code}.json`);
  if (!existsSync(file)) return null;

  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    console.warn(`[loadFeatureScores] JSON parse 失敗 (${file}): ${e.message}`);
    return null;
  }
  if (!json || typeof json !== 'object') return null;

  // 受信側ガード: engine / category 一致を確認（import 側ガードと二重化）
  if (json.engine !== EXPECTED_ENGINE[category] || json.category !== category) {
    console.warn(`[loadFeatureScores] engine/category 不一致 (expected ${EXPECTED_ENGINE[category]}/${category}, got ${json.engine}/${json.category}) → null`);
    return null;
  }
  if (!json.races || typeof json.races !== 'object') return null;
  return json;
}

/**
 * 指定 race/horse の 6項目ブロックを返す。無ければ null。
 * value=null / insufficient はそのまま返す（表示側で出し分ける）。
 *
 * @returns {object|null} { speedIndex:{value,rank,confidence,basisRaces}, ... } または null
 */
export function getHorseFeatures(featureScoresData, raceNumber, horseNumber) {
  if (!featureScoresData || typeof featureScoresData !== 'object') return null;
  const race = featureScoresData.races?.[String(raceNumber)];
  if (!race || !race.horses) return null;
  const horse = race.horses[String(horseNumber)];
  if (!horse || !horse.featureScores) return null;
  return horse.featureScores;
}

/**
 * 表示価値があるか：entry が存在し、6項目のうち value!=null が1つ以上あるか。
 * 6項目すべて null（真にデータ皆無）のときだけ false。
 *
 * @returns {boolean}
 */
export function hasUsableFeatureScores(featureScoresData, raceNumber, horseNumber) {
  const fs = getHorseFeatures(featureScoresData, raceNumber, horseNumber);
  if (!fs) return false;
  return FEATURE_KEYS.some((k) => fs[k] && fs[k].value != null);
}
