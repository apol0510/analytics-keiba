#!/usr/bin/env node

/**
 * JRA 速報結果インポートスクリプト
 *
 * keiba-data-shared/jra/live-results/YYYY/MM/YYYY-MM-DD.json を取得し、
 * astro-site/src/data/jraLiveResults/YYYY-MM-DD.json に保存する。
 *
 * 速報データは確定データ (archiveResultsJra.json) で上書きされる前提の
 * 一時データ。日付別ファイルで管理し、確定後は削除可能。
 *
 * Usage:
 *   node scripts/importJraLiveResults.js --date=2026-05-02
 *
 * 受信ペイロード (workflow から):
 *   - date: YYYY-MM-DD
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const SHARED_OWNER = 'apol0510';
const SHARED_REPO = 'keiba-data-shared';
const SHARED_BRANCH = 'main';

function parseArgs(argv) {
  const args = { date: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--date=')) args.date = a.slice('--date='.length);
    else if (a === '--date' && argv[argv.indexOf(a) + 1]) args.date = argv[argv.indexOf(a) + 1];
  }
  return args;
}

async function fetchLiveResultsFromShared(date) {
  const year = date.slice(0, 4);
  const month = date.slice(5, 7);
  const path = `jra/live-results/${year}/${month}/${date}.json`;
  const url = `https://raw.githubusercontent.com/${SHARED_OWNER}/${SHARED_REPO}/${SHARED_BRANCH}/${path}`;
  console.log(`📡 GET ${url}`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'keiba-intelligence-import-live',
      // GITHUB_TOKEN があれば添付（rate limit 緩和、private repo対応）
      ...(process.env.GITHUB_TOKEN ? { 'Authorization': `token ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (res.status === 404) {
    return { found: false, data: null };
  }
  if (!res.ok) {
    throw new Error(`GitHub raw fetch failed: HTTP ${res.status}`);
  }
  const data = await res.json();
  return { found: true, data };
}

function validateLiveData(data, expectedDate) {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid data: not an object');
  }
  if (data.live !== true) {
    throw new Error(`Invalid data: live flag must be true (got ${data.live})`);
  }
  if (data.date !== expectedDate) {
    throw new Error(`date mismatch: expected ${expectedDate}, got ${data.date}`);
  }
  if (!Array.isArray(data.venues)) {
    throw new Error('Invalid data: venues must be an array');
  }
  return true;
}

/**
 * 確定データ (archiveResultsJra.json) に「完全な」同日エントリがあれば
 * live-results は不要 → 保存スキップ + 既存ファイル削除。
 *
 * 「完全」の判定: totalPayout > 0 (HR取得済み・払戻が実体ある)
 *   - JV-Link が rank/HR を取れずに payout=0 で archive 入りした「broken」状態
 *     では live 側を残し、UI の暫定再計算に使えるようにする。
 */
function shouldSkipBecauseConfirmed(date) {
  try {
    const archivePath = join(projectRoot, 'src', 'data', 'archiveResultsJra.json');
    if (!existsSync(archivePath)) return false;
    const archive = JSON.parse(readFileSync(archivePath, 'utf-8'));
    if (!Array.isArray(archive)) return false;
    const entry = archive.find((e) => e?.date === date);
    if (!entry) return false;
    // payout が実体ある場合のみ「完全な確定」とみなす
    const totalPayout = Number(entry.totalPayout) || 0;
    if (totalPayout > 0) return true;
    console.log(`ℹ️ archive entry for ${date} あるが totalPayout=0 (broken/HR未取得) → live 取込を継続`);
    return false;
  } catch (e) {
    console.warn(`⚠️  archiveResultsJra.json チェック失敗 (継続): ${e.message}`);
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error('Usage: node scripts/importJraLiveResults.js --date=YYYY-MM-DD');
    process.exit(2);
  }
  const date = args.date;
  console.log(`📅 対象日: ${date}`);

  // ── 確定データ優先: 既に archiveResultsJra に同日エントリがあれば live は不要 ──
  if (shouldSkipBecauseConfirmed(date)) {
    console.log(`✅ ${date} は確定データが既にあるため live-results 取込をスキップ`);
    // 既存の live ファイルがあれば削除
    const liveDir = join(projectRoot, 'src', 'data', 'jraLiveResults');
    const livePath = join(liveDir, `${date}.json`);
    if (existsSync(livePath)) {
      unlinkSync(livePath);
      console.log(`🗑  古い live ファイルを削除: src/data/jraLiveResults/${date}.json`);
    }
    return;
  }

  // ── keiba-data-shared から fetch ──
  const { found, data } = await fetchLiveResultsFromShared(date);
  if (!found) {
    console.warn(`⚠️  keiba-data-shared に jra/live-results/${date}.json なし → スキップ`);
    return;
  }

  validateLiveData(data, date);

  const totalRaces = data.venues.reduce((s, v) => s + (v.races?.length || 0), 0);
  console.log(`✅ live-results 取得: venues=${data.venues.length} races=${totalRaces} fetchedAt=${data.fetchedAt}`);

  // ── ローカル保存 ──
  const liveDir = join(projectRoot, 'src', 'data', 'jraLiveResults');
  if (!existsSync(liveDir)) mkdirSync(liveDir, { recursive: true });
  const livePath = join(liveDir, `${date}.json`);
  writeFileSync(livePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`💾 saved: src/data/jraLiveResults/${date}.json`);
}

main().catch((e) => {
  console.error('❌ FATAL:', e);
  process.exit(1);
});
