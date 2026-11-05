#!/usr/bin/env node
/**
 * AI 事前選定の候補を過去レースで比べる（読み取り専用）。
 *   node scripts/research-ai-selection.mjs --out /tmp/ai-selection.json
 * 候補はレース前の入力だけで組を決める。精算はその組の実払戻 ÷ その組の点数 × 100 円。
 * 候補は結果を見る前にこの表で固定し、開発期間（〜DEV_END）で選んで検証期間で確かめる。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { aiPointBasis, expandUmatanLine, extraCount } from '../src/lib/results/aiBetPoints.js';
import { narrowUmatan } from '../src/lib/acquisition/predictionContent.js';
import { summarize } from '../src/lib/results/evFilter.js';

export const DEV_END = '2026-08-31';
const D = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');
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

/** 候補。入力は horses（予想）・買い目・頭数だけ */
export const CANDIDATES = {
  'AI算定の組（10/6 の点数どおり）': (c) => c.basis,
  '少ない買い目だけ': (c) => c.narrow,
  '上位 1 組': (c) => c.basis.slice(0, 1),
  '上位 3 組': (c) => c.basis.slice(0, 3),
  '堅いレースだけ・AI算定の組': (c) => (c.extra <= 3 ? c.basis : []),
  '堅いレースだけ・少ない買い目': (c) => (c.extra <= 3 ? c.narrow : []),
  '混戦だけ・AI算定の組': (c) => (c.extra >= 5 ? c.basis : []),
  '本命 1 着だけ・AI算定の組': (c) => c.basis.filter((t) => Number(t.split('-')[0]) === c.axis),
  '本命 2 着だけ・AI算定の組': (c) => c.basis.filter((t) => Number(t.split('-')[1]) === c.axis),
};

function raceContext(cat, entry, race, preds) {
  const p = preds.get(`${norm(race.venue || entry.venue)}#${Number(String(race.raceNumber).replace(/\D/g, ''))}`);
  const lines = (race.bettingLines || []).filter(Boolean);
  const first = race.result?.first?.number;
  const second = race.result?.second?.number;
  if (!p || !lines.length || first == null || second == null) return null;
  const opts = { cat, horseCount: p.raceInfo?.horseCount };
  const basis = aiPointBasis(p.horses, lines, opts);
  if (!basis?.length) return null;
  const nar = narrowUmatan(p.horses, lines);
  const normal = new Set(lines.flatMap(expandUmatanLine));
  return {
    date: entry.date,
    basis,
    narrow: nar ? expandUmatanLine(nar.line).filter((t) => normal.has(t)) : [],
    extra: extraCount(p.horses, opts),
    axis: Number(p.horses.find((h) => h.role === '本命')?.horseNumber ?? p.horses.find((h) => h.role === '本命')?.number),
    winning: `${first}-${second}`,
    payout: Number(race.umatan?.payout ?? race.payout) || 0,
  };
}

const settle = (c, tickets) => {
  const hit = tickets.includes(c.winning);
  return { date: c.date, points: tickets.length, invest: tickets.length * 100, payout: hit ? c.payout : 0, hit };
};

function run(cat, file) {
  const entries = JSON.parse(readFileSync(join(D, file), 'utf8')).filter((e) => cat !== 'nankan' || e.date >= '2026-04-15').sort((a, b) => a.date.localeCompare(b.date));
  const contexts = [];
  let skipped = 0;
  for (const e of entries) {
    const preds = loadPreds(cat, e.date);
    for (const r of e.races || []) {
      const c = raceContext(cat, e, r, preds);
      if (c) contexts.push(c); else skipped += 1;
    }
  }
  const rows = Object.entries(CANDIDATES).map(([name, pick]) => {
    const all = contexts.map((c) => settle(c, pick(c)));
    return {
      name,
      dev: summarize(all.filter((r) => r.date <= DEV_END)),
      holdout: summarize(all.filter((r) => r.date > DEV_END)),
      total: summarize(all),
    };
  });
  return { cat, races: contexts.length, skipped, dates: [contexts[0]?.date, contexts.at(-1)?.date], rows };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = [run('nankan', 'archiveResults.json'), run('jra', 'archiveResultsJra.json')];
  const i = process.argv.indexOf('--out');
  if (i >= 0) writeFileSync(process.argv[i + 1], `${JSON.stringify(report, null, 2)}\n`);
  const pct = (v) => (v == null ? '-' : `${(v * 100).toFixed(1)}%`);
  for (const r of report) {
    console.log(`\n[${r.cat}] ${r.races}R 除外${r.skipped} ${r.dates.join('〜')}`);
    for (const x of r.rows) {
      console.log(`${x.name} | 開発 ${x.dev.races}R ${x.dev.points}点 ${x.dev.hits}的中 ${pct(x.dev.roi)} | 検証 ${x.holdout.races}R ${x.holdout.points}点 ${x.holdout.hits}的中 ${pct(x.holdout.roi)} [${pct(x.holdout.roiCi95[0])}〜${pct(x.holdout.roiCi95[1])}] | 全 ${pct(x.total.roi)} ${x.total.net}円`);
    }
  }
}
