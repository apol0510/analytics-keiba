/**
 * dayResultsView.js — 開催日 1 日ぶんの「結果」ビュー（中央・南関 共通の単一源）
 *
 * 日付別恒久ページ（`/free-prediction/{jra,nankan}/YYYY-MM-DD/`）に出す結果を組み立てる。
 * 公開範囲は `/results-showcase/` と同じ（`buildShowcaseDay()` を再利用）:
 *   - 各レースの着順 1〜3 着・的中 ✅✗
 *   - メインレースの買い目（本命→相手・抑えは伏せる）と結果・的中時の払戻
 * メイン以外の買い目・払戻・抑えは出さない。
 *
 * 2026-09-28: 南関だけに結果を付けて中央に付けていなかった非対称を解消するため、
 * 南関専用だった組み立てをここへ切り出した（中央・南関で同じ関数を使う）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildShowcaseDay } from './resultsShowcase.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** カテゴリ → 結果アーカイブのファイル名 */
export const RESULTS_ARCHIVE_FILE = Object.freeze({
  nankan: 'archiveResults.json',
  jra: 'archiveResultsJra.json',
});

/** 結果アーカイブ（日付 → エントリ）。読めなければ空 */
export function loadResultsByDate(category, root = process.cwd()) {
  const file = RESULTS_ARCHIVE_FILE[category];
  const out = new Map();
  if (!file) return out;
  const path = join(root, 'src', 'data', file);
  if (!existsSync(path)) return out;
  let arr = null;
  try { arr = JSON.parse(readFileSync(path, 'utf-8')); } catch { arr = null; }
  for (const e of Array.isArray(arr) ? arr : []) {
    if (e && DATE_RE.test(String(e.date)) && Array.isArray(e.races) && !out.has(e.date)) out.set(e.date, e);
  }
  return out;
}

/** アーカイブの result（first/second/third）→ 1〜3 着の配列。無ければ null */
export function topThree(result) {
  if (!result) return null;
  const pick = (x) => (x && x.number != null ? { number: Number(x.number), name: String(x.name || '') } : null);
  const rows = [pick(result.first), pick(result.second), pick(result.third)];
  return rows.some(Boolean) ? rows : null;
}

/**
 * 1 日ぶんの結果ビュー。エントリが無ければ null。
 * @returns {null|{hitRaces:number, totalRaces:number, venues:Array<{venue, hitRaces, totalRaces, mainRace, races}>}}
 */
export function buildDayResultsView(entry) {
  const showcase = entry ? buildShowcaseDay(entry) : null;
  if (!showcase) return null;
  const raceByKey = new Map((entry.races || []).map((r) => [`${r.venue}|${Number(r.raceNumber)}`, r]));
  const venues = showcase.venueGroups.map((g) => ({
    venue: g.venue,
    totalRaces: g.races.length,
    hitRaces: g.races.filter((r) => r.isHit).length,
    mainRace: g.mainRace || null,
    races: g.races.map((r) => {
      const rec = raceByKey.get(`${g.venue}|${Number(r.raceNumber)}`) || null;
      return {
        raceNumber: Number(r.raceNumber),
        raceName: String(rec?.raceName || ''),
        top3: topThree(rec?.result),
        isHit: !!r.isHit,
        isMain: !!r.isMain,
      };
    }),
  }));
  return {
    venues,
    totalRaces: venues.reduce((s, v) => s + v.totalRaces, 0),
    hitRaces: venues.reduce((s, v) => s + v.hitRaces, 0),
  };
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

/** 曜日（日本語 1 文字）。2026-09-28 → 月 */
export function weekdayJa(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return '日月火水木金土'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
