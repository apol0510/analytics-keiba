#!/usr/bin/env node
/**
 * 少点数の馬単と事前フィルターの実測回収率を集計する（読み取り専用）。
 *   node scripts/report-umatan-narrow.mjs
 * 分子は買った組に当たり組があるときの払戻、分母は買った組の点数 × 100 円。
 * 事前フィルターは既存の evaluateSanrenpukuRace の推奨度（レース前のデータだけ）をそのまま使う。
 * 閾値を回収率に合わせて変えない。
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { umatanTickets } from '../src/lib/results/umatanHit.js';
import { narrowUmatan } from '../src/lib/acquisition/predictionContent.js';
import { evaluateSanrenpukuRace, GRADE } from '../src/lib/acquisition/sanrenpukuSelection.js';

const D = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');
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

/** 買った組（"軸>相手" の Set）と記録された払戻から 1 レースの収支を返す */
export function settle(tickets, umatan) {
  const [a, b] = String(umatan?.combination || '').split('-').map((s) => parseInt(s));
  const hit = tickets.has(`${a}>${b}`);
  return { points: tickets.size, hit, payout: hit ? umatan?.payout || 0 : 0 };
}

export function total(rows) {
  const points = rows.reduce((s, r) => s + r.points, 0);
  const payout = rows.reduce((s, r) => s + r.payout, 0);
  const hits = rows.filter((r) => r.hit).length;
  return {
    races: rows.length, hits, hitRate: rows.length ? +((hits / rows.length) * 100).toFixed(1) : null, points, payout,
    recovery: points ? +((payout / (points * 100)) * 100).toFixed(1) : null,
    maxPayoutShare: payout ? +((Math.max(...rows.map((r) => r.payout)) / payout) * 100).toFixed(1) : null,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const table = {};
  for (const [cat, label, file] of [['nankan', '南関', 'archiveResults.json'], ['jra', '中央', 'archiveResultsJra.json']]) {
    const days = JSON.parse(readFileSync(join(D, file), 'utf8')).filter((e) => cat === 'jra' || e.date >= '2026-04-15');
    const last = days.map((d) => d.date).sort().at(-1);
    const c = new Date(`${last}T00:00:00Z`); c.setUTCMonth(c.getUTCMonth() - 3);
    const cutoff = c.toISOString().slice(0, 10);
    const rows = [];
    for (const e of days) {
      const preds = loadPreds(cat, e.date);
      for (const r of e.races || []) {
        const p = preds.get(`${normVenue(r.venue || e.venue)}#${Number(r.raceNumber)}`);
        const lines = (r.bettingLines || []).filter(Boolean);
        if (!p || !lines.length || !r.umatan?.combination) continue;
        const narrow = narrowUmatan(p.horses, lines);
        if (!narrow) continue;
        const grade = evaluateSanrenpukuRace(p.horses, { horseCount: p.raceInfo?.horseCount, cat }).grade;
        rows.push({ date: e.date, grade,
          honsen: settle(umatanTickets(lines), r.umatan),
          narrow: settle(umatanTickets([narrow.line]), r.umatan) });
      }
    }
    const isAB = (r) => r.grade === GRADE.A || r.grade === GRADE.B;
    for (const [period, set] of [['全期間', rows], ['直近3か月', rows.filter((r) => r.date >= cutoff)], ['それ以前', rows.filter((r) => r.date < cutoff)]]) {
      table[`${label} ${period} 本線全部`] = total(set.map((r) => r.honsen));
      table[`${label} ${period} 少点数`] = total(set.map((r) => r.narrow));
      table[`${label} ${period} 少点数+推奨AB`] = total(set.filter(isAB).map((r) => r.narrow));
      table[`${label} ${period} 少点数+推奨A`] = total(set.filter((r) => r.grade === GRADE.A).map((r) => r.narrow));
    }
  }
  console.table(table);
}
