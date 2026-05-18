#!/usr/bin/env node
/**
 * 【著作権・表示安全対策】表示用コンピ指数 = raw - 1 ルールの検証スクリプト。
 *
 * 目的:
 *   元指数（racebook 由来 computerIndex / sourceComputerIndex）を画面に
 *   そのまま表示すると著作権上 NG。analytics-keiba では必ず raw - 1 を表示する。
 *   その不変条件を「全レース・全馬」レベルで検証する。
 *
 * 使い方:
 *   node scripts/check-display-computer-index.mjs                       # 全 predictions/*.json
 *   node scripts/check-display-computer-index.mjs 2026-05-19            # 日付指定
 *   node scripts/check-display-computer-index.mjs 2026-05-19 ooi        # 日付 + 会場
 *   node scripts/check-display-computer-index.mjs 2026-05-19 ooi 10     # + Race
 *
 * 失敗条件:
 *   - getDisplayComputerIndex(raw) !== raw - 1（数値変換不能を除く）
 *   - raw == display（-1 が適用されていない）
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { getDisplayComputerIndex } from '../src/lib/shared-prediction-logic.js';
import { adaptNewToLegacy } from '../src/lib/adaptLatestPrediction.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PRED_DIR_NANKAN = join(REPO_ROOT, 'src/data/predictions');
const PRED_DIR_JRA = join(REPO_ROOT, 'src/data/predictions/jra');

function listNankanFiles(dateFilter, venueFilter) {
  const files = [];
  for (const name of readdirSync(PRED_DIR_NANKAN)) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})-([a-z0-9]+)\.json$/i);
    if (!m) continue;
    if (dateFilter && m[1] !== dateFilter) continue;
    if (venueFilter && m[2].toLowerCase() !== venueFilter.toLowerCase()) continue;
    files.push({ path: join(PRED_DIR_NANKAN, name), date: m[1], venueSlug: m[2] });
  }
  files.sort((a, b) => (a.date < b.date ? 1 : -1));
  return files;
}

function listJraFiles(dateFilter) {
  const files = [];
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) {
        const date = name.replace('.json', '');
        if (dateFilter && date !== dateFilter) continue;
        files.push({ path: full, date });
      }
    }
  }
  walk(PRED_DIR_JRA);
  files.sort((a, b) => (a.date < b.date ? 1 : -1));
  return files;
}

/**
 * 1 馬の raw / display を比較する。
 * raw が null / 数値化不能なら検証スキップ（OK）。
 */
function checkHorse(rawIndex) {
  const n = Number(rawIndex);
  if (!Number.isFinite(n)) return { skipped: true, raw: null, display: null, ok: true };
  const expected = Math.max(0, n - 1);
  const actual = getDisplayComputerIndex(rawIndex);
  // raw == display は NG（-1 されていない）。
  // ただし raw=0 のときは expected=0 で raw==display も OK（下限保護）。
  const noDecrement = (actual === n) && (n > 0);
  const ok = (actual === expected) && !noDecrement;
  return { skipped: false, raw: n, display: actual, expected, ok };
}

function pad(s, n) { return String(s).padEnd(n, ' '); }

function header() {
  console.log(
    pad('日付', 11),
    pad('会場', 8),
    pad('R', 4),
    pad('馬番', 4),
    pad('馬名', 18),
    pad('raw', 5),
    pad('disp', 5),
    pad('期待', 5),
    '判定',
  );
}

function runRace(date, venue, raceNumber, horses, raceFilter) {
  if (raceFilter && String(raceNumber) !== String(raceFilter)) return { rows: 0, failures: 0 };
  let rows = 0;
  let failures = 0;
  for (const h of horses) {
    const raw = h.computerIndex ?? h.sourceComputerIndex ?? null;
    const r = checkHorse(raw);
    if (r.skipped) continue;
    rows++;
    const ok = r.ok;
    if (!ok) failures++;
    console.log(
      pad(date, 11),
      pad(venue, 8),
      pad(raceNumber + 'R', 4),
      pad(h.number ?? h.horseNumber ?? '?', 4),
      pad((h.name ?? h.horseName ?? '').slice(0, 18), 18),
      pad(r.raw, 5),
      pad(r.display, 5),
      pad(r.expected, 5),
      ok ? 'OK' : 'NG',
    );
  }
  return { rows, failures };
}

function summarize(label, files, isJra, raceFilter) {
  console.log(`\n=== ${label} (${files.length} file) ===`);
  if (files.length === 0) {
    console.log('  対象ファイルなし');
    return { ok: true, rows: 0, failures: 0 };
  }
  header();
  let rows = 0;
  let failures = 0;
  for (const f of files) {
    const raw = JSON.parse(readFileSync(f.path, 'utf-8'));
    if (isJra) {
      const venues = Array.isArray(raw.venues) ? raw.venues : [];
      for (const v of venues) {
        const adapted = adaptNewToLegacy(v);
        for (const r of adapted.races) {
          // allHorses は convertHorse 経由で number/name と computerIndex/sourceComputerIndex を保つ
          const result = runRace(f.date, v.venue || adapted.track, r.raceNumber.replace('R',''), r.allHorses || [], raceFilter);
          rows += result.rows;
          failures += result.failures;
        }
      }
    } else {
      const adapted = adaptNewToLegacy(raw);
      for (const r of adapted.races) {
        const result = runRace(f.date, adapted.track || f.venueSlug, r.raceNumber.replace('R',''), r.allHorses || [], raceFilter);
        rows += result.rows;
        failures += result.failures;
      }
    }
  }
  return { ok: failures === 0, rows, failures };
}

function main() {
  const args = process.argv.slice(2);
  const dateFilter = args[0] || null;
  const venueFilter = args[1] || null;
  const raceFilter = args[2] || null;

  const nankanFiles = listNankanFiles(dateFilter, venueFilter);
  const jraFiles = (!venueFilter || ['jra', 'all'].includes(venueFilter.toLowerCase()))
    ? listJraFiles(dateFilter)
    : [];

  const nk = summarize('NANKAN', nankanFiles, false, raceFilter);
  const jr = summarize('JRA', jraFiles, true, raceFilter);

  console.log('\n--- まとめ ---');
  console.log(`NANKAN: ${nk.rows} 馬 / 失敗 ${nk.failures}`);
  console.log(`JRA   : ${jr.rows} 馬 / 失敗 ${jr.failures}`);

  if (nk.failures > 0 || jr.failures > 0) {
    console.error('\n❌ raw == display または -1 が適用されていない馬があります。');
    process.exit(1);
  }
  console.log('\n✅ すべての馬で 表示指数 == raw − 1（著作権・表示安全ルール OK）');
}

main();
