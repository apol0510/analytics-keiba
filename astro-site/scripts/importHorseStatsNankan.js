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
 * 取得方式（importEntriesNankan.js と同思想 + 401/403 時 public raw fallback）:
 *   - Contents API + Accept: application/vnd.github.raw
 *   - token 優先: KEIBA_DATA_SHARED_TOKEN → GITHUB_TOKEN_KEIBA_DATA_SHARED → GITHUB_TOKEN
 *   - token が無い/401/403 のときは raw.githubusercontent.com に fallback（public 前提）
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
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const SHARED_OWNER = 'apol0510';
const SHARED_REPO = 'keiba-data-shared';
const DEFAULT_BRANCH = 'main';
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

function pickToken() {
  if (process.env.KEIBA_DATA_SHARED_TOKEN) return { token: process.env.KEIBA_DATA_SHARED_TOKEN, source: 'KEIBA_DATA_SHARED_TOKEN' };
  if (process.env.GITHUB_TOKEN_KEIBA_DATA_SHARED) return { token: process.env.GITHUB_TOKEN_KEIBA_DATA_SHARED, source: 'GITHUB_TOKEN_KEIBA_DATA_SHARED' };
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, source: 'GITHUB_TOKEN' };
  return { token: null, source: 'NONE' };
}

function safePrefix(text, n = 80) {
  if (text == null) return '<null>';
  const s = String(text).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function fetchRawPublic(sharedPath, ref) {
  const rawUrl = `https://raw.githubusercontent.com/${SHARED_OWNER}/${SHARED_REPO}/${ref}/${sharedPath}?t=${Date.now()}`;
  const res = await fetch(rawUrl, { cache: 'no-store' });
  if (res.status === 404) return { ok: false, status: 404 };
  if (!res.ok) { const body = await res.text().catch(() => ''); return { ok: false, status: res.status, error: `raw ${res.status}: ${safePrefix(body)}` }; }
  return { ok: true, status: 200, body: await res.text(), via: 'raw' };
}

async function fetchSharedRaw(sharedPath, token, ref) {
  if (token) {
    const url = `https://api.github.com/repos/${SHARED_OWNER}/${SHARED_REPO}/contents/${sharedPath}?ref=${ref}`;
    const res = await fetch(url, {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.raw', 'User-Agent': 'import-horse-stats-nankan' },
    });
    if (res.status === 404) return { ok: false, status: 404 };
    // token が invalid 等（401/403）なら public raw に fallback
    if (res.status === 401 || res.status === 403) return fetchRawPublic(sharedPath, ref);
    if (!res.ok) { const body = await res.text().catch(() => ''); return { ok: false, status: res.status, error: `Contents API ${res.status}: ${safePrefix(body)}` }; }
    return { ok: true, status: 200, body: await res.text(), via: 'api' };
  }
  return fetchRawPublic(sharedPath, ref);
}

function parseJsonStrict(body, status) {
  if (body == null || body === '') throw new Error(`empty body (status=${status})`);
  const first = body.trimStart()[0];
  if (first !== '{' && first !== '[') throw new Error(`invalid JSON prefix: "${safePrefix(body)}" (status=${status})`);
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
  const { token, source: tokenSource } = pickToken();

  console.log('📥 importHorseStatsNankan');
  console.log(`   date:    ${args.date}`);
  console.log(`   venues:  ${venues.join(', ')}`);
  console.log(`   races:   R01..R${String(args.expectedRaces).padStart(2, '0')}`);
  console.log(`   ref:     ${args.sharedRef}`);
  console.log(`   auth:    ${token ? `Contents API (token from ${tokenSource}, 401/403時 raw fallback)` : 'raw public'}`);
  console.log(`   dry-run: ${args.dryRun ? 'YES' : 'NO'}`);
  console.log('');

  let filesFound = 0, totalHorses = 0, errors = 0, notFound = 0, wouldWrite = 0, written = 0;

  for (const venue of venues) {
    for (let n = 1; n <= args.expectedRaces; n++) {
      const sharedPath = buildSharedPath(args.date, venue, n);
      const localPath = buildLocalPath(args.date, venue, n);
      const label = `${venue} ${rnnOf(n)}`;
      try {
        const r = await fetchSharedRaw(sharedPath, token, args.sharedRef);
        if (r.status === 404) { console.log(`  ${label}: skip (404 ${sharedPath})`); notFound++; continue; }
        if (!r.ok) throw new Error(r.error || `fetch failed (status=${r.status})`);
        const json = parseJsonStrict(r.body, r.status);
        const horses = validateHorseStatsJson(json, venue, args.date, n);
        filesFound++; totalHorses += horses;
        if (args.dryRun) {
          console.log(`  ${label}: OK (dry-run, horses=${horses}, via=${r.via}, would write ${localPath.replace(projectRoot, '.')})`);
          wouldWrite++;
        } else {
          mkdirSync(dirname(localPath), { recursive: true });
          writeFileSync(localPath, JSON.stringify(json, null, 2), 'utf-8');
          console.log(`  ${label}: saved (horses=${horses}) -> ${localPath.replace(projectRoot, '.')}`);
          written++;
        }
      } catch (e) {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
}

export { validateHorseStatsJson, buildSharedPath, buildLocalPath };
