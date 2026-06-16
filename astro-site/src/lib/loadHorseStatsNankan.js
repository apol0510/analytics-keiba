/**
 * 南関 horseStats（uma_info 元表統計・raceNo別）を読み、指定 horse の
 * `horseStatsNankan` オブジェクトを返す loader。
 *
 * 設計: keiba-data-shared-admin docs/nankan-uma-info-horse-stats-schema.md。
 *   既存 loadEntriesNankan.js（fs multi-candidate path 方式）を踏襲。
 *
 * 厳守:
 *   - fs / existsSync / readFileSync の multi-candidate path（import.meta.glob は使わない）。
 *   - 読み取って horseStatsNankan を返すだけ（mutation しない）。
 *   - 例外でページ全体を落とさない（fail を返す）。
 *   - featureScores / AI指数 / 印 / 買い目 / EV / recentRaces に接続しない。
 *
 * shared 正本: src/data/horseStats/nankan/YYYY/MM/YYYY-MM-DD-VENUE-RNN.json（1レース1ファイル）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __moduleDir = dirname(fileURLToPath(import.meta.url));
const REL = ['src', 'data', 'horseStats', 'nankan'];
const rnnOf = (n) => `R${String(n).padStart(2, '0')}`;

function candidatePaths(date, venue, raceNo) {
  const [year, month] = String(date).split('-');
  const file = `${date}-${venue}-${rnnOf(raceNo)}.json`;
  const tail = [...REL, year, month, file];
  return [...new Set([
    join(process.cwd(), ...tail),
    join(__moduleDir, '..', 'data', 'horseStats', 'nankan', year, month, file),
    join(__moduleDir, '..', '..', ...tail),
    join('/var/task', ...tail),
  ])];
}

function fail(fallbackReason, warnings) {
  return { ok: false, source: 'horseStats-nankan', horseStats: null, fallbackReason, matchedBy: null, warnings: warnings || [] };
}

/**
 * @param {object} target  { date, venue(=venueCode), raceNo, horseNumber?, horseName? }
 * @param {object} [opts]  { projectRoot? }
 * @returns {{ok:boolean, source:string, horseStats:object|null, matchedBy?:string, fallbackReason?:string, warnings:string[]}}
 */
export function loadHorseStatsNankan(target = {}, opts = {}) {
  const warnings = [];
  const { date, venue, raceNo, horseNumber, horseName } = target;
  if (!date || !venue || raceNo == null) return fail('invalid-args', ['date/venue/raceNo 未指定']);

  const cands = candidatePaths(date, venue, raceNo);
  if (opts.projectRoot) {
    const [year, month] = String(date).split('-');
    cands.unshift(join(opts.projectRoot, ...REL, year, month, `${date}-${venue}-${rnnOf(raceNo)}.json`));
  }
  const file = cands.find((p) => existsSync(p));
  if (!file) return fail('file-not-found', [`no file in ${cands.length} candidates`]);

  let json;
  try { json = JSON.parse(readFileSync(file, 'utf-8')); }
  catch (e) { return fail('invalid-json', [`JSON.parse failed: ${e.message}`]); }

  if (!json || typeof json !== 'object') return fail('invalid-object', ['not an object']);
  if (json.dataType !== 'horseStats') return fail('invalid-dataType', [`dataType=${json.dataType}`]);
  if (json.raceNo != null && Number(json.raceNo) !== Number(raceNo)) return fail('raceNo-mismatch', [`file raceNo ${json.raceNo} != ${raceNo}`]);
  if (json.date && json.date !== date) warnings.push(`file date ${json.date} != requested ${date}`);
  if (json.venueCode && json.venueCode !== venue) warnings.push(`file venueCode ${json.venueCode} != requested ${venue}`);
  if (!Array.isArray(json.horses)) return fail('horses-not-array', ['horses not an array']);

  if (horseNumber == null) return fail('horse-not-found', ['horseNumber 未指定']);
  const wantNum = Number(horseNumber);
  const wantName = horseName != null ? String(horseName).trim() : null;
  const horse = json.horses.find((h) => Number(h.horseNumber) === wantNum);
  if (!horse) return fail('horse-not-found', [`horseNumber=${horseNumber} not in R${raceNo}`]);

  let matchedBy = 'horseNumber';
  if (wantName) {
    const got = String(horse.horseName || '').trim();
    if (got === wantName) matchedBy = 'horseNumber+horseName';
    else warnings.push(`horseName mismatch: want=${wantName} got=${got}（horseNumber 一致のため採用）`);
  }

  if (!horse.horseStatsNankan || typeof horse.horseStatsNankan !== 'object') {
    return fail('horseStatsNankan-missing', [`horseNumber=${horseNumber} に horseStatsNankan なし`]);
  }
  return { ok: true, source: 'horseStats-nankan', horseStats: horse.horseStatsNankan, matchedBy, warnings };
}

export default loadHorseStatsNankan;
