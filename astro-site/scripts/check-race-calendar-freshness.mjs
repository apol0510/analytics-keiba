#!/usr/bin/env node
/**
 * check-race-calendar-freshness.mjs — 開催の例外リストが古いままでないか警告する
 *
 * ⚠️ **販売は止めない。** 例外リスト（中央・南関とも開催が無い日）は年 1〜3 日で、
 *    空でも通常販売は続く。ここは「気づかず古いまま運用する」のを防ぐだけ。
 *
 * exit code:
 *   0 … 期限内 / 期限が近い（警告のみ）
 *   0 … 期限切れ・未記録も **0**（CI を落とさない。販売条件ではないため）
 * `--strict` を付けたときだけ期限切れで 1 を返す（任意運用）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shapeRaceCalendar, checkCalendarFreshness } from '../src/lib/premiumPlus/premiumPlusRaceCalendar.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'src', 'data', 'premiumPlusRaceCalendar.json');
const strict = process.argv.includes('--strict');

const jstToday = () => {
  const d = new Date(Date.now() + 9 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

let raw = null;
try { raw = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* 無くても販売は止めない */ }
const cal = shapeRaceCalendar(raw);
const f = checkCalendarFreshness({ calendar: cal, nowDate: jstToday() });

console.log(`開催の例外日: ${cal.size} 件 / 確認済み: ${cal.checkedUntil || '(未記録)'}`);
if (f.stale) {
  console.warn(`⚠️  ${f.note}`);
  console.warn('   対応: 中央・南関とも開催が無い日を src/data/premiumPlusRaceCalendar.json の');
  console.warn('   noRaceDates へ追記し、checkedUntil を更新してください。');
  if (strict) process.exit(1);
  process.exit(0);
}
if (f.expiringSoon) { console.warn(`⚠️  ${f.note}`); process.exit(0); }
console.log('✅ 例外リストは確認期限内です');
