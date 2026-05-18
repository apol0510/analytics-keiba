#!/usr/bin/env node
/**
 * 全レースプレビュー（free-prediction/nankan・jra）で全頭が必ず
 * 本命 / 対抗 / 単穴 / 連下 / 抑え / 不要馬 のいずれかに分類されることを検証する。
 *
 * 目的:
 *   - 「不要馬」セクションが消える事故（無/補欠 ロールが表示から落ちる）の再発防止
 *   - role 未付与データでも分類補完が落ちないことの確認
 *
 * 使い方:
 *   node scripts/check-free-prediction-horse-sections.mjs              # 全 predictions/*.json
 *   node scripts/check-free-prediction-horse-sections.mjs 2026-05-19   # 日付指定
 *   node scripts/check-free-prediction-horse-sections.mjs 2026-05-19 ooi
 *
 * 失敗条件:
 *   - 表示分類合計 !== 出走頭数（どこかの馬が分類から漏れている）
 *   - isIneligibleHorse / isOsaeCandidate が undefined を返す
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  normalizeHorseData,
  isOsaeCandidate,
  isIneligibleHorse,
} from '../src/lib/shared-prediction-logic.js';
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

function classifyRace(raceData) {
  const horses = normalizeHorseData(raceData) || [];
  const honmei = horses.filter(h => h.role === '本命').length;
  const taikou = horses.filter(h => h.role === '対抗').length;
  const tana   = horses.filter(h => h.role === '単穴').length;
  const renka  = horses.filter(h => h.role === '連下' || h.role === '連下最上位').length;
  const osae   = horses.filter(isOsaeCandidate).length;
  const inelig = horses.filter(isIneligibleHorse).length;
  const total  = honmei + taikou + tana + renka + osae + inelig;
  return { total: horses.length, honmei, taikou, tana, renka, osae, inelig, sum: total };
}

function pad(s, n) { return String(s).padEnd(n, ' '); }

function header() {
  console.log(
    pad('日付', 11),
    pad('会場', 8),
    pad('R', 4),
    pad('総', 4),
    pad('◎', 3), pad('◯', 3), pad('▲', 3),
    pad('△', 3), pad('×', 3), pad('不要', 4),
    pad('合計', 5), '判定'
  );
}

function row(date, venue, r, c) {
  const ok = c.sum === c.total;
  console.log(
    pad(date, 11),
    pad(venue, 8),
    pad(r, 4),
    pad(c.total, 4),
    pad(c.honmei, 3), pad(c.taikou, 3), pad(c.tana, 3),
    pad(c.renka, 3), pad(c.osae, 3), pad(c.inelig, 4),
    pad(c.sum, 5), ok ? 'OK' : `NG (diff=${c.total - c.sum})`,
  );
  return ok;
}

function summarize(label, files, isJra) {
  console.log(`\n=== ${label} (${files.length} file) ===`);
  if (files.length === 0) {
    console.log('  対象ファイルなし');
    return { ok: true, races: 0, failures: 0 };
  }
  header();
  let failures = 0;
  let races = 0;
  for (const f of files) {
    const raw = JSON.parse(readFileSync(f.path, 'utf-8'));
    if (isJra) {
      // JRA: { date, venues: [{ venue, eventInfo, predictions }] }
      const venues = Array.isArray(raw.venues) ? raw.venues : [];
      for (const v of venues) {
        const adapted = adaptNewToLegacy(v);
        for (const r of adapted.races) {
          const c = classifyRace(r);
          races++;
          if (!row(f.date, v.venue || adapted.track, r.raceNumber, c)) failures++;
        }
      }
    } else {
      const adapted = adaptNewToLegacy(raw);
      for (const r of adapted.races) {
        const c = classifyRace(r);
        races++;
        if (!row(f.date, adapted.track || f.venueSlug, r.raceNumber, c)) failures++;
      }
    }
  }
  return { ok: failures === 0, races, failures };
}

function main() {
  const args = process.argv.slice(2);
  const dateFilter = args[0] || null;
  const venueFilter = args[1] || null;

  const nankanFiles = listNankanFiles(dateFilter, venueFilter);
  const jraFiles = listJraFiles(dateFilter);

  const nk = summarize('NANKAN', nankanFiles, false);
  const jr = summarize('JRA', jraFiles, true);

  console.log('\n--- まとめ ---');
  console.log(`NANKAN: ${nk.races} レース / 失敗 ${nk.failures}`);
  console.log(`JRA   : ${jr.races} レース / 失敗 ${jr.failures}`);

  if (nk.failures > 0 || jr.failures > 0) {
    console.error('\n❌ 表示分類合計が出走頭数と一致しないレースがあります。');
    process.exit(1);
  }
  console.log('\n✅ すべてのレースで「全頭が分類済み」（合計 == 出走頭数）');
}

main();
