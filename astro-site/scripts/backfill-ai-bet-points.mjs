#!/usr/bin/env node
/**
 * backfill-ai-bet-points.mjs — 既存の結果アーカイブへ「AI レース別購入点数」（race.aiBet）を付ける
 *
 * 【状態】MK 確定仕様（2026-10-06）。本番反映は MK の Deploy Preview 目視後。
 * 正本: docs/BET_POINT_LOGIC.md「MK確定仕様: 実績の購入点数は AI レース別算定」／単一源 src/lib/results/aiBetPoints.js
 *
 * 既存フィールド（isHit / bettingLines / betPoints / returnRate 等）は一切変えない。race.aiBet を足すだけ。
 * 予想データ（src/data/predictions）が無いレースは付けない（その日は回収率を出さない）。
 *
 *   node scripts/backfill-ai-bet-points.mjs            # 集計だけ（書き込まない）
 *   node scripts/backfill-ai-bet-points.mjs --apply    # 書き込む
 *   node scripts/backfill-ai-bet-points.mjs --days 2026-10-04,2026-10-05   # 日ごとのレース別点数一覧
 *   node scripts/backfill-ai-bet-points.mjs --months 2026-10                # 月ごとの集計
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAiBet, summarizeAiDays, summarizeAiDay, expandUmatanLine } from '../src/lib/results/aiBetPoints.js';
import { getMainRaceNumber } from '../src/utils/mainRaceBetting.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const D = join(root, 'src', 'data');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const listArg = (flag) => (args.includes(flag) ? (args[args.indexOf(flag) + 1] || '').split(',').filter(Boolean) : []);
const dayList = listArg('--days');
const monthList = listArg('--months');

const normVenue = (v) => String(v || '').replace(/競馬場?$/, '').trim();

function loadPreds(cat, date) {
  const out = new Map();
  const add = (venue, preds) => {
    for (const p of preds || []) out.set(`${normVenue(p.raceInfo?.venue || venue)}#${Number(p.raceInfo?.raceNumber)}`, p);
  };
  if (cat === 'jra') {
    const f = join(D, 'predictions', 'jra', date.slice(0, 4), date.slice(5, 7), `${date}.json`);
    if (existsSync(f)) for (const v of JSON.parse(readFileSync(f, 'utf8')).venues || []) add(v.venue, v.predictions);
  } else {
    for (const f of readdirSync(join(D, 'predictions')).filter((x) => x.startsWith(date) && x.endsWith('.json'))) {
      const d = JSON.parse(readFileSync(join(D, 'predictions', f), 'utf8'));
      add(d.eventInfo?.venue, d.predictions);
    }
  }
  return out;
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

for (const [cat, file] of [['jra', 'archiveResultsJra.json'], ['nankan', 'archiveResults.json']]) {
  const path = join(D, file);
  const arr = JSON.parse(readFileSync(path, 'utf8'));
  let added = 0, missing = 0;
  for (const e of arr) {
    const preds = loadPreds(cat, e.date);
    for (const r of e.races || []) {
      const p = preds.get(`${normVenue(r.venue || e.venue)}#${Number(r.raceNumber)}`);
      const lines = (r.bettingLines || []).filter(Boolean);
      const ai = p && lines.length ? buildAiBet(p.horses, lines, { cat, horseCount: p.raceInfo?.horseCount }) : null;
      if (ai) { r.aiBet = ai; added++; } else { delete r.aiBet; missing++; }
    }
  }

  // ---- 集計（算定のそろった日だけ。比較も同じ日・同じレースで） ----
  const full = arr.filter((e) => summarizeAiDay(e).complete);
  const races = full.flatMap((e) => e.races);
  const s = summarizeAiDays(full);
  const dist = {};
  for (const r of races) dist[r.aiBet.points] = (dist[r.aiBet.points] || 0) + 1;
  const pays = (r) => (r.isHit ? Number(r.umatan?.payout) || 0 : 0);
  const totalPayout = races.reduce((x, r) => x + pays(r), 0);
  const fivePts = races.length * 5;
  const normalPts = races.reduce((x, r) => x + uniqLen(r.bettingLines), 0);
  const pts = races.map((r) => r.aiBet.points);
  console.log(`\n== ${cat}: aiBet 付与 ${added} / 付与できず ${missing}（予想データ無し等）`);
  console.log(`対象 ${full.length} 日・${races.length} レース（${full[full.length - 1]?.date}〜${full[0]?.date}）`);
  console.log(`平均 ${(s.points / races.length).toFixed(1)} 点 / 最小 ${Math.min(...pts)} / 最大 ${Math.max(...pts)}`);
  console.log(`分布 ${Object.entries(dist).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}点:${v}`).join(' ')}`);
  console.log(`的中率 ${s.hitRate}%（通常買い目）`);
  console.log(`回収率 ${s.recoveryRate}%（購入 ${s.points.toLocaleString()} 点・払戻 ¥${s.payout.toLocaleString()}＝通常買い目で記録された払戻）`);
  console.log(`  比較: 5点固定 ${pct(totalPayout, fivePts * 100)}%（${fivePts.toLocaleString()} 点）／通常買い目全点 ${pct(totalPayout, normalPts * 100)}%（${normalPts.toLocaleString()} 点）`);

  for (const month of monthList) {
    const m = summarizeAiDays(arr.filter((e) => String(e.date).startsWith(month)));
    console.log(`  [${cat} ${month}] ${m.fullDays}/${m.days} 日・的中率 ${m.hitRate}%・購入 ${m.points ?? '-'} 点・払戻 ¥${(m.payout ?? 0).toLocaleString()}・回収率 ${m.recoveryRate ?? '-'}%`);
  }

  for (const day of dayList) {
    const e = arr.find((x) => x.date === day);
    if (!e) continue;
    const d = summarizeAiDay(e);
    const byV = {};
    for (const r of e.races) byV[r.venue] = (byV[r.venue] || 0) + 1;
    console.log(`\n  [${cat} ${day}] 合計 ${d.points ?? '-'} 点・払戻 ¥${(d.payout ?? 0).toLocaleString()}・回収率 ${d.recoveryRate ?? '-'}%`);
    for (const r of e.races) {
      const main = Number(r.raceNumber) === getMainRaceNumber(byV[r.venue]) ? '★' : ' ';
      const ai = r.aiBet;
      const win = String(r.umatan?.combination || '');
      console.log(`   ${main}${(r.venue || '').padEnd(3, '　')}${String(r.raceNumber).padStart(2)}R  ${ai ? String(ai.points).padStart(2) + '点' : ' -  '}  通常${String(uniqLen(r.bettingLines)).padStart(2)}点  ${r.isHit ? '的中' : '　　'} ${win.padEnd(6)} ${r.isHit ? '¥' + (Number(r.umatan?.payout) || 0).toLocaleString() : ''}`);
    }
  }

  if (APPLY) {
    writeFileSync(path, JSON.stringify(arr, null, 2) + '\n');
    console.log(`✍️  ${file} に書き込みました`);
  }
}

function uniqLen(lines) {
  return new Set((lines || []).filter(Boolean).flatMap(expandUmatanLine)).size;
}
