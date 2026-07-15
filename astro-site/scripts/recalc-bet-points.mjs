#!/usr/bin/env node
/**
 * archiveResults.json / archiveResultsJra.json を
 * 固定6点・案2「150%目標最近傍」回収率選定（src/lib/recoverySelection.js）で
 * 全エントリ再計算するワンオフスクリプト。
 *
 * 詳細: BET_POINT_LOGIC.md / src/lib/recoverySelection.js
 *
 * 使い方:
 *   node astro-site/scripts/recalc-bet-points.mjs           # 実書き換え
 *   node astro-site/scripts/recalc-bet-points.mjs --dry-run # 差分確認のみ
 *
 * 冪等性（重要）:
 *   - 候補源は computeRecoveryDay 内の resolveCandidate が決定する。
 *     race.candidateHit が保存済みなら常にそれを候補源とし、
 *     案2適用後の公開 isHit からは候補を逆算しない。
 *   - よって複数回実行しても候補数・選択・回収率は減少せず同一結果に収束する。
 *
 * 影響範囲（day 単位で上書き）:
 *   - betPointsPerRace(=6) / totalBetPoints / totalInvestment / betAmount
 *   - totalPayout(=採用払戻) / recoveryRate / returnRate
 *   - hitRaces / missRaces / hitRate（採用ベースへ統一）
 *   - candidateHitRaces / rawTotalPayout / recoverySelection（新規・監査用）
 *   - races[]: candidateHit / candidatePayout / candidateHitLines / isHit / payout /
 *              hitLines / selectionReason / betPoints(=6)
 *
 * 触らないフィールド:
 *   - races[].umatan.payout（払戻原本）/ races[].result / races[].bettingLines
 *   - date / venue / venues / verifiedAt / races[].bettingPoints
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { computeRecoveryDay } from '../src/lib/recoverySelection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'src', 'data');

const dryRun = process.argv.includes('--dry-run');

function recalcDay(day) {
  if (!Array.isArray(day.races)) return null;

  const before = {
    betPointsPerRace: day.betPointsPerRace,
    totalInvestment:  day.totalInvestment ?? day.betAmount,
    totalPayout:      day.totalPayout,
    recoveryRate:     day.recoveryRate ?? day.returnRate,
    hitRaces:         day.hitRaces,
  };

  const { races, day: d } = computeRecoveryDay(day.races, { pointsPerRace: 6 });

  day.races             = races;
  day.totalRaces        = d.totalRaces;
  day.hitRaces          = d.hitRaces;
  day.missRaces         = d.missRaces;
  day.hitRate           = d.hitRate;
  day.betPointsPerRace  = d.betPointsPerRace;
  day.totalBetPoints    = d.totalBetPoints;
  day.totalInvestment   = d.totalInvestment;
  day.betAmount         = d.betAmount;
  day.totalPayout       = d.totalPayout;
  day.returnRate        = d.returnRate;
  day.recoveryRate      = d.recoveryRate;
  day.candidateHitRaces = d.candidateHitRaces;
  day.rawTotalPayout    = d.rawTotalPayout;
  day.recoverySelection = d.recoverySelection;

  return {
    before,
    after: {
      betPointsPerRace: d.betPointsPerRace,
      totalInvestment:  d.totalInvestment,
      totalPayout:      d.totalPayout,
      recoveryRate:     d.recoveryRate,
      hitRaces:         d.hitRaces,
    },
  };
}

function processFile(filePath) {
  if (!existsSync(filePath)) {
    console.log(`⏭️  SKIP (not found): ${basename(filePath)}`);
    return;
  }
  const archive = JSON.parse(readFileSync(filePath, 'utf-8'));
  if (!Array.isArray(archive)) {
    console.log(`⏭️  SKIP (not array): ${basename(filePath)}`);
    return;
  }

  console.log(`\n━━━ ${basename(filePath)} (${archive.length} 日) ━━━`);

  let changedDays = 0;
  let over200Days = 0;
  let identityFailDays = 0;
  const samples = [];

  for (const day of archive) {
    const result = recalcDay(day);
    if (!result) continue;

    // 恒等式検証（回帰防止）
    const sumIsHit = day.races.reduce((s, r) => s + (r.isHit ? Number(r.payout) || 0 : 0), 0);
    if (sumIsHit !== day.totalPayout) identityFailDays++;
    if ((day.returnRate ?? 0) > 200) over200Days++;

    const changed =
      result.before.betPointsPerRace !== result.after.betPointsPerRace ||
      Math.abs((result.before.recoveryRate ?? 0) - result.after.recoveryRate) > 0.05 ||
      result.before.totalPayout !== result.after.totalPayout ||
      result.before.hitRaces !== result.after.hitRaces;
    if (changed) changedDays++;
    if (samples.length < 3 && changed) {
      samples.push({ date: day.date, venue: day.venue, before: result.before, after: result.after });
    }
  }

  console.log(`変更日数: ${changedDays} / ${archive.length}`);
  console.log(`恒等式不一致(totalPayout != Σ採用payout): ${identityFailDays} 日`);
  console.log(`回収率 200% 超過: ${over200Days} 日`);
  if (samples.length > 0) {
    console.log(`サンプル変更:`);
    for (const s of samples) {
      console.log(`  [${s.date} ${s.venue}]`);
      console.log(`    before: ${s.before.betPointsPerRace}点 / 投資¥${s.before.totalInvestment} / 払戻¥${s.before.totalPayout} / 的中${s.before.hitRaces} / 回収率${s.before.recoveryRate}%`);
      console.log(`    after : ${s.after.betPointsPerRace}点 / 投資¥${s.after.totalInvestment} / 採用払戻¥${s.after.totalPayout} / 的中${s.after.hitRaces} / 回収率${s.after.recoveryRate}%`);
    }
  }

  if (identityFailDays > 0) {
    throw new Error(`恒等式不一致が ${identityFailDays} 日検出されました（${basename(filePath)}）。書き込みを中止します。`);
  }

  if (!dryRun) {
    writeFileSync(filePath, JSON.stringify(archive, null, 2), 'utf-8');
    console.log(`✅ 書き換え完了: ${basename(filePath)}`);
  } else {
    console.log(`💡 --dry-run のため未保存`);
  }
}

console.log(`mode: ${dryRun ? 'DRY-RUN' : 'WRITE'}`);
processFile(join(dataDir, 'archiveResults.json'));
processFile(join(dataDir, 'archiveResultsJra.json'));

console.log(`\n🎉 完了`);
