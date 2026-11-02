// 料金ページの決済会社別の説明（2026-11-02 MK 確定 Paddle 一本化）。切替前（PayPal）の掲載文を 1 文字も変えない
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUBSCRIPTION_PROVIDER_COPY, subscriptionProviderCopy } from './subscriptionProviderCopy.js';
import { ACTIVE_SUBSCRIPTION_PROVIDER } from './cardSales.js';

const page = readFileSync(fileURLToPath(new URL('../../pages/pricing.astro', import.meta.url)), 'utf8');

test('PayPal の行は 2026-11-02 までの掲載文と同一', () => {
  const p = SUBSCRIPTION_PROVIDER_COPY.paypal;
  assert.equal(p.label, 'PayPal');
  assert.equal(p.annualTitle, 'カード（PayPal）の年払いは自動更新です。');
  assert.equal(p.annualStop, '更新を止めるには、PayPal のアカウントで自動支払いを停止してください。次回から請求されず、支払い済みの 12 か月が終わるまでご利用いただけます。');
  assert.equal(p.flowStep2, '決済画面（PayPal）でお支払いを承認');
});

test('Paddle の行: PayPal の操作を案内しない・解約の結果は実装どおり（支払い済みの終わりまで）', () => {
  const p = SUBSCRIPTION_PROVIDER_COPY.paddle;
  assert.equal(p.label, 'Paddle');
  for (const v of Object.values(p)) assert.doesNotMatch(v, /PayPal/);
  assert.match(p.annualStop, /支払い済みの 12 か月が終わるまで/);
});

test('料金ページは ACTIVE の行だけを使い、決済会社名を直書きしない', () => {
  assert.equal(subscriptionProviderCopy(), SUBSCRIPTION_PROVIDER_COPY[ACTIVE_SUBSCRIPTION_PROVIDER]);
  assert.match(page, /const providerCopy = subscriptionProviderCopy\(\);/);
  const visible = page.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(visible.replace(/data\.provider === 'paypal'/g, ''), /PayPal/, '画面に出る文に PayPal を直書きしない');
});
