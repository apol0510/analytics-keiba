#!/usr/bin/env node

/**
 * アーカイブ同期検証スクリプト
 *
 * keiba-data-shared の南関結果と archiveResults.json の最新日付を比較し、
 * 「インポート可能なのに未反映」の日付だけを同期ズレとして検知する。
 *
 * 判定ルール:
 *   NG条件（差分扱い）: 南関開催あり かつ ローカル予想あり かつ archive未反映
 *   OK条件（スキップ）: 南関開催なし / 予想未作成
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createSharedClient, resolveSharedToken } from './lib/sharedFetch.mjs';
import { exitDeferredOrFatal } from './lib/sharedCheckerSupport.mjs';

const LABEL = 'verifyArchiveSync.js';

// keiba-data-shared 取得は認証付き Contents API へ統一（匿名 raw 廃止・匿名 fallback 禁止）。
const SHARED_REF = 'main';
const sharedClient = createSharedClient();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const NANKAN_VENUES = ['OOI', 'FUN', 'KAW', 'URA'];
const MIN_RACES_THRESHOLD = 8;

async function checkNankanResults(dateStr) {
  const [year, month] = dateStr.split('-');
  const venues = [];
  let totalRaces = 0;

  const dir = `nankan/results/${year}/${month}`;

  // 統合ファイル（任意）: 404 は会場別へフォールバック。
  // 認証/権限/レート/5xx/timeout は SharedFetchError として throw（fatal・匿名 fallback なし）。
  const unified = await sharedClient.fetchJson(`${dir}/${dateStr}.json`, { ref: SHARED_REF, required: false });
  if (unified) {
    const raceCount = unified.races?.length || 0;
    totalRaces = raceCount;
    venues.push({ code: 'unified', races: raceCount });
    return { hasResults: totalRaces >= MIN_RACES_THRESHOLD, totalRaces, venues };
  }

  for (const code of NANKAN_VENUES) {
    // 会場別（任意）: 404 のみ未投入として skip。認証/通信エラーは throw（fatal 伝播）。
    const data = await sharedClient.fetchJson(`${dir}/${dateStr}-${code}.json`, { ref: SHARED_REF, required: false });
    if (data) {
      const raceCount = data.races?.length || 0;
      totalRaces += raceCount;
      venues.push({ code, races: raceCount });
    }
  }

  return { hasResults: totalRaces >= MIN_RACES_THRESHOLD, totalRaces, venues };
}

function formatVenues(venues) {
  return venues.map(v => `${v.code}(${v.races})`).join(', ');
}

function hasLocalPrediction(dateStr, venues) {
  const [year, month] = dateStr.split('-');
  const predictionsDir = join(projectRoot, 'src', 'data', 'predictions');

  for (const { code } of venues) {
    if (code === 'unified') continue;
    const filePath = join(predictionsDir, `${dateStr}-${code.toLowerCase()}.json`);
    if (existsSync(filePath)) return true;
  }

  const oldFormatPath = join(predictionsDir, year, month, `${dateStr}.json`);
  if (existsSync(oldFormatPath)) return true;

  return false;
}

async function getLatestResultDate() {
  const today = new Date();
  const jstNow = new Date(today.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));

  for (let i = 0; i < 30; i++) {
    const checkDate = new Date(jstNow);
    checkDate.setDate(checkDate.getDate() - i);
    const dateStr = checkDate.toISOString().split('T')[0];

    const info = await checkNankanResults(dateStr);
    if (info.hasResults) {
      console.log(`📊 最新南関結果: ${dateStr} - ${info.totalRaces}レース (${formatVenues(info.venues)})`);
      return { date: dateStr, ...info };
    }
  }

  throw new Error('過去30日間に南関の結果データが見つかりませんでした');
}

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

async function main() {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📋 アーカイブ同期検証`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  try {
    // private 化後に備え、開始直後に token を必須化（未設定なら匿名 fallback せず即 fatal）。
    resolveSharedToken();

    const latestResult = await getLatestResultDate();
    const latestResultDate = latestResult.date;

    console.log();

    const latestArchiveDate = getLatestArchiveDate();

    console.log();
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔍 同期状態チェック`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`   最新結果:     ${latestResultDate} (${formatVenues(latestResult.venues)})`);
    console.log(`   最新アーカイブ: ${latestArchiveDate}`);

    if (new Date(latestArchiveDate).getTime() >= new Date(latestResultDate).getTime()) {
      console.log();
      console.log(`✅ 同期OK: 最新結果がアーカイブに反映されています`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      process.exit(0);
    }

    const startDate = new Date(latestArchiveDate);
    startDate.setDate(startDate.getDate() + 1);
    const endDate = new Date(latestResultDate);

    console.log(`   対象期間:     ${startDate.toISOString().split('T')[0]} 〜 ${latestResultDate}`);
    console.log();
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔎 期間内の日付を分類`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const missing = [];
    const skippedNoRace = [];
    const skippedNoPrediction = [];

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = new Date(d).toISOString().split('T')[0];
      const info = await checkNankanResults(dateStr);

      if (!info.hasResults) {
        skippedNoRace.push(dateStr);
        console.log(`   ⏭️  ${dateStr}: スキップ（南関開催なし）`);
        continue;
      }

      if (!hasLocalPrediction(dateStr, info.venues)) {
        skippedNoPrediction.push({ date: dateStr, venues: info.venues });
        console.log(`   ⏭️  ${dateStr}: スキップ（予想未作成 / ${formatVenues(info.venues)}）`);
        continue;
      }

      missing.push({ date: dateStr, venues: info.venues });
      console.log(`   ❌ ${dateStr}: 未反映（${formatVenues(info.venues)}）`);
    }

    console.log();

    if (missing.length === 0) {
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`✅ 同期OK: インポート対象の未反映日付はありません`);
      if (skippedNoRace.length > 0) {
        console.log(`   南関開催なし: ${skippedNoRace.length}日 (${skippedNoRace.join(', ')})`);
      }
      if (skippedNoPrediction.length > 0) {
        const dates = skippedNoPrediction.map(s => s.date).join(', ');
        console.log(`   予想未作成:   ${skippedNoPrediction.length}日 (${dates})`);
      }
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      process.exit(0);
    }

    console.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.error(`❌ 同期ズレ検出: インポート可能だが未反映の日付が ${missing.length}件 あります`);
    console.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.error();
    console.error(`【未反映の日付】`);
    missing.forEach(({ date, venues }) => {
      console.error(`   - ${date} (${formatVenues(venues)})`);
    });
    console.error();
    console.error(`【対処方法】`);
    console.error(`   以下のコマンドで手動インポートを実行してください:`);
    missing.forEach(({ date }) => {
      console.error(`   node scripts/importResults.js --date ${date}`);
    });
    console.error();
    console.error(`【再発防止のために確認すること】`);
    console.error(`   1. GitHub Actions の Import Results (Dispatch) が実行されたか確認`);
    console.error(`   2. repository_dispatch イベントが送信されたか確認`);
    console.error(`   3. keiba-data-shared の dispatch-results-intelligence.yml を確認`);
    console.error(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    process.exit(1);

  } catch (error) {
    // 一時失敗(rate limit/timeout/5xx)は exit 75 で deferred、それ以外は fail-closed。
    exitDeferredOrFatal(error, { label: LABEL });
  }
}

main();
