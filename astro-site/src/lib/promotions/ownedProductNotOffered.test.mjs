/**
 * ownedProductNotOffered.test.mjs — 「買ったのに、まだ勧め続ける」を止める
 *
 * ## 実際に起きたこと（2026-08-25）
 *
 * 三連複を購入いただいた当日、`/pricing/` などに
 * 「三連複 買い切り 10,000円OFF」が**出続けていた**。
 *
 * 原因は、三連複が **プラン名に現れない**こと。買い切りの追加権なので
 * Airtable では `プラン` ではなく `LifetimeSanrenpuku` が持ち、購入後も
 * `プラン` は `'Premium'` のまま。ところが公開 API の出し分けは
 * `?plan=` の文字列だけを見ていたため、`'Premium'` = まだ持っていない、と読んでいた。
 *
 * | 画面 | 判定材料 | 購入後 |
 * |---|---|---|
 * | マイページのカード・お知らせ | サーバーの実データ | 正しく消えていた |
 * | `/pricing/` などのバナー・申込金額 | `?plan=` の文字列 | **出続けていた** |
 *
 * ## 直し方
 *
 * 画面は保存済みの `lifetimeSanrenpuku` を**事実として**送り、
 * それが何を意味するかはサーバーが決める（判断を画面へ持ち出さない）。
 * さらに、お金が動く側（申込 Function）で二重申込を断る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveCampaignOfferIdsFor, CAMPAIGN_OFFER_IDS } from './campaignOffers.js';
import { resolveDuplicatePurchase, DUPLICATE_PURCHASE } from '../payments/duplicatePurchase.js';
import { fromAirtableFields, resolveEntitlements } from '../entitlements/resolveEntitlements.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8');

/** 実在の契約形（Premium 年額 ＋ 三連複買い切り）。プラン名は 'Premium' のまま */
const PREMIUM_PLUS_SANRENPUKU = {
  'プラン': 'Premium',
  'PlanType': 'Annual',
  'Status': 'active',
  '有効期限': '2027-08-01',
  'LifetimeSanrenpuku': true,
};

test('三連複を買った方には、もう三連複を勧めない（実データ）', () => {
  const ent = resolveEntitlements(fromAirtableFields(PREMIUM_PLUS_SANRENPUKU), Date.parse('2026-08-25T12:00:00+09:00'));
  assert.equal(ent.canViewSanrenpuku, true, '購入が権利として読めていない');
  assert.deepEqual(resolveCampaignOfferIdsFor(ent), [], 'すでに持っている商品を勧めている');
});

test('買う前の Premium 会員には三連複を勧める（案内を消しすぎない）', () => {
  const before = { ...PREMIUM_PLUS_SANRENPUKU, LifetimeSanrenpuku: false };
  const ent = resolveEntitlements(fromAirtableFields(before), Date.parse('2026-08-25T12:00:00+09:00'));
  assert.deepEqual(resolveCampaignOfferIdsFor(ent), [CAMPAIGN_OFFER_IDS.SANRENPUKU_LIFETIME]);
});

// ── 公開 API は「プラン名」だけで判断しない ──────────────────
const API = read('../../pages/api/campaign.json.js');

test('公開 API は三連複の買い切り権を受け取る（プラン名に現れないため）', () => {
  assert.match(API, /sanrenpuku/, '買い切り権の申告を受け取っていない');
  // 出し分け・商品価格の**両方**で使うこと（片方だけだと案内と金額がズレる）
  // ⚠️ 定義（function ...）は除き、**呼び出し**だけを見る
  const calls = [];
  for (const m of API.matchAll(/entitlementsFromDeclaredPlan\(/g)) {
    if (/function\s+$/.test(API.slice(0, m.index))) continue;
    calls.push(API.slice(m.index, m.index + 160));
  }
  assert.ok(calls.length >= 2, `呼び出しが ${calls.length} か所しか無い`);
  for (const args of calls) {
    assert.match(args, /sanrenpuku/, `買い切り権を渡していない呼び出しがある: ${args.split('\n')[0]}`);
  }
});

test('画面は「事実」だけを送る（意味づけを画面に持ち出さない）', () => {
  for (const [label, src] of [
    ['申込モーダルの金額', read('../../../public/js/campaign-price.js')],
    ['ご案内バナー', read('../../components/CampaignBanner.astro')],
  ]) {
    assert.match(src, /lifetimeSanrenpuku/, `${label}: 買い切り権を送っていない`);
    assert.match(src, /sanrenpuku=/, `${label}: API へ渡していない`);
    // ⚠️ 画面で「持っているから出さない」と判断しないこと（判断はサーバー）
    assert.doesNotMatch(src.replace(/\/\/[^\n]*/g, ''), /canViewSanrenpuku/,
      `${label}: 画面で権利を解釈している`);
  }
});

// ── お金が動く側の最後の砦 ──────────────────────────────
test('すでに持っている三連複の申込は受け付けない', () => {
  const d = resolveDuplicatePurchase({
    planName: 'Premium Sanrenpuku', planType: 'Lifetime',
    entitlements: { canViewSanrenpuku: true },
  });
  assert.equal(d.blocked, true);
  assert.equal(d.reason, DUPLICATE_PURCHASE.SANRENPUKU_OWNED);
  assert.match(d.message, /すでにお持ち/);
});

test('持っていない方・他の商品・確認できないときは止めない（買えない事故を作らない）', () => {
  for (const input of [
    { planName: 'Premium Sanrenpuku', entitlements: { canViewSanrenpuku: false } },
    { planName: 'Premium Sanrenpuku', entitlements: {} },              // 確認できない
    { planName: 'Premium Sanrenpuku' },                                 // 権利そのものが無い
    { planName: 'Premium', entitlements: { canViewSanrenpuku: true } },  // 別商品（更新など）
    { planName: 'Light', entitlements: { canViewSanrenpuku: true } },
    {},
  ]) {
    assert.equal(resolveDuplicatePurchase(input).blocked, false, JSON.stringify(input));
  }
});

test('申込 Function は書き込む前に断る（レコードを触らない）', () => {
  const fn = read('../../../netlify/functions/bank-transfer-application.js');
  assert.match(fn, /resolveDuplicatePurchase/, '申込側で見ていない');
  const i = fn.indexOf('resolveDuplicatePurchase({');
  const j = fn.indexOf('// 既存顧客 - Update');
  assert.ok(i > 0 && j > 0 && i < j, '書き込みより後で判定している');
  const block = fn.slice(i, i + 900);
  assert.match(block, /statusCode: 409/, '断り方が 409 でない');
  assert.match(block, /sideEffects: 'none'/, '何も起きていないことを伝えていない');
});
