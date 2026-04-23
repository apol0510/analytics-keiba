/**
 * 予想 × 結果の突合（的中判定）共通モジュール。
 *
 * importResults.js / importResultsJra.js の既存ロジックが各所で重複していたため、
 * ここに一元化する。馬番ベースで予想の買い目と結果を突合し、
 * 的中判定 / 払戻 / 回収率を返す。
 *
 * 依存しないデータ形式:
 *   prediction = { horses: [{horseNumber, role}, ...] }      or
 *   prediction = { horses: {main:{number}, sub:{number}, ...} }
 *
 *   result = {
 *     first: {number}, second: {number}, third: {number},
 *     umatan: {number: "5-8", payout: 123}?,
 *     sanrenpuku: {numbers: "5-8-11", payout: 456}?,
 *   }
 */

const DEFAULT_BET_UNIT = 100; // 1点あたり円

/**
 * 予想から本命/対抗/単穴/連下の馬番リストを抽出する。
 * 新スキーマ（配列+role）と旧スキーマ（{main,sub,...}）のどちらでも動く。
 */
function extractRoleNumbers(prediction) {
  if (!prediction) return { main: null, sub: null, holes: [], connects: [] };

  // 旧スキーマ: horses = {main:{number}, sub:{number}, hole1:{number}, ...}
  if (prediction.horses && !Array.isArray(prediction.horses)) {
    const h = prediction.horses;
    const holes = [];
    if (h.hole1?.number) holes.push(h.hole1.number);
    if (h.hole2?.number) holes.push(h.hole2.number);
    const connects = [];
    if (h.connectTop?.number) connects.push(h.connectTop.number);
    if (Array.isArray(h.connect)) {
      for (const c of h.connect) if (c?.number) connects.push(c.number);
    }
    return {
      main: h.main?.number ?? null,
      sub: h.sub?.number ?? null,
      holes,
      connects,
    };
  }

  // 新スキーマ: horses = [{horseNumber, role}, ...]
  if (Array.isArray(prediction.horses)) {
    const pick = (role) => prediction.horses.find(h => h.role === role);
    const pickAll = (role) => prediction.horses.filter(h => h.role === role);
    const num = (h) => h?.horseNumber ?? h?.number ?? null;
    return {
      main: num(pick('本命')),
      sub: num(pick('対抗')),
      holes: pickAll('単穴').map(num).filter(n => n != null),
      connects: [
        ...(pick('連下最上位') ? [num(pick('連下最上位'))] : []),
        ...pickAll('連下').map(num).filter(n => n != null),
      ],
    };
  }

  return { main: null, sub: null, holes: [], connects: [] };
}

/**
 * 馬単（2連単）の的中判定。
 * 本命 → [対抗, 単穴1, 単穴2, 連下...] の組み合わせが 1着→2着 に一致すれば的中。
 */
function checkUmatanHit(roleNums, result) {
  const first = result?.first?.number ?? null;
  const second = result?.second?.number ?? null;
  if (first == null || second == null) return false;
  const { main, sub, holes, connects } = roleNums;
  if (main == null) return false;
  if (first !== main) return false;
  const partners = [sub, ...holes, ...connects].filter(n => n != null);
  return partners.includes(second);
}

/**
 * 三連複の的中判定。本命・対抗・単穴の3頭ボックスが上位3着に含まれていれば的中。
 */
function checkSanrenpukuHit(roleNums, result) {
  const { main, sub, holes } = roleNums;
  const axis = [main, sub, ...holes].filter(n => n != null);
  if (axis.length < 3) return false;
  const top3 = [result?.first?.number, result?.second?.number, result?.third?.number].filter(n => n != null);
  if (top3.length < 3) return false;
  // axis の中から任意の3頭が top3 と一致すればOK
  const axisSet = new Set(axis);
  return top3.every(n => axisSet.has(n));
}

/**
 * 1レース分の的中判定を行い、共通形式で返す。
 *
 * @param {Object} opts
 * @param {string} opts.raceId
 * @param {Object} opts.prediction  - { horses, ... } 予想1レース分
 * @param {Object} opts.result      - { first, second, third, umatan, sanrenpuku }
 * @param {'umatan'|'sanrenpuku'} [opts.betType]
 * @param {number} [opts.betPoints] - 購入点数（回収率計算に使用。未指定なら 1）
 * @param {number} [opts.betUnit]   - 1点あたり円（デフォ 100）
 * @returns {{raceId:string, hit:boolean, betType:string, payout:number, recoveryRate:number}}
 */
export function matchPredictionToResult({
  raceId,
  prediction,
  result,
  betType = 'umatan',
  betPoints,
  betUnit = DEFAULT_BET_UNIT,
}) {
  const roleNums = extractRoleNumbers(prediction);
  const points = Number(betPoints ?? 1);
  const invested = points * betUnit;

  let hit = false;
  let payout = 0;
  if (betType === 'umatan') {
    hit = checkUmatanHit(roleNums, result);
    if (hit) payout = Number(result?.umatan?.payout ?? 0);
  } else if (betType === 'sanrenpuku') {
    hit = checkSanrenpukuHit(roleNums, result);
    if (hit) payout = Number(result?.sanrenpuku?.payout ?? 0);
  }

  const recoveryRate = invested > 0 ? Math.round((payout / invested) * 100) : 0;
  return { raceId, hit, betType, payout, recoveryRate };
}
