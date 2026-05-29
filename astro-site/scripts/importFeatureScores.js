#!/usr/bin/env node
/**
 * importFeatureScores.js
 *
 * keiba-data-shared の {category}/featureScores/YYYY/MM/YYYY-MM-DD-{VENUE}.json を
 * 本リポジトリの astro-site/src/data/featureScores/{category}/YYYY/MM/{file} に転記する。
 *
 * - 表示専用データ（Layer A normalizedPastRaces + Layer B 6項目 featureScores）。
 *   AI総合指数 / 印 / 買い目 / 予想本文 / 過去走 とは独立。本スクリプトはそれらに触れない。
 * - 取得は importHorseHistoriesJra.js と同型（Contents API raw / token 優先 / raw fallback）。
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
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..'); // astro-site

const SHARED_OWNER = 'apol0510';
const SHARED_REPO = 'keiba-data-shared';
const SHARED_BRANCH = 'main';

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

/** --source local: shared-root 配下のローカルファイルから読む（検証用・read only） */
function fetchLocal(sharedRoot, sharedPath) {
  const full = join(resolve(sharedRoot), sharedPath);
  if (!existsSync(full)) return { ok: false, status: 404, meta: { url: full } };
  const body = readFileSync(full, 'utf-8');
  return { ok: true, status: 200, meta: { url: full }, body };
}

/** --source remote: Contents API raw（token あれば）/ raw fallback。importHorseHistoriesJra.js と同型 */
async function fetchSharedRaw(sharedPath, token) {
  if (token) {
    const url = `https://api.github.com/repos/${SHARED_OWNER}/${SHARED_REPO}/contents/${sharedPath}?ref=${SHARED_BRANCH}`;
    const res = await fetch(url, {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.raw', 'User-Agent': 'import-feature-scores' },
    });
    const meta = { url: `api.github.com/.../contents/${sharedPath}`, status: res.status, contentType: res.headers.get('content-type') || '', rateRemaining: res.headers.get('x-ratelimit-remaining') || '' };
    if (res.status === 404) return { ok: false, status: 404, meta };
    if (res.status === 401) return { ok: false, status: 401, meta, error: 'HTTP 401 (token missing/invalid)' };
    if (res.status === 403) {
      const body = await res.text().catch(() => '');
      const isRate = /rate limit/i.test(body) || meta.rateRemaining === '0';
      return { ok: false, status: 403, meta, error: isRate ? `HTTP 403 (rate limit, ${safePrefix(body)})` : `HTTP 403 (forbidden, ${safePrefix(body)})` };
    }
    if (!res.ok) { const body = await res.text().catch(() => ''); return { ok: false, status: res.status, meta, error: `Contents API ${res.status}: ${safePrefix(body)}` }; }
    return { ok: true, status: 200, meta, body: await res.text() };
  }
  const rawUrl = `https://raw.githubusercontent.com/${SHARED_OWNER}/${SHARED_REPO}/${SHARED_BRANCH}/${sharedPath}?t=${Date.now()}`;
  const res = await fetch(rawUrl, { cache: 'no-store' });
  const meta = { url: `raw.githubusercontent.com/.../${sharedPath}`, status: res.status, contentType: res.headers.get('content-type') || '' };
  if (res.status === 404) return { ok: false, status: 404, meta };
  if (!res.ok) { const body = await res.text().catch(() => ''); return { ok: false, status: res.status, meta, error: `raw fetch ${res.status}: ${safePrefix(body)}` }; }
  return { ok: true, status: 200, meta, body: await res.text() };
}

function parseJsonStrict(body, meta) {
  if (body == null || body === '') throw new Error(`empty response body (status=${meta.status})`);
  const first = body.trimStart()[0];
  if (first !== '{' && first !== '[') throw new Error(`invalid JSON prefix: "${safePrefix(body)}" (status=${meta.status})`);
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
  const { token, source: tokenSource } = pickToken();
  // local の既定 shared-root: astro-site から見た ../../keiba-data-shared
  const sharedRoot = args.sharedRoot || join(projectRoot, '..', '..', 'keiba-data-shared');

  // 書き込みルート（dest assert 用）
  const FS_ROOT = join(projectRoot, 'src', 'data', 'featureScores') + sep;

  console.log(`📥 importFeatureScores`);
  console.log(`   category: ${args.category} (expect engine=${EXPECTED_ENGINE[args.category]})`);
  console.log(`   date:     ${args.date}`);
  console.log(`   venues:   ${venues.join(', ')}`);
  console.log(`   source:   ${args.source}${args.source === 'local' ? ` (root=${resolve(sharedRoot)})` : ` (auth=${token ? tokenSource : 'NONE/raw'})`}`);
  console.log(`   dry-run:  ${args.dryRun ? 'YES' : 'NO'}`);
  console.log('');

  let savedCount = 0, skippedCount = 0, failedCount = 0;

  for (const venue of venues) {
    const sharedPath = buildSharedPath(args.category, args.date, venue);
    const localPath = buildLocalPath(args.category, args.date, venue);
    process.stdout.write(`  ${venue}: `);
    try {
      const r = args.source === 'local' ? fetchLocal(sharedRoot, sharedPath) : await fetchSharedRaw(sharedPath, token);
      if (r.status === 404) { console.log(`skip (404: ${sharedPath} 未保存)`); skippedCount++; continue; }
      if (!r.ok) throw new Error(r.error || `fetch failed (status=${r.status})`);
      const json = parseJsonStrict(r.body, r.meta);
      validateFeatureScoresJson(json, args.category, venue, args.date); // 不一致は throw → 書き込まない
      const raceCount = Object.keys(json.races || {}).length;

      // 書き込み先 assert（src/data/featureScores/ 配下のみ）
      const destAbs = resolve(localPath);
      if (!destAbs.startsWith(FS_ROOT)) {
        console.log(`SAFETY ABORT: 書き込み先が src/data/featureScores/ 配下でない: ${destAbs}`);
        process.exit(3);
      }

      if (args.dryRun) {
        console.log(`OK (dry-run, races=${raceCount}, bytes=${r.body.length}, would write ${localPath.replace(projectRoot, '.')})`);
        savedCount++;
        continue;
      }
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, JSON.stringify(json, null, 2), 'utf-8');
      console.log(`saved (races=${raceCount}, bytes=${r.body.length}) -> ${localPath.replace(projectRoot, '.')}`);
      savedCount++;
    } catch (e) {
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

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
