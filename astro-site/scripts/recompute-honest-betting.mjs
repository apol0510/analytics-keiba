#!/usr/bin/env node
/**
 * recompute-honest-betting.mjs — 既存の的中実績（archiveResults.json / archiveResultsJra.json）の
 * 購入点数・投資額・回収率を「表示した買い目どおり」に数え直す（docs/BET_POINT_LOGIC.md）。
 *   node scripts/recompute-honest-betting.mjs           # 下見（書き込まない）
 *   node scripts/recompute-honest-betting.mjs --apply   # 書き込む
 * 買い目の記録が無い日は変更しない（honest:false を付けるだけ）。払戻の合計が既存値と食い違う日は中止する。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHonestBetting, honestDay } from '../src/lib/honestBetting.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');
const apply = process.argv.includes('--apply');
for (const name of ['archiveResults.json', 'archiveResultsJra.json']) {
  const path = join(DATA, name);
  const arr = JSON.parse(readFileSync(path, 'utf8'));
  let before = { inv: 0, pay: 0 }, after = { inv: 0, pay: 0 }, changed = 0, skipped = 0;
  const out = arr.map((e) => {
    const h = honestDay(e);
    if (!h.complete) { skipped += 1; return { ...e, honest: false }; }
    if (Math.round(h.totalPayout) !== Math.round(Number(e.totalPayout) || 0)) {
      throw new Error(`${name} ${e.date}: 払戻の合計が一致しない（既存 ${e.totalPayout} / 買い目から ${h.totalPayout}）`);
    }
    before.inv += Number(e.totalInvestment ?? e.betAmount) || 0; before.pay += Number(e.totalPayout) || 0;
    after.inv += h.totalInvestment; after.pay += h.totalPayout;
    changed += 1;
    return applyHonestBetting(e);
  });
  const rate = (x) => (x.inv ? (Math.round((x.pay / x.inv) * 1000) / 10) + '%' : '-');
  console.log(JSON.stringify({ file: name, days: arr.length, recomputed: changed, skippedNoLines: skipped,
    before: { investment: before.inv, payout: before.pay, recovery: rate(before) },
    after: { investment: after.inv, payout: after.pay, recovery: rate(after) } }));
  if (apply) writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
}
if (!apply) console.log('下見のみ（--apply で書き込み）');
