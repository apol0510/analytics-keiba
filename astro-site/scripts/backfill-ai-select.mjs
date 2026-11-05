#!/usr/bin/env node
/**
 * 過去のレースへ AI 事前選定（race.aiSelect）を付ける。既存の項目は変えず、足すだけ。
 * 組は予想データと買い目だけで決まる。結果は読まない。
 *   node scripts/backfill-ai-select.mjs           # 件数だけ
 *   node scripts/backfill-ai-select.mjs --apply   # 書き込む
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAiSelect, summarizeAiSelect } from '../src/lib/results/aiBetPoints.js';

const D = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');
const APPLY = process.argv.includes('--apply');
const norm = (v) => String(v || '').replace(/競馬場?$/, '').trim();

function loadPreds(cat, date) {
  const out = new Map();
  const add = (venue, preds) => { for (const p of preds || []) out.set(`${norm(p.raceInfo?.venue || venue)}#${Number(p.raceInfo?.raceNumber)}`, p); };
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

for (const [cat, file] of [['nankan', 'archiveResults.json'], ['jra', 'archiveResultsJra.json']]) {
  const path = join(D, file);
  const arr = JSON.parse(readFileSync(path, 'utf8'));
  let added = 0;
  let missing = 0;
  for (const e of arr) {
    const preds = loadPreds(cat, e.date);
    for (const r of e.races || []) {
      const p = preds.get(`${norm(r.venue || e.venue)}#${Number(String(r.raceNumber).replace(/\D/g, ''))}`);
      const lines = (r.bettingLines || []).filter(Boolean);
      const select = p && lines.length ? buildAiSelect(p.horses, lines, { cat, horseCount: p.raceInfo?.horseCount }) : null;
      if (select) { r.aiSelect = select; added += 1; } else missing += 1;
    }
  }
  console.log(cat, { added, missing, summary: summarizeAiSelect(cat === 'nankan' ? arr.filter((e) => e.date >= '2026-04-15') : arr) });
  if (APPLY) writeFileSync(path, `${JSON.stringify(arr, null, 2)}\n`);
}
