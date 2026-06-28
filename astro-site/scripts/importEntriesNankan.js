#!/usr/bin/env node
/**
 * importEntriesNankan.js  (PR-F4b)
 *
 * keiba-data-shared の nankan/entries/YYYY/MM/YYYY-MM-DD-{VENUE}.json (南関 出馬表 full venue)
 * を本リポジトリの astro-site/src/data/entries/nankan/YYYY/MM/{file} に転記する。
 *
 * ※ JRA horseHistories / 南関 recentHorseHistories とは別系統
 *   (別 script / 別 workflow / 別 event)。
 *    既存 importRecentHorseHistoriesNankan.js / importHorseHistoriesJra.js は
 *    一切共有・改変しない。取得方式・token 解決は同思想だが、entries 専用に自己完結。
 *
 * import 契約 (keiba-data-shared-admin docs §30 / 1会場=全レース集約契約 §29):
 *   - 取り込み対象は **full venue entries のみ** (totalRaces>1)。
 *   - **R01-only (uma_shosai かつ totalRaces===1) / partial は import しない**。
 *   - record は null が正 (auto/uma_shosai は recordSourced=false)。**0埋めは reject**。
 *     record は表示には接続しない (出馬表由来データ・F5 で条件付き表示)。
 *
 * 取得方式 (importRecentHorseHistoriesNankan.js と同思想):
 *   - 認証付き Contents API へ統一 (匿名 raw 廃止)。token 未設定は取得前に fatal。
 *   - token 解決チェーンは sharedFetch helper 側に集約 (KEIBA_DATA_SHARED_TOKEN 推奨)。
 *   - 401/403/レート/5xx/timeout は fatal (伝播)。optional な 404 のみ skip。
 *   - token 値は絶対に表示しない。
 *
 * 使い方:
 *   node scripts/importEntriesNankan.js --date 2026-06-10 --venues OOI --dry-run
 *   node scripts/importEntriesNankan.js --date 2026-06-10 --venues OOI,FUN
 *   node scripts/importEntriesNankan.js --date 2026-06-10 --dry-run         (全4場)
 *
 * 終了コード: guard reject/取得失敗 → 4 / 1件も保存/通過なし → 5 / 引数不正 → 2 / OK → 0。
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

// 南関4場: 大井 OOI / 川崎 KAW / 船橋 FUN / 浦和 URA
const ALL_NANKAN_VENUES = ['OOI', 'KAW', 'FUN', 'URA'];
const NANKAN_VENUE_NAME_BY_CODE = { OOI: '大井', KAW: '川崎', FUN: '船橋', URA: '浦和' };

// 自動取得 entries の期待 sourceMeta (admin §30 / EXPECT_SOURCE と一致)。
const EXPECT_SOURCE = {
  sourceType: 'auto',
  sourcePageType: 'uma_shosai',
  recordSourced: false,
  recordCoverage: '0%',
  missingRecordReason: 'uma_shosai_no_record',
};

const RECORD_KEYS = ['total', 'left', 'right', 'venue', 'distance'];
const RECORD_FIELDS = ['wins', 'seconds', 'thirds', 'unplaced'];

function parseArgs(argv) {
  const args = { date: null, venues: null, dryRun: false, sharedRef: DEFAULT_BRANCH };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a.startsWith('--date=')) args.date = a.slice('--date='.length);
    else if (a === '--venues') args.venues = argv[++i];
    else if (a.startsWith('--venues=')) args.venues = a.slice('--venues='.length);
    else if (a === '--shared-ref') args.sharedRef = argv[++i];
    else if (a.startsWith('--shared-ref=')) args.sharedRef = a.slice('--shared-ref='.length);
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
  return `nankan/entries/${year}/${month}/${date}-${venue}.json`;
}

function buildLocalPath(date, venue) {
  const [year, month] = date.split('-');
  return join(projectRoot, 'src', 'data', 'entries', 'nankan', year, month, `${date}-${venue}.json`);
}

function safePrefix(text, n = 80) {
  if (text == null) return '<null>';
  const s = String(text).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 認証付き Contents API 経由で本文を取得。404 (未保存) は null (optional skip)。
 *  認証/権限/レート/サーバ/タイムアウト/INVALID は SharedFetchError として throw (fatal・匿名 fallback なし)。 */
async function fetchSharedRaw(sharedPath, ref, client = sharedClient) {
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

function countHorses(json) {
  let horses = 0;
  for (const race of json.races || []) {
    horses += Array.isArray(race.horses) ? race.horses.length : 0;
  }
  return horses;
}

// record が「全区分0埋め」かを判定 (admin の 0埋め検出と同条件)。
function hasZeroFilledRecord(json) {
  for (const race of json.races || []) {
    for (const h of race.horses || []) {
      const rec = h && h.record;
      if (!rec || typeof rec !== 'object') continue; // null は正常 (未取得)
      const allZero = RECORD_KEYS.every((rk) => {
        const seg = rec[rk];
        return seg && typeof seg === 'object'
          && RECORD_FIELDS.every((f) => seg[f] === 0);
      });
      if (allZero) return true;
    }
  }
  return false;
}

/**
 * 南関 entries import guard (admin docs §30.2 / §30.3)。
 * 不適合は throw (= その venue を reject)。R01-only は専用メッセージで skip 扱い。
 * 戻り値: { skip?: 'R01-only', ... }（skip の場合）/ true（import 可）。
 */
function validateEntriesJson(json, expectedVenueCode, expectedDate) {
  if (!json || typeof json !== 'object') throw new Error('not an object');

  // --- R01-only / totalRaces=1 は import しない (防御的 skip) ---
  const sm = json.sourceMeta || {};
  const races = Array.isArray(json.races) ? json.races : null;
  const totalRaces = json.totalRaces;
  if (
    totalRaces === 1 ||
    (races && races.length === 1) ||
    (sm.sourcePageType === 'uma_shosai' && totalRaces === 1)
  ) {
    return { skip: 'R01-only', reason: `totalRaces=${totalRaces} (R01-only/partial は import 対象外)` };
  }

  // --- 必須契約 ---
  if (json.category !== 'nankan') throw new Error(`unexpected category: ${json.category}`);
  if (json.date !== expectedDate) throw new Error(`date mismatch: expected=${expectedDate}, file=${json.date}`);
  if (json.venueCode !== expectedVenueCode) {
    throw new Error(`venueCode mismatch: expected=${expectedVenueCode}, file=${json.venueCode}`);
  }
  const expectedName = NANKAN_VENUE_NAME_BY_CODE[expectedVenueCode];
  if (expectedName && json.venue !== expectedName) {
    throw new Error(`venue 名不整合: expected=${expectedName}(${expectedVenueCode}), file=${json.venue}`);
  }

  if (!races) throw new Error('races missing or not an array');
  if (totalRaces !== races.length) throw new Error(`totalRaces(${totalRaces}) != races.length(${races.length})`);
  if (!(totalRaces > 1)) throw new Error(`totalRaces=${totalRaces} (full venue=複数レースのみ import)`);
  if (!(races.length > 1)) throw new Error(`races.length=${races.length} (複数レースのみ import)`);

  // sourceMeta.races が存在する場合は races と件数一致
  if (Array.isArray(sm.races) && sm.races.length !== races.length) {
    throw new Error(`sourceMeta.races.length(${sm.races.length}) != races.length(${races.length})`);
  }

  // raceNumber 昇順 & 重複なし & horses 空なし
  let prev = -Infinity;
  for (let i = 0; i < races.length; i++) {
    const r = races[i];
    if (!r || typeof r !== 'object') throw new Error(`race[${i}] がオブジェクトでない`);
    if (typeof r.raceNumber !== 'number') throw new Error(`race[${i}] raceNumber が数値でない`);
    if (!(r.raceNumber > prev)) throw new Error(`raceNumber が昇順/一意でない: ${races.map((x) => x.raceNumber).join(',')}`);
    prev = r.raceNumber;
    if (!Array.isArray(r.horses) || r.horses.length === 0) throw new Error(`race[${i}](R${r.raceNumber}) horses が空`);
  }

  // record 0埋めは reject (null は正常)
  if (hasZeroFilledRecord(json)) throw new Error('record 0埋めを検出 (0埋めは import しない)');

  return true;
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

  console.log('📥 importEntriesNankan (PR-F4b)');
  console.log(`   date:    ${args.date}`);
  console.log(`   venues:  ${venues.join(', ')}`);
  console.log(`   ref:     ${args.sharedRef}`);
  console.log(`   auth:    認証付き Contents API`);
  console.log(`   dry-run: ${args.dryRun ? 'YES' : 'NO'}`);
  console.log('');

  let savedCount = 0;
  let skippedCount = 0;
  let rejectedCount = 0;
  let failedCount = 0;

  for (const venue of venues) {
    const sharedPath = buildSharedPath(args.date, venue);
    const localPath = buildLocalPath(args.date, venue);
    process.stdout.write(`  ${venue}: `);
    try {
      const body = await fetchSharedRaw(sharedPath, args.sharedRef); // 404→null / auth等→throw
      if (body === null) {
        console.log(`skip (HTTP 404 from keiba-data-shared: ${sharedPath})`);
        skippedCount++;
        continue;
      }
      const json = parseJsonStrict(body);

      const verdict = validateEntriesJson(json, venue, args.date);
      if (verdict && verdict.skip) {
        console.log(`skip (${verdict.skip}: ${verdict.reason})`);
        skippedCount++;
        continue;
      }

      const raceCount = json.races.length;
      const horseCount = countHorses(json);
      const recordNull = json.races.every((race) => (race.horses || []).every((h) => h.record == null));

      if (args.dryRun) {
        console.log(
          `OK (dry-run, totalRaces=${json.totalRaces}, races=${raceCount}, horses=${horseCount}, ` +
          `recordNull=${recordNull}, bytes=${body.length}, would write ${localPath.replace(projectRoot, '.')})`
        );
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
      // guard 不適合は「reject」、取得/JSON 失敗は「fail」として区別
      const isReject = /mismatch|!=|昇順|空|0埋め|unexpected|not an object|missing/.test(e.message);
      if (isReject) {
        console.log(`REJECT: ${e.message}`);
        rejectedCount++;
      } else {
        console.log(`FAIL: ${e.message}`);
        failedCount++;
      }
    }
  }

  console.log('');
  console.log(`━━━ サマリ: passed=${savedCount} skipped=${skippedCount} rejected=${rejectedCount} failed=${failedCount} ━━━`);

  if (rejectedCount > 0) {
    console.error('❌ import 契約 (§30) に不適合な venue があります (reject)');
    process.exit(4);
  }
  if (failedCount > 0) {
    console.error('❌ 一部 venue で取得失敗');
    process.exit(4);
  }
  if (savedCount === 0) {
    console.error('❌ 1件も import 対象なし (すべて 404/skip?)');
    process.exit(5);
  }
}

// 直接実行時のみ main を起動 (テスト時は import して関数を使える)
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
  });
}

export { fetchSharedRaw, validateEntriesJson, hasZeroFilledRecord, buildSharedPath, buildLocalPath };
