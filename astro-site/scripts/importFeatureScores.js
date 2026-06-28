#!/usr/bin/env node
/**
 * importFeatureScores.js
 *
 * keiba-data-shared の {category}/featureScores/YYYY/MM/YYYY-MM-DD-{VENUE}.json を
 * 本リポジトリの astro-site/src/data/featureScores/{category}/YYYY/MM/{file} に転記する。
 *
 * - 表示専用データ（Layer A normalizedPastRaces + Layer B 6項目 featureScores）。
 *   AI総合指数 / 印 / 買い目 / 予想本文 / 過去走 とは独立。本スクリプトはそれらに触れない。
 * - remote 取得は認証付き Contents API へ統一（匿名 raw 廃止）。token 未設定は取得前に fatal。
 *   --source local は token 不要のローカルファイル読取モードとして維持。
 * - 書き込み先は src/data/featureScores/ 配下のみ（dest assert で強制）。
 * - featureScores 未保存の場（HTTP 404）は skip（エラーにしない）。
 * - engine が category と一致しない / parse 不能なファイルは書き込まない（受信側ガード）。
 *
 * 使い方:
 *   node scripts/importFeatureScores.js --category jra --date 2026-05-24 --venues TOK,KYO --dry-run
 *   node scripts/importFeatureScores.js --category nankan --date 2026-05-29 --venues URA
 *   node scripts/importFeatureScores.js --category jra --date 2026-05-24 --venues TOK --source local --shared-root /tmp/fs-fixture
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, sep, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createSharedClient, resolveSharedToken, SharedFetchError, SHARED_FETCH_CODES } from './lib/sharedFetch.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..'); // astro-site

// remote 取得は keiba-data-shared 認証付き Contents API へ統一（匿名 raw 廃止）。
// token 未設定は取得前に fatal（匿名 fallback 禁止）。--source local は token 不要のまま維持。
const SHARED_REF = 'main';
const sharedClient = createSharedClient();

const VENUES_BY_CATEGORY = {
  jra: ['TOK', 'NAK', 'KYO', 'HAN', 'CHU', 'KOK', 'NII', 'FKS', 'SAP', 'HKD'],
  nankan: ['OOI', 'KAW', 'FUN', 'URA'],
};
const EXPECTED_ENGINE = { jra: 'jra-v1', nankan: 'nankan-v1' };

function parseArgs(argv) {
  const args = { category: null, date: null, venues: null, dryRun: false, source: 'remote', sharedRoot: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--category') args.category = argv[++i];
    else if (a.startsWith('--category=')) args.category = a.slice('--category='.length);
    else if (a === '--date') args.date = argv[++i];
    else if (a.startsWith('--date=')) args.date = a.slice('--date='.length);
    else if (a === '--venues' || a === '--venue') args.venues = argv[++i];
    else if (a.startsWith('--venues=')) args.venues = a.slice('--venues='.length);
    else if (a.startsWith('--venue=')) args.venues = a.slice('--venue='.length);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--source') args.source = argv[++i];
    else if (a.startsWith('--source=')) args.source = a.slice('--source='.length);
    else if (a === '--shared-root') args.sharedRoot = argv[++i];
    else if (a.startsWith('--shared-root=')) args.sharedRoot = a.slice('--shared-root='.length);
  }
  return args;
}

function resolveVenues(category, arg) {
  if (!arg) return VENUES_BY_CATEGORY[category];
  return arg.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function buildSharedPath(category, date, venue) {
  const [year, month] = date.split('-');
  return `${category}/featureScores/${year}/${month}/${date}-${venue}.json`;
}

function buildLocalPath(category, date, venue) {
  const [year, month] = date.split('-');
  return join(projectRoot, 'src', 'data', 'featureScores', category, year, month, `${date}-${venue}.json`);
}

function safePrefix(text, n = 80) {
  if (text == null) return '<null>';
  const s = String(text).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** --source local: shared-root 配下のローカルファイルから読む（検証用・read only） */
function fetchLocal(sharedRoot, sharedPath) {
  const full = join(resolve(sharedRoot), sharedPath);
  if (!existsSync(full)) return { ok: false, status: 404, meta: { url: full } };
  const body = readFileSync(full, 'utf-8');
  return { ok: true, status: 200, meta: { url: full }, body };
}

/** --source remote: 認証付き Contents API 経由で本文を取得。
 *  404（未保存）は null（optional skip）。認証/権限/レート/サーバ/タイムアウト/INVALID は
 *  SharedFetchError として throw（fatal・匿名 fallback なし）。 */
async function fetchRemoteFeatureScores(sharedPath, client = sharedClient, ref = SHARED_REF) {
  return client.fetchText(sharedPath, { ref, required: false });
}

function parseJsonStrict(body) {
  if (body == null || body === '') throw new Error('empty response body');
  const first = body.trimStart()[0];
  if (first !== '{' && first !== '[') throw new Error(`invalid JSON prefix: "${safePrefix(body)}"`);
  try { return JSON.parse(body); } catch (e) { throw new Error(`JSON.parse failed: ${e.message} (prefix="${safePrefix(body)}")`); }
}

/** 受信側ガード: engine / category / date / venueCode の整合を検証。不一致は throw（→書き込まない） */
function validateFeatureScoresJson(json, category, venue, date) {
  if (!json || typeof json !== 'object') throw new Error('not an object');
  const expectedEngine = EXPECTED_ENGINE[category];
  if (json.engine !== expectedEngine) throw new Error(`engine mismatch: expected=${expectedEngine}, file=${json.engine}`);
  if (json.category !== category) throw new Error(`category mismatch: expected=${category}, file=${json.category}`);
  if (json.date !== date) throw new Error(`date mismatch: expected=${date}, file=${json.date}`);
  if (json.venueCode !== venue) throw new Error(`venueCode mismatch: expected=${venue}, file=${json.venueCode}`);
  if (!json.races || typeof json.races !== 'object') throw new Error('races missing or not an object');
  return true;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.category || !['jra', 'nankan'].includes(args.category)) {
    console.error('❌ --category jra|nankan が必要（local は対象外）');
    process.exit(2);
  }
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error('❌ --date YYYY-MM-DD が必要');
    process.exit(2);
  }
  const venues = resolveVenues(args.category, args.venues);
  // remote 取得は token 必須（取得前に fail-fast・匿名 fallback なし）。local は token 不要。
  if (args.source !== 'local') {
    resolveSharedToken();
  }
  // local の既定 shared-root: astro-site から見た ../../keiba-data-shared
  const sharedRoot = args.sharedRoot || join(projectRoot, '..', '..', 'keiba-data-shared');

  // 書き込みルート（dest assert 用）
  const FS_ROOT = join(projectRoot, 'src', 'data', 'featureScores') + sep;

  console.log(`📥 importFeatureScores`);
  console.log(`   category: ${args.category} (expect engine=${EXPECTED_ENGINE[args.category]})`);
  console.log(`   date:     ${args.date}`);
  console.log(`   venues:   ${venues.join(', ')}`);
  console.log(`   source:   ${args.source}${args.source === 'local' ? ` (root=${resolve(sharedRoot)})` : ` (auth=認証付き Contents API)`}`);
  console.log(`   dry-run:  ${args.dryRun ? 'YES' : 'NO'}`);
  console.log('');

  let savedCount = 0, skippedCount = 0, failedCount = 0;

  for (const venue of venues) {
    const sharedPath = buildSharedPath(args.category, args.date, venue);
    const localPath = buildLocalPath(args.category, args.date, venue);
    process.stdout.write(`  ${venue}: `);
    try {
      let body;
      if (args.source === 'local') {
        const r = fetchLocal(sharedRoot, sharedPath);
        if (r.status === 404) { console.log(`skip (404: ${sharedPath} 未保存)`); skippedCount++; continue; }
        if (!r.ok) throw new Error(r.error || `fetch failed (status=${r.status})`);
        body = r.body;
      } else {
        body = await fetchRemoteFeatureScores(sharedPath); // 404→null / auth等→throw（匿名 fallback なし）
        if (body === null) { console.log(`skip (404: ${sharedPath} 未保存)`); skippedCount++; continue; }
      }
      const json = parseJsonStrict(body);
      validateFeatureScoresJson(json, args.category, venue, args.date); // 不一致は throw → 書き込まない
      const raceCount = Object.keys(json.races || {}).length;

      // 書き込み先 assert（src/data/featureScores/ 配下のみ）
      const destAbs = resolve(localPath);
      if (!destAbs.startsWith(FS_ROOT)) {
        console.log(`SAFETY ABORT: 書き込み先が src/data/featureScores/ 配下でない: ${destAbs}`);
        process.exit(3);
      }

      if (args.dryRun) {
        console.log(`OK (dry-run, races=${raceCount}, bytes=${body.length}, would write ${localPath.replace(projectRoot, '.')})`);
        savedCount++;
        continue;
      }
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, JSON.stringify(json, null, 2), 'utf-8');
      console.log(`saved (races=${raceCount}, bytes=${body.length}) -> ${localPath.replace(projectRoot, '.')}`);
      savedCount++;
    } catch (e) {
      // 認証/権限/レート/サーバ/タイムアウト/INVALID 等は fatal（伝播・partial write なし）。
      // optional な 404 のみ上で skip 済み。
      if (e instanceof SharedFetchError && e.code !== SHARED_FETCH_CODES.NOT_FOUND) throw e;
      console.log(`FAIL: ${e.message}`);
      failedCount++;
    }
  }

  console.log('');
  console.log(`━━━ サマリ: saved=${savedCount} skipped=${skippedCount} failed=${failedCount} ━━━`);

  if (failedCount > 0) {
    console.error('❌ 一部 venue で取得/検証失敗（engine 不一致・parse 不能等は書き込まずスキップ）');
    process.exit(4);
  }
  // featureScores 未保存（全 404 skip）は正常終了（エラーにしない）
  if (savedCount === 0) {
    console.log('ℹ️  保存対象なし（全 venue 未保存=404 skip）。featureScores 未生成のため正常。');
  }
}

// 直接実行時のみ起動（import 時は実行しない＝テスト可能）。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
}

export { fetchRemoteFeatureScores, validateFeatureScoresJson, buildSharedPath, buildLocalPath };
