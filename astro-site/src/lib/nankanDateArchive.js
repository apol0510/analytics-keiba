/**
 * nankanDateArchive.js — 南関「日付 × 競馬場 × 予想・結果」恒久ページの単一データ源
 *
 * ## なぜ要るか（2026-09-28 SEO 監査）
 *
 * 南関には日付別の恒久ページが無く（JRA は `/free-prediction/jra/YYYY-MM-DD/` がある）、
 * 毎日の予想と結果が翌日には検索から辿れない状態だった。旧ドメインの検索資産も 5 月末で消えた。
 * AK が実際に持つ一次情報（その日の印・着順・的中）を、日付ごとの恒久 URL に積み上げる。
 *
 * ## 公開範囲（新しい公開範囲を作らない）
 *
 * 既に無料で公開している範囲だけを組み合わせる:
 *   - 印（◎○▲△・馬番・馬名）… `/free/` と同じ公開 DTO `buildFreePublicRows()`（`freePublicView.js`）
 *   - 着順（1〜3 着）・各レースの的中 ✅/✗・メインレースの買い目（本命→相手・抑えは伏せる）
 *     … `/results-showcase/` と同じ `buildShowcaseDay()`（`resultsShowcase.js`）
 * 出さないもの: AI総合指数・pt・役割名・特徴量・メイン以外の買い目・払戻（メイン的中時の払戻を除く）・抑え。
 * ⚠️ `_horse`（生データ参照）はこのモジュールの出力に**含めない**。
 *
 * ## データ
 *   予想: `src/data/predictions/YYYY-MM-DD-{venueSlug}.json`（`eventInfo` + `predictions`）
 *   結果: `src/data/archiveResults.json`（日付降順・1 日 1 エントリ・同日複数会場は `venues`）
 * ページはビルド時に静的生成する（`prerender = true`）。SSR 関数のデータ間引きの影響を受けない。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { buildFreePublicRows } from './freePublicView.js';
import { headlineMarksOf } from './freeViewpoints/listView.js';
import { cleanRaceName } from './freeViewpoints/loadRaceViewpoints.js';
import { buildShowcaseDay } from './resultsShowcase.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRED_FILE_RE = /^(\d{4}-\d{2}-\d{2})-[a-z]+\.json$/;

/** 恒久ページの URL（末尾スラッシュ付き・JRA と同じ形） */
export const nankanDatePath = (date) => `/free-prediction/nankan/${date}/`;
export const NANKAN_ARCHIVE_HUB_PATH = '/free-prediction/nankan/archive/';

function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return null; }
}

/** 予想ファイル一覧（日付 → ファイル群） */
function predictionFilesByDate(root) {
  const dir = join(root, 'src', 'data', 'predictions');
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const m = name.match(PRED_FILE_RE);
    if (!m) continue;
    if (!out.has(m[1])) out.set(m[1], []);
    out.get(m[1]).push(join(dir, name));
  }
  return out;
}

/** 結果アーカイブ（日付 → エントリ）。読めなければ空 */
export function loadNankanResultsByDate(root) {
  const arr = readJson(join(root, 'src', 'data', 'archiveResults.json'));
  const out = new Map();
  for (const e of Array.isArray(arr) ? arr : []) {
    if (e && DATE_RE.test(String(e.date)) && Array.isArray(e.races) && !out.has(e.date)) out.set(e.date, e);
  }
  return out;
}

/**
 * ページを作る日付（予想 or 結果のどちらかがある日）。新しい順。
 * @returns {string[]}
 */
export function listNankanArchiveDates(root = process.cwd()) {
  const set = new Set([...predictionFilesByDate(root).keys(), ...loadNankanResultsByDate(root).keys()]);
  return [...set].filter((d) => DATE_RE.test(d)).sort((a, b) => (a < b ? 1 : -1));
}

const topThree = (result) => {
  if (!result) return null;
  const pick = (x) => (x && x.number != null ? { number: Number(x.number), name: String(x.name || '') } : null);
  const rows = [pick(result.first), pick(result.second), pick(result.third)];
  return rows.some(Boolean) ? rows : null;
};

/**
 * 1 日ぶんのページビュー（純粋な組み立て。I/O は root から読むだけ）。
 * 予想も結果も無い日は null。
 *
 * @returns {null|{date, venues: Array<{venue, totalRaces, hitRaces, mainRace, races: Array}>, summary}}
 */
export function buildNankanDatePage(date, root = process.cwd(), cache = {}) {
  if (!DATE_RE.test(String(date))) return null;
  const files = (cache.predFiles || predictionFilesByDate(root)).get(date) || [];
  const resultEntry = (cache.results || loadNankanResultsByDate(root)).get(date) || null;
  const showcase = resultEntry ? buildShowcaseDay(resultEntry) : null;
  const groupByVenue = new Map((showcase?.venueGroups || []).map((g) => [g.venue, g]));
  const resultRaceByKey = new Map(
    (resultEntry?.races || []).map((r) => [`${r.venue}|${Number(r.raceNumber)}`, r]),
  );

  // 予想側の会場（ファイル順は安定させる）
  const predVenues = files
    .map((f) => readJson(f))
    .filter((d) => d && d.eventInfo && d.eventInfo.venue && Array.isArray(d.predictions))
    .map((d) => ({ venue: d.eventInfo.venue, predictions: d.predictions }));

  const venueNames = [...new Set([...predVenues.map((v) => v.venue), ...groupByVenue.keys()])];
  if (venueNames.length === 0) return null;

  const venues = venueNames.map((venue) => {
    const pv = predVenues.find((v) => v.venue === venue) || null;
    const g = groupByVenue.get(venue) || null;
    const hitByRace = new Map((g?.races || []).map((r) => [Number(r.raceNumber), r]));

    const raceNumbers = new Set([
      ...(pv ? pv.predictions.map((r) => Number(r?.raceInfo?.raceNumber)) : []),
      ...hitByRace.keys(),
    ]);
    const races = [...raceNumbers].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b).map((n) => {
      const pr = pv ? pv.predictions.find((r) => Number(r?.raceInfo?.raceNumber) === n) : null;
      const ri = pr?.raceInfo || {};
      const rr = resultRaceByKey.get(`${venue}|${n}`) || null;
      const hit = hitByRace.get(n) || null;
      // ⚠️ 公開 DTO → 印だけ取り出す（_horse はここで捨てる）
      const marks = pr ? headlineMarksOf(buildFreePublicRows(pr.horses || [])) : [];
      return {
        raceNumber: n,
        raceName: cleanRaceName(ri.raceName || rr?.raceName || ''),
        startTime: ri.startTime || null,
        distance: Number.isFinite(Number(ri.distance)) ? Number(ri.distance) : null,
        horseCount: Number.isFinite(Number(ri.horseCount)) ? Number(ri.horseCount) : null,
        marks: marks.map((m) => ({ mark: m.mark, kind: m.kind, number: m.number, name: m.name })),
        top3: topThree(rr?.result),
        hasResult: !!hit,
        isHit: hit ? !!hit.isHit : null,
        isMain: hit ? !!hit.isMain : false,
      };
    });

    return {
      venue,
      totalRaces: races.length,
      hasResults: !!g,
      hitRaces: g ? g.races.filter((r) => r.isHit).length : null,
      // メインレースの買い目は /results-showcase/ と同じ公開範囲（抑えは伏せる）
      mainRace: g?.mainRace || null,
      races,
    };
  });

  const withResults = venues.filter((v) => v.hasResults);
  return {
    date,
    venues,
    summary: {
      venueLabel: venues.map((v) => v.venue).join('・'),
      totalRaces: venues.reduce((s, v) => s + v.totalRaces, 0),
      hasResults: withResults.length > 0,
      hitRaces: withResults.length > 0 ? withResults.reduce((s, v) => s + v.hitRaces, 0) : null,
      resultRaces: withResults.reduce((s, v) => s + v.races.filter((r) => r.hasResult).length, 0),
    },
  };
}

/** 全日付を 1 回の読み込みで作る（ビルド用。予想・結果ファイルを日ごとに読み直さない） */
export function buildAllNankanDatePages(root = process.cwd()) {
  const cache = { predFiles: predictionFilesByDate(root), results: loadNankanResultsByDate(root) };
  const dates = [...new Set([...cache.predFiles.keys(), ...cache.results.keys()])]
    .filter((d) => DATE_RE.test(d)).sort((a, b) => (a < b ? 1 : -1));
  return dates.map((d) => buildNankanDatePage(d, root, cache)).filter(Boolean);
}

/** 日付の日本語表記（2026-09-25 → 2026年9月25日） */
export function formatJpDate(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

/** 前後の開催日（新しい順配列の中で） */
export function neighborDates(dates, date) {
  const i = dates.indexOf(date);
  if (i < 0) return { newer: null, older: null };
  return { newer: i > 0 ? dates[i - 1] : null, older: i < dates.length - 1 ? dates[i + 1] : null };
}
