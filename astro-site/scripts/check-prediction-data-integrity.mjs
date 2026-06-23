#!/usr/bin/env node
/**
 * 【再発防止ガード / 2026-05-24】
 *
 * 予想 JSON (JRA / NANKAN) の馬データ整合性を検査する。
 *
 * 検出する異常:
 *  1. 役割が本命/対抗/単穴/連下系/補欠 なのに horseName が空
 *  2. age (性齢) が記号のみ (')' や '(' など) の異常パターン
 *  3. 役割あり馬で computerIndex == null / 異常値
 *  4. AI総合指数 (raw - 1) として 100 を超える / 10 未満の値を生む可能性
 *  5. AI総合指数を pt から fallback して取ろうとしていないか（旧バグの温床）
 *
 * 対象スコープ:
 *  - 当日 (今日) + 直近の予想 JSON のみを検査対象とする (過去汚染をブロッカーにしない)
 *  - 過去 JSON は遡及修正しない方針 (CLAUDE.md)
 *
 * exit code:
 *   0 = 異常なし
 *   1 = 異常検出 (CI fail)
 *   2 = 走査対象 0 件 (素通り防止)
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isJraPredictionFilename, parseNankanPredictionFilename, inWindow } from './lib/predictionFileScope.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// JRA 予想: src/data/predictions/jra 以下を再帰走査（filename = YYYY-MM-DD.json）。
const JRA_ROOT = join(ROOT, 'src/data/predictions/jra');
// 南関 予想: src/data/predictions 直下のフラットファイル（filename = YYYY-MM-DD-<venueSlug>.json）。
// ※ predictions 直下は南関ファイルと jra/ サブディレクトリのみ。jra/ は下の readdir(非再帰)で
//   ディレクトリとして除外され、parseNankanPredictionFilename でも非該当のため二重走査しない。
const NANKAN_ROOT = join(ROOT, 'src/data/predictions');

// 検査対象: 今日以降 (-1 日マージン含む) のみ。窓判定は predictionFileScope.inWindow に集約。
// 過去 JSON はサニタイズ実装前データが残るため CI ブロッカーにはしない。
// (CLAUDE.md「過去 JSON は遡及修正しない、新規取込から正常化」方針)

const PICK_ROLES = new Set(['本命', '対抗', '単穴', '連下最上位', '連下', '補欠', '抑え']);
const errors = [];
const warnings = [];

function isAgeBroken(age) {
  if (typeof age !== 'string') return false;
  const s = age.trim();
  if (s === '') return false;
  if (/^[牡牝セ騙][0-9]+$/.test(s)) return false;
  if (/^[\)\(\s\-_~・,\.]+$/.test(s)) return true;
  return false;
}

function checkHorse(h, ctx) {
  const role = h.role;
  const isPick = PICK_ROLES.has(role);
  const label = `${ctx.cat} ${ctx.venue}R${ctx.raceNumber} 馬番${h.horseNumber ?? '?'} (role=${role})`;

  // 1. 馬名空
  if (isPick && (h.horseName === '' || h.horseName == null)) {
    errors.push(`馬名空: ${label} → 取込側 sanitize で '無' 降格すべき。`);
  }

  // 2. 性齢ゴミ
  if (isAgeBroken(h.age)) {
    errors.push(`性齢が記号のみ: ${label} age=${JSON.stringify(h.age)} → sanitizeAge で空文字に正規化されるべき。`);
  }

  // 3. AI 総合指数: sourceComputerIndex / computerIndex
  const raw = h.sourceComputerIndex ?? h.computerIndex;
  const n = Number(raw);
  if (isPick && (raw == null || !Number.isFinite(n))) {
    warnings.push(`AI総合指数の正規源が無い: ${label} (sourceCi=${h.sourceComputerIndex}, ci=${h.computerIndex})`);
  }

  // 4. 仕様上限超
  if (Number.isFinite(n) && n > 99) {
    errors.push(`AI総合指数 raw>99: ${label} raw=${n} → スケール異常 / 別フィールド混入の疑い。`);
  }

  // 5. pt が異常に高くて ci が null → 旧バグ温床
  const ptNum = Number(h.pt);
  if (isPick && (raw == null || !Number.isFinite(n)) && Number.isFinite(ptNum) && ptNum > 100) {
    warnings.push(`pt fallback リスク: ${label} pt=${ptNum} ci=null → 過去 getDisplayIndex の pt fallback で 100 超表示の温床`);
  }
}

let totalScanned = 0;
let totalFiles = 0;

// 再帰走査して JRA 予想ファイル（YYYY-MM-DD.json）のパスを集める。
function walkJra(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkJra(p, out);
    else if (isJraPredictionFilename(name)) out.push(p);
  }
  return out;
}

// 1 予想ファイルの中身を走査して馬データを検査する。
// 対応構造: JRA = d.venues / d.races、南関 = d.predictions（eventInfo+predictions[].raceInfo+horses[]）。
function scanPredictionData(d, cat, date, defaultVenue) {
  const collectRace = (race, venueLabel) => {
    const ri = race.raceInfo || {};
    const horses = race.horses || [];
    for (const h of horses) {
      totalScanned += 1;
      checkHorse(h, { cat, venue: venueLabel || ri.venue || '', raceNumber: ri.raceNumber, date });
    }
  };

  if (d.venues) {
    const venues = Array.isArray(d.venues) ? d.venues : Object.values(d.venues);
    for (const v of venues) {
      const races = v.predictions || v.races || [];
      for (const r of races) collectRace(r, v.venue || '');
    }
  } else if (d.races) {
    for (const r of d.races) collectRace(r, d.venue || '');
  } else if (Array.isArray(d.predictions)) {
    // 南関: { eventInfo:{date,venue}, predictions:[{raceInfo, horses}] }
    const venueLabel = (d.eventInfo && d.eventInfo.venue) || defaultVenue || '';
    for (const r of d.predictions) collectRace(r, venueLabel);
  }
}

// JRA 予想（再帰・YYYY-MM-DD.json）
for (const file of walkJra(JRA_ROOT)) {
  const dateMatch = file.match(/(\d{4}-\d{2}-\d{2})\.json$/);
  if (!dateMatch || !inWindow(dateMatch[1])) continue;
  totalFiles += 1;
  const d = JSON.parse(readFileSync(file, 'utf-8'));
  scanPredictionData(d, 'JRA', dateMatch[1]);
}

// 南関 予想（predictions 直下フラット・YYYY-MM-DD-<venueSlug>.json）
if (existsSync(NANKAN_ROOT)) {
  for (const name of readdirSync(NANKAN_ROOT)) {
    const parsed = parseNankanPredictionFilename(name);
    if (!parsed || !inWindow(parsed.date)) continue;
    totalFiles += 1;
    const d = JSON.parse(readFileSync(join(NANKAN_ROOT, name), 'utf-8'));
    scanPredictionData(d, 'NANKAN', parsed.date, parsed.venueSlug);
  }
}

if (totalFiles === 0) {
  console.error('❌ 検査対象ファイルが 0 件 (素通り防止)。検査ウィンドウまたは predictions ディレクトリを確認してください。');
  process.exit(2);
}
if (totalScanned === 0) {
  console.error('❌ 検査対象馬データが 0 件 (素通り防止)。JSON スキーマ破損の疑い。');
  process.exit(2);
}

console.log(`=== AI総合指数 / 馬データ整合性検査 ===`);
console.log(`  検査ファイル: ${totalFiles}`);
console.log(`  検査馬データ: ${totalScanned}`);

if (warnings.length > 0) {
  console.log(`\n⚠️  WARN (${warnings.length}):`);
  warnings.slice(0, 20).forEach(w => console.log('  ', w));
  if (warnings.length > 20) console.log(`  ... 他 ${warnings.length - 20} 件`);
}

if (errors.length > 0) {
  console.error(`\n❌ ERROR (${errors.length}):`);
  errors.slice(0, 30).forEach(e => console.error('  ', e));
  if (errors.length > 30) console.error(`  ... 他 ${errors.length - 30} 件`);
  console.error('\n対処:');
  console.error('  - 馬名空: src/utils/normalizePrediction.js の sanitizeHorseName / isHorseNameBroken を確認');
  console.error('  - 性齢ゴミ: src/utils/normalizePrediction.js の sanitizeAge を確認');
  console.error('  - AI総合指数 raw>99: src/lib/shared-prediction-logic.js の getHorseAiIndex 経由で表示しているか確認');
  console.error('  - 過去 JSON は遡及修正しない方針なので、新規取込ファイルのみ対象。');
  process.exit(1);
}

console.log(`\n✅ AI総合指数 / 馬データ整合性 OK (異常 0 件)`);
process.exit(0);
