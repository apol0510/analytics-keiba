/**
 * JRA 速報ベース 的中判定ユーティリティ
 *
 * archiveResultsJra.json の確定データが「broken」(totalPayout=0 / rank=null由来)
 * のとき、live-results (1着/2着のみ) と prediction (印情報) を組み合わせて
 * 暫定的な isHit を再計算するために使う。
 *
 * 的中ルール (KEIBA Intelligence 共通):
 *   1. 本命 (◎) または 対抗 (○) のどちらかが連対 (1着 or 2着) している
 *   2. かつ、1着と2着の両方が「不要馬以外」(マークあり/買い目内) である
 *
 * 「不要馬以外」 = 印あり (本命/対抗/単穴/連下/連下最上位) ∪ 買い目内 (axis/相手/抑え)
 */

const VALID_ROLES = new Set(['本命', '対抗', '単穴', '連下', '連下最上位', '抑え']);
const AXIS_ROLES = new Set(['本命', '対抗']);

/**
 * 予想レースから「不要馬以外」の馬番セットを構築。
 * 印 + 馬単買い目に含まれる全馬番を集約する。
 */
export function buildValidHorseSet(predRace) {
  const set = new Set();
  for (const h of (predRace?.horses || [])) {
    if (VALID_ROLES.has(h.role)) {
      const n = parseInt(h.horseNumber, 10);
      if (Number.isFinite(n)) set.add(n);
    }
  }
  for (const line of (predRace?.bettingLines?.umatan || [])) {
    const m = String(line).match(/^(\d+)-(.+)$/);
    if (!m) continue;
    set.add(parseInt(m[1], 10));
    const aitePart = m[2];
    const main = aitePart.replace(/\(抑え.+\)/, '');
    main.split('.').forEach((s) => {
      const v = parseInt(s, 10);
      if (Number.isFinite(v)) set.add(v);
    });
    const osae = aitePart.match(/\(抑え([0-9.]+)\)/);
    if (osae) {
      osae[1].split('.').forEach((s) => {
        const v = parseInt(s, 10);
        if (Number.isFinite(v)) set.add(v);
      });
    }
  }
  return set;
}

/**
 * 予想レースから 本命/対抗 (軸馬) の馬番セットを構築。
 */
export function buildAxisSet(predRace) {
  const set = new Set();
  for (const h of (predRace?.horses || [])) {
    if (AXIS_ROLES.has(h.role)) {
      const n = parseInt(h.horseNumber, 10);
      if (Number.isFinite(n)) set.add(n);
    }
  }
  return set;
}

/**
 * live race × prediction race で 的中判定。
 * @param {object} liveRace - { raceNumber, results: [{position, number}] }
 * @param {object} predRace - { raceInfo, horses, bettingLines }
 * @returns {{isHit: boolean, first: number?, second: number?, reason: string?}}
 */
export function judgeLiveHit(liveRace, predRace) {
  if (!liveRace || !predRace) {
    return { isHit: false, first: null, second: null, reason: 'data不足' };
  }
  const first = liveRace.results?.find((r) => r.position === 1)?.number ?? null;
  const second = liveRace.results?.find((r) => r.position === 2)?.number ?? null;
  if (!first || !second) {
    return { isHit: false, first, second, reason: 'live未確定' };
  }
  const valid = buildValidHorseSet(predRace);
  const axis = buildAxisSet(predRace);

  const axisConnect = axis.has(first) || axis.has(second);
  const bothValid = valid.has(first) && valid.has(second);

  return {
    isHit: axisConnect && bothValid,
    first,
    second,
    reason: !axisConnect ? '軸馬不連対' : !bothValid ? '不要馬絡み' : null,
  };
}

/**
 * venueCode (TOK/KYO/NII...) → 日本語会場名 (東京/京都/新潟...)
 * archive と prediction は日本語名、live は venueCode を使うため変換に必要。
 */
export const VENUE_CODE_TO_NAME = {
  TOK: '東京',
  NAK: '中山',
  KYO: '京都',
  HAN: '阪神',
  CHU: '中京',
  KOK: '小倉',
  NII: '新潟',
  FKS: '福島',
  FUK: '福島', // alt code
  SAP: '札幌',
  HAK: '函館',
  HKD: '函館', // alt code
};

/**
 * archive entry を broken (totalPayout=0 + returnRate=0) と判定。
 */
export function isBrokenEntry(entry) {
  if (!entry) return false;
  return (Number(entry.totalPayout) || 0) === 0
      && (Number(entry.returnRate) || 0) === 0;
}

/**
 * BET_POINT_LOGIC.md 準拠: 払戻と実レース数から 1レース当たり購入点数を決定。
 * 100% 以上を維持できる最大点数を選び、下限は 6 点。
 * 1 点 = 100 円。
 */
export function getBetPointsPerRace(totalPayout, races) {
  if (!races || races <= 0) return 6;
  if (totalPayout >= races * 12 * 100) return 12;
  if (totalPayout >= races * 10 * 100) return 10;
  if (totalPayout >= races *  8 * 100) return 8;
  if (totalPayout >= races *  6 * 100) return 6;
  return 6; // 下限
}

/**
 * 払戻と実レース数から購入点数・投資額・回収率を一括計算。
 * BET_POINT_LOGIC.md と同一実装。
 */
export function computeBetMetrics(totalPayout, totalRaces) {
  const betPointsPerRace = getBetPointsPerRace(totalPayout, totalRaces);
  const totalBetPoints = totalRaces * betPointsPerRace;
  const totalInvestment = totalBetPoints * 100;
  const recoveryRate = totalInvestment > 0
    ? Math.round((totalPayout / totalInvestment) * 1000) / 10
    : 0;
  return {
    betPointsPerRace,
    totalBetPoints,
    totalInvestment,
    betAmount: totalInvestment, // alias
    recoveryRate,
    returnRate: recoveryRate, // alias
  };
}

/**
 * 予想データを venue+raceNumber でインデックス化。
 */
export function buildPredictionIndex(predData) {
  const idx = new Map();
  for (const v of (predData?.venues || [])) {
    for (const r of (v.predictions || [])) {
      const venueName = v.venue || r.raceInfo?.venue;
      const raceNum = r.raceInfo?.raceNumber;
      if (venueName && raceNum != null) {
        idx.set(`${venueName}-${raceNum}`, r);
      }
    }
  }
  return idx;
}

/**
 * 既存 archive entry を live + 予想データで enrich (副作用あり: entry を直接書き換える)。
 *
 * - broken (totalPayout=0 + returnRate=0) と判定された entry に対してのみ実行する想定。
 * - entry.races[].isHit を live ベースで再計算
 * - entry.races[].umatan を live の payout で backfill (broken 時は元々 null)
 * - entry.hitRaces / hitRate / totalPayout を再集計
 * - entry.live = true マーカー
 *
 * @returns {boolean} enrich を行った場合 true
 */
export function enrichEntryWithLive(entry, liveData, predData) {
  if (!entry || !liveData || !Array.isArray(liveData.venues)) return false;
  const predIndex = predData ? buildPredictionIndex(predData) : new Map();

  let recomputedHits = 0;
  let recomputedPayout = 0;
  for (const liveVenue of liveData.venues) {
    const venueName = VENUE_CODE_TO_NAME[liveVenue.venueCode] || liveVenue.venueName;
    if (!venueName) continue;
    for (const liveRace of (liveVenue.races || [])) {
      const predRace = predIndex.get(`${venueName}-${liveRace.raceNumber}`);
      const judge = judgeLiveHit(liveRace, predRace);
      if (judge.isHit) recomputedHits++;

      const liveUmatan = liveRace.umatan && liveRace.umatan.payout > 0
        ? { combination: liveRace.umatan.combination, payout: liveRace.umatan.payout }
        : null;
      if (judge.isHit && liveUmatan) recomputedPayout += liveUmatan.payout;

      const archiveRace = entry.races?.find(
        (r) => r.venue === venueName && r.raceNumber === liveRace.raceNumber
      );
      if (archiveRace) {
        archiveRace.isHit = judge.isHit;
        archiveRace._liveFirst = judge.first;
        archiveRace._liveSecond = judge.second;
        // 既存 payout が空なら live で backfill
        if (liveUmatan && (!archiveRace.umatan?.payout)) {
          archiveRace.umatan = { combination: liveUmatan.combination, payout: liveUmatan.payout };
        }
      }
    }
  }

  entry.hitRaces = recomputedHits;
  if (entry.totalRaces > 0) {
    entry.hitRate = ((recomputedHits / entry.totalRaces) * 100).toFixed(1);
  }
  // 元々 totalPayout=0 (broken) のはずなので live 由来で backfill
  if ((Number(entry.totalPayout) || 0) === 0) {
    entry.totalPayout = recomputedPayout;
  }
  // 投資額・回収率を BET_POINT_LOGIC で再計算 (元値が 0 なら必ず上書き)
  const m = computeBetMetrics(entry.totalPayout || 0, entry.totalRaces || 0);
  entry.betPointsPerRace = m.betPointsPerRace;
  entry.totalBetPoints = m.totalBetPoints;
  entry.totalInvestment = m.totalInvestment;
  entry.betAmount = m.betAmount;
  entry.recoveryRate = m.recoveryRate;
  entry.returnRate = m.returnRate;
  entry.live = true;
  return true;
}

/**
 * live + 予想データから 暫定 archive entry を合成。
 * archiveResultsJra に該当日のエントリが無いとき、画面に live ベースで表示するために使う。
 *
 * @param {string} date YYYY-MM-DD
 * @param {object} liveData jraLiveResults/{date}.json の内容
 * @param {object} predData predictions/jra/{yyyy}/{mm}/{date}.json の内容
 * @returns {object} archive entry 互換オブジェクト (live: true フラグ付き)
 */
export function synthesizeEntryFromLive(date, liveData, predData) {
  if (!liveData || !Array.isArray(liveData.venues)) return null;
  const predIndex = predData ? buildPredictionIndex(predData) : new Map();

  let hits = 0;
  let total = 0;
  let totalPayout = 0;
  const races = [];
  const venueNames = [];

  for (const lv of liveData.venues) {
    const venueName = VENUE_CODE_TO_NAME[lv.venueCode] || lv.venueName;
    if (!venueName) continue;
    if (!venueNames.includes(venueName)) venueNames.push(venueName);
    for (const lr of (lv.races || [])) {
      const predRace = predIndex.get(`${venueName}-${lr.raceNumber}`);
      const judge = judgeLiveHit(lr, predRace);
      total++;
      if (judge.isHit) hits++;
      // 馬単払戻: live が umatan を持っていて、かつ的中している場合のみ採用
      const liveUmatan = lr.umatan && lr.umatan.payout > 0
        ? { combination: lr.umatan.combination, payout: lr.umatan.payout }
        : { combination: null, payout: null };
      if (judge.isHit && liveUmatan.payout) totalPayout += liveUmatan.payout;
      races.push({
        raceNumber: lr.raceNumber,
        venue: venueName,
        isHit: judge.isHit,
        umatan: liveUmatan,
        results: [],
        _liveFirst: judge.first,
        _liveSecond: judge.second,
      });
    }
  }

  const m = computeBetMetrics(totalPayout, total);
  return {
    date,
    venue: venueNames.join('・'),
    venues: venueNames,
    totalRaces: total,
    hitRaces: hits,
    hitRate: total > 0 ? ((hits / total) * 100).toFixed(1) : '0',
    betPointsPerRace: m.betPointsPerRace,
    totalBetPoints: m.totalBetPoints,
    totalInvestment: m.totalInvestment,
    betAmount: m.betAmount,
    totalPayout,
    recoveryRate: m.recoveryRate,
    returnRate: m.returnRate,
    races,
    live: true,
    _synthesized: true,
  };
}
