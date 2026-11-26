/**
 * ownIndex.js — 独自指数（OWN_INDEX_V1）。純関数・依存なし。
 *
 * 独自指数 = 基礎点（公表されている指数）＋ 独自評価の点（先行力・前走着順・騎手・上がりの 4 項目）。
 *   - 各項目は、評価する馬の中で上位 3 分の 1 なら +1、下位 3 分の 1 なら −1（全頭が同じ値の項目は使わない）。点は −4〜+4。
 *   - 先行力: 近 3 走の 1 コーナー（最初の通過順）の平均。前にいるほど高い。記録が無ければ 6 番手とみなす
 *   - 前走着順: 前走の着順を点にする（1 着 100・2 着 85・3 着 70・5 着まで 55・8 着まで 35・それ以下 15）。前走が無ければ 40
 *   - 騎手: その開催日より前の確定結果での騎手の勝率（(勝ち + 1) / (騎乗 + 10)）
 *   - 上がり: 近 3 走の上がり 3F の最速。記録が無ければ 40.5 秒とみなす
 *   - 印の順 = 独自指数の高い順 → 基礎点の高い順 → 馬番の小さい順。能力差（基礎点の差）が小さい 2 頭は、独自評価で順位が入れ替わる
 * 検証（南関 2,399R・中央 2,699R・2026-02〜11）: 本命の単勝・複勝率、馬単の的中率・回収率は従来の順位と同等（回収率差の 95% 区間が 0 を含む）。
 * 🛑 入力は前日に作られた予想ファイルと、開催日より前の確定結果だけ（当日の情報・結果は使わない）。
 */

export const OWN_INDEX_VERSION = 'OWN_INDEX_V1';
export const OWN_INDEX_MIN_BASE = 45;
export const OWN_INDEX_FACTORS = Object.freeze(['early', 'last', 'jockey', 'f3']);

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').trim());
  return Number.isFinite(n) ? n : null;
};
const int = (v) => {
  const n = num(v);
  return n != null && Number.isInteger(n) ? n : null;
};

/** 騎手の照合キー（空白を除いた先頭 3 文字） */
export function jockeyKey(name) {
  return typeof name === 'string' ? name.replace(/[\s　]/g, '').slice(0, 3) : '';
}

/** 着順 → 点 */
export function finishPoint(rank) {
  if (!rank || rank <= 0) return 0;
  if (rank === 1) return 100;
  if (rank === 2) return 85;
  if (rank === 3) return 70;
  if (rank <= 5) return 55;
  if (rank <= 8) return 35;
  return 15;
}

const firstCorner = (run) => {
  const n = parseInt(String(run?.passingOrder ?? '').split('-')[0], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const final3f = (run) => {
  const n = num(run?.final3F ?? run?.last3f);
  return n != null && n > 0 ? n : null;
};
const finishOf = (run) => {
  const n = int(run?.finish ?? run?.rank);
  return n != null && n > 0 ? n : 0;
};

/**
 * 1 頭の 4 項目（高いほど良い）。
 * @param {object[]} recent 過去走（**新しい順**・[0] = 前走）
 * @param {{ rides: number, wins: number } | undefined} jockeyRecord
 */
export function ownFactors(recent, jockeyRecord) {
  const runs = Array.isArray(recent) ? recent : [];
  const corners = runs.slice(0, 3).map(firstCorner).filter((v) => v != null);
  const f3s = runs.slice(0, 3).map(final3f).filter((v) => v != null);
  const last = runs.length ? finishOf(runs[0]) : 0;
  const rides = jockeyRecord?.rides ?? 0;
  const wins = jockeyRecord?.wins ?? 0;
  return {
    early: corners.length ? -(corners.reduce((a, b) => a + b, 0) / corners.length) : -6,
    last: last > 0 ? finishPoint(last) : 40,
    jockey: (wins + 1) / (rides + 10),
    f3: f3s.length ? -Math.min(...f3s) : -40.5,
  };
}

/**
 * 1 レースの独自指数。
 * @param {Array<{ number: number, base: number, recent: object[], jockey?: string, jockeyRecord?: { rides: number, wins: number } }>} horses
 *   base = 基礎点（公表されている指数・45 未満は評価しない）。recent は新しい順の過去走。
 *   jockeyRecord があればそれを騎手成績に使う（無ければ jockeyStats を騎手名で引く）
 * @param {Map<string, { rides: number, wins: number }>} jockeyStats 開催日より前の騎手成績（jockeyKey → 成績）
 * @returns {Map<number, { ownIndex: number, base: number, points: number, factors: object }>}
 */
export function ownIndexRace(horses, jockeyStats = new Map()) {
  const rated = (Array.isArray(horses) ? horses : [])
    .filter((h) => Number.isInteger(h?.number) && typeof h.base === 'number' && Number.isFinite(h.base) && h.base >= OWN_INDEX_MIN_BASE);
  const n = rated.length;
  const fx = new Map(rated.map((h) => [h.number, ownFactors(h.recent, h.jockeyRecord ?? jockeyStats.get(jockeyKey(h.jockey)))]));
  const points = new Map(rated.map((h) => [h.number, 0]));
  for (const k of OWN_INDEX_FACTORS) {
    const vals = rated.map((h) => fx.get(h.number)[k]);
    if (!vals.length || Math.max(...vals) - Math.min(...vals) < 1e-9) continue;
    const order = [...rated].sort((a, b) => fx.get(b.number)[k] - fx.get(a.number)[k] || a.number - b.number);
    order.forEach((h, r) => {
      if (r < n / 3) points.set(h.number, points.get(h.number) + 1);
      else if (r >= n - n / 3) points.set(h.number, points.get(h.number) - 1);
    });
  }
  return new Map(rated.map((h) => [h.number, {
    ownIndex: h.base + points.get(h.number), base: h.base, points: points.get(h.number), factors: fx.get(h.number),
  }]));
}

/** 印の順（独自指数 → 基礎点 → 馬番）。@returns {number[]} 馬番 */
export function ownOrder(indexMap) {
  return [...indexMap.entries()]
    .sort(([na, a], [nb, b]) => b.ownIndex - a.ownIndex || b.base - a.base || na - nb)
    .map(([n]) => n);
}

/**
 * 騎手成績を 1 開催分ずつ足す（予想ファイルの騎手 × 確定着順を馬番で照合）。
 * 🛑 呼び出し側は「対象の開催日より前」の開催だけを渡す。
 * @param {Map<string, { rides: number, wins: number }>} stats 書き換える
 * @param {object} prediction keiba-data-shared の予想ファイル（races[].horses[].{ number, jockey }）
 * @param {object} results keiba-data-shared の結果ファイル（races[].results[].{ number, rank | position }）
 */
export function addJockeyResults(stats, prediction, results) {
  const byRace = new Map();
  for (const r of results?.races ?? []) {
    const ranks = new Map();
    for (const x of r?.results ?? []) {
      const rank = int(x?.rank) ?? int(x?.position);
      if (Number.isInteger(x?.number) && rank != null && rank > 0) ranks.set(x.number, rank);
    }
    byRace.set(int(r?.raceNumber), ranks);
  }
  for (const race of prediction?.races ?? []) {
    const ranks = byRace.get(int(race?.raceNumber));
    if (!ranks) continue;
    for (const h of race?.horses ?? []) {
      const key = jockeyKey(h?.jockey);
      const rank = ranks.get(h?.number);
      if (!key || rank == null) continue;
      const s = stats.get(key) ?? { rides: 0, wins: 0 };
      s.rides += 1;
      if (rank === 1) s.wins += 1;
      stats.set(key, s);
    }
  }
  return stats;
}
