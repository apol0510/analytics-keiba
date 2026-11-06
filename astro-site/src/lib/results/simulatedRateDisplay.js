/**
 * simulatedRateDisplay.js — 事後シミュレーション算定値を画面へ出す単一の入口（純粋関数）
 *
 * 画面はこのファイルだけを使い、simulatedRecoveryV2.js を直接 import しない。
 * 数値は必ず SIMULATED_RATE_LABEL と説明文を近くに添えて出す。
 * 「回収率」の名前で出さない。title・meta・構造化データ・メールに数値を入れない（説明が一緒に出ないため）。
 * 利益の色（profit）を付けない。止めるときは SIMULATED_RATE_PUBLIC を false にする。
 * RECOVERY_RATE_PUBLIC とは別のスイッチで、あちらは非採用の値が出るので true にしない。
 * 正本: docs/spec.md「回収率の公式算定方式は未確定」・docs/BET_POINT_LOGIC.md「事後シミュレーション算定値 v2」
 */
import { summarizeSimulationV2 } from './simulatedRecoveryV2.js';
import { dayRaces } from './legacySimulation.js';
import { recentCutoff } from './aiBetPoints.js';

export const SIMULATED_RATE_PUBLIC = true;
export const SIMULATED_RATE_LABEL = '事後シミュレーション算定値';
export const SIMULATED_RATE_NOTE = '結果確定後に、その日の払戻に応じた想定点数（1レース10〜34点）を当てはめて計算した試算です。実際に購入した場合の回収率ではなく、表示の購入点数とも異なります。将来の結果を保証するものではありません。';
export const SIMULATED_RATE_NOTE_SHORT = '結果確定後の試算で、実際の購入の回収率ではありません';

/** 複数日の加重の算定値。非公開またはデータなしは null */
export function simulatedRateOf(entries) {
  return SIMULATED_RATE_PUBLIC ? summarizeSimulationV2(entries).weightedRate : null;
}

/** 通算と直近の算定値（直近の範囲は通算回収率と同じ） */
export function simulatedRateSummary(entries, { recentMonths = 3 } = {}) {
  const dated = (Array.isArray(entries) ? entries : []).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e?.date || '') && dayRaces(e) > 0);
  if (dated.length === 0) return null;
  const dates = dated.map((e) => e.date).sort();
  const to = dates[dates.length - 1];
  const cutoff = recentCutoff(to, recentMonths);
  const overall = summarizeSimulationV2(dated);
  return {
    from: dates[0],
    to,
    races: overall.races,
    overall: simulatedRateOf(dated),
    recent: simulatedRateOf(dated.filter((e) => e.date >= cutoff)),
  };
}
