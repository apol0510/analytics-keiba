#!/usr/bin/env node
/**
 * importHorseHistoriesJra.js
 *
 * keiba-data-shared の jra/horseHistories/YYYY/MM/YYYY-MM-DD-{VENUE}.json を
 * 本リポジトリの astro-site/src/data/horseHistories/jra/YYYY/MM/{file} に転記する。
 *
 * 取得方式（PR-AK-4 で認証付き shared-fetch helper へ統一）:
 *   - 認証必須: 開始直後に resolveSharedToken() で token を必須化（匿名 fallback 廃止）。
 *   - listDirectory() で月ディレクトリを列挙し、対象 venue の entry を取得。
 *   - fetchJsonFromEntry() で本文取得。≤1MB は Contents API raw、>1MB は
 *     git blobs API（base64）へ helper が entry.size/entry.sha を見て自動切替する。
 *     （horseHistories には 1MB 超のファイルが多数あり Contents raw では取得不可）
 *   - token 解決順は helper（KEIBA_DATA_SHARED_TOKEN 推奨）に委譲。
 *
 * 使い方:
 *   node scripts/importHorseHistoriesJra.js --date 2026-05-24
 *   node scripts/importHorseHistoriesJra.js --date 2026-05-24 --venues TOK,KYO,NII
 *   node scripts/importHorseHistoriesJra.js --date 2026-05-24 --dry-run
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedClient, resolveSharedToken, SharedFetchError, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// keiba-data-shared 取得は認証付き helper へ統一（匿名 raw 廃止・token 未設定 fatal）。
const SHARED_REF = 'main';
const sharedClient = createSharedClient();

const ALL_JRA_VENUES = ['TOK', 'NAK', 'KYO', 'HAN', 'CHU', 'KOK', 'NII', 'FKS', 'SAP', 'HKD'];

function parseArgs(argv) {
  const args = { date: null, venues: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a.startsWith('--date=')) args.date = a.slice('--date='.length);
    else if (a === '--venues') args.venues = argv[++i];
    else if (a.startsWith('--venues=')) args.venues = a.slice('--venues='.length);
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

function resolveVenues(arg) {
  if (!arg) return ALL_JRA_VENUES;
  return arg.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function buildFileName(date, venue) {
  return `${date}-${venue}.json`;
}

function buildLocalPath(date, venue) {
  const [year, month] = date.split('-');
  return join(projectRoot, 'src', 'data', 'horseHistories', 'jra', year, month, `${date}-${venue}.json`);
}

function validateHorseHistoriesJson(json, expectedVenue, expectedDate) {
  if (!json || typeof json !== 'object') throw new Error('not an object');
  if (json.source !== 'jra-official') throw new Error(`unexpected source: ${json.source}`);
  if (json.date !== expectedDate) throw new Error(`date mismatch: payload=${expectedDate}, file=${json.date}`);
  if (json.venueCode !== expectedVenue) throw new Error(`venueCode mismatch: expected=${expectedVenue}, file=${json.venueCode}`);
  if (!json.horses || typeof json.horses !== 'object') throw new Error('horses missing or not an object');
  return true;
}

/**
 * 指定日の対象 venue の horseHistories JSON を取得する。
 *
 * 月ディレクトリの一覧を 1 回だけ取得（任意=required:false。月ディレクトリが
 * まだ無ければ null を返し、呼び出し側は全 venue skip 扱い）。一覧済みの
 * 各 entry は required:true で本文取得し、≤1MB/>1MB の振り分けは helper の
 * fetchJsonFromEntry が entry.size/entry.sha を見て透過的に行う。
 *
 * 認証/権限/レート/5xx/timeout/INVALID_RESPONSE/INVALID_JSON/FILE_TOO_LARGE、および一覧済み
 * ファイルの 404 は SharedFetchError として throw（fatal・匿名 fallback なし）。
 *
 * @returns {Promise<null|Array<{venue,name,found,json?,size?,year?,month?}>>}
 *   月ディレクトリが無ければ null。あれば venue ごとの結果配列。
 */
export async function fetchHorseHistoriesForDate(date, venues, client = sharedClient) {
  const [year, month] = date.split('-');
  const dirPath = `jra/horseHistories/${year}/${month}`;

  const listing = await client.listDirectory(dirPath, { ref: SHARED_REF, required: false });
  if (listing === null) return null; // 月ディレクトリ未投入（optional 404 のみ許容する silent skip）

  const byName = new Map(listing.map((e) => [e.name, e]));

  const results = [];
  for (const venue of venues) {
    const name = buildFileName(date, venue);
    const entry = byName.get(name);
    if (!entry) {
      // 一覧に無い = その venue のファイルは未投入。skip（fatal ではない）。
      results.push({ venue, name, found: false });
      continue;
    }
    // 一覧済み entry の本文取得。required:true なので 404 は fatal。
    // ≤1MB は Contents raw / >1MB は git blobs API（base64）へ helper が自動切替。
    const json = await client.fetchJsonFromEntry(entry, { ref: SHARED_REF, required: true });
    results.push({ venue, name, found: true, json, size: entry.size, year, month });
  }
  return results;
}

async function main() {
  // private 化に備え、開始直後に token を必須化（未設定なら匿名 fallback せず即 fatal）。
  resolveSharedToken();

  const args = parseArgs(process.argv);
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error('❌ --date YYYY-MM-DD が必要');
    process.exit(2);
  }
  const venues = resolveVenues(args.venues);

  console.log(`📥 importHorseHistoriesJra`);
  console.log(`   date:    ${args.date}`);
  console.log(`   venues:  ${venues.join(', ')}`);
  console.log(`   auth:    Contents/Blobs API (authenticated shared-fetch)`);
  console.log(`   dry-run: ${args.dryRun ? 'YES' : 'NO'}`);
  console.log('');

  let savedCount = 0;
  let skippedCount = 0;

  // 取得を先に完走させる（fatal は write 前に throw → 部分書き込みを防止）。
  const results = await fetchHorseHistoriesForDate(args.date, venues);

  if (results === null) {
    for (const venue of venues) {
      console.log(`  ${venue}: skip (月ディレクトリ未投入: jra/horseHistories/${args.date.slice(0, 4)}/${args.date.slice(5, 7)})`);
      skippedCount++;
    }
  } else {
    for (const r of results) {
      process.stdout.write(`  ${r.venue}: `);
      if (!r.found) {
        console.log(`skip (keiba-data-shared に未投入: ${r.name})`);
        skippedCount++;
        continue;
      }
      validateHorseHistoriesJson(r.json, r.venue, args.date);
      const horseCount = Object.keys(r.json.horses || {}).length;
      const localPath = buildLocalPath(args.date, r.venue);
      if (args.dryRun) {
        console.log(`OK (dry-run, horses=${horseCount}, would write ${localPath.replace(projectRoot, '.')})`);
        savedCount++;
        continue;
      }
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, JSON.stringify(r.json, null, 2), 'utf-8');
      console.log(`saved (horses=${horseCount}) -> ${localPath.replace(projectRoot, '.')}`);
      savedCount++;
    }
  }

  console.log('');
  console.log(`━━━ サマリ: saved=${savedCount} skipped=${skippedCount} ━━━`);

  if (savedCount === 0) {
    console.error('❌ 1件も保存されなかった (すべて未投入?)');
    process.exit(5);
  }
}

// 直接実行時のみ起動（import 時は実行しない＝テスト可能）。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((e) => {
    // SharedFetchError は token・秘密値を含めない設計（message のみ表示）。
    if (e instanceof SharedFetchError) {
      console.error(`❌ shared-fetch ${e.code}: ${e.message}`);
      if (e.code === SHARED_FETCH_CODES.TOKEN_MISSING) {
        console.error('   ヒント: keiba-data-shared 用の token が未設定です。');
        console.error('   KEIBA_DATA_SHARED_TOKEN を env / workflow secret に設定してください。');
      }
      process.exit(1);
    }
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}
