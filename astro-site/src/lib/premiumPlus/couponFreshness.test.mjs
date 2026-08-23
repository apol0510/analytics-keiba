/**
 * couponFreshness.test.mjs — 管理画面の操作が**顧客画面へすぐ反映される**ことを固定する
 *
 * ## 直した障害（2026-08-23 / MK 報告「反映されない」）
 *
 * 管理画面でクーポンを再発行しても、顧客側 API は **10 分間ずっと古い取得日時**を返していた。
 * `purchaseAnchorLookup` が Customers の fields を 10 分キャッシュしており、
 * **管理操作は別 Function なのでそのキャッシュを無効化できない**ため。
 *
 * 実測（本番）:
 *   admin  … 取得日時 2026-08-23T14:35:22.669Z（再発行済み）
 *   顧客API … 取得日時 2026-08-23T13:06:14.313Z（**1 つ前のまま**）
 *
 * → お知らせの「新しさ」も古い値で判定され、**通知が出なかった**。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  lookupCustomerFields, clearAnchorCache,
  ANCHOR_CACHE_TTL_MS, FRESH_LOOKUP_MAX_AGE_MS,
} from './purchaseAnchorLookup.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const REC = 'recSYNTH00000001';
const ENV = { AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'b' };

let served;
let calls;
const fetchImpl = async () => {
  calls += 1;
  return { ok: true, status: 200, json: async () => ({ id: REC, fields: served }) };
};

beforeEach(() => {
  clearAnchorCache();
  calls = 0;
  served = { PremiumPlusReopenCouponClaimedAt: '2026-08-23T13:06:14.313Z' };
});

test('鮮度を指定しなければ従来どおりキャッシュを使う（読み取りを増やさない）', async () => {
  const t = Date.parse('2026-08-23T14:00:00.000Z');
  await lookupCustomerFields({ recordId: REC, env: ENV, now: t, fetchImpl });
  await lookupCustomerFields({ recordId: REC, env: ENV, now: t + 5 * 60 * 1000, fetchImpl });
  assert.equal(calls, 1, 'キャッシュが効いていない');
});

test('鮮度を指定すると、古い値を使わず取り直す（管理操作がすぐ見える）', async () => {
  const t = Date.parse('2026-08-23T14:00:00.000Z');
  await lookupCustomerFields({ recordId: REC, env: ENV, now: t, fetchImpl, maxAgeMs: FRESH_LOOKUP_MAX_AGE_MS });

  // 管理画面で再発行された（別 Function なので、こちらのキャッシュは無効化されない）
  served = { PremiumPlusReopenCouponClaimedAt: '2026-08-23T14:35:22.669Z' };

  const after = await lookupCustomerFields({
    recordId: REC, env: ENV, now: t + FRESH_LOOKUP_MAX_AGE_MS + 1, fetchImpl,
    maxAgeMs: FRESH_LOOKUP_MAX_AGE_MS,
  });
  assert.equal(calls, 2, '古い値を使い続けている');
  assert.equal(after.PremiumPlusReopenCouponClaimedAt, '2026-08-23T14:35:22.669Z',
    '管理画面の操作が顧客画面へ反映されない');
});

test('鮮度の範囲内なら取り直さない（毎回 Airtable を叩かない）', async () => {
  const t = Date.parse('2026-08-23T14:00:00.000Z');
  await lookupCustomerFields({ recordId: REC, env: ENV, now: t, fetchImpl, maxAgeMs: FRESH_LOOKUP_MAX_AGE_MS });
  await lookupCustomerFields({
    recordId: REC, env: ENV, now: t + FRESH_LOOKUP_MAX_AGE_MS - 1, fetchImpl,
    maxAgeMs: FRESH_LOOKUP_MAX_AGE_MS,
  });
  assert.equal(calls, 1);
});

test('許容鮮度は 10 分キャッシュより十分短い', () => {
  assert.ok(FRESH_LOOKUP_MAX_AGE_MS > 0);
  assert.ok(FRESH_LOOKUP_MAX_AGE_MS <= 2 * 60 * 1000, '反映まで待たせすぎ');
  assert.ok(FRESH_LOOKUP_MAX_AGE_MS < ANCHOR_CACHE_TTL_MS);
});

// ── どの面が鮮度を要求するか ────────────────────────────────
test('クーポンに関わる面はすべて新しい値で読む', () => {
  const surfaces = [
    ['マイページのお知らせ・カード', '../../pages/api/upsell.json.js'],
    ['クーポンページ', '../../pages/premium-plus-coupon.astro'],
    ['申込画面の価格', '../../pages/api/premium-plus-order.json.js'],
    ['クーポンの取得', '../../pages/api/premium-plus-coupon.json.js'],
  ];
  for (const [name, rel] of surfaces) {
    const src = read(rel);
    assert.match(src, /maxAgeMs: FRESH_LOOKUP_MAX_AGE_MS/, `${name}: 古い値を使い続ける`);
  }
});
