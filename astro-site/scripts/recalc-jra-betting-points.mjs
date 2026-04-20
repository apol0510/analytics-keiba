#!/usr/bin/env node
/**
 * archiveResultsJra.json の bettingPoints を再計算するワンオフスクリプト。
 *
 * 背景:
 *   旧ロジックは 本線+抑え を合算していたため、1レース 20〜34 点の表示になっていた。
 *   新ロジック (importResultsJra.js の calculateBettingPoints) は本線のみ・最大12点 cap。
 *   過去の archive エントリを bettingLines から再計算してその場で書き換える。
 *
 * 使い方:
 *   node astro-site/scripts/recalc-jra-betting-points.mjs
 *
 * 影響範囲:
 *   - archiveResultsJra.json の race[].bettingPoints のみ上書き
 *   - betAmount / totalPayout / returnRate / hitRate は変更しない
 *     (これらは betPointsPerRace ベースで算出されているため独立)
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const archivePath = join(__dirname, '..', 'src', 'data', 'archiveResultsJra.json');

function calcMainOnly(bettingLine) {
  const m = bettingLine.match(/^(\d+)-(.+)$/);
  if (!m) return 0;
  const mainPart = m[2].replace(/\(抑え.+\)/, '');
  return mainPart.split('.').filter(n => /^\d+$/.test(n)).length;
}

const archive = JSON.parse(readFileSync(archivePath, 'utf-8'));

let changed = 0;
let racesTotal = 0;
const before = { min: Infinity, max: -Infinity, sum: 0 };
const after  = { min: Infinity, max: -Infinity, sum: 0 };

for (const day of archive) {
  if (!Array.isArray(day.races)) continue;
  for (const race of day.races) {
    racesTotal++;
    const prev = race.bettingPoints ?? 0;
    before.min = Math.min(before.min, prev);
    before.max = Math.max(before.max, prev);
    before.sum += prev;

    const lines = Array.isArray(race.bettingLines) ? race.bettingLines : [];
    const raw = lines.reduce((s, l) => s + calcMainOnly(l), 0);
    const next = Math.min(raw, 12);

    after.min = Math.min(after.min, next);
    after.max = Math.max(after.max, next);
    after.sum += next;

    if (prev !== next) {
      race.bettingPoints = next;
      changed++;
    }
  }
}

writeFileSync(archivePath, JSON.stringify(archive, null, 2), 'utf-8');

console.log(`✅ archiveResultsJra.json 更新完了`);
console.log(`   races: ${racesTotal}`);
console.log(`   changed: ${changed}`);
console.log(`   before: min=${before.min} max=${before.max} avg=${(before.sum/racesTotal).toFixed(1)}`);
console.log(`   after : min=${after.min} max=${after.max} avg=${(after.sum/racesTotal).toFixed(1)}`);
