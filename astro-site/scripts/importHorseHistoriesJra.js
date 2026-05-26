#!/usr/bin/env node
/**
 * importHorseHistoriesJra.js
 *
 * keiba-data-shared の jra/horseHistories/YYYY/MM/YYYY-MM-DD-{VENUE}.json を
 * 本リポジトリの astro-site/src/data/horseHistories/jra/YYYY/MM/{file} に転記する。
 *
 * 取得方式:
 *   - Contents API + Accept: application/vnd.github.raw を使用
 *     (>1MB のファイルでも raw でボディに返るため Unexpected end of JSON input を防ぐ)
 *   - token 優先順位:
 *       1. KEIBA_DATA_SHARED_TOKEN (推奨 / Actions secret はこの名前)
 *       2. GITHUB_TOKEN_KEIBA_DATA_SHARED (ローカル互換用 fallback)
 *       3. GITHUB_TOKEN (最終 fallback。Actions の自動トークンは
 *          keiba-data-shared には届かないため通常使えない)
 *   - token が無ければ raw.githubusercontent.com に fallback (public 前提)
 *
 * 使い方:
 *   node scripts/importHorseHistoriesJra.js --date 2026-05-24
 *   node scripts/importHorseHistoriesJra.js --date 2026-05-24 --venues TOK,KYO,NII
 *   node scripts/importHorseHistoriesJra.js --date 2026-05-24 --dry-run
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const SHARED_OWNER = 'apol0510';
const SHARED_REPO = 'keiba-data-shared';
const SHARED_BRANCH = 'main';

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

function pickToken() {
  // 優先順位:
  //   1. KEIBA_DATA_SHARED_TOKEN  ← Actions secret はこの名前 (GITHUB_ 始まりは禁止のため)
  //   2. GITHUB_TOKEN_KEIBA_DATA_SHARED  ← ローカル互換用 fallback
  //   3. GITHUB_TOKEN  ← Actions の自動トークン。keiba-data-shared には通常届かない
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

async function fetchSharedRaw(sharedPath, token) {
  // Contents API + Accept: application/vnd.github.raw
  //   * >1MB のファイルでもボディに raw が返る
  //   * private repo でも token があれば取得可
  if (token) {
    const url = `https://api.github.com/repos/${SHARED_OWNER}/${SHARED_REPO}/contents/${sharedPath}?ref=${SHARED_BRANCH}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.raw',
        'User-Agent': 'import-horse-histories-jra',
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
  const rawUrl = `https://raw.githubusercontent.com/${SHARED_OWNER}/${SHARED_REPO}/${SHARED_BRANCH}/${sharedPath}?t=${Date.now()}`;
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

function validateHorseHistoriesJson(json, expectedVenue, expectedDate) {
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
  const { token, source: tokenSource } = pickToken();

  console.log(`📥 importHorseHistoriesJra`);
  console.log(`   date:    ${args.date}`);
  console.log(`   venues:  ${venues.join(', ')}`);
  console.log(`   auth:    ${token ? `Contents API (token from ${tokenSource})` : 'NONE (raw fallback, public only)'}`);
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
      const r = await fetchSharedRaw(sharedPath, token);
      if (r.status === 404) {
        console.log(`skip (HTTP 404 from keiba-data-shared: ${sharedPath})`);
        skippedCount++;
        continue;
      }
      if (!r.ok) {
        throw new Error(r.error || `fetch failed (status=${r.status})`);
      }
      const json = parseJsonStrict(r.body, r.meta);
      validateHorseHistoriesJson(json, venue, args.date);
      const horseCount = Object.keys(json.horses || {}).length;
      if (args.dryRun) {
        console.log(`OK (dry-run, horses=${horseCount}, bytes=${r.body.length}, would write ${localPath.replace(projectRoot, '.')})`);
        savedCount++;
        continue;
      }
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, JSON.stringify(json, null, 2), 'utf-8');
      console.log(`saved (horses=${horseCount}, bytes=${r.body.length}) -> ${localPath.replace(projectRoot, '.')}`);
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
    if (tokenSource === 'NONE') {
      console.error('   ヒント: keiba-data-shared が private の場合、token が必須です。');
      console.error('   workflow secret に KEIBA_DATA_SHARED_TOKEN を設定してください。');
      console.error('   (GITHUB_ で始まる secret 名は GitHub Actions で禁止のため、専用名を使います)');
    } else if (tokenSource === 'GITHUB_TOKEN') {
      console.error('   ヒント: Actions の自動 GITHUB_TOKEN は keiba-data-shared には通常届きません。');
      console.error('   workflow secret に KEIBA_DATA_SHARED_TOKEN を設定し、env で渡してください。');
    }
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
