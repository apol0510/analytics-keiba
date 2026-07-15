#!/usr/bin/env node
/**
 * Premium Plus: 刷新前の実績画像を legacy として一括投入する（seed 専用経路 / Phase 3）
 *
 * scripts/data/premium-plus-legacy.json の実測値を legacy=true で登録する。
 * legacy のエントリは的中率・回収率の母数に入らない（的中日しか保存されていないため）。
 *
 * Phase 3 の seed 仕様（2 段階・current は最後まで変えない）:
 *   - seed-stage: 画像を 1 枚ずつ immutable キーへ保存（body 上限回避）。current は不変。
 *   - seed-commit: ステージ済みの (date, checksum) を参照するマニフェストを 1 回だけ発行し、
 *     current を一度だけ切り替える。
 *   - operationId で冪等。expectedVersion で楽観ロック。409 は自動上書きしない。
 *   - Blobs へ直接書き込まない。
 *
 * 使い方:
 *   export PREMIUM_PLUS_ADMIN_SECRET='...'
 *   npm run seed:premium-plus -- --dry-run   # 何を送るか確認だけ
 *   npm run seed:premium-plus                # 実行（既定は本番宛先）
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_DIR = path.join(__dirname, '..', 'public', 'upsell-images');
const DATA_FILE = path.join(__dirname, 'data', 'premium-plus-legacy.json');

const api = process.env.PREMIUM_PLUS_API || 'https://analytics.keiba.link/.netlify/functions/premium-plus-media';
const origin = new URL(api).origin;
const secret = process.env.PREMIUM_PLUS_ADMIN_SECRET;
const dryRun = process.argv.includes('--dry-run');

if (!secret && !dryRun) { console.error('❌ PREMIUM_PLUS_ADMIN_SECRET が未設定です'); process.exit(1); }

console.log(`🌐 宛先: ${api}  (context: production 前提)`);

const { entries } = JSON.parse(await readFile(DATA_FILE, 'utf8'));

// 各 entry の meta + 画像を用意
const prepared = [];
for (const entry of entries) {
  const imagePath = path.join(IMAGE_DIR, entry.file);
  let buffer;
  try { buffer = await readFile(imagePath); }
  catch { console.warn(`⚠️  画像なし・スキップ: ${entry.file}`); continue; }
  if (dryRun) {
    console.log(`  ${entry.date} ${entry.venue}${entry.raceNumber}R  的中 ¥${entry.payout.toLocaleString('ja-JP')}  (${Math.round(buffer.length / 1024)}KB)`);
  }
  prepared.push({
    meta: { date: entry.date, venue: entry.venue, raceNumber: entry.raceNumber, stake: entry.stake, isHit: entry.isHit, payout: entry.payout, legacy: true },
    imageBase64: `data:image/png;base64,${buffer.toString('base64')}`,
  });
}

console.log(`📦 ${prepared.length} 件を ${dryRun ? '確認しました（送信なし）' : '2 段階（stage → commit）で投入します'}`);
if (dryRun) process.exit(0);

async function post(payload) {
  const response = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret, Origin: origin },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, result };
}

// Phase 1: 画像を 1 枚ずつ stage（current は変えない）。checksum を集める。
const committedItems = [];
for (const p of prepared) {
  const { ok, status, result } = await post({ action: 'seed-stage', items: [{ ...p.meta, imageBase64: p.imageBase64 }] });
  if (!ok) { console.error(`❌ stage 失敗 (${p.meta.date}): ${status} ${result.error || ''}`); process.exit(1); }
  committedItems.push({ ...p.meta, checksum: result.staged[0].checksum });
  console.log(`  ✅ staged ${p.meta.date}`);
}

// Phase 2: current version を取得 → 1 回だけ commit（一度だけ切替）
const status = await post({ action: 'status' });
if (!status.ok) { console.error(`❌ status 取得失敗: ${status.status} ${status.result.error || ''}`); process.exit(1); }
const { ok, status: code, result } = await post({
  action: 'seed-commit', items: committedItems, operationId: randomUUID(), expectedVersion: status.result.version,
});
if (code === 409) { console.error(`⛔ version 競合（current=${result.currentVersion}）。自動上書きしません。`); process.exit(2); }
if (!ok) { console.error(`❌ seed-commit 失敗: ${code} ${result.error || ''}`); process.exit(1); }

console.log(`🎉 ${result.count} 件を登録しました（version ${result.version}）。`);
