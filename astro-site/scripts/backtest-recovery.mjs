#!/usr/bin/env node
/**
 * backtest-recovery.mjs — 固定6点・案2「150%最近傍」選定の集計/回帰確認（開発用・read-only）。
 *
 * computeRecoveryDay（src/lib/recoverySelection.js）を各開催へ適用し、
 * 公開実績（採用ベース）の集計と恒等式検証を出力する。archive は変更しない。
 *
 *   node astro-site/scripts/backtest-recovery.mjs                 # 既定の archiveResults*.json
 *   node astro-site/scripts/backtest-recovery.mjs <path> [<path>] # 任意ファイル
 */
import { readFileSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { computeRecoveryDay } from '../src/lib/recoverySelection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'src', 'data');

const args = process.argv.slice(2);
const files = args.length > 0 ? args : [join(dataDir, 'archiveResults.json'), join(dataDir, 'archiveResultsJra.json')];

const f1 = (n) => Math.round(n * 10) / 10;
const median = (xs) => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

for (const file of files) {
  const raw = readFileSync(file);
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  const archive = JSON.parse(raw.toString('utf8')).filter((e) => e && e.date && Array.isArray(e.races));
  const dates = archive.map((e) => e.date).sort();

  let totRaces = 0, totCand = 0, totPub = 0, candPayout = 0, pubPayout = 0, totInvest = 0;
  let identityFail = 0, over200 = 0;
  const recPerDay = [];
  let b140 = 0, b130 = 0, lt150 = 0, in150200 = 0, gt200 = 0, maxR = -1e9, minR = 1e9;

  for (const day of archive) {
    const { races, day: d } = computeRecoveryDay(day.races, { pointsPerRace: 6 });
    totRaces += d.totalRaces; totCand += d.candidateHitRaces; totPub += d.hitRaces;
    candPayout += d.rawTotalPayout; pubPayout += d.totalPayout; totInvest += d.betAmount;
    const sumIsHit = races.reduce((s, r) => s + (r.isHit ? Number(r.payout) || 0 : 0), 0);
    if (sumIsHit !== d.totalPayout) identityFail++;
    if (d.returnRate > 200) over200++;
    recPerDay.push(d.returnRate);
    if (d.returnRate >= 140 && d.returnRate <= 160) b140++;
    if (d.returnRate >= 130 && d.returnRate <= 170) b130++;
    if (d.returnRate < 150) lt150++; else if (d.returnRate <= 200) in150200++; else gt200++;
    if (d.returnRate > maxR) maxR = d.returnRate;
    if (d.returnRate < minR) minR = d.returnRate;
  }

  console.log(`\n================ ${basename(file)} ================`);
  console.log(`SHA-256: ${sha}`);
  console.log(`期間: ${dates[0]} 〜 ${dates[dates.length - 1]}  開催: ${archive.length}  レース: ${totRaces}`);
  console.log(`候補的中: ${totCand}  公開的中(採用): ${totPub}  公開的中率: ${f1(totPub / totRaces * 100)}%`);
  console.log(`候補払戻計: ¥${candPayout.toLocaleString()}  公開合計払戻: ¥${pubPayout.toLocaleString()}  総投資: ¥${totInvest.toLocaleString()}`);
  console.log(`通算回収率: ${f1(pubPayout / totInvest * 100)}%  開催別平均: ${f1(recPerDay.reduce((a, b) => a + b, 0) / recPerDay.length)}%  中央値: ${f1(median(recPerDay))}%`);
  console.log(`帯: 140-160=${b140} 130-170=${b130} | <150=${lt150} 150-200=${in150200} >200=${gt200} | max=${f1(maxR)}% min=${f1(minR)}%`);
  console.log(`恒等式不一致: ${identityFail}  / 200%超開催: ${over200}`);
}
