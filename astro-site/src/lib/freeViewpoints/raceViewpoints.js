/**
 * raceViewpoints.js — 無料「レースの見どころ」の判定ロジック（**単一源・純粋・I/O なし**）
 *
 * ── 出すもの / 出さないもの ──────────────────────────────────
 * 出す  : 公開事実（過去走の会場・距離・騎手）から数えた**レース単位**の傾向タグと短い説明。
 * 出さない: 買い目 / `pt` / AI総合指数 / 役割 / 特徴量。**入力にも使っていない**。
 *          （有料値を非公開入力に使うこと自体は禁止されていないが、初期設計では使わない）
 *
 * ── 2 つのレイヤーを混同しない ────────────────────────────────
 *   絶対タグ (`tags`)          … JRA / 南関それぞれの**カテゴリ全体**の分布が基準。意味は日替わりしない
 *   当日相対 (`dailyHighlights`) … **その会場のその日**の中での順位。意味はその日限り
 *
 * ── レースの状態は 4 つに分かれる ────────────────────────────
 *   'tagged'      通常判定できて、突出した傾向があった
 *   'neutral'     通常判定できたが、突出が無かった（＝確認したうえで目立つ変化なし）
 *   'no-history'  出走馬に近走が無い（新馬戦など）。**照合失敗とは別物**
 *   'unmatched'   近走を照合しきれていない（データ準備中）。**未出走とは別物**
 *
 * 個別フィールド（今日のレース距離など）だけ欠けた場合は、
 * **そのフィールドに依存するタグだけ**落とし、他のタグは残す（縮退）。
 */

import { MIN_HORSES, THRESHOLDS, DISTANCE_CHANGE_METERS, RECENT_RACES_WINDOW, REQUIRED_COVERAGE } from './thresholds.js';

/** タグの識別子。文言は表示側が持つ（ここは判定だけ）。 */
export const TAG = Object.freeze({
  DISTANCE_CHANGE: 'distance-change',
  FIRST_COURSE: 'first-course',
  JOCKEY_CHANGE: 'jockey-change',
  EASY_COMPARE: 'easy-compare',
  HARD_COMPARE: 'hard-compare',
});

export const RACE_STATE = Object.freeze({
  TAGGED: 'tagged',
  NEUTRAL: 'neutral',
  NO_HISTORY: 'no-history',
  UNMATCHED: 'unmatched',
});

// null / undefined / '' を 0 と誤読しないこと（Number(null) === 0 のため素の Number は使えない）。
// 距離が取れないレースを「距離 0m」と扱うと全頭が「距離替わり」になってしまう。
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 1 頭ぶんの近走から、その馬が各条件に該当するかを判定する。
 *
 * @param {{past: Array<{venue?: string, distance?: number, jockey?: string}>, todayJockey?: string}} horse
 * @param {{venue: string, distanceMeters: number|null, sameJockey: (a: any, b: any) => boolean|null}} ctx
 */
function classifyHorse(horse, ctx) {
  const past = Array.isArray(horse?.past) ? horse.past.slice(0, RECENT_RACES_WINDOW) : [];
  if (past.length === 0) return { hasHistory: false };
  const prev = past[0];
  const prevDistance = num(prev?.distance);
  const today = num(ctx.distanceMeters);
  const distanceKnown = prevDistance != null && today != null;

  const jockeySame = ctx.sameJockey(horse?.todayJockey, prev?.jockey);

  return {
    hasHistory: true,
    distanceKnown,
    distanceChanged: distanceKnown && Math.abs(prevDistance - today) >= DISTANCE_CHANGE_METERS,
    firstCourse: !past.some((p) => p && p.venue === ctx.venue),
    jockeyKnown: jockeySame !== null,
    jockeyChanged: jockeySame === false,
    easyCompare: distanceKnown && prev?.venue === ctx.venue
      && Math.abs(prevDistance - today) < DISTANCE_CHANGE_METERS,
  };
}

/**
 * 1 レースの見どころを判定する。
 *
 * @param {object} race
 * @param {'jra'|'nankan'} race.category
 * @param {string} race.venue        今日の開催会場（近走の会場名と同じ表記であること）
 * @param {number|null} race.distanceMeters  今日の距離（取れなければ null → 距離依存タグのみ落とす）
 * @param {number} race.entryCount   出走頭数（照合前の全頭）
 * @param {Array} race.horses        `{past: [{venue, distance, jockey}], todayJockey}` の配列。**照合できた馬のみ**
 * @param {(a:any,b:any)=>boolean|null} sameJockey 騎手の同一判定（表記ゆれ吸収は呼び出し側の責務）
 * @returns {{state: string, tags: string[], counts: object, coverage: number, matched: number, entryCount: number, degraded: string[]}}
 */
export function evaluateRace(race, sameJockey) {
  const category = race?.category === 'jra' ? 'jra' : 'nankan';
  const th = THRESHOLDS[category];
  const entryCount = Math.max(0, num(race?.entryCount) ?? 0);
  const horses = Array.isArray(race?.horses) ? race.horses : [];
  const matched = horses.length;
  const coverage = entryCount > 0 ? matched / entryCount : 0;

  const empty = { tags: [], counts: { matched, withHistory: 0 }, coverage, matched, entryCount, degraded: [] };

  // 照合しきれていない → 一部の馬で全体を語らない
  if (entryCount === 0 || coverage < REQUIRED_COVERAGE) {
    return { state: RACE_STATE.UNMATCHED, ...empty };
  }

  const ctx = { venue: race?.venue, distanceMeters: num(race?.distanceMeters), sameJockey };
  const flags = horses.map((h) => classifyHorse(h, ctx));
  const withHistory = flags.filter((f) => f.hasHistory);

  // 全頭照合できたうえで近走が 1 頭も無い → 新馬戦など（照合失敗ではない）
  if (withHistory.length === 0) {
    return { state: RACE_STATE.NO_HISTORY, ...empty };
  }

  const distanceBase = withHistory.filter((f) => f.distanceKnown).length;
  const jockeyBase = withHistory.filter((f) => f.jockeyKnown).length;

  const counts = {
    matched,
    withHistory: withHistory.length,
    distanceBase,
    jockeyBase,
    distanceChange: withHistory.filter((f) => f.distanceChanged).length,
    firstCourse: withHistory.filter((f) => f.firstCourse).length,
    jockeyChange: withHistory.filter((f) => f.jockeyChanged).length,
    easyCompare: withHistory.filter((f) => f.easyCompare).length,
  };

  const ratios = {
    dist: distanceBase > 0 ? counts.distanceChange / distanceBase : null,
    first: counts.firstCourse / withHistory.length,
    jchg: jockeyBase > 0 ? counts.jockeyChange / jockeyBase : null,
    comp: distanceBase > 0 ? counts.easyCompare / distanceBase : null,
  };

  // 母数が取れなかった軸＝その軸のタグだけ落とす（他は残す）
  const degraded = [];
  if (ratios.dist === null) degraded.push('distance');
  if (ratios.jchg === null) degraded.push('jockey');

  const tags = [];
  const upper = (key, count) => ratios[key] !== null && ratios[key] >= th[key][1] && count >= MIN_HORSES;
  if (upper('dist', counts.distanceChange)) tags.push(TAG.DISTANCE_CHANGE);
  if (upper('first', counts.firstCourse)) tags.push(TAG.FIRST_COURSE);
  if (upper('jchg', counts.jockeyChange)) tags.push(TAG.JOCKEY_CHANGE);
  if (ratios.comp !== null) {
    if (ratios.comp >= th.comp[1] && counts.easyCompare >= MIN_HORSES) tags.push(TAG.EASY_COMPARE);
    else if (ratios.comp <= th.comp[0]) tags.push(TAG.HARD_COMPARE);
  }

  return {
    state: tags.length > 0 ? RACE_STATE.TAGGED : RACE_STATE.NEUTRAL,
    tags,
    counts,
    ratios,
    coverage,
    matched,
    entryCount,
    degraded,
  };
}

/**
 * 「今日のこの会場では」の相対ハイライト。**絶対タグとは別レイヤー**。
 * 判定できたレース（tagged / neutral）だけを対象にし、同点は若い R を優先する。
 *
 * @param {Array<{raceNumber: number, result: object}>} races
 * @returns {{mostChanged: number|null, easiest: number|null, hardest: number|null}}
 */
export function dailyHighlights(races) {
  const usable = (Array.isArray(races) ? races : []).filter(
    (x) => x && x.result && (x.result.state === RACE_STATE.TAGGED || x.result.state === RACE_STATE.NEUTRAL),
  );
  if (usable.length === 0) return { mostChanged: null, easiest: null, hardest: null };

  const changeScore = (x) => {
    const r = x.result.ratios || {};
    return (r.dist ?? 0) + (r.first ?? 0) + (r.jchg ?? 0);
  };
  const pick = (arr, score, desc) => {
    let best = null;
    for (const x of arr) {
      const s = score(x);
      if (s == null) continue;
      if (best === null || (desc ? s > best.s : s < best.s)
        || (s === best.s && x.raceNumber < best.x.raceNumber)) best = { s, x };
    }
    return best ? best.x.raceNumber : null;
  };
  const withComp = usable.filter((x) => (x.result.ratios || {}).comp != null);
  return {
    mostChanged: pick(usable, changeScore, true),
    easiest: pick(withComp, (x) => x.result.ratios.comp, true),
    hardest: pick(withComp, (x) => x.result.ratios.comp, false),
  };
}

export default { evaluateRace, dailyHighlights, TAG, RACE_STATE };
