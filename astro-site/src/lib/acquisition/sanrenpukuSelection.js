/**
 * sanrenpukuSelection.js — Premium Sanrenpuku: 三連複で参加すべきレースの選別（純粋）
 *
 * 2026-10-03 MK 確定: Premium Sanrenpuku は「買い目を減らす商品」ではなく「三連複で狙うレースを AI が選ぶ商品」。
 * 各レースに 推奨度（A / B）または 見送り と、その理由を付ける。正本 docs/PREDICTION_ACQUISITION.md §3
 *
 * 使う材料（取込済みの予想データだけ）:
 *   - 本命の指数（racebook 系コンピ指数 raw。表示はしない）
 *   - 本命と 2 番手の評価差（pt）
 *   - 頭数
 *   - 中心買い目（generateNarrowSanrenpuku）が組めるか
 * 理由文には指数の数値を書かない（表示指数は raw−1 のルールがあるため・数値は本文の指数表で見せる）。
 */
import { generateNarrowSanrenpuku } from '../../utils/sanrenpukuBetting.js';

export const GRADE = Object.freeze({ A: 'A', B: 'B', SKIP: 'skip' });

/**
 * 閾値（変更するときは docs と test を同時に直す）。
 * 南関と中央で本命の指数の分布が違う（2026-08〜10 実測: 中央値 南関 82 / 中央 77）ため区分ごとに持つ。
 * 2026-08〜10 の実データで推奨（A+B）は南関 36%・中央 33%（1 会場あたり A 約 2 / 1 レース、B 約 2 / 3 レース）。
 */
export const SELECTION_RULES = Object.freeze({
  nankan: Object.freeze({ aMinIndex: 86, aMinGap: 24, bMinIndex: 82, bMinGap: 16, minField: 7, wideField: 10 }),
  jra: Object.freeze({ aMinIndex: 84, aMinGap: 20, bMinIndex: 78, bMinGap: 12, minField: 7, wideField: 10 }),
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const rawIndex = (h) => num(h?.sourceComputerIndex ?? h?.computerIndex);
const pt = (h) => num(h?.pt ?? h?.displayScore ?? h?.rawScore) ?? 0;

export function evaluateSanrenpukuRace(horses, { horseCount, cat = 'nankan' } = {}) {
  const list = Array.isArray(horses) ? horses.filter(Boolean) : [];
  const honmei = list.find((h) => h.role === '本命');
  const field = num(horseCount) ?? list.length;
  const center = generateNarrowSanrenpuku(list);
  if (!honmei || !center) {
    return { grade: GRADE.SKIP, skip: true, score: 0, reasons: ['軸または相手候補が決まらず、三連複の組み立てに向きません。'] };
  }
  const idx = rawIndex(honmei) ?? 0;
  const others = list.filter((h) => h !== honmei).map(pt).sort((a, b) => b - a);
  const gap = pt(honmei) - (others[0] ?? 0);
  const R = SELECTION_RULES[cat] || SELECTION_RULES.nankan;

  const reasons = [];
  let grade = GRADE.SKIP;
  if (field < R.minField) {
    reasons.push('頭数が少なく、三連複の配当妙味が薄いレースです。');
  } else if (idx >= R.aMinIndex && gap >= R.aMinGap) {
    grade = GRADE.A;
  } else if (idx >= R.bMinIndex && gap >= R.bMinGap) {
    grade = GRADE.B;
  } else {
    if (idx < R.bMinIndex) reasons.push('軸の信頼度が十分でなく、三連複の軸を決めにくいレースです。');
    if (gap < R.bMinGap) reasons.push('上位の評価が拮抗した混戦で、相手が絞りにくいレースです。');
  }
  if (grade !== GRADE.SKIP) {
    reasons.push(idx >= R.aMinIndex ? '軸の信頼度が高いレースです。' : '軸に一定の信頼が置けるレースです。');
    if (gap >= R.aMinGap) reasons.push('本命と他馬の評価差が大きく、相手候補を絞りやすいレースです。');
    else reasons.push('本命が上位の評価で、相手候補を整理しやすいレースです。');
    if (field >= R.wideField) reasons.push('頭数が多く、三連複で狙う価値があります。');
  }
  const score = grade === GRADE.SKIP ? 0 : idx + gap + (field >= R.wideField ? 3 : 0) + (grade === GRADE.A ? 100 : 0);
  return { grade, skip: grade === GRADE.SKIP, score, reasons };
}

/** その日のレースから推奨（A→B、score 降順）と上位 3、見送りを並べる */
export function rankDay(evaluated) {
  const items = (Array.isArray(evaluated) ? evaluated : []).filter(Boolean);
  const recommended = items.filter((x) => !x.selection.skip)
    .sort((a, b) => b.selection.score - a.selection.score);
  return {
    recommended,
    top3: recommended.slice(0, 3),
    skipped: items.filter((x) => x.selection.skip),
    total: items.length,
  };
}
