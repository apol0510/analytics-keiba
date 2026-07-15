#!/usr/bin/env node
/**
 * Premium Plus 実績画像 アップロード（ターミナル用 / Phase 3）
 *
 * 管理画面 /admin/premium-plus-images と同じ Function を叩く（Blobs へ直接書き込まない）。
 * 楽観ロック（expectedVersion）と operationId（冪等）で二重登録・後勝ち上書きを防ぐ。
 *
 * 使い方:
 *   export PREMIUM_PLUS_ADMIN_SECRET='...'          # Netlify に設定したものと同じ値
 *   npm run upload:premium-plus -- --file ~/Desktop/spat4.png \
 *     --date 2026-07-15 --venue 川崎 --race 6 --stake 16000 --payout 277000
 *   npm run upload:premium-plus -- --file ... --date ... --stake 16000 --miss   # 不的中
 *   npm run upload:premium-plus -- --dry-run --file ... --date ...              # 送信せず確認
 *   npm run upload:premium-plus -- --hide 2026-07-15        # 論理非表示（物理削除はしない）
 *   npm run upload:premium-plus -- --show 2026-07-15        # 再表示
 *   npm run upload:premium-plus -- --rollback 42            # 過去 version へ巻き戻し（新 version 発行）
 *
 * 注意:
 *   - secret はコマンドライン引数に渡さない（env のみ）。
 *   - 409（version 競合）時は自動上書き・自動 retry しない。状況を表示して非ゼロ終了する。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_API =
  process.env.PREMIUM_PLUS_API || 'https://analytics.keiba.link/.netlify/functions/premium-plus-media';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (['miss', 'legacy', 'dry-run'].includes(key)) args[key] = true;
    else if (next && !next.startsWith('--')) { args[key] = next; i++; }
    else args[key] = true;
  }
  return args;
}

const CONTENT_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function die(message) { console.error(`❌ ${message}`); process.exit(1); }

const args = parseArgs(process.argv.slice(2));
const api = args.api || DEFAULT_API;
const origin = new URL(api).origin; // 管理 POST は Origin 完全一致が必須
const dryRun = args['dry-run'] === true;
const secret = process.env.PREMIUM_PLUS_ADMIN_SECRET;
if (!secret && !dryRun) die('PREMIUM_PLUS_ADMIN_SECRET が未設定です（Netlify に設定した値を export してください）');

console.log(`🌐 宛先: ${api}  (context: production 前提)`);
if (dryRun) console.log('🧪 dry-run: 送信しません');

async function post(payload) {
  const response = await fetch(api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret, Origin: origin },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, result };
}

async function fetchVersion() {
  const { ok, status, result } = await post({ action: 'status' });
  if (!ok) die(`status 取得失敗: ${status} ${result.error || ''}`);
  return result.version;
}

function onConflict(result) {
  console.error(`⛔ version 競合（409）。current=${result.currentVersion}。`);
  console.error('   自動上書きはしません。最新状態を確認してからやり直してください。');
  process.exit(2);
}

// --- 論理非表示 / 再表示 ---
if (args.hide || args.show) {
  const date = String(args.hide || args.show);
  const action = args.hide ? 'hide' : 'show';
  if (dryRun) { console.log(`  ${action} ${date}`); process.exit(0); }
  const expectedVersion = await fetchVersion();
  const { ok, status, result } = await post({ action, date, operationId: randomUUID(), expectedVersion });
  if (status === 409) onConflict(result);
  if (!ok) die(`${status}: ${result.error || `${action} 失敗`}`);
  console.log(`✅ ${date} を${action === 'hide' ? '非表示' : '再表示'}にしました（version ${result.version} / op ${result.operationId}）`);
  process.exit(0);
}

// --- rollback ---
if (args.rollback) {
  const targetVersion = Number(args.rollback);
  if (!Number.isInteger(targetVersion) || targetVersion < 1) die('--rollback は 1 以上の version 番号');
  if (dryRun) { console.log(`  rollback → v${targetVersion}`); process.exit(0); }
  const expectedVersion = await fetchVersion();
  const { ok, status, result } = await post({ action: 'rollback', targetVersion, operationId: randomUUID(), expectedVersion });
  if (status === 409) onConflict(result);
  if (!ok) die(`${status}: ${result.error || 'rollback 失敗'}`);
  console.log(`✅ v${targetVersion} へ巻き戻しました（新 version ${result.version} / op ${result.operationId}）`);
  process.exit(0);
}

// --- upload ---
if (!args.file) die('--file が必要です');
if (!args.date) die('--date が必要です（YYYY-MM-DD）');

const filePath = path.resolve(String(args.file).replace(/^~/, process.env.HOME || '~'));
const buffer = await readFile(filePath).catch(() => die(`画像を読めません: ${filePath}`));
const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'image/png';
const isHit = !args.miss;
const payout = Number(args.payout || 0);
if (isHit && !payout) die('的中の場合は --payout が必要です（不的中なら --miss を付けてください）');

const uploadPayload = {
  action: 'upload',
  date: String(args.date),
  venue: args.venue ? String(args.venue) : '',
  raceNumber: args.race ? Number(args.race) : null,
  stake: Number(args.stake || 0),
  isHit,
  payout: isHit ? payout : 0,
  imageBase64: `data:${contentType};base64,${buffer.toString('base64')}`,
};

if (dryRun) {
  console.log(`  ${uploadPayload.date} ${uploadPayload.venue}${uploadPayload.raceNumber ?? ''}R  ${isHit ? `的中 ¥${payout.toLocaleString('ja-JP')}` : '不的中'}  (${Math.round(buffer.length / 1024)}KB)`);
  process.exit(0);
}

const expectedVersion = await fetchVersion();
const { ok, status, result } = await post({ ...uploadPayload, operationId: randomUUID(), expectedVersion });
if (status === 409) onConflict(result);
if (!ok) die(`${status}: ${result.error || 'アップロードに失敗しました'}`);

console.log(`✅ ${uploadPayload.date} を保存しました（version ${result.version} / op ${result.operationId}${result.idempotent ? ' / 冪等' : ''}）`);
console.log('🌐 反映確認: https://analytics.keiba.link/premium-plus/ （会員のみ・ビルド不要で数秒反映）');
