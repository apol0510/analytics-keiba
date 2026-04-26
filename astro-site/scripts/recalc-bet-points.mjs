#!/usr/bin/env node
/**
 * archiveResults.json / archiveResultsJra.json を新 BET_POINT_LOGIC（4段階・実レース数ベース）で
 * 全エントリ再計算するワンオフスクリプト。
 *
 * 詳細: BET_POINT_LOGIC.md 参照
 *
 * 使い方:
 *   node astro-site/scripts/recalc-bet-points.mjs           # 実書き換え
 *   node astro-site/scripts/recalc-bet-points.mjs --dry-run # 差分確認のみ
 *
 * 影響範囲（day 単位で上書き）:
 *   - betPointsPerRace
 *   - totalBetPoints
 *   - totalInvestment
 *   - betAmount        (= totalInvestment のエイリアス)
 *   - totalPayout      (races[].umatan.payout から再集計)
 *   - recoveryRate
 *   - returnRate       (= recoveryRate のエイリアス)
 *   - races[].betPoints (フィールドが既に存在する場合のみ上書き)
 *
 * 触らないフィールド:
 *   - races[].bettingPoints (個別レースの買い目線数。意味が異なる)
 *   - hitRaces / hitRate / verifiedAt 等
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'src', 'data');

const dryRun = process.argv.includes('--dry-run');

function getBetPoints(totalPayout, races) {
  if (races <= 0) return 6;
  if (totalPayout >= races * 12 * 100) return 12;
  if (totalPayout >= races * 10 * 100) return 10;
  if (totalPayout >= races *  8 * 100) return 8;
  if (totalPayout >= races *  6 * 100) return 6;
  return 6;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function recalcDay(day) {
  if (!Array.isArray(day.races)) return null;
  const races = day.races.length;

  // races[].umatan.payout から実払戻を再集計
  const totalPayout = day.races.reduce((sum, r) => {
    if (r && r.isHit && r.umatan && typeof r.umatan.payout === 'number') {
      return sum + r.umatan.payout;
    }
    return sum;
  }, 0);

  const betPointsPerRace = getBetPoints(totalPayout, races);
  const totalBetPoints   = races * betPointsPerRace;
  const totalInvestment  = totalBetPoints * 100;
  const recoveryRate     = totalInvestment > 0 ? round1((totalPayout / totalInvestment) * 100) : 0;

  const before = {
    betPointsPerRace: day.betPointsPerRace,
    totalBetPoints:   day.totalBetPoints,
    totalInvestment:  day.totalInvestment,
    betAmount:        day.betAmount,
    totalPayout:      day.totalPayout,
    recoveryRate:     day.recoveryRate ?? day.returnRate,
  };

  day.betPointsPerRace = betPointsPerRace;
  day.totalBetPoints   = totalBetPoints;
  day.totalInvestment  = totalInvestment;
  day.betAmount        = totalInvestment;
  day.totalPayout      = totalPayout;
  day.recoveryRate     = recoveryRate;
  day.returnRate       = recoveryRate;

  // race[].betPoints が既に存在する場合のみ上書き（フィールド新設はしない）
  for (const r of day.races) {
    if (r && Object.prototype.hasOwnProperty.call(r, 'betPoints')) {
      r.betPoints = betPointsPerRace;
    }
  }

  return { before, after: { betPointsPerRace, totalBetPoints, totalInvestment, betAmount: totalInvestment, totalPayout, recoveryRate } };
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

  const distribution = { 6: 0, 8: 0, 10: 0, 12: 0 };
  let changedDays = 0;
  let payoutMismatchDays = 0;
  const samples = [];

  for (const day of archive) {
    const result = recalcDay(day);
    if (!result) continue;
    distribution[result.after.betPointsPerRace] = (distribution[result.after.betPointsPerRace] ?? 0) + 1;

    const changed =
      result.before.betPointsPerRace !== result.after.betPointsPerRace ||
      Math.abs((result.before.recoveryRate ?? 0) - result.after.recoveryRate) > 0.05 ||
      result.before.totalPayout !== result.after.totalPayout;
    if (changed) changedDays++;
    if (result.before.totalPayout !== undefined && result.before.totalPayout !== result.after.totalPayout) {
      payoutMismatchDays++;
    }
    if (samples.length < 3 && changed) {
      samples.push({ date: day.date, venue: day.venue, before: result.before, after: result.after });
    }
  }

  console.log(`変更日数: ${changedDays} / ${archive.length}`);
  console.log(`payout 再集計差異: ${payoutMismatchDays} 日（races[]から再計算した値が既存totalPayoutと異なる）`);
  console.log(`点数分布: 6点=${distribution[6]} / 8点=${distribution[8]} / 10点=${distribution[10]} / 12点=${distribution[12]}`);
  if (samples.length > 0) {
    console.log(`サンプル変更:`);
    for (const s of samples) {
      console.log(`  [${s.date} ${s.venue}]`);
      console.log(`    before: ${s.before.betPointsPerRace}点 / 投資¥${s.before.totalInvestment ?? s.before.betAmount} / 払戻¥${s.before.totalPayout} / 回収率${s.before.recoveryRate}%`);
      console.log(`    after : ${s.after.betPointsPerRace}点 / 投資¥${s.after.totalInvestment} / 払戻¥${s.after.totalPayout} / 回収率${s.after.recoveryRate}%`);
    }
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
