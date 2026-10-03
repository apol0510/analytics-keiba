/**
 * raceSource.js — 予想データ（src/data/predictions）を日付・会場・レースで読む（サーバー専用）
 *
 * 読むのは SSR 関数に残るファイルだけ（runtimeDataRetention.js: 南関 root は全件・JRA は直近 KEEP_DATES 日）。
 * 取得後の再閲覧はスナップショットから描画するので、ここで読めなくなった日付でも本文は消えない。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { venueIdOf, NANKAN_VENUES } from './predictionKey.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const baseDir = (root) => join(root || process.cwd(), 'src', 'data', 'predictions');

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** 予想がある日付（新しい順） */
export function listDates(cat, { root, limit = 7 } = {}) {
  const dir = baseDir(root);
  const dates = new Set();
  if (cat === 'nankan') {
    if (!existsSync(dir)) return [];
    for (const f of readdirSync(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})-([a-z]+)\.json$/.exec(f);
      if (m && Object.values(NANKAN_VENUES).includes(m[2])) dates.add(m[1]);
    }
  } else if (cat === 'jra') {
    const jra = join(dir, 'jra');
    if (!existsSync(jra)) return [];
    for (const y of readdirSync(jra).filter((n) => /^\d{4}$/.test(n))) {
      for (const mo of readdirSync(join(jra, y)).filter((n) => /^\d{2}$/.test(n))) {
        for (const f of readdirSync(join(jra, y, mo))) {
          const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
          if (m) dates.add(m[1]);
        }
      }
    }
  }
  return [...dates].sort().reverse().slice(0, limit);
}

/**
 * @returns {Array<{ venueName, venueId, totalRaces, races: Array<{raceInfo, horses, bettingLines}> }>}
 */
export function loadDay(cat, date, { root } = {}) {
  if (!DATE_RE.test(String(date))) return [];
  const dir = baseDir(root);
  const out = [];
  if (cat === 'nankan') {
    for (const [venueName, slug] of Object.entries(NANKAN_VENUES)) {
      const d = readJson(join(dir, `${date}-${slug}.json`));
      if (!d || !Array.isArray(d.predictions) || d.eventInfo?.date !== date) continue;
      out.push({
        venueName, venueId: slug,
        totalRaces: Number(d.eventInfo?.totalRaces) || d.predictions.length,
        races: d.predictions.filter((r) => Number(r?.raceInfo?.raceNumber) > 0),
      });
    }
  } else if (cat === 'jra') {
    const d = readJson(join(dir, 'jra', date.slice(0, 4), date.slice(5, 7), `${date}.json`));
    if (d && d.date === date && Array.isArray(d.venues)) {
      for (const v of d.venues) {
        const venueId = venueIdOf('jra', v.venue);
        if (!venueId || !Array.isArray(v.predictions)) continue;
        out.push({
          venueName: String(v.venue).replace('競馬場', ''), venueId,
          totalRaces: Number(v.eventInfo?.totalRaces) || v.predictions.length,
          races: v.predictions.filter((r) => Number(r?.raceInfo?.raceNumber) > 0),
        });
      }
    }
  }
  for (const v of out) v.races.sort((a, b) => a.raceInfo.raceNumber - b.raceInfo.raceNumber);
  return out;
}

/** 1 レースを探す（キーの venue / raceNumber で） */
export function findRace(cat, date, venueId, raceNumber, opts) {
  const v = loadDay(cat, date, opts).find((x) => x.venueId === venueId);
  if (!v) return null;
  const race = v.races.find((r) => Number(r.raceInfo.raceNumber) === Number(raceNumber));
  return race ? { venue: v, race } : null;
}
