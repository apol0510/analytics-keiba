/**
 * predictionFileScope.mjs
 *
 * check-prediction-data-integrity.mjs の「走査対象判定」を純粋関数として切り出したもの。
 * ファイル fs 走査からは独立させ、単体テスト（predictionFileScope.test.js）で固定できるようにする。
 *
 * 背景（2026-06-24 別タスク）:
 *   南関予想は src/data/predictions 直下に `YYYY-MM-DD-<venueSlug>.json`（例 2026-06-24-urawa.json）
 *   で保存されるが、旧 integrity スクリプトは root=predictions/nankan・filename=YYYY-MM-DD.json を
 *   前提にしていたため南関が恒常的に走査対象外だった。実レイアウトに合わせて判定する。
 */

/**
 * 南関 venue slug 正規集合（大井/川崎/船橋/浦和の4会場固定。CLAUDE.md 競馬場表）。
 *
 * 出所（AK には export 済みの共通定義が無いため重複を一元化）:
 *   - producer: scripts/importPrediction.js の venueMap（'大井'→'ooi' 等・保存ファイル名生成）
 *   - consumer: src/lib/inject{HorseStats,EntriesRecentRaces,RecentHorseHistories}Nankan.js の
 *               NANKAN_SLUG_TO_CODE（{ ooi, kawasaki, funabashi, urawa }）
 * ドリフト防止: predictionFileScope.test.js で本集合が上記4 slug と完全一致することを assert する。
 */
export const NANKAN_VENUE_SLUGS = new Set(['ooi', 'funabashi', 'kawasaki', 'urawa']);

/** JRA 予想ファイル名か（venue 接尾辞なし: YYYY-MM-DD.json）。 */
export function isJraPredictionFilename(name) {
  return /^\d{4}-\d{2}-\d{2}\.json$/.test(name);
}

/**
 * 南関 予想ファイル名を解析する（YYYY-MM-DD-<venueSlug>.json）。
 * venueSlug が南関4会場のいずれかのときだけ採用し、それ以外（JRA・無関係 JSON）は null。
 * @returns {{date:string, venueSlug:string}|null}
 */
export function parseNankanPredictionFilename(name) {
  const m = /^(\d{4}-\d{2}-\d{2})-([a-z]+)\.json$/.exec(name);
  if (!m) return null;
  const [, date, venueSlug] = m;
  if (!NANKAN_VENUE_SLUGS.has(venueSlug)) return null;
  return { date, venueSlug };
}

/**
 * 検査窓判定（既存仕様を不変で移植）。
 * fileDate ∈ [today-1, today+30]（当日＋未来30日。前日朝などのマージンで -1 日）。
 * 不正日付（Invalid Date）は対象外。today は注入可能（テスト用）。
 */
export function inWindow(yyyyMmDd, today = new Date()) {
  const d = new Date(yyyyMmDd);
  if (Number.isNaN(d.getTime())) return false;
  const diffDays = (today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays >= -30 && diffDays <= 1;
}
