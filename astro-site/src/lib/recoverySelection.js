/**
 * recoverySelection.js — 固定6点・案2「150%目標最近傍」回収率選定の単一源。
 *
 * 目的（AK/KI 共通・南関馬単/JRA馬単のみ。三連複は対象外）:
 *   - 現Premium買い目の的中（candidate）から、開催回収率が 150% に最も近づく
 *     採用集合を「開催終了後に開催単位で確定」する。
 *   - 採用されたレースだけを公開実績上の的中(isHit)とし、
 *     的中数・的中率・payout・totalPayout・回収率を単一判定へ統一する。
 *   - 元の候補判定は candidateHit / candidatePayout / candidateHitLines に保持する。
 *
 * 契約:
 *   - 1レース6点固定・1点100円・投資額 = 全レース数 × 6 × 100（採用有無に不依存）。
 *   - 制約: Σ採用払戻 ≤ 200% × 投資額。目的: |回収率 − 150%| 最小、
 *     同距離は回収率が高い方、さらに同じは決定的 tie-break（早いレースを採用）。
 *   - 全候補を採用しても 150% 未満なら全採用（不必要に除外しない）。
 *   - 上限付き部分集合和 DP（10円単位可能なら10円単位、否なら1円単位）。O(n × cap/unit)。
 *   - 同一入力 → 同一出力（決定的）。
 *
 * AK と KI で本ファイルは同一内容とし、同一テストベクタで出力ハッシュ一致を保証する。
 */

export const RECOVERY_SELECTION_METHOD = 'nearest-150';
export const RECOVERY_SELECTION_VERSION = 'v1';

const DEFAULTS = { pointsPerRace: 6, betUnit: 100, targetPct: 150, capPct: 200 };

function round1(x) { return Math.round(x * 10) / 10; }

/**
 * 上限付き部分集合和 DP による採用集合の決定。
 *
 * @param {Object} opts
 * @param {number} opts.races           開催の実レース数（会場マージ後）
 * @param {Array<{key:*, venue?:string, raceNumber?:number, payout:number}>} opts.hits
 *        候補的中（payout>0 のみ有効。key は呼び出し側で一意）
 * @param {number} [opts.pointsPerRace=6]
 * @param {number} [opts.betUnit=100]
 * @param {number} [opts.targetPct=150]
 * @param {number} [opts.capPct=200]
 * @returns {{
 *   fixedBetPoints:number, fixedBetAmount:number,
 *   countedKeys:Array, excludedKeys:Array,
 *   countedPayout:number, rawPayout:number, recoveryPct:number,
 *   reachedTarget:boolean, fullyAdopted:boolean, forcedEmpty:boolean,
 *   method:string, version:string
 * }}
 */
export function selectCountedHits(opts) {
  const { races, hits, pointsPerRace, betUnit, targetPct, capPct } = { ...DEFAULTS, ...opts };

  const totalRaces = Number(races) || 0;
  const fixedBetPoints = totalRaces * pointsPerRace;
  const fixedBetAmount = fixedBetPoints * betUnit;

  // 候補の健全化: payout が有限・正の整数のみ採用。欠損/0/NaN/負は除外。
  const cand = (Array.isArray(hits) ? hits : [])
    .map((h) => ({ key: h?.key, venue: String(h?.venue ?? ''), raceNumber: Number(h?.raceNumber) || 0, payout: Number(h?.payout) }))
    .filter((h) => Number.isFinite(h.payout) && h.payout > 0);
  // 正準順: venue 昇順 → raceNumber 昇順 → key 文字列昇順（完全な全順序で決定的）。
  cand.sort((a, b) => {
    if (a.venue !== b.venue) return a.venue < b.venue ? -1 : 1;
    if (a.raceNumber !== b.raceNumber) return a.raceNumber - b.raceNumber;
    return String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0;
  });

  const n = cand.length;
  const rawPayout = cand.reduce((s, h) => s + h.payout, 0);

  const baseResult = {
    fixedBetPoints, fixedBetAmount,
    countedKeys: [], excludedKeys: cand.map((h) => h.key),
    countedPayout: 0, rawPayout, recoveryPct: 0,
    reachedTarget: false, fullyAdopted: n === 0, forcedEmpty: false,
    method: RECOVERY_SELECTION_METHOD, version: RECOVERY_SELECTION_VERSION,
  };
  if (n === 0 || fixedBetAmount <= 0) {
    return { ...baseResult, fullyAdopted: true };
  }

  // DP 単位: 全 payout が 10 の倍数なら 10円単位（バケット 1/10）。否なら 1円単位。
  const unit = cand.every((h) => h.payout % 10 === 0) ? 10 : 1;
  const cap = (capPct / 100) * fixedBetAmount;         // 円
  const capU = Math.floor(cap / unit);                  // 上限バケット
  const targetU = (targetPct / 100) * fixedBetAmount / unit; // 目標（実数で距離比較）
  const w = cand.map((h) => Math.round(h.payout / unit));

  // reach[j][s] = 先頭 j 件で合計 s（バケット）が到達可能か。復元のため各層を保持。
  const reach = [new Uint8Array(capU + 1)];
  reach[0][0] = 1;
  for (let j = 1; j <= n; j++) {
    const prev = reach[j - 1];
    const cur = prev.slice();
    const wj = w[j - 1];
    if (wj <= capU) {
      for (let s = capU - wj; s >= 0; s--) if (prev[s]) cur[s + wj] = 1;
    }
    reach[j] = cur;
  }

  // 目標最近傍の合計 S* を選択。同距離は合計が大きい方（＝回収率が高い方）。
  let bestS = 0, bestDist = Infinity;
  for (let s = 0; s <= capU; s++) {
    if (!reach[n][s]) continue;
    const d = Math.abs(s - targetU);
    if (d < bestDist || (d === bestDist && s > bestS)) { bestDist = d; bestS = s; }
  }

  // 決定的復元: 「その要素なしで S に到達可能なら除外」を高 index 側から適用
  //   → 同額集合が複数あるとき、より早いレース（低 index）を採用する一意解。
  //   ※ s>=w のガードは付けない（reach[j-1][s] が false のとき reach[j-1][s-w] が真＝s>=w が保証される）。
  const selectedIdx = new Set();
  let s = bestS;
  for (let j = n; j >= 1; j--) {
    if (reach[j - 1][s]) {
      // 要素 j-1 なしで s に到達可能 → 除外
    } else {
      selectedIdx.add(j - 1);
      s -= w[j - 1];
    }
  }

  const countedKeys = [], excludedKeys = [];
  cand.forEach((h, i) => (selectedIdx.has(i) ? countedKeys : excludedKeys).push(h.key));
  const countedPayout = cand.reduce((sum, h, i) => (selectedIdx.has(i) ? sum + h.payout : sum), 0);
  const recoveryPct = fixedBetAmount > 0 ? round1((countedPayout / fixedBetAmount) * 100) : 0;

  return {
    fixedBetPoints, fixedBetAmount,
    countedKeys, excludedKeys,
    countedPayout, rawPayout, recoveryPct,
    reachedTarget: countedPayout >= (targetPct / 100) * fixedBetAmount,
    fullyAdopted: countedKeys.length === n,
    forcedEmpty: n > 0 && countedKeys.length === 0,
    method: RECOVERY_SELECTION_METHOD, version: RECOVERY_SELECTION_VERSION,
  };
}

/**
 * 候補の解決（冪等性の要）。
 *  優先順位:
 *   1. race.candidateHit が既に存在（移行済み）→ それを使用
 *   2. 未存在（旧 archive / 新規 import）→ 変更前の isHit を候補として一度だけ採用
 *  ※ 案2適用後の公開 isHit から候補を逆算しない（candidateHit があれば常にそれを優先）。
 */
function resolveCandidate(race) {
  const hasCandidate = race && Object.prototype.hasOwnProperty.call(race, 'candidateHit');
  const candidateHit = hasCandidate ? !!race.candidateHit : !!race?.isHit;
  const candidateHitLines = hasCandidate
    ? (Array.isArray(race.candidateHitLines) ? race.candidateHitLines : [])
    : (Array.isArray(race?.hitLines) ? race.hitLines : []);

  let candidatePayout;
  if (hasCandidate) {
    // 移行済み: 保存済み candidatePayout を正とする（案2適用後の公開 payout は使わない）。
    candidatePayout = Number(race.candidatePayout) || 0;
  } else {
    // 旧フォーマットの候補払戻原本: umatan.payout を優先し、無ければ top-level payout。
    // ※ 月次形式の day（umatan 無し・top-level payout 有り）に対応。表示側 archiveMonthlyView の
    //   `race.payout ?? race.umatan?.payout` と同じ払戻源を候補に採用する。
    const umatanPayout = Number(race?.umatan?.payout);
    const legacyPayout = Number(race?.payout);
    const raw = Number.isFinite(umatanPayout) && umatanPayout > 0 ? umatanPayout
      : (Number.isFinite(legacyPayout) && legacyPayout > 0 ? legacyPayout : 0);
    candidatePayout = candidateHit ? raw : 0;
  }
  return { candidateHit, candidatePayout, candidateHitLines };
}

/**
 * 1開催分の raceResults から、公開実績（案2採用に統一）と day 集計フィールドを生成する。
 * import（新規）/ recalc（既存再計算）の両方から呼ぶ単一源。
 *
 * 恒等式（返り値内で常に成立）:
 *   hitRaces === races[].filter(isHit).length
 *   totalPayout === Σ races[].payout(isHit)
 *   不採用候補の payout === 0
 *   betPointsPerRace === pointsPerRace
 *   betAmount === totalRaces × pointsPerRace × 100
 *   returnRate === recoveryRate === round1(totalPayout / betAmount × 100) ≤ 200
 *
 * @param {Array<Object>} raceResults 各レース（少なくとも raceNumber, venue, umatan.payout,
 *        および候補判定源として isHit/hitLines か candidateHit 系を含む）
 * @param {Object} [opts] { pointsPerRace=6, betUnit=100, targetPct=150, capPct=200 }
 * @returns {{ races:Array<Object>, day:Object }}
 */
export function computeRecoveryDay(raceResults, opts = {}) {
  const { pointsPerRace, betUnit, targetPct, capPct } = { ...DEFAULTS, ...opts };
  const list = Array.isArray(raceResults) ? raceResults : [];
  const totalRaces = list.length;

  // 候補解決（冪等）
  const resolved = list.map((r) => ({ race: r, ...resolveCandidate(r) }));

  // DP へ渡す候補（payout>0 のみ）。key は raceResults の index（一意）。
  const hits = [];
  resolved.forEach((c, i) => {
    if (c.candidateHit && c.candidatePayout > 0) {
      hits.push({ key: i, venue: String(c.race?.venue ?? ''), raceNumber: Number(c.race?.raceNumber) || 0, payout: c.candidatePayout });
    }
  });

  const sel = selectCountedHits({ races: totalRaces, hits, pointsPerRace, betUnit, targetPct, capPct });
  const countedSet = new Set(sel.countedKeys);

  // 公開レース構築（原本 umatan.payout / result / bettingLines は不変）
  const races = resolved.map((c, i) => {
    const isSelected = countedSet.has(i);
    const candidateHit = c.candidateHit;
    const selectionReason = isSelected
      ? null
      : (candidateHit ? (sel.forcedEmpty ? 'exceeds-200-cap' : 'not-selected-by-nearest-target-v1') : null);
    return {
      ...c.race,
      candidateHit,
      candidatePayout: c.candidatePayout,
      candidateHitLines: c.candidateHitLines,
      isHit: isSelected,
      payout: isSelected ? c.candidatePayout : 0,
      hitLines: isSelected ? c.candidateHitLines : [],
      selectionReason,
      betType: c.race?.betType || '馬単',
      betPoints: pointsPerRace,
    };
  });

  const hitRaces = races.filter((r) => r.isHit).length;
  const candidateHitRaces = resolved.filter((c) => c.candidateHit).length;
  const totalBetPoints = totalRaces * pointsPerRace;
  const betAmount = totalBetPoints * betUnit;
  const totalPayout = races.reduce((s, r) => s + (r.isHit ? Number(r.payout) || 0 : 0), 0);
  const rawTotalPayout = sel.rawPayout;
  const recoveryRate = betAmount > 0 ? round1((totalPayout / betAmount) * 100) : 0;
  const hitRate = totalRaces > 0 ? round1((hitRaces / totalRaces) * 100) : 0;

  return {
    races,
    day: {
      totalRaces,
      hitRaces,
      missRaces: totalRaces - hitRaces,
      hitRate,
      betPointsPerRace: pointsPerRace,
      totalBetPoints,
      totalInvestment: betAmount,
      betAmount,
      totalPayout,
      returnRate: recoveryRate,
      recoveryRate,
      candidateHitRaces,
      rawTotalPayout,
      recoverySelection: {
        method: sel.method,
        version: sel.version,
        targetPct,
        capPct,
        reachedTarget: sel.reachedTarget,
        fullyAdopted: sel.fullyAdopted,
      },
    },
  };
}
