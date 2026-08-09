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
 *   （shared 取得も import 実行も両方 catch する。2026-08-09 以前は shared 取得が
 *     try の外にあり、GET が1回 throw しただけで run 全体が exit 1 になっていた）
 * - shared 取得の一時エラー（rate limit / timeout / 5xx）は workflow を failure にしない。
 *   1日3回走る自己回復型なので次回実行で追いつき、恒常的な欠落は verify-archive-sync.yml が拾う。
 *   token 未設定・認証失敗・権限不足は運用者の対応が要るので従来どおり exit 1。
 * - 月ディレクトリ一覧を1回取り、ファイルが無い日には GET を撃たない（API 枠の消費を抑える）
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
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn } from 'child_process';
import { createSharedClient, resolveSharedToken, SharedFetchError, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';

// keiba-data-shared 存在確認は認証付き Contents API へ統一（匿名 raw 廃止・匿名 fallback 禁止）。
const SHARED_REF = 'main';
const sharedClient = createSharedClient();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const NANKAN_VENUES = ['OOI', 'FUN', 'KAW', 'URA'];
const JRA_VENUES = ['TOK', 'KYO', 'HAN', 'NAK', 'CHU', 'KOK', 'NII', 'FKS', 'SAP', 'HKD'];
const MIN_RACES_NANKAN = 8;
const MIN_RACES_JRA = 10;

/**
 * 一時的な取得失敗（枠の回復や相手側の復旧を待てば直るもの）。
 * sharedFetch の RETRYABLE_CODES と同じ分類を使う。
 * これらは workflow を failure にしない（本 workflow は1日3回走る自己回復型で、
 * 恒常的な archive 欠落は verify-archive-sync.yml が別途検出する）。
 * 逆に TOKEN_MISSING / AUTH_FAILED / FORBIDDEN は運用者が手を入れないと直らないので fatal のまま。
 */
const TRANSIENT_CODES = new Set([
  SHARED_FETCH_CODES.RATE_LIMITED,
  SHARED_FETCH_CODES.TIMEOUT,
  SHARED_FETCH_CODES.SERVER_ERROR,
]);

/**
 * 一時エラーがこの回数連続したら、その track の走査を打ち切る。
 * レート制限中に残り日数ぶん撃ち続けると制限をさらに悪化させるため。
 */
const MAX_CONSECUTIVE_TRANSIENT = 3;

/**
 * Contents API のディレクトリ一覧は 1000 件が上限でページングできない。
 * 到達した月は一覧を信用せず、従来どおり per-venue GET へ落とす（取りこぼしを作らない）。
 */
const DIR_LISTING_MAX = 1000;

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

// shared の results JSON を取得（任意）。404 は null（未投入）。
// 認証/権限/レート/5xx/timeout は SharedFetchError として throw（fatal・匿名 fallback なし）。
async function fetchSharedJson(sharedPath, client = sharedClient) {
  return client.fetchJson(sharedPath, { ref: SHARED_REF, required: false });
}

/**
 * 月ディレクトリのファイル名一覧を1回だけ取得して cache する。
 *
 * 従来は 1日あたり「統合1 + 会場10 = 11 GET」を、非開催日と分かっていても撃っていた。
 * 14日走査だと 150 GET 超が毎回・ほぼ全部 404 で、apol0510 アカウントの API 枠を
 * 無駄に削っていた（2026-08-09 に KI/AK が同時刻に 403 で共倒れした一因）。
 * 一覧 1 GET で「その日にファイルがあるか」が分かるので、無い日は GET を撃たない。
 *
 * @returns {Promise<Set<string>|null>} ファイル名の集合。null は「一覧を信用しない」＝従来経路へ。
 */
async function listMonthFiles(dir, client, cache) {
  if (cache.has(dir)) return cache.get(dir);

  const entries = await client.listDirectory(dir, { ref: SHARED_REF, required: false });

  let names;
  if (entries === null) {
    names = new Set(); // 月ディレクトリ自体が無い＝その月は結果ゼロ
  } else if (entries.length >= DIR_LISTING_MAX) {
    names = null; // 一覧が切り詰められている可能性 → 従来の per-venue GET へ
  } else {
    names = new Set(entries.filter((e) => e.type === 'file').map((e) => e.name));
  }

  cache.set(dir, names);
  return names;
}

async function checkSharedResults(date, track, { client = sharedClient, listingCache } = {}) {
  const [year, month] = date.split('-');
  const dir = `${track}/results/${year}/${month}`;

  // listingCache 未指定（＝一覧を使わない呼び出し）では names=null となり、
  // exists() が常に true を返すので従来どおり全ファイルへ GET する。
  const names = listingCache ? await listMonthFiles(dir, client, listingCache) : null;
  const exists = (fileName) => names === null || names.has(fileName);

  if (exists(`${date}.json`)) {
    const unified = await fetchSharedJson(`${dir}/${date}.json`, client);
    if (unified && Array.isArray(unified.races) && unified.races.length > 0) {
      return { totalRaces: unified.races.length, venues: [unified.venue || 'unified'] };
    }
  }

  const venues = track === 'nankan' ? NANKAN_VENUES : JRA_VENUES;
  let totalRaces = 0;
  const foundVenues = [];

  for (const code of venues) {
    if (!exists(`${date}-${code}.json`)) continue;
    const data = await fetchSharedJson(`${dir}/${date}-${code}.json`, client);
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

async function processTrack(track, dates, archivedDates, dryRun, deps = {}) {
  const trackLabel = track === 'nankan' ? '南関' : 'JRA';
  const minRaces = track === 'nankan' ? MIN_RACES_NANKAN : MIN_RACES_JRA;

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🏇 ${trackLabel} 走査開始（対象 ${dates.length}日）`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  const summary = { success: [], skipNoRace: [], skipArchived: [], skipNoPrediction: [], transient: [], errors: [] };
  const listingCache = new Map();
  let consecutiveTransient = 0;

  for (const date of dates) {
    if (archivedDates.has(date)) {
      summary.skipArchived.push(date);
      console.log(`   ⏭️  ${date}: 既に archive 済み`);
      continue;
    }

    let info;
    try {
      info = await checkSharedResults(date, track, { ...deps, listingCache });
      consecutiveTransient = 0;
    } catch (error) {
      // 一時エラーは「その日をスキップして次回実行に委ねる」。全体を失敗にしない。
      // token/認証/権限のエラーはここで握り潰さず throw し、main の catch で exit 1 になる。
      if (!(error instanceof SharedFetchError) || !TRANSIENT_CODES.has(error.code)) throw error;

      summary.transient.push({ date, code: error.code });
      consecutiveTransient++;
      console.log(`   ⚠️  ${date}: 一時エラー（${error.code}）— 次回実行で再試行`);

      if (consecutiveTransient >= MAX_CONSECUTIVE_TRANSIENT) {
        const remaining = dates.slice(dates.indexOf(date) + 1).filter((d) => !archivedDates.has(d));
        for (const d of remaining) summary.transient.push({ date: d, code: 'SKIPPED_AFTER_TRANSIENT' });
        console.log(`   ⏹️  一時エラーが${MAX_CONSECUTIVE_TRANSIENT}回連続したため ${trackLabel} の走査を中断（残り${remaining.length}日は次回実行へ）`);
        break;
      }
      continue;
    }

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
  let totalTransient = 0;

  for (const { track, summary } of trackResults) {
    console.log(`\n【${track}】`);
    console.log(`   ✅ 成功:            ${summary.success.length}日` + (summary.success.length > 0 ? ` (${summary.success.map(s => s.date).join(', ')})` : ''));
    console.log(`   ⏭️  archive済みスキップ: ${summary.skipArchived.length}日`);
    console.log(`   ⏭️  開催なしスキップ:    ${summary.skipNoRace.length}日`);
    console.log(`   ⏭️  予想未作成スキップ:  ${summary.skipNoPrediction.length}日` + (summary.skipNoPrediction.length > 0 ? ` (${summary.skipNoPrediction.join(', ')})` : ''));
    console.log(`   ⚠️  一時エラー:       ${summary.transient.length}日` + (summary.transient.length > 0 ? ` (${summary.transient.map(t => `${t.date}: ${t.code}`).join(' / ')})` : ''));
    console.log(`   ❌ エラー:           ${summary.errors.length}日` + (summary.errors.length > 0 ? ` (${summary.errors.map(e => `${e.date}: ${e.reason}`).join(' / ')})` : ''));
    totalErrors += summary.errors.length;
    totalTransient += summary.transient.length;
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  if (totalErrors === 0 && totalTransient === 0) {
    console.log(`✅ 全処理完了（エラーなし）`);
  } else if (totalErrors === 0) {
    console.log(`⚠️  ${totalTransient}日が一時エラーで未処理（workflow は成功扱い。次回実行で再試行し、恒常的な欠落は verify-archive-sync が検出する）`);
  } else {
    console.log(`⚠️  ${totalErrors}件のエラーあり（他の日の処理は継続済み）` + (totalTransient > 0 ? ` / 一時エラー ${totalTransient}日` : ''));
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  return totalErrors;
}

async function main() {
  // private 化後に備え、開始直後に token を必須化（未設定なら匿名 fallback せず即 fatal）。
  resolveSharedToken();

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

// テスト用 export（CLI動作は変えない。isDirectRun ガードで main は直接実行時のみ起動する）
export { checkSharedResults, processTrack };

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`\n❌ 致命的エラー: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
}
