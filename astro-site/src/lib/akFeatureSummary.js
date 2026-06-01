/**
 * akFeatureSummary.js
 *
 * AK（analytics-keiba）専用: shared featureScores の6項目（正本素材）から、
 * AK の買い目判断向け3項目（安定性 / 能力上位性 / 展開利）へ派生変換する。
 *
 * 方針正本（keiba-data-shared-admin）:
 *   docs/feature-scores-site-differentiation.md
 *   docs/feature-scores-jra-progress.md
 *   - KI は6項目をそのまま詳細表示 / AK は6項目から3項目へ要約。
 *     同じ6項目・同じ値を同じ見せ方で2サイトに出さない。
 *   - Speed Index 等の6項目名・個別値は AK UI にそのまま出さない。
 *   - 値は 0〜100 の整数（×100しない）。computeImportance の固定値とは別系統。
 *   - 算出・正規化は admin/shared 中心。本関数は「正本の派生（要約）」であり再計算ロジックを増やさない。
 *
 * 入力: getHorseFeatures(...) が返す 6項目ブロック
 *   { speedIndex:{value,...}, staminaRating:{...}, formTrend:{...},
 *     trackCompatibility:{...}, distanceFitness:{...}, jockeyFactor:{...} }
 *   各 value は 0〜100 整数 or null。
 *
 * 出力: [{ label, value:Int|null }, ...] の3要素配列、または null。
 *   - 構成要素の一部が null → その重みを除き、残りの重みで再正規化して算出。
 *   - 構成要素がすべて null → その項目 value=null。
 *   - 3項目すべて算出不能 → 関数全体で null（呼び出し側は既存 e.importance fallback へ）。
 */

// 派生式（feature-scores-site-differentiation.md の暫定案）
const AK_ITEMS = [
  { label: '安定性',     parts: [['formTrend', 0.50], ['staminaRating', 0.25], ['jockeyFactor', 0.25]] },
  { label: '能力上位性', parts: [['speedIndex', 0.45], ['distanceFitness', 0.30], ['trackCompatibility', 0.25]] },
  { label: '展開利',     parts: [['trackCompatibility', 0.40], ['distanceFitness', 0.30], ['formTrend', 0.30]] },
];

function valueOf(fs6, key) {
  const v = fs6 && fs6[key] ? fs6[key].value : null;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function deriveItem(fs6, parts) {
  let weightSum = 0;
  let acc = 0;
  for (const [key, w] of parts) {
    const v = valueOf(fs6, key);
    if (v == null) continue;        // null は除外
    acc += v * w;
    weightSum += w;
  }
  if (weightSum === 0) return null; // 構成要素すべて null
  let out = Math.round(acc / weightSum); // 残り重みで再正規化
  if (out < 0) out = 0;
  if (out > 100) out = 100;
  return out;
}

/**
 * 6項目ブロック → AK専用3項目配列。全項目算出不能なら null。
 * @param {object|null} fs6 getHorseFeatures(...) の戻り値
 * @returns {Array<{label:string,value:number|null}>|null}
 */
export function deriveAkImportance(fs6) {
  if (!fs6 || typeof fs6 !== 'object') return null;
  const items = AK_ITEMS.map(({ label, parts }) => ({ label, value: deriveItem(fs6, parts) }));
  if (items.every((it) => it.value == null)) return null; // → 呼び出し側 fallback
  return items;
}
