#!/usr/bin/env node
/**
 * 回収率の算定を元データと突き合わせて点検する（読み取り専用）。
 *   node scripts/audit-recovery-metrics.mjs --shared ../../keiba-data-shared --out /tmp/audit.json
 * 欠損・重複・払戻の対応を調べ、10/6 の式と現金回収率を市場別・月別に出す。
 * 南関は現在基準（2026-04-15 以降）だけを数える。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { checkUmatanHit, checkUmatanHitWithOsae, umatanTickets } from '../src/lib/results/umatanHit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const shared = arg('shared', join(HERE, '..', '..', '..', '..', 'keiba-data-shared'));
const clean = (v) => String(v || '').replace(/競馬場?$/, '').trim();
const key = (date, venue, n) => `${date}#${clean(venue)}#${Number(String(n).replace(/\D/g, ''))}`;

function officialPayouts(market) {
  const out = new Map();
  const dir = join(shared, market, 'results');
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const d = JSON.parse(readFileSync(join(e.parentPath ?? e.path, e.name), 'utf8'));
    for (const r of d.races || []) {
      const pay = new Map();
      for (const p of r.payouts?.umatan || []) {
        const m = String(p.combination).match(/(\d+)\D+(\d+)/);
        if (m) pay.set(`${Number(m[1])}>${Number(m[2])}`, Number(p.payout));
      }
      out.set(key(d.date, r.venue || d.venue, r.raceNumber), pay);
    }
  }
  return out;
}

const blank = () => ({ races: 0, ai: 0, honsenPoints: 0, allPoints: 0, honsenPayout: 0, allPayout: 0, honsenHits: 0, allHits: 0 });
const pct = (a, b) => (b ? Math.round((a / (b * 100)) * 1000) / 10 : null);

function audit(market, file) {
  const entries = JSON.parse(readFileSync(join(HERE, '..', 'src', 'data', file), 'utf8'));
  const official = officialPayouts(market);
  const seen = new Set();
  const q = { races: 0, duplicates: 0, noAiBet: 0, noLines: 0, noResult: 0, aiOverHonsen: 0, missingOfficial: 0, payoutChecked: 0, payoutMismatch: 0, payoutDiffYen: 0, hitFlagMismatch: 0, hitWithoutPayout: 0, missedPayoutYen: 0 };
  const total = blank();
  const months = {};
  for (const e of entries) {
    if (market === 'nankan' && e.date < '2026-04-15') continue;
    for (const r of e.races || []) {
      q.races += 1;
      const k = key(e.date, r.venue || e.venue, r.raceNumber);
      if (seen.has(k)) q.duplicates += 1;
      seen.add(k);
      const lines = Array.isArray(r.bettingLines) ? r.bettingLines : [];
      if (!lines.length) { q.noLines += 1; continue; }
      const first = r.result?.first?.number;
      const second = r.result?.second?.number;
      if (first == null || second == null) { q.noResult += 1; continue; }
      const points = Number(r.aiBet?.points);
      if (!(points > 0)) { q.noAiBet += 1; continue; }
      const placed = { results: [{ number: first }, { number: second }] };
      const honsen = lines.some((l) => checkUmatanHit(l, placed));
      const all = lines.some((l) => checkUmatanHitWithOsae(l, placed));
      const recorded = Number(r.umatan?.payout ?? r.payout) || 0;
      const honsenPoints = umatanTickets(lines).size;
      if (points > honsenPoints) q.aiOverHonsen += 1;
      if (all !== !!r.isHit) q.hitFlagMismatch += 1;
      if (all && !recorded) q.hitWithoutPayout += 1;
      const pay = official.get(k);
      if (!pay) q.missingOfficial += 1;
      else if (all) {
        const actual = pay.get(`${first}>${second}`);
        q.payoutChecked += 1;
        if (actual !== recorded) { q.payoutMismatch += 1; q.payoutDiffYen += (actual || 0) - recorded; }
        if (actual && !recorded) q.missedPayoutYen += actual;
      }
      for (const b of [total, (months[e.date.slice(0, 7)] ??= blank())]) {
        b.races += 1; b.ai += points; b.honsenPoints += honsenPoints;
        b.allPoints += umatanTickets(lines, { includeOsae: true }).size;
        if (honsen) { b.honsenHits += 1; b.honsenPayout += recorded; }
        if (all) { b.allHits += 1; b.allPayout += recorded; }
      }
    }
  }
  const view = (b) => ({ ...b, aiIndex: pct(b.honsenPayout, b.ai), honsenCash: pct(b.honsenPayout, b.honsenPoints), cash: pct(b.allPayout, b.allPoints), osaeOverAi: pct(b.allPayout, b.ai) });
  return { market, quality: q, total: view(total), months: Object.fromEntries(Object.entries(months).sort().map(([m, b]) => [m, view(b)])), pointsFor150AiIndex: Math.round(total.honsenPayout / 150) };
}

const report = [audit('nankan', 'archiveResults.json'), audit('jra', 'archiveResultsJra.json')];
if (arg('out')) writeFileSync(arg('out'), `${JSON.stringify(report, null, 2)}\n`);
for (const r of report) {
  console.log(r.market, JSON.stringify(r.quality));
  console.log(' total', JSON.stringify(r.total), 'AI 点数がこの値なら 150%:', r.pointsFor150AiIndex);
  for (const [m, b] of Object.entries(r.months)) console.log(' ', m, `${b.races}R AI指標 ${b.aiIndex}% 本線全組 ${b.honsenCash}% 現金 ${b.cash}%`);
}
