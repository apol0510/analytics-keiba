#!/usr/bin/env node
/**
 * importHorseHistoriesJra.js
 *
 * keiba-data-shared の jra/horseHistories/YYYY/MM/YYYY-MM-DD-{VENUE}.json を
 * 本リポジトリの astro-site/src/data/horseHistories/jra/YYYY/MM/{file} に転記する。
 *
 * 取得方式:
 *   - 認証あり: GitHub Contents API (Authorization: token $GITHUB_TOKEN)
 *   - 認証なし: raw.githubusercontent.com (public 前提)
 *
 * 既存 importer (importResultsJra.js 等) の merge ロジックや mojibake 補正は
 * 不要 (horseHistories は JRA 公式由来で既に正規化済)。
 *
 * 使い方:
 *   node scripts/importHorseHistoriesJra.js --date 2026-05-24
 *   node scripts/importHorseHistoriesJra.js --date 2026-05-24 --venues TOK,KYO,NII
 *
 * オプション:
 *   --date YYYY-MM-DD   必須
 *   --venues CSV        例 "TOK,KYO,NII"。省略時は10場すべて試行 (404 はスキップ)
 *   --dry-run           取得のみで書き込みなし
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const SHARED_OWNER = 'apol0510';
const SHARED_REPO = 'keiba-data-shared';
const SHARED_BRANCH = 'main';

// 全 JRA 場 (--venues 省略時のフォールバック対象)
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

function buildSharedPath(date, venue) {
  const [year, month] = date.split('-');
  return `jra/horseHistories/${year}/${month}/${date}-${venue}.json`;
}

function buildLocalPath(date, venue) {
  const [year, month] = date.split('-');
  return join(projectRoot, 'src', 'data', 'horseHistories', 'jra', year, month, `${date}-${venue}.json`);
}

async function fetchSharedJson(sharedPath, token) {
  // 認証あり: Contents API。なしなら raw fallback (public).
  if (token) {
    const url = `https://api.github.com/repos/${SHARED_OWNER}/${SHARED_REPO}/contents/${sharedPath}?ref=${SHARED_BRANCH}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'import-horse-histories-jra',
      },
    });
    if (res.status === 404) return { status: 404 };
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Contents API ${res.status}: ${text}`);
    }
    const j = await res.json();
    const json = JSON.parse(Buffer.from(j.content, 'base64').toString('utf-8'));
    return { status: 200, json };
  }
  // raw fallback (public 前提)
  const rawUrl = `https://raw.githubusercontent.com/${SHARED_OWNER}/${SHARED_REPO}/${SHARED_BRANCH}/${sharedPath}?t=${Date.now()}`;
  const res = await fetch(rawUrl, { cache: 'no-store' });
  if (res.status === 404) return { status: 404 };
  if (!res.ok) throw new Error(`raw fetch ${res.status}`);
  const json = await res.json();
  return { status: 200, json };
}

function validateHorseHistoriesJson(json, expectedVenue, expectedDate) {
  // 最低限の構造検証 (壊れた入力で local を上書きしないため)
  if (!json || typeof json !== 'object') throw new Error('not an object');
  if (json.source !== 'jra-official') throw new Error(`unexpected source: ${json.source}`);
  if (json.date !== expectedDate) throw new Error(`date mismatch: payload=${expectedDate}, file=${json.date}`);
  if (json.venueCode !== expectedVenue) throw new Error(`venueCode mismatch: expected=${expectedVenue}, file=${json.venueCode}`);
  if (!json.horses || typeof json.horses !== 'object') throw new Error('horses missing or not an object');
  return true;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error('❌ --date YYYY-MM-DD が必要');
    process.exit(2);
  }
  const venues = resolveVenues(args.venues);
  const token = process.env.GITHUB_TOKEN || null;

  console.log(`📥 importHorseHistoriesJra`);
  console.log(`   date:    ${args.date}`);
  console.log(`   venues:  ${venues.join(', ')}`);
  console.log(`   auth:    ${token ? 'GITHUB_TOKEN (Contents API)' : 'NONE (raw fallback)'}`);
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
      const r = await fetchSharedJson(sharedPath, token);
      if (r.status === 404) {
        console.log(`skip (404: ${sharedPath})`);
        skippedCount++;
        continue;
      }
      validateHorseHistoriesJson(r.json, venue, args.date);
      const horseCount = Object.keys(r.json.horses || {}).length;
      if (args.dryRun) {
        console.log(`OK (dry-run, horses=${horseCount}, would write ${localPath.replace(projectRoot, '.')})`);
        savedCount++;
        continue;
      }
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, JSON.stringify(r.json, null, 2), 'utf-8');
      console.log(`saved (horses=${horseCount}) -> ${localPath.replace(projectRoot, '.')}`);
      savedCount++;
    } catch (e) {
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

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
