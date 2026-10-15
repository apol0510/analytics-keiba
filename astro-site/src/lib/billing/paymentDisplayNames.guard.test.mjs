/**
 * 決済関連名称から競馬関連の語を排除する（2026-10-11 MK 確定）。決済会社をまたいで再混入を防ぐ。
 * 対象外: AK のサイト名・ドメイン・サービス内容の説明・法定表示（ここでは検査しない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PAYMENT_BASE_NAME, PAYMENT_BANNED_WORDS, hasBannedPaymentWord, assertPaymentDisplayName,
  PAYPAL_PLAN_NAMES, assertPaypalPlanName,
} from './paymentDisplayNames.js';
import { MONTHLY_SALES_OPEN } from './stripePlans.js';
import {
  STRIPE_PLANS, STRIPE_STATEMENT_DESCRIPTOR, STRIPE_PORTAL_HEADLINE, hasBannedStripeDisplayWord,
} from './stripePlans.js';
import { derivePlanFromProductName } from '../payments/productName.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('禁止語: KEIBA / keiba / Keiba / 全角 / 競馬 / 馬券 を検出し、基本名称は通す', () => {
  for (const t of ['KEIBA', 'keiba', 'Keiba Analytics', 'ｋｅｉｂａ', '南関競馬', '馬券の買い方']) {
    assert.equal(hasBannedPaymentWord(t), true, t);
  }
  assert.equal(PAYMENT_BASE_NAME, 'Analytics Premium');
  assert.equal(hasBannedPaymentWord(PAYMENT_BASE_NAME), false);
  for (const w of ['KEIBA', '競馬', '馬券']) assert.ok(PAYMENT_BANNED_WORDS.includes(w), w);
});

test('禁止語（2026-10-15 MK 確定で拡大）: 中央・南関・JRA・NANKAN・中央競馬・地方競馬・南関東・その他の関連表現を表記揺れごと検出', () => {
  for (const w of ['中央', '南関', 'JRA', 'NANKAN', '中央競馬', '地方競馬', '南関東']) assert.ok(PAYMENT_BANNED_WORDS.includes(w), w);
  for (const t of [
    'Analytics Premium 中央', 'Analytics Premium（中央＋南関）', 'Analytics Premium 南関', 'Premium JRA', 'premium-jra', 'Ｊｒａ',
    'nankan', 'ＮＡＮＫＡＮ', '南関東公営', '地方競馬', 'Horse data', 'RACING', 'jockey', 'Betting', 'Gambling', '三連複', '馬単', '大井',
  ]) assert.equal(hasBannedPaymentWord(t), true, t);
  // 既存の中立名称は通る（語を足すときの前提）
  for (const t of ['Analytics Premium', 'Analytics Premium J', 'Analytics Premium N', 'Analytics Premium 年払い', 'Analytics Premium 年払い（Light会員特典）',
    'Analytics Premium 買い切り', 'Analytics Premium monthly membership', 'ANALYTICS PREMIUM', 'TIROL DATA LABO']) assert.equal(hasBannedPaymentWord(t), false, t);
});

test('PayPal のプラン名は許可リストの 3 つだけ（大文字小文字・スペースまで完全一致・2026-10-15 MK 確定）', () => {
  assert.deepEqual({ ...PAYPAL_PLAN_NAMES }, { 'premium': 'Analytics Premium', 'premium-jra': 'Analytics Premium J', 'premium-nankan': 'Analytics Premium N' });
  for (const [id, name] of Object.entries(PAYPAL_PLAN_NAMES)) assert.equal(assertPaypalPlanName(id, name), name);
  for (const [id, bad] of [['premium-jra', 'Analytics Premium j'], ['premium-jra', 'Analytics Premium  J'], ['premium-nankan', 'Analytics Premium N（月額）'],
    ['premium', 'Analytics Premium（中央＋南関）'], ['premium-jra', 'Analytics Premium 中央版'], ['premium-x', 'Analytics Premium']]) {
    assert.throws(() => assertPaypalPlanName(id, bad), (e) => e.code === 'unapproved_paypal_plan_name', `${id}: ${bad}`);
  }
});

test('assertPaymentDisplayName は禁止語で fail closed（その名前で決済会社に作らない）', () => {
  assert.equal(assertPaymentDisplayName('Analytics Premium 年払い'), 'Analytics Premium 年払い');
  assert.throws(() => assertPaymentDisplayName('KEIBA Analytics Premium', 'paddle product'), (e) => e.code === 'banned_payment_word');
});

test('Stripe の判定は決済会社共通の単一源と同じ・Stripe は停止・不使用（2026-10-15 MK）で新しい名前を送らない', () => {
  assert.equal(hasBannedStripeDisplayWord, hasBannedPaymentWord);
  // Stripe の Product 名（既存）は Stripe 側を変えない（MK: Stripe の商品名・設定は更新しない）。新規販売は閉じたまま
  assert.equal(MONTHLY_SALES_OPEN, false);
  for (const p of STRIPE_PLANS) assert.equal(/KEIBA|競馬|馬券/i.test(p.productName.normalize('NFKC')), false, p.productName);
  // PayPal のプラン名は Stripe の productName に依存しない
  for (const p of STRIPE_PLANS) assert.notEqual(PAYPAL_PLAN_NAMES[p.id], p.productName);
  assert.equal(hasBannedPaymentWord(STRIPE_STATEMENT_DESCRIPTOR), false);
  assert.equal(hasBannedPaymentWord(STRIPE_PORTAL_HEADLINE), false);
});

test('申込の商品名（/pricing/ と各ページの銀行振込ボタン）に禁止語が無い', () => {
  const pages = ['../../pages/pricing.astro', '../../pages/dashboard.astro', '../../pages/premium-upgrade.astro'];
  let n = 0;
  for (const f of pages) {
    for (const m of read(f).matchAll(/openBankModal\('([^']+)'/g)) {
      n += 1;
      assert.equal(hasBannedPaymentWord(m[1]), false, `${f}: ${m[1]}`);
      assert.equal(hasBannedPaymentWord(derivePlanFromProductName(m[1]).planName), false, m[1]);
    }
  }
  assert.ok(n >= 3, '申込ボタンを読み取れない（テストの前提が壊れた）');
});
