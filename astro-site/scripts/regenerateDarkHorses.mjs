#!/usr/bin/env node
/**
 * src/data/computer/**\/*.json を新しい dark-horse.mjs ロジックで再生成する
 * （一回限りのバックフィル用）。
 *
 * 既存ファイルは pastRaces を保持しているのでそのまま再抽出可能。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { applyDarkHorsesToComputerData } from '/Users/user/Projects/keiba-data-shared-admin/netlify/functions/_shared/dark-horse.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COMPUTER_DIR = join(__dirname, '..', 'src', 'data', 'computer');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const fp = join(dir, name);
    const st = statSync(fp);
    if (st.isDirectory()) out.push(...walk(fp));
    else if (name.endsWith('.json')) out.push(fp);
  }
  return out;
}

const files = walk(COMPUTER_DIR);
let updated = 0;
for (const fp of files) {
  const data = JSON.parse(readFileSync(fp, 'utf8'));
  const enriched = applyDarkHorsesToComputerData(data, null);
  writeFileSync(fp, JSON.stringify(enriched, null, 2));
  updated++;
  const total = enriched.races.reduce((s, r) => s + (r.darkHorses?.length || 0), 0);
  const fallbackCnt = enriched.races.reduce(
    (s, r) => s + (r.darkHorses?.filter(h => h.fallback).length || 0), 0
  );
  console.log(`✓ ${fp.replace(COMPUTER_DIR, '')} — ${total} picks (fallback ${fallbackCnt})`);
}
console.log(`\nDone. Re-generated ${updated} files.`);
