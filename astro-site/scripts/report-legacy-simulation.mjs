#!/usr/bin/env node
/**
 * 旧 4 段階方式の再計算（読み取り専用・内部検証）。結果判明後のシミュレーションで、公開値ではない。
 * 使い方: node scripts/report-legacy-simulation.mjs [archive のディレクトリ]
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeLegacySimulation } from '../src/lib/results/legacySimulation.js';

const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');
const total = [];
for (const [label, file, from] of [['南関', 'archiveResults.json', '2026-04-15'], ['中央', 'archiveResultsJra.json', '']]) {
  const all = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  for (const [scope, rows] of [['全件', all], ['現在基準', all.filter((e) => !from || String(e.date) >= from)]]) {
    const s = summarizeLegacySimulation(rows);
    console.log(label, scope, rows.at(-1)?.date, '〜', rows[0]?.date, JSON.stringify(s));
  }
  total.push(...all.filter((e) => !from || String(e.date) >= from));
}
console.log('合算', JSON.stringify(summarizeLegacySimulation(total)));
