/**
 * aiEvaluationIndex.js — AI評価指数（純粋関数・レース前のデータだけ）
 *
 * 150 を基準にした、本命の優位の大きさの指数。150 は「本命と 2 番手の評価差が中央値のレース」で、
 * 差が上位 25% の水準（GAP_TIERS.strong）で 160。
 *
 * 🛑 回収率ではない。払戻・的中・オッズを入力にしない。% を付けず、「回収」「収益」を名称に使わない。
 *    旧方式のシミュレーション（legacySimulation.js）とは別管理で、値を相互に流用しない。
 * 正本: docs/spec.md「AI評価指数」
 */
import { GAP_TIERS, honmeiGap } from './aiBetPoints.js';

export const AI_EVALUATION_BASE = 150;
export const AI_EVALUATION_MIN = 120;
export const AI_EVALUATION_MAX = 180;
const POINTS_PER_TIER = 10;

/** @returns {number | null} 本命がいないレースは null（推測で埋めない） */
export function aiEvaluationIndex(horses, { cat = 'nankan' } = {}) {
  const gap = honmeiGap(horses);
  if (gap == null) return null;
  const { mid, strong } = GAP_TIERS[cat] || GAP_TIERS.nankan;
  const value = AI_EVALUATION_BASE + (POINTS_PER_TIER * (gap - mid)) / (strong - mid);
  return Math.round(Math.max(AI_EVALUATION_MIN, Math.min(AI_EVALUATION_MAX, value)));
}
