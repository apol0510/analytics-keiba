#!/usr/bin/env node
/**
 * Premium Plus: 刷新前の実績画像（public/upsell-images/）を Blobs へ 1 回だけ流し込む。
 *
 * scripts/data/premium-plus-legacy.json の実測値を legacy=true で登録する。
 * legacy のエントリは的中率・回収率の母数に入らない（的中日しか保存されていないため）。
 * 最高払戻・的中時平均払戻にだけ寄与する。
 *
 * 使い方:
 *   export PREMIUM_PLUS_ADMIN_SECRET='...'
 *   npm run seed:premium-plus              # 実行
 *   npm run seed:premium-plus -- --dry-run # 何を送るか確認だけ
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_DIR = path.join(__dirname, '..', 'public', 'upsell-images');
const DATA_FILE = path.join(__dirname, 'data', 'premium-plus-legacy.json');

const api =
  process.env.PREMIUM_PLUS_API || 'https://analytics.keiba.link/.netlify/functions/premium-plus-media';
const secret = process.env.PREMIUM_PLUS_ADMIN_SECRET;
const dryRun = process.argv.includes('--dry-run');

if (!secret && !dryRun) {
  console.error('❌ PREMIUM_PLUS_ADMIN_SECRET が未設定です');
  process.exit(1);
}

const { entries } = JSON.parse(await readFile(DATA_FILE, 'utf8'));
console.log(`📦 ${entries.length} 件を ${dryRun ? '確認' : `送信 → ${api}`}`);

let sent = 0;
for (const entry of entries) {
  const imagePath = path.join(IMAGE_DIR, entry.file);
  let buffer;
  try {
    buffer = await readFile(imagePath);
  } catch {
    console.warn(`⚠️  画像なし・スキップ: ${entry.file}`);
    continue;
  }

  if (dryRun) {
    console.log(`  ${entry.date} ${entry.venue}${entry.raceNumber}R  的中 ¥${entry.payout.toLocaleString('ja-JP')}  (${Math.round(buffer.length / 1024)}KB)`);
    continue;
  }

  const response = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
    body: JSON.stringify({
      action: 'upload',
      date: entry.date,
      venue: entry.venue,
      raceNumber: entry.raceNumber,
      stake: entry.stake,
      isHit: entry.isHit,
      payout: entry.payout,
      legacy: true,
      imageBase64: `data:image/png;base64,${buffer.toString('base64')}`,
    }),
  });

  if (!response.ok) {
    const { error } = await response.json().catch(() => ({}));
    console.error(`❌ ${entry.date}: ${response.status} ${error || ''}`);
    process.exit(1);
  }

  sent++;
  console.log(`  ✅ ${entry.date} ${entry.venue}${entry.raceNumber}R`);
}

if (!dryRun) console.log(`\n🎉 ${sent} 件を登録しました。https://analytics.keiba.link/premium-plus/ で確認できます。`);
