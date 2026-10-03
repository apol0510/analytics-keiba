/**
 * valueSummary.js — 「この価格でこれだけ使える」を伝える活用状況（2026-10-04 MK 確定・docs/PREDICTION_ACQUISITION.md §2-3）
 *
 * - 本日の活用状況 = 本日の対象レースのうち取得したレース数 / 本日その契約で取得できる実レース数（%）
 *   分母は固定値ではなく、その日の開催の実レース数（中央のみ・南関のみ・両方を契約に合わせて）。
 *   % は利用上限ではない（「本日これだけのレースが月額内で利用できる」ことを伝える指標）。「残り○回」とは書かない。
 * - 主役は「次に取得できる予想」。取得済みの見返しは機能として残すが主役にしない。
 * - 今月の活用状況 = 今月の取得レース数・利用日数・中央/南関内訳・1 レースあたりの実質額（月額 ÷ 取得数）
 */
import { canAcquire } from './acquisitionPolicy.js';
import { countRaces, listDates } from './raceSource.js';
import { summarizeUsage } from './usageStats.js';

const JST_MS = 9 * 3600 * 1000;
export const jstToday = (nowMs) => new Date(nowMs + JST_MS).toISOString().slice(0, 10);

/**
 * 契約から月あたりの金額（定価・税込）。分からない・月額費用が無い契約は null（実質額を出さない）。
 * 金額は料金ページ・確定仕様と同じ値（Stripe 月額 ¥4,980 / 中央版・南関版 ¥2,980、銀行振込 30 日 ¥18,000、年額 ¥49,800 ÷ 12）。
 * キャンペーン・乗り換え特典で安く契約した場合も定価で計算する（実際より高く見せない＝実質額は控えめに出る）。
 */
export const MONTHLY_PRICE = Object.freeze({
  stripePremium: 4980, stripeVenue: 2980, bankMonthly: 18000, annual: Math.round(49800 / 12),
});

export function monthlyPriceFor(contract) {
  const c = contract || {};
  const tier = String(c.tier || '').toLowerCase();
  if (!tier.includes('premium')) return null;
  if (c.stripe) {
    const venue = String(c.venueAccess || '').toLowerCase();
    return (venue === 'jra' || venue === 'nankan')
      ? { yen: MONTHLY_PRICE.stripeVenue, basis: '月額' }
      : { yen: MONTHLY_PRICE.stripePremium, basis: '月額' };
  }
  const t = String(c.planType || '').toLowerCase();
  if (t === 'monthly') return { yen: MONTHLY_PRICE.bankMonthly, basis: '30日' };
  if (t === 'annual') return { yen: MONTHLY_PRICE.annual, basis: '年額の月あたり' };
  return null; // Lifetime・無料特典・不明は実質額を出さない
}

/** この契約・商品で取得できる区分 */
export function accessibleCats(ent, product) {
  return ['jra', 'nankan'].filter((cat) => canAcquire(ent, { product, cat }));
}

/**
 * @param {object} p
 * @param {Array} p.acquisitions 本人の取得記録（null = 読めない）
 * @param {object} p.ent resolveEntitlements の結果
 * @param {object} p.contract gatePaidPage の contract
 * @param {'premium'|'srp'} p.product
 * @param {(cat:string,date:string)=>number} [p.count] テスト用
 * @param {(cat:string)=>string[]} [p.dates] テスト用
 */
export function buildValueSummary({ acquisitions, ent, contract, product = 'premium', nowMs = Date.now(), count, dates, root } = {}) {
  const cats = accessibleCats(ent, product);
  const cnt = count || ((cat, date) => countRaces(cat, date, { root }));
  const listD = dates || ((cat) => listDates(cat, { root, limit: 14 }));
  const today = jstToday(nowMs);
  const list = Array.isArray(acquisitions) ? acquisitions : null;
  const mine = (list || []).filter((e) => e.product === product);

  const byCatToday = {};
  let available = 0;
  for (const cat of cats) { byCatToday[cat] = cnt(cat, today); available += byCatToday[cat]; }
  const acquiredToday = mine.filter((e) => e.date === today && cats.includes(e.cat)).length;
  const todayInfo = {
    date: today,
    available,
    acquired: list ? Math.min(acquiredToday, available || acquiredToday) : null,
    pct: list && available > 0 ? Math.round((Math.min(acquiredToday, available) / available) * 100) : null,
    byCat: byCatToday,
  };

  // 次に取得できる予想: 本日に未取得のレースがあれば本日、無ければ次の開催日
  let next = null;
  if (available > 0 && (!list || acquiredToday < available)) {
    next = { date: today, isToday: true, available, cats: cats.filter((c) => byCatToday[c] > 0) };
  } else {
    const future = [...new Set(cats.flatMap((c) => listD(c)))].filter((d) => d > today).sort();
    for (const d of future) {
      const per = Object.fromEntries(cats.map((c) => [c, cnt(c, d)]));
      const total = Object.values(per).reduce((a, b) => a + b, 0);
      if (total > 0) { next = { date: d, isToday: false, available: total, byCat: per, cats: cats.filter((c) => per[c] > 0) }; break; }
    }
  }

  const usage = list ? summarizeUsage(mine, { nowMs }) : null;
  // 実質額は Premium（月額で取得し放題）の価値表示。三連複の選別（買い切り等）には出さない
  const price = product === 'premium' ? monthlyPriceFor(contract) : null;
  const monthCount = usage ? usage.monthCount : 0;
  const month = usage ? {
    count: monthCount,
    activeDays: usage.activeDays,
    byCategory: usage.byCategory,
    price,
    unitCost: price && monthCount > 0 ? Math.round(price.yen / monthCount) : null,
  } : null;
  return { product, cats, today: todayInfo, next, month, usage };
}
