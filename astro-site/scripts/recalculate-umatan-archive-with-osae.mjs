#!/usr/bin/env node
/**
 * 馬単アーカイブを「本線＋連下・抑え」判定へ再計算する（2026-11-06 MK 指示・docs/BET_POINT_LOGIC.md）。
 * 全レースに同じ規則を当てる。特定のレースだけを書き換えない。何度実行しても同じ結果になる。
 *   node scripts/recalculate-umatan-archive-with-osae.mjs            # dry-run
 *   node scripts/recalculate-umatan-archive-with-osae.mjs --execute  # archive を書き換える
 * 買い目行か着順の無いレースを含む開催は再判定できないので据え置く。
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { checkUmatanHitWithOsae } from '../src/lib/results/umatanHit.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');
const round1 = (v) => +v.toFixed(1);
const decidable = (r) => r.bettingLines?.length > 0 && r.result?.first?.number != null && r.result?.second?.number != null;

export function recomputeEntryWithOsae(entry) {
  const races = entry.races || [];
  if (!races.length || !races.every(decidable)) return entry;
  const newRaces = races.map((r) => {
    const placed = { results: [{ number: r.result.first.number }, { number: r.result.second.number }] };
    const hitLines = r.bettingLines.filter((l) => checkUmatanHitWithOsae(l, placed));
    return { ...r, isHit: hitLines.length > 0, hitLines };
  });
  const hitRaces = newRaces.filter((r) => r.isHit).length;
  const totalPayout = newRaces.reduce((s, r) => s + (r.isHit ? r.umatan?.payout || 0 : 0), 0);
  const returnRate = entry.betAmount > 0 ? round1((totalPayout / entry.betAmount) * 100) : 0;
  return {
    ...entry, hitRaces, missRaces: races.length - hitRaces, hitRate: round1((hitRaces / races.length) * 100),
    totalPayout, returnRate, recoveryRate: returnRate, races: newRaces,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const execute = process.argv.includes('--execute');
  for (const file of ['archiveResults.json', 'archiveResultsJra.json']) {
    const path = join(DATA_DIR, file);
    const raw = readFileSync(path, 'utf-8');
    const before = JSON.parse(raw);
    const after = before.map(recomputeEntryWithOsae);
    const sum = (arr, k) => arr.reduce((s, e) => s + (e[k] || 0), 0);
    console.log(file, { days: before.length, skipped: before.filter((e, i) => e === after[i]).length,
      hitRaces: `${sum(before, 'hitRaces')} -> ${sum(after, 'hitRaces')}`,
      totalPayout: `${sum(before, 'totalPayout')} -> ${sum(after, 'totalPayout')}` });
    if (execute) writeFileSync(path, JSON.stringify(after, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
  }
  if (!execute) console.log('dry-run: --execute で書き換える');
}
