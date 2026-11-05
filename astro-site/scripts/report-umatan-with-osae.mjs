#!/usr/bin/env node
/**
 * 本線＋連下・抑えを含めた馬単の的中・回収率を集計する（読み取り専用。archive は書き換えない）。
 *   node scripts/report-umatan-with-osae.mjs [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
 * --from の既定は、会場区分ごとの最新開催日の 3 か月前。
 * 回収率は 2 通り出す: 既存の AI 算定点数を分母にした値 / 抑えの組まで買った実点数を分母にした値。
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { checkUmatanHit, checkUmatanHitWithOsae, umatanTickets } from '../src/lib/results/umatanHit.js';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

export function summarize(entries) {
  const s = { days: entries.length, races: 0, hitHonsen: 0, hitWithOsae: 0, payoutHonsen: 0, payoutWithOsae: 0, aiPoints: 0, ticketsHonsen: 0, ticketsWithOsae: 0 };
  for (const day of entries) {
    for (const race of day.races || []) {
      const lines = race.bettingLines || [];
      const first = race.result?.first?.number;
      const second = race.result?.second?.number;
      if (!lines.length || first == null || second == null) continue;
      const result = { results: [{ number: first }, { number: second }] };
      const payout = race.umatan?.payout || 0;
      s.races += 1;
      s.aiPoints += race.aiBet?.points || 0;
      s.ticketsHonsen += umatanTickets(lines).size;
      s.ticketsWithOsae += umatanTickets(lines, { includeOsae: true }).size;
      if (lines.some((l) => checkUmatanHit(l, result))) { s.hitHonsen += 1; s.payoutHonsen += payout; }
      if (lines.some((l) => checkUmatanHitWithOsae(l, result))) { s.hitWithOsae += 1; s.payoutWithOsae += payout; }
    }
  }
  return {
    ...s,
    hitRateHonsen: pct(s.hitHonsen, s.races),
    hitRateWithOsae: pct(s.hitWithOsae, s.races),
    recoveryOnAiPoints: pct(s.payoutWithOsae, s.aiPoints * 100),
    recoveryOnActualTickets: pct(s.payoutWithOsae, s.ticketsWithOsae * 100),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  const to = arg('to') || '9999-12-31';
  const threeMonthsBefore = (date) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 3);
    return d.toISOString().slice(0, 10);
  };
  const rows = {};
  for (const [label, file] of [['南関', 'archiveResults.json'], ['中央', 'archiveResultsJra.json']]) {
    const all = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8'));
    const from = arg('from') || threeMonthsBefore(all.map((d) => d.date).sort().at(-1));
    rows[`${label} ${from}〜`] = summarize(all.filter((d) => d.date >= from && d.date <= to));
  }
  console.table(rows);
}
