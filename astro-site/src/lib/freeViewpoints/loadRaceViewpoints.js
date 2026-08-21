/**
 * loadRaceViewpoints.js — 無料「レースの見どころ」用にデータを読み、判定へ渡す（I/O 層）
 *
 * 判定そのものは `raceViewpoints.js`（純粋）が単一源。ここは**源の違いを吸収するだけ**。
 *
 *   南関 : `predictions/*.json` ＋ `horseStats/nankan/…-R{NN}.json`（**馬番**で結合。欠損 0.00% 実測）
 *   JRA  : `predictions/jra/…json` ＋ `horseHistories/jra/…-{VENUE}.json`
 *          （**馬名**で結合。規則は `lib/jra/horseHistoryJoin.js` が単一源＝完全一致優先 →
 *            `(地)`/`(外)` を外して再照合 → 衝突は fail closed）
 *
 * どちらも「当日分が毎日そろう」ことを確認済みの源で、停止しうる featureScores には依存しない。
 * 読むだけ。`pt` / AI総合指数 / 役割 / 特徴量 / 買い目は**読み出しもしない**。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { buildJoinIndex, joinRaceHorses } from '../jra/horseHistoryJoin.js';
import { buildFreePublicRows } from '../freePublicView.js';
import { evaluateRace, dailyHighlights } from './raceViewpoints.js';
import { buildHorseExtras, buildSameConditionTable } from './memberExtras.js';
import { RECENT_RACES_WINDOW } from './thresholds.js';

const JRA_VENUE_CODE = {
  東京: 'TOK', 中山: 'NAK', 京都: 'KYO', 阪神: 'HAN', 中京: 'CHU',
  新潟: 'NII', 福島: 'FKS', 小倉: 'KOK', 札幌: 'SAP', 函館: 'HKD',
};
const NANKAN_VENUE_CODE = { 大井: 'OOI', 川崎: 'KAW', 船橋: 'FUN', 浦和: 'URA' };

/** 「1,600m」「ダート1400㍍」等から距離(m)を取り出す。取れなければ null。 */
export function parseDistanceMeters(...candidates) {
  for (const c of candidates) {
    if (c === null || c === undefined || c === '') continue;
    if (typeof c === 'number' && Number.isFinite(c)) return c;
    const m = String(c).replace(/,/g, '').match(/(\d{3,4})/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * 騎手名の同一判定。予想側は略称（`岩田望`）、履歴側は姓名（`団野 大成`）と表記が違うため、
 * 空白を除いたうえで**どちらかがどちらかの接頭辞**なら同一とみなす。
 * 判定できない（どちらかが空）ときは null を返し、母数から外す。
 */
export function sameJockey(a, b) {
  const x = String(a ?? '').replace(/[\s　]/g, '');
  const y = String(b ?? '').replace(/[\s　]/g, '');
  if (!x || !y) return null;
  return y.startsWith(x) || x.startsWith(y);
}

/** レース名から距離・頭数・発走時刻の付随表記を落として見出し用にする。 */
export function cleanRaceName(raceName) {
  return String(raceName ?? '')
    .replace(/\s*[ダ芝][\d,]+\.?\d*m.*$/, '')
    .replace(/\s*[（(]\d+頭[）)].*$/, '')
    .replace(/\s*発走時刻.*$/, '')
    .trim();
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return null; }
}


/**
 * 詳細に出す出走馬行を作る。
 *
 * **無料公開してよい範囲の単一源は `freePublicView.js` の `buildFreePublicRows()`**。
 * ここを迂回して自前で組み立てないこと（有料項目の混入を検査できなくなる）。
 * DTO は `pt` / AI総合指数 / 役割 / 特徴量を含まないので、そのまま出しても漏れない。
 * `_horse`（生データ参照）は**この時点で捨てる**。
 *
 * @param {Array} entries 予想側の出走馬（正規化前でよい）
 * @param {Array<{ref:any, hasHistory:boolean, distanceChanged:boolean, firstCourse:boolean, jockeyChanged:boolean, easyCompare:boolean}>} horseFlags
 * @param {Map<number, object>} prevByNumber 馬番 -> 前走（公開事実のみ）
 */
function buildHorseRows(entries, horseFlags, prevByNumber, pastByNumber, today) {
  const flagByRef = new Map((horseFlags || []).map((f) => [f.ref, f]));
  const rows = buildFreePublicRows(entries, { resolveRecent: () => [] });
  return rows.map((row) => {
    const f = flagByRef.get(row.number) || null;
    const prev = prevByNumber.get(row.number) || null;
    return {
      number: row.number,
      name: row.name,
      jockey: row.jockey,
      trainer: row.trainer,
      weight: row.weight,
      ageGender: row.ageGender,
      // 父（血統）。公開 DTO には元からあるが、ここで落ちていて画面まで届いていなかった。
      sire: row.sire,
      isHeadline: row.isHeadline,
      headlineMark: row.headlineMark,
      headlineKind: row.headlineKind,
      // 公開事実由来の条件変化。無ければ null（データ不足を「該当なし」と偽らない）
      changes: f && f.hasHistory ? {
        distanceChanged: f.distanceChanged,
        firstCourse: f.firstCourse,
        jockeyChanged: f.jockeyChanged,
        easyCompare: f.easyCompare,
      } : null,
      prev: prev
        ? { venue: prev.venue, distance: prev.distance, jockey: prev.jockey, finish: prev.finish, bodyWeight: prev.bodyWeight }
        : null,
      // 無料会員登録で開く拡張表示（出走間隔 / 馬体重の増減 / 条件変化の履歴）。
      // 公開事実だけで作っており、ゲートが破られても有料情報は漏れない。
      extras: buildHorseExtras({ past: pastByNumber.get(row.number) || [] }, today),
    };
  });
}

// ── 南関 ──────────────────────────────────────────────────────

function latestNankanFiles(root) {
  const dir = join(root, 'src', 'data', 'predictions');
  if (!existsSync(dir)) return { date: null, files: [] };
  const entries = readdirSync(dir)
    .filter((n) => /^\d{4}-\d{2}-\d{2}.*\.json$/.test(n))
    .map((n) => ({ name: n, date: n.slice(0, 10) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (entries.length === 0) return { date: null, files: [] };
  const date = entries[0].date;
  return { date, files: entries.filter((e) => e.date === date).map((e) => join(dir, e.name)) };
}

function buildNankanVenue(root, date, file) {
  const data = readJson(file);
  const venue = data?.eventInfo?.venue;
  const code = NANKAN_VENUE_CODE[venue];
  if (!venue || !code || !Array.isArray(data?.predictions)) return null;

  const races = [];
  for (const r of data.predictions) {
    const ri = r?.raceInfo || {};
    const raceNumber = Number(ri.raceNumber);
    if (!Number.isFinite(raceNumber)) continue;
    const entries = Array.isArray(r?.horses) ? r.horses : [];
    const statsFile = join(root, 'src', 'data', 'horseStats', 'nankan',
      date.slice(0, 4), date.slice(5, 7), `${date}-${code}-R${String(raceNumber).padStart(2, '0')}.json`);
    const stats = readJson(statsFile);
    const byNumber = new Map(
      (stats?.horses || []).map((x) => [x.horseNumber, x.horseStatsNankan || {}]),
    );

    const horses = [];
    const prevByNumber = new Map();
    const pastByNumber = new Map();
    for (const h of entries) {
      const st = byNumber.get(h?.horseNumber);
      if (!st) continue;
      const past = (st.recentRacesDetailed || []).slice(0, RECENT_RACES_WINDOW).map((e) => ({
        venue: e?.venue, distance: parseDistanceMeters(e?.distance), jockey: e?.jockey,
        // 会員向け拡張の材料（公開事実のみ）
        date: e?.date ?? null, bodyWeight: e?.bodyWeight ?? null, finish: e?.finish ?? null,
      }));
      if (past[0]) prevByNumber.set(h.horseNumber, past[0]);
      pastByNumber.set(h.horseNumber, past);
      horses.push({ ref: h.horseNumber, past, todayJockey: st.profile?.jockey });
    }

    const distanceMeters = parseDistanceMeters(ri.distance, ri.raceName);
    const result = evaluateRace({
      category: 'nankan', venue, distanceMeters, entryCount: entries.length, horses,
    }, sameJockey);
    const todayCtx = { date, venue, distanceMeters };
    const horseRows = buildHorseRows(entries, result.horseFlags, prevByNumber, pastByNumber, todayCtx);

    races.push({
      raceNumber,
      startTime: ri.startTime || null,
      raceName: cleanRaceName(ri.raceName),
      distanceMeters,
      entryCount: entries.length,
      result,
      horseRows,
      sameCondition: buildSameConditionTable(horseRows, todayCtx),
    });
  }
  races.sort((a, b) => a.raceNumber - b.raceNumber);
  return { venue, races, highlights: dailyHighlights(races) };
}

// ── JRA ───────────────────────────────────────────────────────

function latestJraFile(root) {
  const base = join(root, 'src', 'data', 'predictions', 'jra');
  if (!existsSync(base)) return null;
  const years = readdirSync(base).filter((n) => /^\d{4}$/.test(n)).sort().reverse();
  for (const y of years) {
    const months = readdirSync(join(base, y)).filter((n) => /^\d{2}$/.test(n)).sort().reverse();
    for (const m of months) {
      const files = readdirSync(join(base, y, m)).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().reverse();
      if (files.length > 0) return join(base, y, m, files[0]);
    }
  }
  return null;
}

function buildJraVenue(root, date, venueData) {
  const venue = venueData?.venue;
  const code = JRA_VENUE_CODE[venue];
  if (!venue || !code) return null;
  const histories = readJson(join(root, 'src', 'data', 'horseHistories', 'jra',
    date.slice(0, 4), date.slice(5, 7), `${date}-${code}.json`));
  const index = histories ? buildJoinIndex(histories) : null;

  const races = [];
  for (const r of venueData.predictions || []) {
    const ri = r?.raceInfo || {};
    const raceNumber = Number(String(ri.raceNumber ?? '').replace('R', ''));
    if (!Number.isFinite(raceNumber)) continue;
    const entries = Array.isArray(r?.horses) ? r.horses : [];
    const joined = index ? joinRaceHorses(entries, index) : entries.map(() => ({ matched: false }));

    const horses = [];
    const prevByNumber = new Map();
    const pastByNumber = new Map();
    entries.forEach((h, i) => {
      if (!joined[i]?.matched) return;
      const r5 = joined[i].entry?.recent5 || [];
      const past = r5.slice(0, RECENT_RACES_WINDOW).map((e) => ({
        venue: e?.venue,
        distance: parseDistanceMeters(e?.distanceMeters, e?.displayDistance),
        jockey: e?.jockey,
        // 会員向け拡張の材料（公開事実のみ）
        date: e?.date ?? null, bodyWeight: e?.bodyWeight ?? null, finish: e?.finish ?? null,
      }));
      if (past[0]) prevByNumber.set(h?.horseNumber, past[0]);
      pastByNumber.set(h?.horseNumber, past);
      horses.push({ ref: h?.horseNumber, past, todayJockey: h?.jockey });
    });

    const distanceMeters = parseDistanceMeters(ri.distance, ri.raceName);
    const result = evaluateRace({ category: 'jra', venue, distanceMeters, entryCount: entries.length, horses }, sameJockey);
    const todayCtx = { date, venue, distanceMeters };
    const horseRows = buildHorseRows(entries, result.horseFlags, prevByNumber, pastByNumber, todayCtx);
    races.push({
      raceNumber,
      startTime: ri.startTime || null,
      raceName: cleanRaceName(ri.raceName),
      distanceMeters,
      entryCount: entries.length,
      result,
      horseRows,
      sameCondition: buildSameConditionTable(horseRows, todayCtx),
    });
  }
  races.sort((a, b) => a.raceNumber - b.raceNumber);
  return { venue, races, highlights: dailyHighlights(races) };
}

/**
 * カテゴリの最新開催日ぶんの「見どころ」ビューを組み立てる。
 * データが無ければ `null`（ページ側で案内を出す）。
 *
 * @param {'jra'|'nankan'} category
 * @param {string} [projectRoot]
 * @returns {{category: string, date: string, venues: Array}|null}
 */
export function buildViewpoints(category, projectRoot = process.cwd()) {
  if (category === 'nankan') {
    const { date, files } = latestNankanFiles(projectRoot);
    if (!date) return null;
    const venues = files.map((f) => buildNankanVenue(projectRoot, date, f)).filter(Boolean);
    return venues.length > 0 ? { category, date, venues } : null;
  }
  const file = latestJraFile(projectRoot);
  const data = readJson(file);
  if (!data?.date || !Array.isArray(data.venues)) return null;
  const venues = data.venues.map((v) => buildJraVenue(projectRoot, data.date, v)).filter(Boolean);
  return venues.length > 0 ? { category, date: data.date, venues } : null;
}

export default { buildViewpoints, sameJockey, parseDistanceMeters, cleanRaceName };
