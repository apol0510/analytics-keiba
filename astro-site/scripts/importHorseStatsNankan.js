#!/usr/bin/env node
/**
 * importHorseStatsNankan.js
 *
 * keiba-data-shared の nankan/horseStats/YYYY/MM/YYYY-MM-DD-{VENUE}-R{NN}.json（uma_info 元表統計・raceNo別）
 * を本リポジトリの src/data/horseStats/nankan/YYYY/MM/{file} に転記する。
 *
 * ※ entries / recentHorseHistories とは別系統（別 script・別 data dir）。
 *   importEntriesNankan.js / importRecentHorseHistoriesNankan.js を雛形にした自己完結スクリプト。
 *   horseStats は **1会場=最大12ファイル（R01〜R12）** で entries（1会場1ファイル）と異なる。
 *
 * 取得方式（importEntriesNankan.js と同思想）:
 *   - 認証付き Contents API へ統一（匿名 raw 廃止）。token 未設定は取得前に fatal。
 *   - token 解決チェーンは sharedFetch helper 側に集約（KEIBA_DATA_SHARED_TOKEN 推奨）。
 *   - 401/403/レート/5xx/timeout は fatal（伝播）。optional な 404 のみ skip。
 *   - token 値は絶対に表示しない。
 *
 * 表示専用データ: featureScores / AI指数 / 印 / 買い目 / EV / recentRaces には一切接続しない。
 *
 * 使い方:
 *   node scripts/importHorseStatsNankan.js --date=2026-06-16 --venue=KAW --dry-run
 *   node scripts/importHorseStatsNankan.js --date=2026-06-16 --venue=KAW
 *   node scripts/importHorseStatsNankan.js --date=2026-06-16 --venues=OOI,KAW
 *
 * 終了コード: 取得/検証エラーあり → 4 / 1件も取得なし → 5 / 引数不正 → 2 / OK → 0。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createSharedClient, resolveSharedToken, SharedFetchError, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// keiba-data-shared 取得は認証付き Contents API へ統一（匿名 raw 廃止）。
// token 未設定は取得前に fatal（匿名 fallback 禁止）。
const DEFAULT_BRANCH = 'main';
const sharedClient = createSharedClient();
const DEFAULT_EXPECTED_RACES = 12;

const ALL_NANKAN_VENUES = ['OOI', 'KAW', 'FUN', 'URA'];
const NANKAN_VENUE_NAME_BY_CODE = { OOI: '大井', KAW: '川崎', FUN: '船橋', URA: '浦和' };

function parseArgs(argv) {
  const args = { date: null, venues: null, dryRun: false, sharedRef: DEFAULT_BRANCH, expectedRaces: DEFAULT_EXPECTED_RACES };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a.startsWith('--date=')) args.date = a.slice('--date='.length);
    else if (a === '--venue' || a === '--venues') args.venues = argv[++i];
    else if (a.startsWith('--venue=')) args.venues = a.slice('--venue='.length);
    else if (a.startsWith('--venues=')) args.venues = a.slice('--venues='.length);
    else if (a === '--shared-ref') args.sharedRef = argv[++i];
    else if (a.startsWith('--shared-ref=')) args.sharedRef = a.slice('--shared-ref='.length);
    else if (a.startsWith('--expected-races=')) args.expectedRaces = Number(a.slice('--expected-races='.length));
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

function resolveVenues(arg) {
  if (!arg) return ALL_NANKAN_VENUES;
  return arg.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

const rnnOf = (n) => `R${String(n).padStart(2, '0')}`;

function buildSharedPath(date, venue, n) {
  const [year, month] = date.split('-');
  return `nankan/horseStats/${year}/${month}/${date}-${venue}-${rnnOf(n)}.json`;
}
function buildLocalPath(date, venue, n) {
  const [year, month] = date.split('-');
  return join(projectRoot, 'src', 'data', 'horseStats', 'nankan', year, month, `${date}-${venue}-${rnnOf(n)}.json`);
}

function safePrefix(text, n = 80) {
  if (text == null) return '<null>';
  const s = String(text).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 認証付き Contents API 経由で本文を取得。404（未保存）は null（optional skip）。
 *  認証/権限/レート/サーバ/タイムアウト/INVALID は SharedFetchError として throw（fatal・匿名 fallback なし）。 */
async function fetchSharedRaw(sharedPath, ref, client = sharedClient) {
  return client.fetchText(sharedPath, { ref, required: false });
}

function parseJsonStrict(body) {
  if (body == null || body === '') throw new Error('empty body');
  const first = body.trimStart()[0];
  if (first !== '{' && first !== '[') throw new Error(`invalid JSON prefix: "${safePrefix(body)}"`);
  return JSON.parse(body);
}

/** horseStats 1ファイルの import 契約検証。不適合は throw。戻り値: horses 数。 */
function validateHorseStatsJson(json, venue, date, raceNo) {
  if (!json || typeof json !== 'object') throw new Error('not an object');
  if (json.dataType !== 'horseStats') throw new Error(`dataType mismatch: ${json.dataType}`);
  if (json.date !== date) throw new Error(`date mismatch: expected=${date}, file=${json.date}`);
  if (json.venueCode !== venue && json.venue !== venue) throw new Error(`venue mismatch: file venueCode=${json.venueCode}/venue=${json.venue}, expected=${venue}`);
  const expectedName = NANKAN_VENUE_NAME_BY_CODE[venue];
  if (expectedName && json.venue && json.venue !== expectedName && json.venueCode !== venue) throw new Error(`venue 名不整合: ${json.venue}`);
  if (json.raceNo !== raceNo) throw new Error(`raceNo mismatch: expected=${raceNo}, file=${json.raceNo}`);
  if (json.raceNumber !== json.raceNo) throw new Error(`raceNumber(${json.raceNumber}) != raceNo(${json.raceNo})`);
  const horses = json.horses;
  if (!Array.isArray(horses)) throw new Error('horses missing or not an array');
  if (json.totalHorses !== horses.length) throw new Error(`totalHorses(${json.totalHorses}) != horses.length(${horses.length})`);
  if (horses.length > 0 && !horses[0].horseStatsNankan) throw new Error('horses[0].horseStatsNankan missing');
  return horses.length;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error('❌ --date=YYYY-MM-DD が必要');
    process.exit(2);
  }
  if (!(args.expectedRaces >= 1 && args.expectedRaces <= 12)) {
    console.error('❌ --expected-races は 1〜12');
    process.exit(2);
  }
  const venues = resolveVenues(args.venues);
  // 取得前に token 必須化（未設定なら匿名 fallback せず即 fatal）。
  resolveSharedToken();

  console.log('📥 importHorseStatsNankan');
  console.log(`   date:    ${args.date}`);
  console.log(`   venues:  ${venues.join(', ')}`);
  console.log(`   races:   R01..R${String(args.expectedRaces).padStart(2, '0')}`);
  console.log(`   ref:     ${args.sharedRef}`);
  console.log(`   auth:    認証付き Contents API`);
  console.log(`   dry-run: ${args.dryRun ? 'YES' : 'NO'}`);
  console.log('');

  let filesFound = 0, totalHorses = 0, errors = 0, notFound = 0, wouldWrite = 0, written = 0;

  for (const venue of venues) {
    for (let n = 1; n <= args.expectedRaces; n++) {
      const sharedPath = buildSharedPath(args.date, venue, n);
      const localPath = buildLocalPath(args.date, venue, n);
      const label = `${venue} ${rnnOf(n)}`;
      try {
        const body = await fetchSharedRaw(sharedPath, args.sharedRef); // 404→null / auth等→throw
        if (body === null) { console.log(`  ${label}: skip (404 ${sharedPath})`); notFound++; continue; }
        const json = parseJsonStrict(body);
        const horses = validateHorseStatsJson(json, venue, args.date, n);
        filesFound++; totalHorses += horses;
        if (args.dryRun) {
          console.log(`  ${label}: OK (dry-run, horses=${horses}, would write ${localPath.replace(projectRoot, '.')})`);
          wouldWrite++;
        } else {
          mkdirSync(dirname(localPath), { recursive: true });
          writeFileSync(localPath, JSON.stringify(json, null, 2), 'utf-8');
          console.log(`  ${label}: saved (horses=${horses}) -> ${localPath.replace(projectRoot, '.')}`);
          written++;
        }
      } catch (e) {
        // 認証/権限/レート/サーバ/タイムアウト/INVALID 等は fatal（伝播・partial write なし）。
        if (e instanceof SharedFetchError && e.code !== SHARED_FETCH_CODES.NOT_FOUND) throw e;
        console.log(`  ${label}: ERROR ${e.message}`);
        errors++;
      }
    }
  }

  console.log('');
  console.log(`━━━ filesFound=${filesFound} totalHorses=${totalHorses} errors=${errors} notFound=${notFound} wouldWrite=${wouldWrite} written=${written} ━━━`);

  if (errors > 0) { console.error('❌ 取得/検証エラーあり'); process.exit(4); }
  if (filesFound === 0) { console.error('❌ 1件も取得なし'); process.exit(5); }
}

// 直接実行時のみ起動（import 時は実行しない＝テスト可能）。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((e) => {
    // レート制限・timeout・5xx は「今は確定できない」だけ＝deferred。
    // sharedFetch 側で回復時刻ぶんの bounded retry を尽くした後にここへ来る。
    // 人間に再実行を求めず、workflow は failure にしない（次回の自動実行で追いつく）。
    // auth / 権限 / schema / 検証失敗は従来どおり fail-closed（exit 1）。
    // exit 2 は既に「引数エラー」で使われているため、慣例の EX_TEMPFAIL=75 を用いる。
    const DEFERRABLE = new Set([
      SHARED_FETCH_CODES.RATE_LIMITED,
      SHARED_FETCH_CODES.TIMEOUT,
      SHARED_FETCH_CODES.SERVER_ERROR,
    ]);
    if (e instanceof SharedFetchError && DEFERRABLE.has(e.code)) {
      console.error(`DEFERRED: ${e.code} — 一時的に取得できないため中断（未書込・次回再試行）`);
      console.error(`  path: ${e.path ?? '-'}`);
      process.exit(75);
    }
    console.error('FATAL:', e);
    process.exit(1);
  });
}

export { fetchSharedRaw, validateHorseStatsJson, buildSharedPath, buildLocalPath };
