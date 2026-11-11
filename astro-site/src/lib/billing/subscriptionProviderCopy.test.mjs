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
  assert.equal(p.flowStep2, '決済画面（PayPal）でお支払いを承認');
});

test('Paddle の行: PayPal の操作を案内しない', () => {
  const p = SUBSCRIPTION_PROVIDER_COPY.paddle;
  assert.equal(p.label, 'Paddle');
  for (const v of Object.values(p)) assert.doesNotMatch(v, /PayPal/);
});

// 2026-11-02 MK 確定: 料金ページで退会・解約の方法を販売の訴求として出さない（決済会社のメール・アカウントでの解約、支払い済み期間までの利用）
test('どの決済会社の行も退会・解約の方法を持たない', () => {
  for (const [k, row] of Object.entries(SUBSCRIPTION_PROVIDER_COPY)) {
    assert.equal('annualStop' in row, false, k);
    for (const v of Object.values(row)) assert.doesNotMatch(v, /解約|退会|停止|支払い済み|確認メール/, k);
  }
});

test('料金ページ（FAQ より前）に退会・解約の方法や支払い済み期間までの利用を出さない', () => {
  const visible = page.replace(/<!--[\s\S]*?-->/g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const beforeFaq = visible.slice(0, visible.indexOf('class="faq-section"'));
  assert.ok(beforeFaq.length > 1000);
  assert.doesNotMatch(beforeFaq, /annualStop|確認メール[^。]*解約|支払い済み[^。]*(終わる|まで)|「退会する」でも止められます/);
  // 購入時の料金・請求周期・自動更新の条件は出し続ける
  assert.match(beforeFaq, /12 か月ごとに、通常の年額（¥49,800。Light 会員さまの乗り換え特典は ¥44,820）で自動的に更新・請求されます/);
});

test('料金ページは ACTIVE の行だけを使い、決済会社名を直書きしない', () => {
  assert.equal(subscriptionProviderCopy(), SUBSCRIPTION_PROVIDER_COPY[ACTIVE_SUBSCRIPTION_PROVIDER]);
  assert.match(page, /const providerCopy = subscriptionProviderCopy\(\);/);
  const visible = page.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(visible.replace(/data\.provider === 'paypal'/g, ''), /PayPal/, '画面に出る文に PayPal を直書きしない');
});
