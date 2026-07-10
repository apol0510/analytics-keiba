/**
 * planTiers.js — 料金プランの上下関係（tier）の単一源。ランタイム非依存・純粋。
 *
 * `/pricing/` で「現在のプラン以下を出さない」判定に使う。
 * プラン名の別名吸収は `auth/planNormalization.js` が単一源であり、
 * ここではその正規値へ tier を割り当てるだけ。ローカルに別名表を作らないこと。
 */

import { CANONICAL_PLANS, PLAN_ALIASES } from '../auth/planNormalization.js';

/**
 * 正規プラン → tier。数値が大きいほど上位。
 * CANONICAL_PLANS に値を足したらここにも足すこと（不足は build 時に throw）。
 */
export const PLAN_TIER_BY_CANONICAL = Object.freeze({
  'free': 0,
  'light': 1,
  'premium': 2,
  'premium-predictions': 2,
  'premium-sanrenpuku': 2,
  'premium-sanrentan': 2,
  'premium-combo': 2,
  'premium-plus': 3,
});

/**
 * 正規化済みトークン（normalizePlanToken の出力）→ tier のルックアップ表を作る。
 * ブラウザのインライン script へ渡して同期的に tier を引くために使う
 * （インライン script は import できないため、値を焼き込む）。
 *
 * @returns {Record<string, number>}
 * @throws CANONICAL_PLANS に tier 未定義のプランがある場合（build を落とす）
 */
export function buildPlanTierByToken() {
  const missing = CANONICAL_PLANS.filter(
    (p) => typeof PLAN_TIER_BY_CANONICAL[p] !== 'number',
  );
  if (missing.length > 0) {
    throw new Error(
      `planTiers: tier 未定義の正規プランがあります: ${missing.join(', ')}`,
    );
  }

  const map = {};
  for (const plan of CANONICAL_PLANS) {
    map[plan] = PLAN_TIER_BY_CANONICAL[plan];
  }
  for (const [alias, canonical] of Object.entries(PLAN_ALIASES)) {
    map[alias] = PLAN_TIER_BY_CANONICAL[canonical];
  }
  return map;
}
