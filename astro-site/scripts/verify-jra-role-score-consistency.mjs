#!/usr/bin/env node
/**
 * verify-jra-role-score-consistency.mjs
 *
 * JRA prediction JSON の role / pt 整合性を検証する。
 *
 * 不変条件:
 *   1. 本命 pt >= 対抗 pt
 *   2. 対抗 pt >= 単穴 pt
 *   3. 単穴 pt >= 連下最上位 pt
 *   4. 連下最上位 pt >= max(連下 pt)
 *   5. max(連下 pt) >= max(補欠/抑え pt)
 *   6. 本命・対抗・単穴・連下最上位 はそれぞれ 1 頭
 *   7. role / pt が空でない
 *
 * 使い方:
 *   node scripts/verify-jra-role-score-consistency.mjs                # JRA 全期間
 *   node scripts/verify-jra-role-score-consistency.mjs 2026-05-16     # JRA 特定日のみ
 *   node scripts/verify-jra-role-score-consistency.mjs --nankan       # 南関のみ 全期間
 *   node scripts/verify-jra-role-score-consistency.mjs --nankan 2026-05-13  # 南関 特定日
 *   node scripts/verify-jra-role-score-consistency.mjs --all          # JRA + 南関 両方
 *
 * 終了コード:
 *   0: すべて整合
 *   1: 不整合あり
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const JRA_DIR = join(projectRoot, 'src/data/predictions/jra');
const NANKAN_DIR = join(projectRoot, 'src/data/predictions');

const args = process.argv.slice(2);
const nankanFlag = args.includes('--nankan');
const allFlag = args.includes('--all');
const dateFilter = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null;

// scope 決定:
//   --all                → JRA + 南関 両方
//   --nankan             → 南関のみ
//   (デフォルト)         → JRA のみ
const scope = allFlag ? 'all' : (nankanFlag ? 'nankan' : 'jra');
const scanJra = scope === 'jra' || scope === 'all';
const scanNankan = scope === 'nankan' || scope === 'all';

const OSAE_LIKE_ROLES = new Set(['押さえ', '抑え', '補欠']);

function ptOf(h) {
  const v = Number(h?.pt);
  return Number.isFinite(v) ? v : 0;
}

function maxPt(horses) {
  if (!horses.length) return null;
  return Math.max(...horses.map(ptOf));
}

function checkRace(venue, raceNum, horses) {
  const errors = [];
  if (!Array.isArray(horses) || horses.length === 0) return errors;

  const honmei = horses.filter(h => h.role === '本命');
  const taikou = horses.filter(h => h.role === '対抗');
  const tanana = horses.filter(h => h.role === '単穴');
  const renkaTop = horses.filter(h => h.role === '連下最上位');
  const renka = horses.filter(h => h.role === '連下');
  const osae = horses.filter(h => OSAE_LIKE_ROLES.has(h.role));

  if (honmei.length !== 1) errors.push(`本命=${honmei.length}頭(期待1)`);
  if (taikou.length !== 1) errors.push(`対抗=${taikou.length}頭(期待1)`);
  if (tanana.length > 1) errors.push(`単穴=${tanana.length}頭(期待<=1)`);
  if (renkaTop.length > 1) errors.push(`連下最上位=${renkaTop.length}頭(期待<=1)`);

  for (const h of horses) {
    if (!h.role || h.role === '無') {
      // 無 は不整合扱いしない (役割未付与は許容)
      continue;
    }
    if (!ptOf(h)) errors.push(`#${h.horseNumber} role=${h.role} だが pt が空`);
  }

  const hPt = honmei.length ? ptOf(honmei[0]) : null;
  const tPt = taikou.length ? ptOf(taikou[0]) : null;
  const taPt = maxPt(tanana);
  const rtPt = maxPt(renkaTop);
  const rPt = maxPt(renka);
  const oPt = maxPt(osae);

  // 1. 本命 >= 対抗
  if (hPt != null && tPt != null && hPt < tPt) {
    errors.push(`本命#${honmei[0].horseNumber}(${hPt}) < 対抗#${taikou[0].horseNumber}(${tPt})`);
  }
  // 2. 対抗 >= 単穴
  if (tPt != null && taPt != null && tPt < taPt) {
    errors.push(`対抗(${tPt}) < 単穴max(${taPt})`);
  }
  // 本命 >= 単穴
  if (hPt != null && taPt != null && hPt < taPt) {
    errors.push(`本命(${hPt}) < 単穴max(${taPt})`);
  }
  // 3. 単穴 >= 連下最上位
  if (taPt != null && rtPt != null && taPt < rtPt) {
    errors.push(`単穴(${taPt}) < 連下最上位(${rtPt})`);
  }
  // 4. 連下最上位 >= 連下max
  if (rtPt != null && rPt != null && rtPt < rPt) {
    errors.push(`連下最上位(${rtPt}) < 連下max(${rPt})`);
  }
  // 単穴 >= 連下max
  if (taPt != null && rPt != null && taPt < rPt) {
    errors.push(`単穴(${taPt}) < 連下max(${rPt})`);
  }
  // 5. 連下 >= 抑え
  if (rPt != null && oPt != null && rPt < oPt) {
    errors.push(`連下max(${rPt}) < 抑え/補欠max(${oPt})`);
  }
  // 連下最上位 >= 抑え
  if (rtPt != null && oPt != null && rtPt < oPt) {
    errors.push(`連下最上位(${rtPt}) < 抑え/補欠max(${oPt})`);
  }

  return errors;
}

function* walkJsonFiles(dir) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) yield* walkJsonFiles(p);
    else if (f.endsWith('.json')) yield p;
  }
}

function extractRaces(data, filename) {
  // フォーマット1: {date, venues: [{venue, predictions: [{raceInfo, horses}]}]}
  if (Array.isArray(data?.venues)) {
    const out = [];
    for (const v of data.venues) {
      for (const r of (v.predictions || v.races || [])) {
        out.push({
          venue: v.venue || v.track || '?',
          raceNumber: r.raceInfo?.raceNumber || r.raceNumber || '?',
          horses: r.horses || []
        });
      }
    }
    return out;
  }
  // フォーマット2: {eventInfo, predictions: [{raceInfo, horses}]} (南関単一会場)
  if (Array.isArray(data?.predictions)) {
    const venue = data.eventInfo?.venue || data.eventInfo?.track || filename;
    return data.predictions.map(r => ({
      venue,
      raceNumber: r.raceInfo?.raceNumber || r.raceNumber || '?',
      horses: r.horses || []
    }));
  }
  return [];
}

let totalRaces = 0;
let badRaces = 0;
const issues = [];

console.log('━━━ role/pt 整合性検証 ━━━');
console.log(`📂 対象: ${scope.toUpperCase()}`);
if (dateFilter) console.log(`📅 日付フィルタ: ${dateFilter}`);
console.log();

let scannedFiles = 0;

if (scanJra) {
  // JRA: src/data/predictions/jra/YYYY/MM/YYYY-MM-DD.json (フォーマット1: venues[])
  for (const file of walkJsonFiles(JRA_DIR)) {
    const filename = file.split('/').pop();
    if (dateFilter && !filename.includes(dateFilter)) continue;
    scannedFiles++;
    let data;
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
      console.warn(`⚠️  ${file}: JSON 読込み失敗 (${e.message})`);
      continue;
    }
    const races = extractRaces(data, filename);
    for (const r of races) {
      totalRaces++;
      const errors = checkRace(r.venue, r.raceNumber, r.horses);
      if (errors.length > 0) {
        badRaces++;
        issues.push({ source: 'JRA', file: filename, venue: r.venue, raceNumber: r.raceNumber, errors });
      }
    }
  }
}

if (scanNankan) {
  // 南関: src/data/predictions/*.json (フォーマット2: predictions[])
  // ※ jra/ サブディレクトリは除外
  for (const file of walkJsonFiles(NANKAN_DIR)) {
    if (file.includes('/jra/')) continue;
    const filename = file.split('/').pop();
    if (dateFilter && !filename.includes(dateFilter)) continue;
    scannedFiles++;
    let data;
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
      console.warn(`⚠️  ${file}: JSON 読込み失敗 (${e.message})`);
      continue;
    }
    const races = extractRaces(data, filename);
    for (const r of races) {
      totalRaces++;
      const errors = checkRace(r.venue, r.raceNumber, r.horses);
      if (errors.length > 0) {
        badRaces++;
        issues.push({ source: '南関', file: filename, venue: r.venue, raceNumber: r.raceNumber, errors });
      }
    }
  }
}

console.log(`スキャンファイル数: ${scannedFiles}`);
console.log(`検証レース数: ${totalRaces}`);
console.log(`不整合レース数: ${badRaces}`);
console.log();

if (issues.length > 0) {
  for (const i of issues) {
    console.log(`❌ [${i.source}] ${i.file} ${i.venue} R${i.raceNumber}`);
    for (const e of i.errors) console.log(`   - ${e}`);
  }
  console.log();
  console.error(`✗ NG: ${badRaces}/${totalRaces} レースに不整合あり`);
  process.exit(1);
}

console.log(`✓ OK: 全 ${totalRaces} レースで role/pt 整合性を確認`);
process.exit(0);
