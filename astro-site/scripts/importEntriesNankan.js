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
 *   - Contents API + Accept: application/vnd.github.raw (>1MB でも raw でボディに返る)
 *   - token 優先順位:
 *       1. KEIBA_DATA_SHARED_TOKEN          (推奨 / Actions secret はこの名前)
 *       2. GITHUB_TOKEN_KEIBA_DATA_SHARED   (ローカル互換用 fallback)
 *       3. GITHUB_TOKEN                     (最終 fallback。Actions 自動 token は通常届かない)
 *   - token が無ければ raw.githubusercontent.com に fallback (public 前提)
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
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const SHARED_OWNER = 'apol0510';
const SHARED_REPO = 'keiba-data-shared';
const DEFAULT_BRANCH = 'main';

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

function pickToken() {
  // 優先順位 (importRecentHorseHistoriesNankan.js と同一):
  //   1. KEIBA_DATA_SHARED_TOKEN  ← Actions secret はこの名前 (GITHUB_ 始まりは禁止のため)
  //   2. GITHUB_TOKEN_KEIBA_DATA_SHARED  ← ローカル互換用 fallback
  //   3. GITHUB_TOKEN  ← Actions の自動 token。keiba-data-shared には通常届かない
  if (process.env.KEIBA_DATA_SHARED_TOKEN) {
    return { token: process.env.KEIBA_DATA_SHARED_TOKEN, source: 'KEIBA_DATA_SHARED_TOKEN' };
  }
  if (process.env.GITHUB_TOKEN_KEIBA_DATA_SHARED) {
    return { token: process.env.GITHUB_TOKEN_KEIBA_DATA_SHARED, source: 'GITHUB_TOKEN_KEIBA_DATA_SHARED' };
  }
  if (process.env.GITHUB_TOKEN) {
    return { token: process.env.GITHUB_TOKEN, source: 'GITHUB_TOKEN' };
  }
  return { token: null, source: 'NONE' };
}

function safePrefix(text, n = 80) {
  if (text == null) return '<null>';
  const s = String(text).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function fetchSharedRaw(sharedPath, token, ref) {
  // Contents API + Accept: application/vnd.github.raw
  if (token) {
    const url = `https://api.github.com/repos/${SHARED_OWNER}/${SHARED_REPO}/contents/${sharedPath}?ref=${ref}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.raw',
        'User-Agent': 'import-entries-nankan',
      },
    });
    const meta = {
      url: `api.github.com/.../contents/${sharedPath}`,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      contentLength: res.headers.get('content-length') || '',
      rateRemaining: res.headers.get('x-ratelimit-remaining') || '',
    };
    if (res.status === 404) return { ok: false, status: 404, meta };
    if (res.status === 401) {
      return { ok: false, status: 401, meta, error: 'HTTP 401 from keiba-data-shared (token missing/invalid)' };
    }
    if (res.status === 403) {
      const body = await res.text().catch(() => '');
      const isRate = /rate limit/i.test(body) || meta.rateRemaining === '0';
      return {
        ok: false,
        status: 403,
        meta,
        error: isRate
          ? `HTTP 403 from keiba-data-shared (rate limit, body=${safePrefix(body)})`
          : `HTTP 403 from keiba-data-shared (forbidden, body=${safePrefix(body)})`,
      };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, meta, error: `Contents API ${res.status}: ${safePrefix(body)}` };
    }
    const body = await res.text();
    return { ok: true, status: 200, meta, body };
  }

  // public 前提の raw fallback (CI では推奨されない)
  const rawUrl = `https://raw.githubusercontent.com/${SHARED_OWNER}/${SHARED_REPO}/${ref}/${sharedPath}?t=${Date.now()}`;
  const res = await fetch(rawUrl, { cache: 'no-store' });
  const meta = {
    url: `raw.githubusercontent.com/.../${sharedPath}`,
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    contentLength: res.headers.get('content-length') || '',
    rateRemaining: '',
  };
  if (res.status === 404) return { ok: false, status: 404, meta };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, meta, error: `raw fetch ${res.status}: ${safePrefix(body)}` };
  }
  const body = await res.text();
  return { ok: true, status: 200, meta, body };
}

function parseJsonStrict(body, meta) {
  if (body == null || body === '') {
    throw new Error(`empty response body (status=${meta.status}, contentType=${meta.contentType})`);
  }
  const first = body.trimStart()[0];
  if (first !== '{' && first !== '[') {
    throw new Error(`invalid JSON response prefix: "${safePrefix(body)}" (status=${meta.status}, contentType=${meta.contentType})`);
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
  const { token, source: tokenSource } = pickToken();

  console.log('📥 importEntriesNankan (PR-F4b)');
  console.log(`   date:    ${args.date}`);
  console.log(`   venues:  ${venues.join(', ')}`);
  console.log(`   ref:     ${args.sharedRef}`);
  console.log(`   auth:    ${token ? `Contents API (token from ${tokenSource})` : 'NONE (raw fallback, public only)'}`);
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
      const r = await fetchSharedRaw(sharedPath, token, args.sharedRef);
      if (r.status === 404) {
        console.log(`skip (HTTP 404 from keiba-data-shared: ${sharedPath})`);
        skippedCount++;
        continue;
      }
      if (!r.ok) {
        throw new Error(r.error || `fetch failed (status=${r.status})`);
      }
      const json = parseJsonStrict(r.body, r.meta);

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
          `recordNull=${recordNull}, bytes=${r.body.length}, would write ${localPath.replace(projectRoot, '.')})`
        );
        savedCount++;
        continue;
      }

      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, JSON.stringify(json, null, 2), 'utf-8');
      console.log(`saved (races=${raceCount}, horses=${horseCount}, bytes=${r.body.length}) -> ${localPath.replace(projectRoot, '.')}`);
      savedCount++;
    } catch (e) {
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
    if (tokenSource === 'NONE') {
      console.error('   ヒント: keiba-data-shared が private の場合、token が必須です。');
      console.error('   workflow secret に KEIBA_DATA_SHARED_TOKEN を設定してください。');
    } else if (tokenSource === 'GITHUB_TOKEN') {
      console.error('   ヒント: Actions の自動 GITHUB_TOKEN は keiba-data-shared には通常届きません。');
    }
    process.exit(4);
  }
  if (savedCount === 0) {
    console.error('❌ 1件も import 対象なし (すべて 404/skip?)');
    process.exit(5);
  }
}

// 直接実行時のみ main を起動 (テスト時は import して関数を使える)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
  });
}

export { validateEntriesJson, hasZeroFilledRecord, buildSharedPath, buildLocalPath };
