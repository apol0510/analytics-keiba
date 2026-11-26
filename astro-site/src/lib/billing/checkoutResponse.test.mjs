import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkoutResponseBody, publicCheckoutPrice } from './checkoutResponse.js';

const base = { url: 'https://checkout.example/x', subscriptionId: 'txn_01abc', provider: 'paddle', recordId: 'recSECRETAAAAAAAA', guest: true };

test('Paddle の申込結果の price（請求される額・特別価格の有無）を返す。会員 ID・guest は返さない', () => {
  const body = checkoutResponseBody({ ...base, price: { firstYen: 2980, regularYen: 2980, discountYen: 0, campaign: false } });
  assert.deepEqual(body, { url: base.url, subscription: 'txn_01abc', provider: 'paddle', price: { firstYen: 2980, regularYen: 2980, discountYen: 0, campaign: false } });
  assert.doesNotMatch(JSON.stringify(body), /rec[A-Za-z0-9]{14}|guest/);
});

test('特別価格が付いた申込はその額を返す', () => {
  assert.deepEqual(checkoutResponseBody({ ...base, price: { firstYen: 2480, regularYen: 2980, discountYen: 500, campaign: true } }).price,
    { firstYen: 2480, regularYen: 2980, discountYen: 500, campaign: true });
});

test('price が無い（PayPal）・形が崩れた price は返さない（従来の 3 項目のまま）', () => {
  assert.deepEqual(Object.keys(checkoutResponseBody(base)).sort(), ['provider', 'subscription', 'url']);
  for (const bad of [null, 'x', { firstYen: '2980', regularYen: 2980, discountYen: 0, campaign: false }, { firstYen: 2980, regularYen: 2980, discountYen: 0 }, { firstYen: -1, regularYen: 2980, discountYen: 0, campaign: false }]) {
    assert.equal(publicCheckoutPrice(bad), null);
  }
  const extra = publicCheckoutPrice({ firstYen: 2980, regularYen: 2980, discountYen: 0, campaign: false, recordId: 'recX', email: 'a@b.c' });
  assert.deepEqual(Object.keys(extra).sort(), ['campaign', 'discountYen', 'firstYen', 'regularYen']);
});

test('入口（monthly-create-checkout）は checkoutResponseBody で返す（price を落とさない）', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../netlify/functions/monthly-create-checkout.js', import.meta.url)), 'utf8');
  assert.match(src, /import \{ checkoutResponseBody \} from '\.\.\/\.\.\/src\/lib\/billing\/checkoutResponse\.js'/);
  assert.match(src, /checkoutResponseBody\(r\)/);
  assert.doesNotMatch(src, /\{ url: r\.url, subscription: r\.subscriptionId, provider: r\.provider \}/);
});

test('料金ページは price.campaign === false で通常価格の案内を出し、price.firstYen を begin_checkout に渡す', () => {
  const src = readFileSync(fileURLToPath(new URL('../../pages/pricing.astro', import.meta.url)), 'utf8');
  assert.match(src, /data\.price && data\.price\.campaign === false/);
  assert.match(src, /checkoutStart\(planId, provider, data\.price && data\.price\.firstYen\)/);
});
