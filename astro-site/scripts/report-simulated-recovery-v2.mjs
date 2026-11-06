#!/usr/bin/env node
/**
 * 事後シミュレーション算定値 v2 のレポート（読み取り専用・内部検証）。実際の購入の回収率ではない。
 * 使い方: node scripts/report-simulated-recovery-v2.mjs [--to YYYY-MM-DD]
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIMULATION_V2, summarizeSimulationV2, monthlySimulationV2 } from '../src/lib/results/simulatedRecoveryV2.js';
import { summarizeLegacySimulation } from '../src/lib/results/legacySimulation.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');
const toArg = process.argv.indexOf('--to');
const to = toArg >= 0 ? process.argv[toArg + 1] : '9999-12-31';
const load = (file, from) => JSON.parse(readFileSync(join(dir, file), 'utf8')).filter((e) => e.date >= from && e.date <= to);
const nankan = load('archiveResults.json', '2026-04-15');
const jra = load('archiveResultsJra.json', '0000');
const dates = (rows) => rows.map((e) => e.date).sort();

console.log('パラメータ', JSON.stringify(SIMULATION_V2));
for (const [label, rows] of [['南関', nankan], ['中央', jra], ['合算', [...nankan, ...jra]]]) {
  const v2 = summarizeSimulationV2(rows);
  const old = summarizeLegacySimulation(rows);
  const d = dates(rows);
  console.log(`\n${label} ${d[0]}〜${d.at(-1)} ${v2.days}日 ${v2.races}R 払戻 ¥${v2.payout.toLocaleString()} 想定購入 ${v2.points.toLocaleString()}点`);
  console.log(`  v2 加重 ${v2.weightedRate}% 日別平均 ${v2.meanDailyRate}% 段階別の日数 ${JSON.stringify(v2.pointDays)}`);
  console.log(`  旧 加重 ${old.weightedRate}% 日別平均 ${old.meanDailyRate}% 差 ${(v2.weightedRate - old.weightedRate).toFixed(1)} / ${(v2.meanDailyRate - old.meanDailyRate).toFixed(1)}`);
}
for (const [label, rows] of [['南関', nankan], ['中央', jra]]) {
  console.log(`\n月別 ${label}`);
  for (const m of monthlySimulationV2(rows)) console.log(`  ${m.month} ${m.days}日 ${m.races}R ¥${m.payout.toLocaleString()} ${m.points.toLocaleString()}点 加重 ${m.weightedRate}%`);
}
