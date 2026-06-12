/**
 * 南関 entries(出馬表) full venue JSON を読み、指定 horse の recentRaces を
 * 表示用 shape に正規化して返す loader（PR-F5c）
 *
 * 設計: keiba-data-shared-admin docs/nankan-horse-detail-display-plan.md §32。
 *   既存 loadRecentHorseHistoriesNankan.js（fs multi-candidate path 方式）を踏襲する。
 *
 * 厳守:
 *   - **fs / existsSync / readFileSync による multi-candidate path**。`import.meta.glob` は使わない
 *     （entries を bundle しない・未参照なら build に影響しない）。
 *   - **付与・mutation はしない**。読み取って mapper 適用済み recentRaces を返すだけ。
 *   - **record は触らない・返さない**（mapper が record を除外）。
 *   - **full venue のみ採用**（R01-only / partial / totalRaces<=1 は skip）。
 *   - featureScores / AI指数 / 印 / 買い目 / 穴馬 に接続しない。
 *
 * 付与・注入・getDisplay 優先順位変更・page 接続は本ファイルでは行わない（F5e の責務）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapEntriesRecentRacesNankan } from './mapEntriesRecentRacesNankan.js';

const __filename = fileURLToPath(import.meta.url);
const __moduleDir = dirname(__filename);

const REL = ['src', 'data', 'entries', 'nankan'];

/**
 * 本番(Netlify)・prerender・ローカルで位置が変わるため複数候補を試す
 * （loadRecentHorseHistoriesNankan.js と同思想）。
 */
function candidatePaths(date, venue) {
  const [year, month] = String(date).split('-');
  const tail = [...REL, year, month, `${date}-${venue}.json`];
  const cands = [
    join(process.cwd(), ...tail),
    join(__moduleDir, '..', 'data', 'entries', 'nankan', year, month, `${date}-${venue}.json`),
    join(__moduleDir, '..', '..', ...tail),
    join('/var/task', ...tail),
  ];
  return [...new Set(cands)];
}

function fail(fallbackReason, warnings) {
  return {
    ok: false,
    source: 'entries-nankan',
    recentRaces: [],
    fallbackReason,
    matchedBy: null,
    warnings: warnings || [],
  };
}

/**
 * @param {string} date       YYYY-MM-DD
 * @param {string} venueCode  3文字場コード（OOI/KAW/FUN/URA）
 * @param {object} target     { raceNumber, horseNumber?, horseName? }
 * @param {object} [opts]     { projectRoot? }  テスト用に明示パスを足す
 * @returns {{ok:boolean, source:string, recentRaces:Array, matchedBy?:string, fallbackReason?:string, warnings:string[]}}
 */
export function loadEntriesNankan(date, venueCode, target = {}, opts = {}) {
  const warnings = [];

  if (!date || !venueCode) return fail('invalid-date-or-venue', ['date/venueCode 未指定']);
  const { raceNumber, horseNumber, horseName } = target;

  // --- ファイル探索 ---
  const cands = candidatePaths(date, venueCode);
  if (opts.projectRoot) {
    const [year, month] = String(date).split('-');
    cands.unshift(join(opts.projectRoot, ...REL, year, month, `${date}-${venueCode}.json`));
  }
  const file = cands.find((p) => existsSync(p));
  if (!file) return fail('entries-file-not-found', [`no file in ${cands.length} candidates`]);

  // --- 読み込み & parse ---
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    return fail('invalid-json', [`JSON.parse failed: ${e.message}`]);
  }

  // --- top-level 構造 / full venue guard（§32.4）---
  if (!json || typeof json !== 'object') return fail('invalid-category', ['not an object']);
  if (json.category !== 'nankan') return fail('invalid-category', [`unexpected category: ${json.category}`]);
  if (!Array.isArray(json.races)) return fail('invalid-races', ['races not an array']);

  const totalRaces = json.totalRaces;
  const racesLen = json.races.length;
  if (totalRaces !== racesLen) return fail('non-full-venue', [`totalRaces(${totalRaces}) != races.length(${racesLen})`]);
  if (!(totalRaces > 1)) return fail('non-full-venue', [`totalRaces=${totalRaces}（R01-only/partial は表示に使わない）`]);
  if (!(racesLen > 1)) return fail('non-full-venue', [`races.length=${racesLen}（複数レースのみ）`]);

  const smRaces = json.sourceMeta && json.sourceMeta.races;
  if (Array.isArray(smRaces) && smRaces.length !== racesLen) {
    return fail('source-meta-race-count-mismatch', [`sourceMeta.races.length(${smRaces.length}) != races.length(${racesLen})`]);
  }

  if (json.date && json.date !== date) warnings.push(`file date ${json.date} != requested ${date}`);
  if (json.venueCode && json.venueCode !== venueCode) warnings.push(`file venueCode ${json.venueCode} != requested ${venueCode}`);

  // --- race 探索（raceNumber 主キー）---
  if (raceNumber == null) return fail('race-not-found', ['raceNumber 未指定']);
  const race = json.races.find((r) => Number(r.raceNumber) === Number(raceNumber));
  if (!race) return fail('race-not-found', [`raceNumber=${raceNumber} not in ${racesLen} races`]);
  if (!Array.isArray(race.horses)) return fail('horses-not-array', [`race ${raceNumber} horses not an array`]);

  // --- horse 探索（horseNumber 主・horseName 補助）---
  if (horseNumber == null) return fail('horse-not-found', ['horseNumber 未指定']);
  const wantNum = Number(horseNumber);
  const wantName = horseName != null ? String(horseName).trim() : null;
  const horse = race.horses.find((h) => Number(h.number) === wantNum);
  if (!horse) return fail('horse-not-found', [`horseNumber=${horseNumber} not in race ${raceNumber}`]);

  let matchedBy = 'horseNumber';
  if (wantName) {
    const got = String(horse.name || '').trim();
    if (got === wantName) matchedBy = 'horseNumber+horseName';
    else warnings.push(`horseName mismatch: want=${wantName} got=${got}（horseNumber 一致のため採用）`);
  }

  if (!Array.isArray(horse.recentRaces)) return fail('recent-races-not-array', [`horse ${horseNumber} recentRaces not an array`]);

  // --- mapper 適用（record は mapper が除外）---
  const recentRaces = mapEntriesRecentRacesNankan(horse.recentRaces, { race, horse });

  return { ok: true, source: 'entries-nankan', recentRaces, matchedBy, warnings };
}

export default loadEntriesNankan;
