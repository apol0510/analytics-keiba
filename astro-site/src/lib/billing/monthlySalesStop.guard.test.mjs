/**
 * 新規の月払いの全面停止（2026-10-11 MK 確定）を固定する。
 * - 月払いは Stripe が復旧しても自動で再開しない（コードの MONTHLY_SALES_OPEN だけが決める・env では開かない）
 * - サーバー側（stripe-create-checkout）が何にも触れずに 410 で拒否する＝URL 直打ち・直 POST で迂回できない
 * - /pricing/ に月額の申込ボタン・Checkout 呼び出しが無い。販売導線は銀行振込の年払い・買い切りだけ
 * - 月額を案内する更新リマインドは月払いが閉じている間は実送信しない
 * - 銀行振込の月払いは引き続き拒否され、案内は年払い・買い切りへ向く
 * - 既存の月額契約者の反映（Webhook）・退会は従来どおり動く（止めない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MONTHLY_SALES_OPEN } from './stripePlans.js';
import { decideBankProductAvailability } from '../payments/discontinuedBankProducts.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('月払いは閉じている（MK の次回明示決定まで）。env や Stripe の状態では開かない', () => {
  assert.equal(MONTHLY_SALES_OPEN, false);
  const src = stripComments(read('./stripePlans.js'));
  assert.match(src, /export const MONTHLY_SALES_OPEN = false;/);
  assert.equal(/MONTHLY_SALES_OPEN\s*=(?!\s*false;)/.test(src), false, 'env 等で切り替えている');
});

test('stripe-create-checkout: 何にも触れる前に 410 monthly_sales_ended（直 POST でも迂回できない）', () => {
  const code = stripComments(read('../../../netlify/functions/stripe-create-checkout.js'));
  const gate = code.indexOf("if (!MONTHLY_SALES_OPEN) return json(410, headers, { error: 'monthly_sales_ended' });");
  assert.ok(gate > 0, '月払い停止のゲートが無い');
  for (const later of ['JSON.parse(event.body', 'getStripe(env)', 'checkStripeLiveSales(env)', 'readSessionRecordId(', 'await airtableGet(', 'stripe.checkout.sessions.create(']) {
    const at = code.indexOf(later);
    assert.ok(at > gate, `${later} が月払い停止のゲートより前にある`);
  }
});

test('/pricing/: Stripe 月額の申込は無い。月額は PayPal の定期課金だけ（共通入口・SUBSCRIPTION_SALES_OPEN で表示）', () => {
  const page = read('../../pages/pricing.astro');
  const code = page.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/data-checkout=/.test(code), false);
  assert.equal(/stripe-create-checkout/.test(code), false);
  // 月額のカードは showMonthly の中だけ（本番は SUBSCRIPTION_SALES_OPEN・Preview は Sandbox 検証用）
  assert.match(code, /const showMonthly = SUBSCRIPTION_SALES_OPEN\[ACTIVE_SUBSCRIPTION_PROVIDER\] === true \|\| process\.env\.CONTEXT === 'deploy-preview';/);
  const outside = code.replace(/\{showMonthly && \([\s\S]*?\n {8}\)\}/, '');
  assert.equal(/<span class="price-period">\/月<\/span>/.test(outside), false, '月額の価格カードが showMonthly の外にある');
  assert.equal(/monthly-create-checkout/.test(code), true);
  assert.equal(/paypal-create-subscription|paddle-create-checkout|paypal-create-order/.test(code), false, '決済会社別の入口を呼ばない');
  const cards = code.slice(code.indexOf('<div class="plans-container'), code.indexOf('<!-- 無料プラン -->') > 0 ? code.indexOf('<!-- 無料プラン -->') : undefined);
  assert.match(code, /data-bank-plan="annual"[\s\S]*openBankModal\('Premium Annual', 49800, 'annual'\)/);
  assert.match(code, /openBankModal\('Premium Annual - Campaign', 44820, 'annual'\)/);
  assert.match(code, /data-bank-plan="lifetime"[\s\S]*openBankModal\('Premium Lifetime', 78000, 'lifetime'\)/);
  assert.ok(cards.length > 0);
});

test('月額を案内する他ページの CTA も無い（dashboard の購入モーダル・premium-upgrade・spring-campaign・Preview）', () => {
  const dash = read('../../pages/dashboard.astro');
  assert.equal(/Premium 月額|¥4,980\/月）へ変更|💳 料金ページで申し込む/.test(dash), false);
  assert.equal(/¥4,980|¥2,980|Premium 月額|月額（カード）/.test(read('../../pages/premium-upgrade.astro')), false);
  assert.equal(/月額プラン<\/div>/.test(read('../../pages/spring-campaign.astro')), false);
  assert.equal(/月額のまま|月額料金だけで/.test(read('../../components/acquisition/PremiumRaceBoard.astro')), false);
});

test('月額を案内する更新リマインドは、月額の申込経路が開いていない間は実送信しない（Stripe の月払いは閉じたまま・判定は monthlySalesChannel）', () => {
  for (const f of ['cron-premium-renewal-reminder.js', 'cron-light-renewal-reminder.js']) {
    const code = stripComments(read(`../../../netlify/functions/${f}`));
    assert.match(code, /const sales = await resolveMonthlySalesChannel\(process\.env\);/, f);
    assert.match(code, /gateModeOnStripeSales\(resolveMode\(process\.env\), sales\)/, f);
  }
  // Stripe の月払いは経路判定の中でも MONTHLY_SALES_OPEN が false の間は見ない（復旧しても再開しない）
  assert.match(read('./monthlySalesChannel.js'), /if \(stripeMonthlyOpen === true\) \{/);
});

test('銀行振込の月払いは拒否し、案内は年払い・買い切りへ（カード決済へ誘導しない）', () => {
  const r = decideBankProductAvailability({ planName: 'Premium', planType: 'monthly', fields: null });
  assert.equal(r.ok, false);
  assert.match(r.message, /年払い・買い切り/);
  assert.equal(/クレジットカード|中央版|南関版/.test(r.message), false);
  const l = decideBankProductAvailability({ planName: 'Light', planType: 'monthly', fields: {} });
  assert.equal(l.ok, false);
  assert.match(l.message, /年払い・買い切り/);
  for (const [planName, planType] of [['Premium', 'annual'], ['Premium', 'lifetime']]) {
    assert.equal(decideBankProductAvailability({ planName, planType, fields: null }).ok, true, `${planName} ${planType}`);
  }
});

test('既存の月額契約者の反映・退会は止めない（Webhook / 退会 / 決済完了画面に月払い停止を入れない）', () => {
  for (const f of ['stripe-webhook.js', 'stripe-withdraw.js', 'stripe-checkout-complete.js', 'stripe-portal.js']) {
    assert.equal(/MONTHLY_SALES_OPEN/.test(read(`../../../netlify/functions/${f}`)), false, f);
  }
});
