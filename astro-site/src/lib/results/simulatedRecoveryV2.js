/**
 * simulatedRecoveryV2.js — 事後シミュレーション算定値 v2（純粋関数・内部専用）
 *
 * 旧 4 段階方式（legacySimulation.js）と同じ構造で、段階と閾値だけを変えた算定。
 * 分母の点数はその日の払戻を見て選ぶので、結果判明後のシミュレーションで、実際の購入の回収率ではない。
 * パラメータは希望水準 150% 前後に合わせて選んだ値で、予想の成績を測る値ではない。
 *
 * 🛑 画面は simulatedRateDisplay.js だけを通す。公開ページ・Function から直接 import しない（テストが検知する）。
 *    結果を 150% へ上書きしない。パラメータを変えるときは version を上げて別定義にする。
 * 正本: docs/BET_POINT_LOGIC.md「事後シミュレーション算定値 v2」
 */
import { dayPayout, dayRaces } from './legacySimulation.js';

export const SIMULATION_V2 = Object.freeze({
  version: 'ak-sim-v2',
  /** 想定購入点数の 4 段階（1 レースあたり） */
  tiers: Object.freeze([10, 18, 26, 34]),
  /** その点数で計算しても残る算定値の下限（%）。旧方式は 100 */
  floorPercent: 125,
  /** 1 点の金額（円） */
  unitYen: 100,
});

/** 払戻が 実レース数 × N × 100 円 × 125% 以上となる最大の N。どの段階にも届かなければ最小の段階 */
export function simulatedPointsV2(totalPayout, races) {
  const { tiers, floorPercent, unitYen } = SIMULATION_V2;
  if (races <= 0) return tiers[0];
  for (let i = tiers.length - 1; i > 0; i -= 1) {
    if (totalPayout >= (races * tiers[i] * unitYen * floorPercent) / 100) return tiers[i];
  }
  return tiers[0];
}

/** 複数日の算定。weightedRate は 払戻合計 ÷ 想定購入額合計、meanDailyRate は日別の値の単純平均 */
export function summarizeSimulationV2(entries) {
  const { tiers, unitYen, version } = SIMULATION_V2;
  let races = 0;
  let payout = 0;
  let points = 0;
  let rateSum = 0;
  let days = 0;
  const pointDays = Object.fromEntries(tiers.map((t) => [t, 0]));
  for (const entry of entries ?? []) {
    const r = dayRaces(entry);
    if (r <= 0) continue;
    const p = dayPayout(entry);
    const n = simulatedPointsV2(p, r);
    races += r;
    payout += p;
    points += r * n;
    rateSum += (p / (r * n * unitYen)) * 100;
    days += 1;
    pointDays[n] += 1;
  }
  const investment = points * unitYen;
  const round1 = (v) => Math.round(v * 10) / 10;
  return {
    version,
    days,
    races,
    payout,
    points,
    investment,
    pointDays,
    weightedRate: investment > 0 ? round1((payout / investment) * 100) : null,
    meanDailyRate: days > 0 ? round1(rateSum / days) : null,
  };
}

/** 月別（YYYY-MM）の算定 */
export function monthlySimulationV2(entries) {
  const byMonth = new Map();
  for (const entry of entries ?? []) {
    const month = String(entry?.date ?? '').slice(0, 7);
    if (!month) continue;
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(entry);
  }
  return [...byMonth.keys()].sort().map((month) => ({ month, ...summarizeSimulationV2(byMonth.get(month)) }));
}
