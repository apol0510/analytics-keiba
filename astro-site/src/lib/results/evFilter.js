/**
 * 馬単の期待値フィルター（純関数）。入出力は全部レース前に分かる値に限る。
 *   EV = p(i→j) × 判定時点のオッズ（1 が損益分岐）
 * 確率は AK の指数から学習した勝率、または勝率と判定時点の単勝オッズの混合。
 * 検証は scripts/verify-ev-filter.mjs。手順と結果は docs/EV_FILTER_VERIFICATION.md。
 */

const sum = (a) => a.reduce((s, v) => s + v, 0);

/** レース内で平均 0・分散 1 にそろえる（欠損は平均＝0 として扱う） */
export function zscore(values) {
  const ok = values.filter((v) => Number.isFinite(v));
  if (ok.length < 2) return values.map(() => 0);
  const mean = sum(ok) / ok.length;
  const sd = Math.sqrt(sum(ok.map((v) => (v - mean) ** 2)) / ok.length);
  if (sd === 0) return values.map(() => 0);
  return values.map((v) => (Number.isFinite(v) ? (v - mean) / sd : 0));
}

export function softmax(scores) {
  const m = Math.max(...scores);
  const e = scores.map((s) => Math.exp(s - m));
  const t = sum(e);
  return e.map((v) => v / t);
}

/** 勝率: レース内で合計 1 になる条件付きロジット */
export function winProbs(features, beta) {
  return softmax(features.map((f) => f.reduce((s, x, k) => s + x * beta[k], 0)));
}

/**
 * 条件付きロジットを最尤で当てる。races = [{ features: number[][], winner: index }]
 * ニュートン法の代わりに小さい次元向けの勾配上昇（特徴量は数個だけ）。
 */
export function fitConditionalLogit(races, { iterations = 300, rate = 0.5, l2 = 1e-4, initial } = {}) {
  const dim = races[0]?.features[0]?.length ?? 0;
  const beta = initial ? [...initial] : new Array(dim).fill(0);
  if (!races.length) return beta;
  for (let it = 0; it < iterations; it += 1) {
    const grad = new Array(dim).fill(0);
    for (const r of races) {
      const p = winProbs(r.features, beta);
      for (let h = 0; h < p.length; h += 1) {
        const y = h === r.winner ? 1 : 0;
        for (let k = 0; k < dim; k += 1) grad[k] += (y - p[h]) * r.features[h][k];
      }
    }
    for (let k = 0; k < dim; k += 1) beta[k] += rate * (grad[k] / races.length - l2 * beta[k]);
  }
  return beta;
}

/**
 * 馬単の確率。2 着の確率を p^λ で割り引く（素の Harville は穴の組を過大評価する）。
 * 返り値は Map("1着馬番>2着馬番" → 確率)。
 */
export function exactaProbs(numbers, pWin, lambda) {
  const powered = pWin.map((p) => p ** lambda);
  const total = sum(powered);
  const out = new Map();
  for (let i = 0; i < numbers.length; i += 1) {
    const rest = total - powered[i];
    if (rest <= 0) continue;
    for (let j = 0; j < numbers.length; j += 1) {
      if (i !== j) out.set(`${numbers[i]}>${numbers[j]}`, (pWin[i] * powered[j]) / rest);
    }
  }
  return out;
}

/** λ を実際の 1・2 着で最尤選択する。races = [{ numbers, pWin, first, second }] */
export function fitLambda(races, grid = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2]) {
  let best = grid[0];
  let bestLl = -Infinity;
  for (const lambda of grid) {
    let ll = 0;
    for (const r of races) {
      const p = exactaProbs(r.numbers, r.pWin, lambda).get(`${r.first}>${r.second}`);
      ll += Math.log(Math.max(p ?? 0, 1e-9));
    }
    if (ll > bestLl) {
      bestLl = ll;
      best = lambda;
    }
  }
  return best;
}

/**
 * 判定時刻までに観測したオッズだけを残す。判定時刻より後の行は必ず捨てる。
 * ticks = [{ selection, odds, observedAt(ms), ok }]。返り値は Map(selection → 最新のオッズ)。
 */
export function asOfOdds(ticks, decisionMs) {
  const latest = new Map();
  for (const t of ticks) {
    if (!(t.observedAt <= decisionMs)) continue;
    const prev = latest.get(t.selection);
    if (!prev || t.observedAt >= prev.observedAt) latest.set(t.selection, t);
  }
  const out = new Map();
  for (const [selection, t] of latest) if (t.ok && t.odds > 0) out.set(selection, t.odds);
  return out;
}

/** EV 付きの組。オッズか確率が無い組は判定できないので含めない */
export function ticketEvs(tickets, probs, odds) {
  const out = [];
  for (const ticket of tickets) {
    const p = probs.get(ticket);
    const o = odds.get(ticket);
    if (p == null || o == null) continue;
    out.push({ ticket, p, odds: o, ev: p * o });
  }
  return out;
}

/**
 * 買う組を決める。
 *   ticket: EV が閾値以上の組だけ買う
 *   race:   組の平均 EV が閾値以上のレースだけ、全部の組を買う
 * pMin / oddsMax は穴の組の過大評価を抑える固定の上下限（ticket 規則だけに掛ける）。
 */
export function selectTickets(evs, { rule, threshold, pMin = 0, oddsMax = Infinity }) {
  if (!evs.length) return [];
  if (rule === 'race') {
    const mean = sum(evs.map((e) => e.ev)) / evs.length;
    return mean >= threshold ? evs.map((e) => e.ticket) : [];
  }
  return evs.filter((e) => e.ev >= threshold && e.p >= pMin && e.odds <= oddsMax).map((e) => e.ticket);
}

/** 実際の払戻で精算する。payouts = Map("1着>2着" → 100 円あたり払戻) */
export function settleTickets(tickets, payouts) {
  let payout = 0;
  let hit = false;
  for (const t of tickets) {
    if (payouts.has(t)) {
      payout += payouts.get(t);
      hit = true;
    }
  }
  return { points: tickets.length, invest: tickets.length * 100, payout, hit };
}

/** 再現できる乱数（ブートストラップの結果を実行ごとに変えない） */
export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** レース単位の成績 → 回収率・信頼区間・純損益・最大ドローダウン。日付順に渡す */
export function summarize(rows, { bootstrap = 2000, seed = 20261106 } = {}) {
  const bought = rows.filter((r) => r.points > 0);
  const invest = sum(bought.map((r) => r.invest));
  const payout = sum(bought.map((r) => r.payout));
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const r of bought) {
    cumulative += r.payout - r.invest;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  const roi = invest ? payout / invest : null;
  let ci = [null, null];
  if (bought.length >= 2 && bootstrap > 0) {
    const random = seededRandom(seed);
    const samples = [];
    for (let b = 0; b < bootstrap; b += 1) {
      let i = 0;
      let p = 0;
      for (let n = 0; n < bought.length; n += 1) {
        const r = bought[Math.floor(random() * bought.length)];
        i += r.invest;
        p += r.payout;
      }
      samples.push(i ? p / i : 0);
    }
    samples.sort((a, b) => a - b);
    ci = [samples[Math.floor(bootstrap * 0.025)], samples[Math.floor(bootstrap * 0.975)]];
  }
  return {
    races: bought.length,
    points: sum(bought.map((r) => r.points)),
    hits: bought.filter((r) => r.hit).length,
    invest,
    payout,
    net: payout - invest,
    roi,
    roiCi95: ci,
    maxDrawdown,
  };
}

/**
 * 事前登録した規則の判定。標本が足りない間は COLLECTING のまま、途中の高い回収率で合格にしない。
 * checkpoint = { minRaces, minHits, minRoi, minRoiCi95Low }
 */
export function forwardVerdict(summary, checkpoint) {
  if (summary.races < checkpoint.minRaces || summary.hits < checkpoint.minHits) return 'COLLECTING';
  return summary.roi >= checkpoint.minRoi && summary.roiCi95[0] >= checkpoint.minRoiCi95Low ? 'PASS' : 'FAIL';
}
