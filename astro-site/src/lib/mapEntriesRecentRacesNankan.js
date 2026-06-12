/**
 * 南関 entries(出馬表) の recentRaces を「表示用 shape」へ正規化する mapper（PR-F5c）
 *
 * 設計: keiba-data-shared-admin docs/nankan-horse-detail-display-plan.md §32.5。
 *
 * 方針（厳守）:
 *   - **pure function**（副作用なし・入力を mutate しない・新しいオブジェクト/配列を返す）。
 *   - **recentRaces のみ**を扱う。**record は絶対に触らない・出力に含めない**。
 *   - featureScores / AI指数 / 印 / 買い目 / 穴馬 には一切接続しない。
 *   - null / undefined を安全に扱う。配列でなければ [] を返す。
 *   - 出力 key は既存 getDisplayRecentRacesForNankan の whitelist に合わせる。
 *     undefined の key は無理に入れない（存在する値だけ出す）。
 *
 * entries → 表示 shape の変換:
 *   finish → rank / finishStatus → finishStatus / weight → carriedWeight /
 *   horse.number → horseNumber（context.horse 由来）/ surface は race.surface 補完 /
 *   raceNumber は race.raceNumber 補完 / distance は recentRace 優先・無ければ race /
 *   headCount は recentRace 優先・無ければ race。
 *   opponentName / postPosition / record は初期 mapper では出さない。
 */

// 既存 getDisplayRecentRacesForNankan の DISPLAY_WHITELIST と同一（record は含まない）
const OUTPUT_WHITELIST = [
  'date', 'venue', 'venueName', 'venueCode', 'raceNumber', 'raceName',
  'distance', 'distanceMeters', 'surface', 'trackCondition', 'headCount',
  'horseNumber', 'rank', 'finishStatus', 'popularity', 'bodyWeight',
  'jockey', 'carriedWeight', 'time', 'passingOrder', 'last3f', 'margin',
];

function isNonEmpty(v) {
  return v !== undefined && v !== null && v !== '';
}

// out[key] = value を「意味のある値のときだけ」セット（undefined/null/'' は入れない）
function put(out, key, value) {
  if (isNonEmpty(value)) out[key] = value;
}

/**
 * entries の recentRace 1走を表示 shape に変換する。
 * @param {object} recentRace entries horse.recentRaces[i]
 * @param {object} [context]  { race?, horse? }（race-level / horse-level の補完元）
 * @returns {object|null} 表示 shape（実体が無ければ null）
 */
export function mapEntriesRecentRaceNankan(recentRace, context = {}) {
  if (!recentRace || typeof recentRace !== 'object') return null;
  const race = (context && context.race) || {};
  const horse = (context && context.horse) || {};
  const out = {};

  // そのまま渡す項目
  put(out, 'date', recentRace.date);
  put(out, 'venue', recentRace.venue);
  put(out, 'raceName', recentRace.raceName);
  put(out, 'trackCondition', recentRace.trackCondition);
  put(out, 'popularity', recentRace.popularity);
  put(out, 'bodyWeight', recentRace.bodyWeight);
  put(out, 'jockey', recentRace.jockey);
  put(out, 'time', recentRace.time);
  put(out, 'passingOrder', recentRace.passingOrder);
  put(out, 'last3f', recentRace.last3f);
  put(out, 'margin', recentRace.margin);

  // 変換項目
  put(out, 'rank', recentRace.finish);                 // finish → rank
  put(out, 'finishStatus', recentRace.finishStatus);   // finishStatus はそのまま
  put(out, 'carriedWeight', recentRace.weight);        // weight → carriedWeight

  // distance / headCount は recentRace 優先・無ければ race-level で補完
  put(out, 'distance', isNonEmpty(recentRace.distance) ? recentRace.distance : race.distance);
  put(out, 'headCount', isNonEmpty(recentRace.headCount) ? recentRace.headCount : race.headCount);

  // race-level からの補完
  put(out, 'surface', recentRace.surface ?? race.surface);            // surface 補完
  put(out, 'raceNumber', recentRace.raceNumber ?? race.raceNumber);   // raceNumber 補完

  // horse-level: 現在エントリの馬番 → horseNumber（突合・表示用）
  put(out, 'horseNumber', horse.number);

  // ※ record / opponentName / postPosition は出力しない（§32.5）

  // 念のため whitelist 外を落とす（将来の追加事故防止）
  for (const k of Object.keys(out)) {
    if (!OUTPUT_WHITELIST.includes(k)) delete out[k];
  }

  // 実体が無い（全項目欠落）の場合は null
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * entries の recentRaces 配列を表示 shape 配列へ正規化する。
 * @param {Array} recentRaces entries horse.recentRaces
 * @param {object} [context]  { race?, horse? }
 * @returns {Array} 表示 shape の配列（入力が配列でなければ []）
 */
export function mapEntriesRecentRacesNankan(recentRaces, context = {}) {
  if (!Array.isArray(recentRaces)) return [];
  return recentRaces
    .map((r) => mapEntriesRecentRaceNankan(r, context))
    .filter(Boolean);
}

export default mapEntriesRecentRacesNankan;
