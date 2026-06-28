#!/usr/bin/env node
/**
 * importRecentHorseHistoriesNankan.js
 *
 * keiba-data-shared の nankan/recentHorseHistories/YYYY/MM/YYYY-MM-DD-{VENUE}.json を
 * 本リポジトリの astro-site/src/data/recentHorseHistories/nankan/YYYY/MM/{file} に転記する。
 *
 * ※ JRA horseHistories とは別系統（別 script / 別 workflow / 別 event）。
 *    既存 importHorseHistoriesJra.js は一切共有・改変しない。
 *    取得方式・token 解決は importHorseHistoriesJra.js と同思想だが、
 *    パスと検証は南関 recentHorseHistories 用に独立している。
 *
 * 取得方式:
 *   - 認証付き Contents API へ統一（匿名 raw 廃止）。token 未設定は取得前に fatal。
 *   - token 解決チェーンは sharedFetch helper 側に集約（KEIBA_DATA_SHARED_TOKEN 推奨）。
 *   - 401/403/レート/5xx/timeout は fatal（伝播）。optional な 404 のみ skip。
 *
 * 使い方:
 *   node scripts/importRecentHorseHistoriesNankan.js --date 2026-05-22
 *   node scripts/importRecentHorseHistoriesNankan.js --date 2026-05-22 --venues OOI,URA
 *   node scripts/importRecentHorseHistoriesNankan.js --date 2026-05-22 --dry-run
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
const SHARED_BRANCH = 'main';
const sharedClient = createSharedClient();

// 南関4場: 大井 OOI / 川崎 KAW / 船橋 FUN / 浦和 URA
const ALL_NANKAN_VENUES = ['OOI', 'KAW', 'FUN', 'URA'];

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
  if (!arg) return ALL_NANKAN_VENUES;
  return arg.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function buildSharedPath(date, venue) {
  const [year, month] = date.split('-');
  return `nankan/recentHorseHistories/${year}/${month}/${date}-${venue}.json`;
}

function buildLocalPath(date, venue) {
  const [year, month] = date.split('-');
  return join(projectRoot, 'src', 'data', 'recentHorseHistories', 'nankan', year, month, `${date}-${venue}.json`);
}

function safePrefix(text, n = 80) {
  if (text == null) return '<null>';
  const s = String(text).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 認証付き Contents API 経由で本文を取得。404 (未保存) は null (optional skip)。
 *  認証/権限/レート/サーバ/タイムアウト/INVALID は SharedFetchError として throw (fatal・匿名 fallback なし)。
 *  >1MB ファイルは helper 側で blobs API へ切替（本文は raw 文字列で返る）。 */
async function fetchSharedRaw(sharedPath, client = sharedClient, ref = SHARED_BRANCH) {
  return client.fetchText(sharedPath, { ref, required: false });
}

function parseJsonStrict(body) {
  if (body == null || body === '') {
    throw new Error('empty response body');
  }
  const first = body.trimStart()[0];
  if (first !== '{' && first !== '[') {
    throw new Error(`invalid JSON response prefix: "${safePrefix(body)}"`);
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`JSON.parse failed: ${e.message} (length=${body.length}, prefix="${safePrefix(body)}")`);
  }
}

// 南関 recentHorseHistories 用の検証（JRA horseHistories とは構造が異なる）
//   top-level: schemaVersion / category / date / venue / venueName / source / races
//   races[]: raceNumber / raceName / horses[]
//   horses[]: horseNumber / horseName / recentRaces[]
// 注意: source は string ではなく object（base/enrichment/generatedAt/generator）。
//       venue フィールドに3文字コードが入る（venueCode は使わない）。
function validateRecentHorseHistoriesJson(json, expectedVenue, expectedDate) {
  if (!json || typeof json !== 'object') throw new Error('not an object');
  if (json.category !== 'nankan') throw new Error(`unexpected category: ${json.category}`);
  if (typeof json.schemaVersion !== 'string' || !json.schemaVersion.startsWith('nankan-recent-horse-histories')) {
    throw new Error(`unexpected schemaVersion: ${json.schemaVersion}`);
  }
  if (json.date !== expectedDate) throw new Error(`date mismatch: payload=${expectedDate}, file=${json.date}`);
  if (json.venue !== expectedVenue) throw new Error(`venue mismatch: expected=${expectedVenue}, file=${json.venue}`);
  if (!Array.isArray(json.races)) throw new Error('races missing or not an array');
  return true;
}

function countHorses(json) {
  let horses = 0;
  for (const race of json.races || []) {
    horses += Array.isArray(race.horses) ? race.horses.length : 0;
  }
  return horses;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error('❌ --date YYYY-MM-DD が必要');
    process.exit(2);
  }
  const venues = resolveVenues(args.venues);
  // 取得前に token 必須化（未設定なら匿名 fallback せず即 fatal）。
  resolveSharedToken();

  console.log(`📥 importRecentHorseHistoriesNankan`);
  console.log(`   date:    ${args.date}`);
  console.log(`   venues:  ${venues.join(', ')}`);
  console.log(`   auth:    認証付き Contents API`);
  console.log(`   dry-run: ${args.dryRun ? 'YES' : 'NO'}`);
  console.log('');

  let savedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const venue of venues) {
    const sharedPath = buildSharedPath(args.date, venue);
    const localPath = buildLocalPath(args.date, venue);
    process.stdout.write(`  ${venue}: `);
    try {
      const body = await fetchSharedRaw(sharedPath); // 404→null / auth等→throw
      if (body === null) {
        console.log(`skip (HTTP 404 from keiba-data-shared: ${sharedPath})`);
        skippedCount++;
        continue;
      }
      const json = parseJsonStrict(body);
      validateRecentHorseHistoriesJson(json, venue, args.date);
      const raceCount = (json.races || []).length;
      const horseCount = countHorses(json);
      if (args.dryRun) {
        console.log(`OK (dry-run, races=${raceCount}, horses=${horseCount}, bytes=${body.length}, would write ${localPath.replace(projectRoot, '.')})`);
        savedCount++;
        continue;
      }
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, JSON.stringify(json, null, 2), 'utf-8');
      console.log(`saved (races=${raceCount}, horses=${horseCount}, bytes=${body.length}) -> ${localPath.replace(projectRoot, '.')}`);
      savedCount++;
    } catch (e) {
      // 認証/権限/レート/サーバ/タイムアウト/INVALID 等は fatal（伝播・partial write なし）。optional な 404 のみ上で skip。
      if (e instanceof SharedFetchError && e.code !== SHARED_FETCH_CODES.NOT_FOUND) throw e;
      console.log(`FAIL: ${e.message}`);
      failedCount++;
    }
  }

  console.log('');
  console.log(`━━━ サマリ: saved=${savedCount} skipped=${skippedCount} failed=${failedCount} ━━━`);

  if (failedCount > 0) {
    console.error('❌ 一部 venue で取得失敗');
    process.exit(4);
  }
  if (savedCount === 0) {
    console.error('❌ 1件も保存されなかった (すべて 404?)');
    process.exit(5);
  }
}

// 直接実行時のみ起動（import 時は実行しない＝テスト可能）。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
  });
}

export { fetchSharedRaw, validateRecentHorseHistoriesJson, countHorses, buildSharedPath, buildLocalPath };
