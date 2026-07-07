/**
 * session/normalize.js — plan / venue の正規化（PR-A）
 *
 * 旧表記・大小文字・日本語表記を明示した canonical 値へ変換する純粋関数。
 * 未知の値は null を返す（呼び出し側で拒否する）。ランタイム非依存。
 */

import {
  PLAN_FREE,
  PLAN_LIGHT,
  PLAN_PREMIUM,
  PLAN_PREMIUM_COMBO,
  PLAN_PREMIUM_PLUS,
  PLAN_PREMIUM_SANRENPUKU,
  PLAN_PREMIUM_SANRENTAN,
  CANONICAL_PLANS,
  PAID_PLANS,
  CANONICAL_VENUES,
} from './constants.js';

// エイリアス（小文字化・trim 後のキー）→ canonical plan
const PLAN_ALIASES = new Map([
  // free
  ['free', PLAN_FREE],
  ['free-registered', PLAN_FREE],
  ['フリー', PLAN_FREE],
  ['無料', PLAN_FREE],
  // light（旧 standard / ライト）
  ['light', PLAN_LIGHT],
  ['standard', PLAN_LIGHT],
  ['ライト', PLAN_LIGHT],
  ['スタンダード', PLAN_LIGHT],
  // premium
  ['premium', PLAN_PREMIUM],
  ['premium predictions', PLAN_PREMIUM],
  ['プレミアム', PLAN_PREMIUM],
  // premium-combo
  ['premium combo', PLAN_PREMIUM_COMBO],
  ['premiumcombo', PLAN_PREMIUM_COMBO],
  ['プレミアムコンボ', PLAN_PREMIUM_COMBO],
  // premium-plus
  ['premium plus', PLAN_PREMIUM_PLUS],
  ['premiumplus', PLAN_PREMIUM_PLUS],
  ['プレミアムプラス', PLAN_PREMIUM_PLUS],
  // premium-sanrenpuku（三連複）
  ['premium sanrenpuku', PLAN_PREMIUM_SANRENPUKU],
  ['premiumsanrenpuku', PLAN_PREMIUM_SANRENPUKU],
  ['premium 三連複', PLAN_PREMIUM_SANRENPUKU],
  ['プレミアム三連複', PLAN_PREMIUM_SANRENPUKU],
  ['三連複', PLAN_PREMIUM_SANRENPUKU],
  // premium-sanrentan（三連単）
  ['premium sanrentan', PLAN_PREMIUM_SANRENTAN],
  ['premiumsanrentan', PLAN_PREMIUM_SANRENTAN],
  ['premium 三連単', PLAN_PREMIUM_SANRENTAN],
  ['プレミアム三連単', PLAN_PREMIUM_SANRENTAN],
  ['三連単', PLAN_PREMIUM_SANRENTAN],
]);

// canonical 値そのものも受理する
for (const p of CANONICAL_PLANS) PLAN_ALIASES.set(p, p);

/**
 * plan を canonical 値へ正規化。未知は null。
 * @param {unknown} input
 * @returns {string|null}
 */
export function normalizePlan(input) {
  if (typeof input !== 'string') return null;
  const key = input.trim().toLowerCase();
  if (key === '') return null;
  return PLAN_ALIASES.get(key) ?? null;
}

/** canonical plan が有料か（free は false） */
export function isPaidPlan(plan) {
  return PAID_PLANS.includes(plan);
}

const VENUE_ALIASES = new Map([
  ['all', 'all'],
  ['', 'all'], // 空/未指定は all 扱い（VenueAccess 既定）
  ['jra', 'jra'],
  ['central', 'jra'],
  ['中央', 'jra'],
  ['nankan', 'nankan'],
  ['南関', 'nankan'],
]);
for (const v of CANONICAL_VENUES) VENUE_ALIASES.set(v, v);

/**
 * venueAccess を canonical 値へ正規化。未知は null。
 * @param {unknown} input
 * @returns {string|null}
 */
export function normalizeVenue(input) {
  if (input == null) return 'all'; // 未指定は all
  if (typeof input !== 'string') return null;
  const key = input.trim().toLowerCase();
  return VENUE_ALIASES.get(key) ?? null;
}
