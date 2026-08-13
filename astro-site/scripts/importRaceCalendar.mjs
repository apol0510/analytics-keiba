#!/usr/bin/env node
/**
 * importRaceCalendar.mjs — 開催カレンダーを取り込む
 *   node scripts/importRaceCalendar.mjs --file <json|csv> [--covers-until YYYY-MM-DD]
 *   node scripts/importRaceCalendar.mjs --dry-run --file ...
 *
 * ## なぜ必要か
 *
 * Premium Plus は 16:30 以降「翌日分（次の開催日分）」を売る。
 * **その日に開催が無ければ届かない日を売る**ことになるため、開催日の正本が要る。
 * この repo には開催カレンダーが無く、予想データは当日に dispatch で届くだけなので、
 * 将来日の開催有無は**外から取り込むしかない**。
 *
 * ## 入力
 *
 * 南関東4競馬場の公式開催日程（または同等の一次情報）を、次のどちらかで渡す。
 *
 *   JSON: { "dates": ["2026-08-14", ...], "coversUntil": "2026-09-30" }
 *   CSV : 1 行 1 日付（YYYY-MM-DD / YYYY/MM/DD）
 *
 * ⚠️ **HTML を推測でスクレイピングしない。** 形が変わったときに黙って
 *    間違った日付を作り、届かない日を売ることになる。
 *    一次情報を人が確認して渡す（または公式が配る構造化データを使う）。
 *
 * ## coversUntil の意味
 *
 * 「この日までは、載っていない日 = 非開催と言い切れる」境界。
 * これを過ぎた日は「不明」として**販売しない**（`premiumPlusRaceCalendar.js`）。
 * 省略時は取り込んだ最終日を採用する。
 *
 * ## 本番への反映
 *
 * 出力先は `src/data/premiumPlusRaceCalendar.json`。git にコミットして deploy する。
 * **このスクリプトは Airtable にも Redis にも書かない。**
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'data', 'premiumPlusRaceCalendar.json');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const has = (name) => argv.includes(`--${name}`);

function parseInput(raw, file) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('入力が空です');
  if (text.startsWith('{')) {
    const j = JSON.parse(text);
    return { dates: Array.isArray(j.dates) ? j.dates : [], coversUntil: j.coversUntil || null };
  }
  // CSV / 改行区切り
  const dates = text.split(/[\r\n,]+/).map((s) => s.trim().replace(/\//g, '-')).filter(Boolean);
  return { dates, coversUntil: null };
}

function main() {
  const file = arg('file');
  if (!file) {
    console.error('使い方: node scripts/importRaceCalendar.mjs --file <json|csv> [--covers-until YYYY-MM-DD] [--dry-run]');
    process.exit(2);
  }
  const parsed = parseInput(readFileSync(file, 'utf8'), file);

  // ⚠️ 形式が不正な日付は**捨てずに落とす**（黙って通すと誤った日を売る）
  const bad = parsed.dates.filter((d) => !DATE_RE.test(d));
  if (bad.length) {
    console.error(`❌ 日付の形式が不正です（${bad.length} 件）: ${bad.slice(0, 5).join(', ')}`);
    process.exit(1);
  }
  const dates = [...new Set(parsed.dates)].sort();
  if (dates.length === 0) {
    console.error('❌ 取り込む日付がありません。空のカレンダーは書き出しません（販売が止まります）');
    process.exit(1);
  }
  const coversUntil = arg('covers-until') || parsed.coversUntil || dates[dates.length - 1];
  if (!DATE_RE.test(coversUntil)) {
    console.error(`❌ covers-until が不正です: ${coversUntil}`);
    process.exit(1);
  }
  if (coversUntil < dates[dates.length - 1]) {
    console.error(`❌ covers-until (${coversUntil}) が最終開催日 (${dates[dates.length - 1]}) より前です`);
    process.exit(1);
  }

  const out = {
    source: arg('source') || path.basename(file),
    fetchedAt: new Date().toISOString(),
    coversUntil,
    dates,
  };

  console.log(`開催日 ${dates.length} 件 / ${dates[0]} 〜 ${dates[dates.length - 1]}`);
  console.log(`coversUntil: ${coversUntil}（この日までは「載っていない = 非開催」と判定）`);

  if (has('dry-run')) {
    console.log('🔎 dry-run のため書き出しません');
    return;
  }
  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`✅ 書き出し: ${path.relative(ROOT, OUT)}`);
}

main();
