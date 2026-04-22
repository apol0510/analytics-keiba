#!/usr/bin/env node

/**
 * 統合アーカイブ同期スクリプト（自己回復型）
 *
 * 直近N日（デフォルト14日）を毎回走査し、
 * 「keiba-data-shared に結果があるのに archive 未反映」の日を自動で埋める。
 *
 * - 南関（archiveResults.json）と JRA（archiveResultsJra.json）を1本で扱う
 * - 既存の importResults.js / importResultsJra.js を child_process で呼ぶ
 *   （既存ロジックを壊さない）
 * - 日付ごとに try/catch。1日失敗しても全体は継続
 * - prediction 未作成日は archive に書かない（UI整合性のため）
 *   → その日は importer 側が exit 0 でスキップ。後日 prediction が追加されれば
 *     次の日次実行で自動的に取り込まれる
 * - 最後に success/skip/error を集計表示
 *
 * Usage:
 *   node scripts/syncArchiveResults.js
 *   node scripts/syncArchiveResults.js --days 30
 *   node scripts/syncArchiveResults.js --dry-run
 *   node scripts/syncArchiveResults.js --tracks nankan     # nankan のみ
 *   node scripts/syncArchiveResults.js --tracks jra        # JRA のみ
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const NANKAN_VENUES = ['OOI', 'FUN', 'KAW', 'URA'];
const JRA_VENUES = ['TOK', 'KYO', 'HAN', 'NAK', 'CHU', 'KOK', 'NII', 'FKS', 'SAP', 'HKD'];
const MIN_RACES_NANKAN = 8;
const MIN_RACES_JRA = 10;

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { days: 14, dryRun: false, tracks: ['nankan', 'jra'] };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      result.days = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--dry-run') {
      result.dryRun = true;
    } else if (args[i] === '--tracks' && args[i + 1]) {
      result.tracks = args[i + 1].split(',').map(s => s.trim());
      i++;
    }
  }

  return result;
}

function getDateRange(days) {
  const today = new Date();
  const jstNow = new Date(today.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));

  // 古い日付 → 新しい日付の順で返す。
  // importResults.js (nankan) は archive.unshift() なので、最後に処理した日付が
  // archive[0] に来る。最新日を archive[0] に置くため昇順に処理する必要がある。
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(jstNow);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

function loadArchiveDates(archiveFileName) {
  const path = join(projectRoot, 'src', 'data', archiveFileName);
  if (!existsSync(path)) return new Set();

  try {
    const archive = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(archive)) return new Set();
    return new Set(archive.map(e => e.date).filter(Boolean));
  } catch (error) {
    console.error(`⚠️  ${archiveFileName} の読み込みに失敗: ${error.message}`);
    return new Set();
  }
}

async function fetchJson(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    return null;
  }
}

async function checkSharedResults(date, track) {
  const [year, month] = date.split('-');
  const base = `https://raw.githubusercontent.com/apol0510/keiba-data-shared/main/${track}/results/${year}/${month}`;

  const unified = await fetchJson(`${base}/${date}.json`);
  if (unified && Array.isArray(unified.races) && unified.races.length > 0) {
    return { totalRaces: unified.races.length, venues: [unified.venue || 'unified'] };
  }

  const venues = track === 'nankan' ? NANKAN_VENUES : JRA_VENUES;
  let totalRaces = 0;
  const foundVenues = [];

  for (const code of venues) {
    const data = await fetchJson(`${base}/${date}-${code}.json`);
    if (data && Array.isArray(data.races)) {
      totalRaces += data.races.length;
      foundVenues.push(code);
    }
  }

  return { totalRaces, venues: foundVenues };
}

function runImporter(track, date) {
  return new Promise((resolve) => {
    const script = track === 'nankan' ? 'importResults.js' : 'importResultsJra.js';
    const scriptPath = join(__dirname, script);

    const child = spawn('node', [scriptPath, '--date', date], {
      cwd: projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    child.on('error', (error) => {
      resolve({ code: -1, stdout, stderr: stderr + `\nspawn error: ${error.message}` });
    });
  });
}

function classifyImportOutcome(result) {
  const combined = result.stdout + '\n' + result.stderr;

  if (result.code === 0 && /処理完了: 予想データなし/.test(combined)) {
    return { status: 'skip', reason: '予想未作成' };
  }
  if (result.code === 0 && /Post-check成功|アーカイブ保存完了/.test(combined)) {
    return { status: 'success', reason: 'archiveに追加' };
  }
  if (result.code === 0) {
    return { status: 'success', reason: '完了（詳細不明）' };
  }
  if (/結果データが見つかりません/.test(combined)) {
    return { status: 'skip', reason: '結果データ無し' };
  }
  return { status: 'error', reason: `exit=${result.code}`, log: combined.slice(-500) };
}

async function processTrack(track, dates, archivedDates, dryRun) {
  const trackLabel = track === 'nankan' ? '南関' : 'JRA';
  const minRaces = track === 'nankan' ? MIN_RACES_NANKAN : MIN_RACES_JRA;

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🏇 ${trackLabel} 走査開始（対象 ${dates.length}日）`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  const summary = { success: [], skipNoRace: [], skipArchived: [], skipNoPrediction: [], errors: [] };

  for (const date of dates) {
    if (archivedDates.has(date)) {
      summary.skipArchived.push(date);
      console.log(`   ⏭️  ${date}: 既に archive 済み`);
      continue;
    }

    const info = await checkSharedResults(date, track);
    if (info.totalRaces < minRaces) {
      summary.skipNoRace.push(date);
      if (info.totalRaces === 0) {
        console.log(`   ⏭️  ${date}: 開催なし`);
      } else {
        console.log(`   ⏭️  ${date}: レース数不足（${info.totalRaces} < ${minRaces}）`);
      }
      continue;
    }

    if (dryRun) {
      console.log(`   🔸 ${date}: [dry-run] import対象 (${info.totalRaces}R / ${info.venues.join(',')})`);
      summary.success.push({ date, dryRun: true });
      continue;
    }

    console.log(`   📥 ${date}: import 実行中... (${info.totalRaces}R / ${info.venues.join(',')})`);
    try {
      const result = await runImporter(track, date);
      const outcome = classifyImportOutcome(result);

      if (outcome.status === 'success') {
        summary.success.push({ date, reason: outcome.reason });
        console.log(`      ✅ ${outcome.reason}`);
      } else if (outcome.status === 'skip') {
        if (outcome.reason === '予想未作成') {
          summary.skipNoPrediction.push(date);
        } else {
          summary.skipNoRace.push(date);
        }
        console.log(`      ⏭️  スキップ: ${outcome.reason}`);
      } else {
        summary.errors.push({ date, reason: outcome.reason, log: outcome.log });
        console.log(`      ❌ エラー: ${outcome.reason}`);
        if (outcome.log) {
          console.log(`         ${outcome.log.split('\n').slice(-5).join('\n         ')}`);
        }
      }
    } catch (error) {
      summary.errors.push({ date, reason: error.message });
      console.log(`      ❌ 例外: ${error.message}`);
    }
  }

  return { track: trackLabel, summary };
}

function printFinalSummary(trackResults, dryRun) {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📊 同期結果サマリー${dryRun ? '（DRY RUN）' : ''}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  let totalErrors = 0;

  for (const { track, summary } of trackResults) {
    console.log(`\n【${track}】`);
    console.log(`   ✅ 成功:            ${summary.success.length}日` + (summary.success.length > 0 ? ` (${summary.success.map(s => s.date).join(', ')})` : ''));
    console.log(`   ⏭️  archive済みスキップ: ${summary.skipArchived.length}日`);
    console.log(`   ⏭️  開催なしスキップ:    ${summary.skipNoRace.length}日`);
    console.log(`   ⏭️  予想未作成スキップ:  ${summary.skipNoPrediction.length}日` + (summary.skipNoPrediction.length > 0 ? ` (${summary.skipNoPrediction.join(', ')})` : ''));
    console.log(`   ❌ エラー:           ${summary.errors.length}日` + (summary.errors.length > 0 ? ` (${summary.errors.map(e => `${e.date}: ${e.reason}`).join(' / ')})` : ''));
    totalErrors += summary.errors.length;
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  if (totalErrors === 0) {
    console.log(`✅ 全処理完了（エラーなし）`);
  } else {
    console.log(`⚠️  ${totalErrors}件のエラーあり（他の日の処理は継続済み）`);
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  return totalErrors;
}

async function main() {
  const args = parseArgs();
  const dates = getDateRange(args.days);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🔄 archive 統合同期`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`   走査日数: ${args.days}日（${dates[dates.length - 1]} 〜 ${dates[0]}）`);
  console.log(`   対象:     ${args.tracks.join(', ')}`);
  if (args.dryRun) console.log(`   モード:   DRY RUN (import は実行しない)`);

  const trackResults = [];

  if (args.tracks.includes('nankan')) {
    const archived = loadArchiveDates('archiveResults.json');
    console.log(`\n📚 archiveResults.json: ${archived.size}件の既存エントリ`);
    trackResults.push(await processTrack('nankan', dates, archived, args.dryRun));
  }

  if (args.tracks.includes('jra')) {
    const archived = loadArchiveDates('archiveResultsJra.json');
    console.log(`\n📚 archiveResultsJra.json: ${archived.size}件の既存エントリ`);
    trackResults.push(await processTrack('jra', dates, archived, args.dryRun));
  }

  const errorCount = printFinalSummary(trackResults, args.dryRun);

  // 日付ごとのエラーは全体失敗にしない（自己回復型の方針）
  // ただし1日もimport/skipできなかった異常ケースだけは非ゼロで返す
  const anyProcessed = trackResults.some(tr => {
    const s = tr.summary;
    return s.success.length + s.skipArchived.length + s.skipNoRace.length + s.skipNoPrediction.length > 0;
  });

  if (!anyProcessed && errorCount > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(`\n❌ 致命的エラー: ${error.message}`);
  console.error(error);
  process.exit(1);
});
