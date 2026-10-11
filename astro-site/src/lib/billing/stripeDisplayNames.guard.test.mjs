/**
 * Stripe の顧客向け表示から「KEIBA」を完全に除外する（2026-10-11 MK 確定）。
 * 対象: Product 名・カード明細表記・Checkout・請求書・領収書・カスタマーポータル。
 * 対象外: AK のサイト名・ドメイン（analytics.keiba.link）・AK が送るメール（Stripe の表示ではない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  STRIPE_PLANS, STRIPE_STATEMENT_DESCRIPTOR, STRIPE_PORTAL_HEADLINE, hasBannedStripeDisplayWord,
} from './stripePlans.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('禁止語の判定は大文字小文字を問わない', () => {
  for (const t of ['KEIBA ANALYTICS', 'Keiba Analytics', 'keiba']) assert.equal(hasBannedStripeDisplayWord(t), true, t);
  assert.equal(hasBannedStripeDisplayWord('Analytics Premium'), false);
});

test('顧客向けの名前は「Analytics Premium」に統一され、KEIBA を含まない', () => {
  for (const p of STRIPE_PLANS) {
    assert.equal(hasBannedStripeDisplayWord(p.productName), false, p.productName);
    assert.match(p.productName, /^Analytics Premium/);
  }
  assert.equal(STRIPE_STATEMENT_DESCRIPTOR, 'ANALYTICS PREMIUM');
  assert.equal(STRIPE_PORTAL_HEADLINE, 'Analytics Premium お支払い管理');
  assert.equal(hasBannedStripeDisplayWord(STRIPE_STATEMENT_DESCRIPTOR), false);
  assert.equal(hasBannedStripeDisplayWord(STRIPE_PORTAL_HEADLINE), false);
});

test('明細表記は Stripe の制約を満たす（5〜22 文字・英字を含む・禁止記号なし・ASCII）', () => {
  const d = STRIPE_STATEMENT_DESCRIPTOR;
  assert.ok(d.length >= 5 && d.length <= 22, String(d.length));
  assert.match(d, /[A-Za-z]/);
  assert.equal(/[<>\\'"*]/.test(d), false);
  assert.match(d, /^[\x20-\x7e]+$/);
});

test('stripe-setup.mjs: 明細表記・ポータル見出しは単一源を使い、KEIBA の直書きが無い', () => {
  const code = stripComments(read('../../../scripts/stripe-setup.mjs'));
  assert.match(code, /statement_descriptor: STRIPE_STATEMENT_DESCRIPTOR/);
  assert.match(code, /headline: STRIPE_PORTAL_HEADLINE/);
  assert.match(code, /await syncProductNames\(\{ withDescriptor: true \}\)/);
  // 文字列リテラルに顧客向けの KEIBA を書かない（ドメイン analytics.keiba.link・鍵ファイルのパスは小文字で別物）
  assert.equal(/['"`][^'"`\n]*KEIBA (ANALYTICS|Analytics)/.test(code), false);
  assert.equal(/statement_descriptor:\s*['"`]/.test(code), false, '明細表記を直書きしない');
  assert.equal(/headline:\s*['"`]/.test(code), false, 'ポータル見出しを直書きしない');
});

test('stripe-create-checkout: Stripe へ送る文言に KEIBA が無い（説明は productName）', () => {
  const code = stripComments(read('../../../netlify/functions/stripe-create-checkout.js'));
  assert.equal(/KEIBA/i.test(code), false);
  assert.match(code, /description: plan\.productName/);
});
