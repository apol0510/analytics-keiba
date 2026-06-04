/**
 * loadRecentHorseHistoriesNankan.js
 *
 * 南関 recentHorseHistories（keiba-data-shared 由来・本リポジトリに同梱）を
 * 読み取り、指定レース・指定馬の recentRaces を「表示候補データ」として返す helper。
 *
 * ※ Phase 6 第2段階: 読み取り単体のみ。本 helper は以下を一切行わない。
 *    - horse.recentRaces の上書き
 *    - recentRacesFromHistoriesNankan への注入（注入は次段の呼び出し側責務）
 *    - Feature Importance / featureScores / generateAdvancedMetrics への接続
 *    - 表示スコア・中間判定の生成
 *
 * データ位置: src/data/recentHorseHistories/nankan/YYYY/MM/YYYY-MM-DD-VENUE.json
 *   top-level: schemaVersion / category / date / venue / venueName / source / races
 *   races[]:   raceNumber / raceName / horses[]
 *   horses[]:  horseNumber / horseName / recentRaces[]
 *
 * 戻り値（docs §10.13）:
 *   成功:  { ok:true,  source:'shared-recentHorseHistories',
 *            recentRaces:[...], fallbackReason:null,
 *            matchedBy:'both'|'horseNumber'|'horseName', warnings:[] }
 *   失敗:  { ok:false, source:'existing-recentRaces',
 *            recentRaces:[], fallbackReason:'file-not-found'|'parse-error'
 *              |'invalid-structure'|'race-not-found'|'horse-not-found',
 *            matchedBy:null, warnings:[...] }
 *
 * fallback 時に既存 horse.recentRaces を返さない（呼び出し側が判断する）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __moduleDir = dirname(__filename);

const REL = ['src', 'data', 'recentHorseHistories', 'nankan'];

/**
 * 本番(Netlify SSR)・prerender・ローカルで位置が変わるため複数候補を試す。
 * JRA helper(KI) の multi-candidate path 思想を踏襲。
 */
function candidatePaths(date, venue) {
  const [year, month] = String(date).split('-');
  const tail = [...REL, year, month, `${date}-${venue}.json`];
  const cands = [
    join(process.cwd(), ...tail),
    // bundle 相対（このモジュールから見た src/data/...）
    join(__moduleDir, '..', 'data', 'recentHorseHistories', 'nankan', year, month, `${date}-${venue}.json`),
    join(__moduleDir, '..', '..', ...tail),
    // Netlify Lambda
    join('/var/task', ...tail),
  ];
  // 重複除去
  return [...new Set(cands)];
}

function fail(fallbackReason, warnings) {
  return {
    ok: false,
    source: 'existing-recentRaces',
    recentRaces: [],
    fallbackReason,
    matchedBy: null,
    warnings: warnings || [],
  };
}

/**
 * @param {string} date   YYYY-MM-DD
 * @param {string} venue  3文字場コード（OOI/KAW/FUN/URA）
 * @param {object} target { raceNumber, horseNumber?, horseName? }
 * @param {object} [opts] { projectRoot? }  テスト用に明示パスを足す
 * @returns 上記の戻り値オブジェクト
 */
export function loadRecentHorseHistoriesNankan(date, venue, target = {}, opts = {}) {
  const warnings = [];

  if (!date || !venue) return fail('invalid-structure', ['date/venue 未指定']);
  const { raceNumber, horseNumber, horseName } = target;

  // --- ファイル探索 ---
  const cands = candidatePaths(date, venue);
  if (opts.projectRoot) {
    const [year, month] = String(date).split('-');
    cands.unshift(join(opts.projectRoot, ...REL, year, month, `${date}-${venue}.json`));
  }
  const file = cands.find((p) => existsSync(p));
  if (!file) return fail('file-not-found', [`no file in ${cands.length} candidates`]);

  // --- 読み込み & parse ---
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (e) {
    return fail('parse-error', [`JSON.parse failed: ${e.message}`]);
  }

  // --- top-level 構造検証 ---
  if (!json || typeof json !== 'object') return fail('invalid-structure', ['not an object']);
  if (typeof json.schemaVersion !== 'string' || !json.schemaVersion.startsWith('nankan-recent-horse-histories')) {
    return fail('invalid-structure', [`unexpected schemaVersion: ${json.schemaVersion}`]);
  }
  if (json.category !== 'nankan') return fail('invalid-structure', [`unexpected category: ${json.category}`]);
  if (!json.date) return fail('invalid-structure', ['date missing']);
  if (!json.venue) return fail('invalid-structure', ['venue missing']);
  if (!Array.isArray(json.races)) return fail('invalid-structure', ['races not an array']);

  if (json.date !== date) warnings.push(`file date ${json.date} != requested ${date}`);
  if (json.venue !== venue) warnings.push(`file venue ${json.venue} != requested ${venue}`);

  // --- race 探索 ---
  if (raceNumber == null) return fail('invalid-structure', ['raceNumber 未指定']);
  const race = json.races.find((r) => Number(r.raceNumber) === Number(raceNumber));
  if (!race) return fail('race-not-found', [`raceNumber=${raceNumber} not in ${json.races.length} races`]);
  if (!Array.isArray(race.horses)) return fail('invalid-structure', [`race ${raceNumber} horses not an array`]);

  // --- horse 探索（horseNumber 主・horseName 確認） ---
  const wantNum = horseNumber != null ? Number(horseNumber) : null;
  const wantName = horseName != null ? String(horseName) : null;

  let matched = null;
  let matchedBy = null;

  if (wantNum != null) {
    const byNum = race.horses.find((h) => Number(h.horseNumber) === wantNum);
    if (byNum) {
      if (wantName != null && String(byNum.horseName) === wantName) {
        matched = byNum; matchedBy = 'both';
      } else if (wantName != null && String(byNum.horseName) !== wantName) {
        // 番号一致だが名前不一致 → 番号一致として採用しつつ警告
        matched = byNum; matchedBy = 'horseNumber';
        warnings.push(`horseNumber matched but name differs (file=${byNum.horseName}, want=${wantName})`);
      } else {
        matched = byNum; matchedBy = 'horseNumber';
      }
    }
  }

  if (!matched && wantName != null) {
    const byName = race.horses.find((h) => String(h.horseName) === wantName);
    if (byName) { matched = byName; matchedBy = 'horseName'; }
  }

  if (!matched) {
    return fail('horse-not-found', [`horse num=${wantNum} name=${wantName} not in race ${raceNumber}`]);
  }

  const recentRaces = Array.isArray(matched.recentRaces) ? matched.recentRaces : [];
  if (recentRaces.length === 0) warnings.push('matched horse has empty recentRaces');

  return {
    ok: true,
    source: 'shared-recentHorseHistories',
    recentRaces,
    fallbackReason: null,
    matchedBy,
    warnings,
  };
}

export default loadRecentHorseHistoriesNankan;
