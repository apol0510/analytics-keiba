/**
 * comebackEmailTemplate.test.mjs — 案内メール本文が offer から生成される
 *   node --test src/lib/promotions/comebackEmailTemplate.test.mjs
 *
 * 守る性質:
 *   - 金額・期間が offer の値そのまま（手書きしない）
 *   - 自社否定（「以前は未完成」等）を書かない
 *   - 的中率・回収率の数値を書かない
 *   - 配信停止リンクを本文に書かない（送信基盤が付与する）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildComebackEmailContent, DEFAULT_COMEBACK_COMBO, yen } from './comebackEmailTemplate.js';
import { resolveOffer } from './promotionOfferCatalog.js';

const LIGHT_LIFETIME = resolveOffer('light-lifetime-free').offer;
const PREMIUM_30D = resolveOffer('premium-30d-free').offer;
const PREMIUM_ANNUAL_HALF = resolveOffer('premium-annual-half').offer;
const PREMIUM_LIFETIME_HALF = resolveOffer('premium-lifetime-half').offer;

test('何も選ばれていなければ本文を作らない', () => {
  assert.equal(buildComebackEmailContent({}), null);
  assert.equal(buildComebackEmailContent({ grantOffers: [], purchaseOffer: null }), null);
});

test('Light 永久無料のみ', () => {
  const c = buildComebackEmailContent({ grantOffers: [LIGHT_LIFETIME] });
  assert.match(c.subject, /Light/);
  assert.match(c.body, /Light プランを無期限で無料/);
  assert.match(c.body, /メインレース買い目/, 'Light で何が見えるかを説明していない');
  assert.equal(c.body.includes('Premium'), false, '選んでいない Premium が本文に出ている');
});

test('Light 永久無料 ＋ Premium 30日無料（主要施策）', () => {
  const c = buildComebackEmailContent({ grantOffers: [LIGHT_LIFETIME, PREMIUM_30D] });
  assert.match(c.body, /Light プランを無期限で無料/);
  assert.match(c.body, /Premium プランを30日間 無料/);
  assert.match(c.body, /期間終了後も Light プランは無料のまま/, 'Premium 終了後の状態を説明していない');
  assert.match(c.body, /お支払いも必要ありません/);
});

test('割引 offer は通常価格と特別価格の両方を出す', () => {
  const c = buildComebackEmailContent({
    grantOffers: [LIGHT_LIFETIME],
    purchaseOffer: PREMIUM_ANNUAL_HALF,
    offerUrl: 'https://analytics.keiba.link/offer/?t=abc',
    offerExpiresText: '2026-08-13',
  });
  assert.match(c.body, /通常 ¥49,800 のところ/);
  assert.match(c.body, /¥24,900/);
  assert.match(c.body, /2026-08-13 までに/);
  assert.equal(c.ctaUrl, 'https://analytics.keiba.link/offer/?t=abc');

  const l = buildComebackEmailContent({ purchaseOffer: PREMIUM_LIFETIME_HALF, offerUrl: 'https://x' });
  assert.match(l.body, /買い切り（永久アクセス）/);
  assert.match(l.body, /¥78,000/);
  assert.match(l.body, /¥39,000/);
});

test('割引の URL が無ければ CTA は購入ページにしない（推測 URL を作らない）', () => {
  const c = buildComebackEmailContent({ grantOffers: [LIGHT_LIFETIME], purchaseOffer: PREMIUM_ANNUAL_HALF });
  assert.match(c.ctaUrl, /\/login\/$/);
});

test('自社否定・誇大表現・数値を書かない', () => {
  const bodies = [
    buildComebackEmailContent({ grantOffers: [LIGHT_LIFETIME, PREMIUM_30D] }).body,
    buildComebackEmailContent({ grantOffers: [LIGHT_LIFETIME], purchaseOffer: PREMIUM_ANNUAL_HALF, offerUrl: 'https://x' }).body,
  ];
  for (const body of bodies) {
    for (const banned of [
      '未完成', '駄目', 'ダメ', '物足りな', '序奏', '序章', '生まれ変わ',
      '的中率', '回収率', '必ず', '確実に', '絶対', '今だけ', '急いで',
      '配信停止', 'unsubscribe',
    ]) {
      assert.equal(body.includes(banned), false, `禁止表現「${banned}」が含まれる`);
    }
    // 継続改善の言い方になっている
    assert.match(body, /継続的に改善/);
  }
});

test('宛名プレースホルダは {{salutation}} だけ', () => {
  const body = buildComebackEmailContent({ grantOffers: [LIGHT_LIFETIME] }).body;
  const placeholders = [...body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(placeholders)], ['salutation']);
});

test('既定の組み合わせは Light 永久無料 ＋ Premium 30日無料', () => {
  const c = buildComebackEmailContent(DEFAULT_COMEBACK_COMBO);
  assert.ok(c);
  assert.match(c.body, /Light プランを無期限で無料/);
  assert.match(c.body, /Premium プランを30日間 無料/);
});

test('yen は 3 桁区切り', () => {
  assert.equal(yen(49800), '¥49,800');
  assert.equal(yen(0), '¥0');
  assert.equal(yen('x'), '');
});
