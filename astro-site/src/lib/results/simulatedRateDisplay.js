/**
 * simulatedRateDisplay.js — 事後シミュレーション算定値を画面へ出す単一の入口（純粋関数）
 *
 * 画面はこのファイルだけを使い、simulatedRecoveryV2.js を直接 import しない。
 * 公開は月別の「回収率（試算）」カードと無料ページのバナーだけ。トップ・ショーケース・索引・年別には出さない。
 * 数値には必ず説明文を近くに添える。
 * 「回収率」単独の名前で出さない。月別カードの見出しだけ「回収率（試算）」（2026-11-06 MK 確定）で、計算は v2 のまま。
 * title・meta・構造化データ・メールに数値を入れない（説明が一緒に出ないため）。
 * 利益の色（profit）を付けない。止めるときは SIMULATED_RATE_PUBLIC を false にする。
 * RECOVERY_RATE_PUBLIC とは別のスイッチで、あちらは非採用の値が出るので true にしない。
 * 正本: docs/spec.md「回収率の公式算定方式は未確定」・docs/BET_POINT_LOGIC.md「事後シミュレーション算定値 v2」
 */
import { SIMULATION_V2, summarizeSimulationV2 } from './simulatedRecoveryV2.js';
import { dayRaces } from './legacySimulation.js';

export const SIMULATED_RATE_PUBLIC = true;
export const SIMULATED_RATE_LABEL = '事後シミュレーション算定値';
export const SIMULATED_CARD_NOTE = '※ 過去の払戻をもとに、結果確定後に想定点数を設定した試算です。実際の購入成績とは異なります。';
export const SIMULATED_METHOD_PATH = '/archive/simulation-method/';
/** 算定方法ページに出すパラメータ（値は v2 の定義をそのまま使う） */
export const SIMULATED_PARAMS = SIMULATION_V2;
export const SIMULATED_RATE_NOTE_SHORT = '結果確定後の試算で、実際の購入の回収率ではありません';

/** 複数日の加重の算定値。非公開またはデータなしは null */
export function simulatedRateOf(entries) {
  return SIMULATED_RATE_PUBLIC ? summarizeSimulationV2(entries).weightedRate : null;
}

/** 月別カードの表示用（小数 1 桁）。非公開またはデータなしは null */
export function simulatedMonthRate(entries) {
  const rate = simulatedRateOf(entries);
  return rate == null ? null : rate.toFixed(1);
}
