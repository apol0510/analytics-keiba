#!/usr/bin/env node

/**
 * アーカイブ同期検証スクリプト
 *
 * keiba-data-sharedの最新結果とarchiveResults.jsonの最新日付を比較し、
 * 同期ズレを検知する
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

/**
 * keiba-data-sharedから最新の結果日付を取得
 */
async function getLatestResultDate() {
  const today = new Date();
  const jstNow = new Date(today.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));

  // 過去30日分をチェック
  for (let i = 0; i < 30; i++) {
    const checkDate = new Date(jstNow);
    checkDate.setDate(checkDate.getDate() - i);
    const dateStr = checkDate.toISOString().split('T')[0];
    const [year, month] = dateStr.split('-');

    // 統合ファイルをチェック
    const unifiedUrl = `https://raw.githubusercontent.com/apol0510/keiba-data-shared/main/nankan/results/${year}/${month}/${dateStr}.json`;

    try {
      const response = await fetch(unifiedUrl);
      if (response.ok) {
        console.log(`📊 最新結果（統合ファイル）: ${dateStr}`);
        return { date: dateStr, source: 'unified' };
      }
    } catch (error) {
      // Continue to venue-specific files
    }

    // 会場別ファイルをチェック
    const venues = ['OOI', 'FUN', 'KAW', 'URA'];
    let totalRaces = 0;
    const foundVenues = [];

    for (const venue of venues) {
      const venueUrl = `https://raw.githubusercontent.com/apol0510/keiba-data-shared/main/nankan/results/${year}/${month}/${dateStr}-${venue}.json`;

      try {
        const response = await fetch(venueUrl);
        if (response.ok) {
          const data = await response.json();
          const raceCount = data.races?.length || 0;
          totalRaces += raceCount;
          foundVenues.push(`${venue}(${raceCount})`);
        }
      } catch (error) {
        // Venue not found, continue
      }
    }

    if (totalRaces >= 8) {
      console.log(`📊 最新結果（会場別）: ${dateStr} - ${totalRaces}レース (${foundVenues.join(', ')})`);
      return { date: dateStr, source: 'venue-specific', venues: foundVenues, races: totalRaces };
    }
  }

  throw new Error('過去30日間に結果データが見つかりませんでした');
}

/**
 * archiveResults.jsonから最新日付を取得
 */
function getLatestArchiveDate() {
  const archivePath = join(projectRoot, 'src', 'data', 'archiveResults.json');
  const content = readFileSync(archivePath, 'utf-8');
  const archive = JSON.parse(content);

  if (archive.length === 0) {
    throw new Error('archiveResults.jsonが空です');
  }

  const latestEntry = archive[0];
  console.log(`📚 最新アーカイブ: ${latestEntry.date} (${latestEntry.venue})`);

  return latestEntry.date;
}

/**
 * メイン処理
 */
async function main() {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📋 アーカイブ同期検証`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  try {
    // 1. 最新結果日付を取得
    const latestResult = await getLatestResultDate();
    const latestResultDate = latestResult.date;

    console.log();

    // 2. 最新アーカイブ日付を取得
    const latestArchiveDate = getLatestArchiveDate();

    console.log();

    // 3. 日付を比較
    const resultTime = new Date(latestResultDate).getTime();
    const archiveTime = new Date(latestArchiveDate).getTime();
    const diffDays = Math.floor((resultTime - archiveTime) / (1000 * 60 * 60 * 24));

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔍 同期状態チェック`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`   最新結果: ${latestResultDate} (${latestResult.source === 'unified' ? '統合ファイル' : `会場別: ${latestResult.venues.join(', ')}`})`);
    console.log(`   最新アーカイブ: ${latestArchiveDate}`);
    console.log(`   差分: ${diffDays}日`);
    console.log();

    if (diffDays === 0) {
      console.log(`✅ 同期OK: 最新結果がアーカイブに反映されています`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      process.exit(0);
    } else if (diffDays > 0) {
      // 不足日を列挙
      const missingDates = [];
      const archiveDate = new Date(latestArchiveDate);
      const resultDate = new Date(latestResultDate);

      for (let d = new Date(archiveDate); d < resultDate; d.setDate(d.getDate() + 1)) {
        missingDates.push(new Date(d).toISOString().split('T')[0]);
      }

      console.error(`❌ 同期ズレ検出: ${latestResultDate}の結果がアーカイブに反映されていません`);
      console.error(`   keiba-data-sharedには結果が存在しますが、archiveResults.jsonに追加されていません。`);
      console.error(`   自動インポートが失敗している可能性があります。`);
      console.error();
      console.error(`【不足している日付】`);
      missingDates.forEach(date => {
        console.error(`   - ${date}`);
      });
      console.error();
      console.error(`【対処方法】`);
      console.error(`   以下のコマンドで手動インポートを実行してください:`);
      console.error(`   node scripts/importResults.js --date ${latestResultDate}`);
      console.error();
      console.error(`【再発防止のために確認すること】`);
      console.error(`   1. GitHub Actions の Import Results (Dispatch) が実行されたか確認`);
      console.error(`   2. repository_dispatch イベントが送信されたか確認`);
      console.error(`   3. keiba-data-shared の dispatch-results-intelligence.yml を確認`);
      console.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      process.exit(1);
    } else {
      console.warn(`⚠️  警告: アーカイブの方が新しい日付です`);
      console.warn(`   これは通常起こりません。データの整合性を確認してください。`);
      console.warn(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      process.exit(1);
    }

  } catch (error) {
    console.error(`\n❌ エラーが発生しました: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

main();
