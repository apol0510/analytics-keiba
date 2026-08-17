#!/usr/bin/env node
/**
 * touch-measurement-scan.mjs — touch 別実績を**ページを辿って**合算する（read-only）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * `action=touchMeasurement` は 1 リクエスト 1 ページしか返さない（timeout を前提にしない設計）。
 * 全体を見たいときは cursor を辿って足す必要があり、その手順を**機械に固定**する。
 * 2026-08-17 に配信行 610 で 504 になったのが発端。最終的に 14,000 名規模になる。
 *
 * ── 使い方 ────────────────────────────────────────────────────
 *   MARKETING_ADMIN_SECRET=… node scripts/touch-measurement-scan.mjs [--campaign <id>] [--page 200]
 *   # secret は PREMIUM_PLUS_ADMIN_SECRET でも可（Function 側の優先順と同じ）
 *   # 基点 URL は AK_BASE_URL で上書きできる（既定 https://analytics.keiba.link）
 *
 * ⚠️ **read-only**。付与・キュー登録・送信は一切しない（呼ぶのは touchMeasurement だけ）。
 * ⚠️ 出力は**件数と率だけ**。アドレス・recordId・secret は出さない。
 */
import { scanAllTouchPages, TOUCH_SCAN_DEFAULT_PAGE } from '../src/lib/marketing/touchMeasurementScan.js';

const BASE_URL = process.env.AK_BASE_URL || 'https://analytics.keiba.link';
const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET || '';

function parseArgs(argv) {
  const out = { campaign: 'light-trial-to-premium-sequence', page: TOUCH_SCAN_DEFAULT_PAGE };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--campaign') { out.campaign = String(argv[i + 1] || out.campaign); i += 1; }
    if (argv[i] === '--page') { const n = Number(argv[i + 1]); if (Number.isFinite(n)) out.page = n; i += 1; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!SECRET) {
  console.error('❌ 管理 secret がありません（MARKETING_ADMIN_SECRET / PREMIUM_PLUS_ADMIN_SECRET）');
  process.exit(1);
}

let pageIndex = 0;

/** 1 ページ取る。**この関数だけが通信する** */
async function fetchPage(cursor) {
  const res = await fetch(`${BASE_URL}/.netlify/functions/admin-marketing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': SECRET },
    body: JSON.stringify({
      action: 'touchMeasurement',
      campaignId: args.campaign,
      pageSize: args.page,
      cursor: cursor || undefined,
      pageIndex,
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) throw new Error(`touchMeasurement: HTTP ${res.status}`);
  pageIndex += 1;
  return body;
}

const result = await scanAllTouchPages({ fetchPage });

console.log(`\n── touch 別実績 / ${args.campaign} ──`);
console.log(`ページ数: ${result.scan.pages} / 読んだ配信行: ${result.scan.rows} / 走査完了: ${result.complete ? 'はい' : '**いいえ**'}`);
console.log(`計測可否: ${result.measurementAvailable ? '計測できている' : '**索引を読めていない（未計測）**'}`);
for (const t of result.touches) {
  const dr = t.deliveryRate === null ? '—' : `${(t.deliveryRate * 100).toFixed(1)}%`;
  const or = t.openRate === null ? '—' : `${(t.openRate * 100).toFixed(1)}%`;
  console.log(`  接点 ${t.touch}: sent ${t.sent} / delivered ${t.delivered} (${dr}) / opened ${t.opened} (${or}) / 未計測 ${t.unknown}`);
}
const T = result.totals;
console.log(`  合計: sent ${T.sent} / delivered ${T.delivered} / opened ${T.opened} / measured ${T.measured} / 未計測 ${T.unknown}`);
console.log('  ※ click は provider 側 OFF（計測していない。0 ではない）\n');

if (!result.complete) {
  console.error('⚠️ 全ページを辿り切れていません（数を全体として扱わないでください）');
  process.exit(1);
}
