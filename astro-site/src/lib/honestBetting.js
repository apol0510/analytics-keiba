/**
 * honestBetting.js — 的中実績の購入点数・投資額・回収率を「表示した買い目どおり」に数える（純粋関数）
 *
 * 正本: docs/BET_POINT_LOGIC.md（2026-10-06 MK 判断待ちの改訂案）
 *   - 1 レースの点数 = そのレースで公開した買い目（bettingLines）を全部 100 円ずつ買った点数
 *       メイン（一方向 `→`）: 相手の数（最大 5 点）
 *       通常（双方向 `↔` 2 段）: 各段 相手の数 × 2（表裏）の合計（最大 20 点）
 *       (抑え…) は買い目に含めない（的中判定 checkUmatanHit と同じ）
 *   - 投資額 = 点数 × 100 円。払戻 = 的中レースの馬単払戻（100 円あたり）
 *   - 回収率 = 払戻 ÷ 投資額。買い目の記録が無いレースがある日は数えない（推測で埋めない）
 *   旧方式（全レース 5 点固定・その前は払戻に応じた 6〜12 点）は、通常レース 20 点を 5〜12 点として数えており
 *   実態より大きく見えていたため廃止。
 */

/** 馬単 1 行の点数（抑えは除外） */
export function umatanLinePoints(line) {
  const m = /^\s*(\d+)\s*([-↔⇔→])\s*(.+)$/.exec(String(line || ''));
  if (!m) return 0;
  const partners = m[3].replace(/[(（]抑え[^)）]*[)）]/g, '').split('.')
    .map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
  return m[2] === '→' ? partners.length : partners.length * 2;
}

/** レースの点数（公開した買い目の合計）。買い目が無ければ null */
export function racePoints(race) {
  const lines = Array.isArray(race?.bettingLines) ? race.bettingLines.filter(Boolean) : [];
  if (lines.length === 0) return null;
  return lines.reduce((s, l) => s + umatanLinePoints(l), 0);
}

const payoutOf = (race) => (race?.isHit ? Number(race?.umatan?.payout) || 0 : 0);

/**
 * 1 日分を表示した買い目どおりに数える。
 * @returns {{ complete: boolean, totalBetPoints, totalInvestment, totalPayout, recoveryRate: number|null, perRace: number[] }}
 */
export function honestDay(entry) {
  const races = Array.isArray(entry?.races) ? entry.races : [];
  const perRace = races.map(racePoints);
  const complete = races.length > 0 && perRace.every((p) => p != null);
  const totalBetPoints = perRace.reduce((s, p) => s + (p || 0), 0);
  const totalInvestment = totalBetPoints * 100;
  const totalPayout = races.reduce((s, r) => s + payoutOf(r), 0);
  const recoveryRate = complete && totalInvestment > 0 ? Math.round((totalPayout / totalInvestment) * 1000) / 10 : null;
  return { complete, totalBetPoints, totalInvestment, totalPayout, recoveryRate, perRace };
}

/**
 * archive の 1 日分（importResults*.js が作る形）を、表示した買い目どおりの値に直したコピーを返す。
 * 買い目の記録が無い日は変更しない（呼び出し側で「回収率を出さない」扱いにする）。
 */
export function applyHonestBetting(entry) {
  const h = honestDay(entry);
  if (!h.complete) return { ...entry, honest: false };
  return {
    ...entry,
    honest: true,
    races: entry.races.map((r, i) => ({ ...r, betPoints: h.perRace[i], bettingPoints: h.perRace[i] })),
    betPointsPerRace: null, // レースごとに違う（メイン 5 点・通常 最大 20 点）
    totalBetPoints: h.totalBetPoints,
    betAmount: h.totalInvestment,
    totalInvestment: h.totalInvestment,
    returnRate: h.recoveryRate,
    recoveryRate: h.recoveryRate,
  };
}
