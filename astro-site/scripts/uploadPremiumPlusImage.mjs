#!/usr/bin/env node
/**
 * Premium Plus 実績画像 アップロード（ターミナル用）
 *
 * 管理画面 /admin/premium-plus-images と同じ API を叩く。どちらで上げても結果は同じ。
 * ビルド不要・数秒で本番反映される。
 *
 * 使い方:
 *   export PREMIUM_PLUS_ADMIN_SECRET='...'          # Netlify に設定したものと同じ値
 *   npm run upload:premium-plus -- \
 *     --file ~/Desktop/spat4.png \
 *     --date 2026-07-15 --venue 川崎 --race 6 \
 *     --stake 16000 --payout 277000
 *
 *   # 不的中だった日（必ず上げること。的中日だけ上げると的中率が嘘になる）
 *   npm run upload:premium-plus -- --file ~/Desktop/spat4.png \
 *     --date 2026-07-16 --venue 大井 --race 11 --stake 16000 --miss
 *
 *   # 削除（撮り直し・入力ミス時。同じ日付で再アップロードすれば上書きなので通常は不要）
 *   npm run upload:premium-plus -- --delete 2026-07-15
 *
 * オプション:
 *   --api <url>   既定 https://analytics.keiba.link/.netlify/functions/premium-plus-media
 *                 （env PREMIUM_PLUS_API でも指定可。ローカル検証は http://localhost:8888/... ）
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_API =
  process.env.PREMIUM_PLUS_API || 'https://analytics.keiba.link/.netlify/functions/premium-plus-media';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (key === 'miss' || key === 'legacy') {
      args[key] = true;
    } else if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function die(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const api = args.api || DEFAULT_API;
const secret = process.env.PREMIUM_PLUS_ADMIN_SECRET;

if (!secret) die('PREMIUM_PLUS_ADMIN_SECRET が未設定です（Netlify に設定した値を export してください）');

async function post(payload) {
  const response = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) die(`${response.status}: ${result.error || 'アップロードに失敗しました'}`);
  return result;
}

if (args.delete) {
  const result = await post({ action: 'delete', date: String(args.delete) });
  console.log(`🗑️  ${result.deleted} を削除しました（残り ${result.count} 件）`);
  process.exit(0);
}

if (!args.file) die('--file が必要です');
if (!args.date) die('--date が必要です（YYYY-MM-DD）');

const filePath = path.resolve(String(args.file).replace(/^~/, process.env.HOME || '~'));
const buffer = await readFile(filePath).catch(() => die(`画像を読めません: ${filePath}`));
const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'image/png';

const isHit = !args.miss;
const payout = Number(args.payout || 0);
if (isHit && !payout) die('的中の場合は --payout が必要です（不的中なら --miss を付けてください）');

const result = await post({
  action: 'upload',
  date: String(args.date),
  venue: args.venue ? String(args.venue) : '',
  raceNumber: args.race ? Number(args.race) : null,
  stake: Number(args.stake || 0),
  isHit,
  payout: isHit ? payout : 0,
  legacy: args.legacy === true,
  imageBase64: `data:${contentType};base64,${buffer.toString('base64')}`,
});

const { rate, payout: payoutStats } = result.stats;
console.log(`✅ ${result.saved.date} ${result.saved.venue}${result.saved.raceNumber ?? ''}R を保存しました`);
console.log(`   結果: ${result.saved.isHit ? `的中 ¥${result.saved.payout.toLocaleString('ja-JP')}` : '不的中'}`);
console.log(`   登録件数: ${result.count}`);
console.log(
  `   的中率: ${
    rate.available
      ? `${rate.hitRate}%（${rate.hits}/${rate.races}・回収率 ${rate.roi}%）`
      : `集計中（${rate.races} 件・10 件から公開）`
  }`
);
console.log(`   最高払戻: ¥${payoutStats.max.toLocaleString('ja-JP')}`);
console.log('');
console.log('🌐 反映確認: https://analytics.keiba.link/premium-plus/ （ビルド不要・数秒で反映）');
