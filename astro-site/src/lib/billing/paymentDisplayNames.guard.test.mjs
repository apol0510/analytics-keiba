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
} from './paymentDisplayNames.js';
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
  assert.deepEqual([...PAYMENT_BANNED_WORDS], ['KEIBA', '競馬', '馬券']);
});

test('assertPaymentDisplayName は禁止語で fail closed（その名前で決済会社に作らない）', () => {
  assert.equal(assertPaymentDisplayName('Analytics Premium 年払い'), 'Analytics Premium 年払い');
  assert.throws(() => assertPaymentDisplayName('KEIBA Analytics Premium', 'paddle product'), (e) => e.code === 'banned_payment_word');
});

test('Stripe の判定は決済会社共通の単一源と同じ', () => {
  assert.equal(hasBannedStripeDisplayWord, hasBannedPaymentWord);
  for (const p of STRIPE_PLANS) assert.equal(hasBannedPaymentWord(p.productName), false, p.productName);
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
