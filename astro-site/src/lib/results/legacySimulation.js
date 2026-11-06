/**
 * legacySimulation.js — 旧 4 段階方式の復元（純粋関数・内部検証専用）
 *
 * 2026-07-02 の #113（d4faa64f）で廃止した getBetPoints を、計算の再現のために復元したもの。
 * 分母の点数をその日の払戻を見て選ぶので、結果判明後のシミュレーションで、実際の購入の収支ではない。
 * レース前に点数を決めて買えた金額ではない。
 *
 * 🛑 公開ページ・メールから import しない（fixedMarketingStats.test.mjs が検知する）。
 *    AI評価指数とは別管理で、この値を指数へ流用しない。
 * 正本: docs/BET_POINT_LOGIC.md「旧 4 段階方式の復元」
 */

/** #113 で削除した getBetPoints と同じ判定。totalPayout は結果判明後の値 */
export function legacyBetPoints(totalPayout, races) {
  if (races <= 0) return 6;
  if (totalPayout >= races * 12 * 100) return 12;
  if (totalPayout >= races * 10 * 100) return 10;
  if (totalPayout >= races * 8 * 100) return 8;
  return 6;
}

/** 1 日分の払戻。的中レースの umatan.payout の合計 */
export function dayPayout(entry) {
  return (entry?.races ?? []).reduce((sum, r) => sum + (r?.isHit ? Number(r?.umatan?.payout) || 0 : 0), 0);
}

/** 1 日分の実レース数 */
export function dayRaces(entry) {
  return Number(entry?.totalRaces) || (entry?.races ?? []).length;
}

/**
 * 複数日の再計算。weightedRate は 払戻合計 ÷ 分母合計、meanDailyRate は日別の値の単純平均。
 * 公開されていた 173% は南関の単純平均に当たる（#113 直前の archive で 173.0%）。
 */
export function summarizeLegacySimulation(entries) {
  let races = 0;
  let payout = 0;
  let investment = 0;
  let rateSum = 0;
  let days = 0;
  const pointDays = { 6: 0, 8: 0, 10: 0, 12: 0 };
  for (const entry of entries ?? []) {
    const r = dayRaces(entry);
    if (r <= 0) continue;
    const p = dayPayout(entry);
    const points = legacyBetPoints(p, r);
    const invested = r * points * 100;
    races += r;
    payout += p;
    investment += invested;
    rateSum += (p / invested) * 100;
    days += 1;
    pointDays[points] += 1;
  }
  const round1 = (v) => Math.round(v * 10) / 10;
  return {
    days,
    races,
    payout,
    investment,
    pointDays,
    weightedRate: investment > 0 ? round1((payout / investment) * 100) : null,
    meanDailyRate: days > 0 ? round1(rateSum / days) : null,
  };
}
