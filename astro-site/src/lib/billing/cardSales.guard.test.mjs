/**
 * カード決済（決済会社共通）の販売停止と月払い停止を固定する guard。
 * 2026-10-11 MK 確定: 直近は銀行振込のみ。Paddle（第一）・PayPal（第二）は Sandbox だけ（fincode は 2026-10-15 に削除）。
 * 本番受付は各社が取扱商品を承認したあと、MK の明示決定で cardSales.js を変える PR だけ。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CARD_SALES_OPEN, resolveCardMode, PRODUCTION_ORIGIN, SUBSCRIPTION_SALES_OPEN, ACTIVE_SUBSCRIPTION_PROVIDER } from './cardSales.js';
import { CARD_PRODUCTS } from './cardOneTime.js';
import { MONTHLY_SALES_OPEN } from './stripePlans.js';

const root = (p) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const read = (p) => readFileSync(root(p), 'utf8');

test('全決済会社の本番受付は閉じている（コード定数・env では開かない）', () => {
  assert.deepEqual({ ...CARD_SALES_OPEN }, { paddle: false, paypal: false });
  assert.ok(Object.isFrozen(CARD_SALES_OPEN));
  const src = read('src/lib/billing/cardSales.js');
  assert.equal(/process\.env|import\.meta\.env/.test(src), false, '販売可否を env から読まない');
  for (const p of ['paddle', 'paypal']) {
    assert.equal(resolveCardMode({ provider: p, keyMode: 'live', origin: PRODUCTION_ORIGIN }).reason, 'card_sales_not_open', p);
    assert.equal(resolveCardMode({ provider: p, keyMode: 'test', origin: PRODUCTION_ORIGIN }).reason, 'test_key_on_production', p);
  }
});

test('一回払いの層は定期課金を持たない。月額は PayPal の定期課金だけ（2026-10-15 MK 決定）・Stripe の新規月払いは閉じたまま', () => {
  assert.equal(MONTHLY_SALES_OPEN, false, 'Stripe の新規月払いは閉じたまま');
  assert.deepEqual(CARD_PRODUCTS.map((p) => p.planType).sort(), ['Annual', 'Annual', 'Lifetime']);
  const libs = ['paddle/paddleCore.js', 'paddle/paddleServer.js', 'paypal/paypalCore.js', 'paypal/paypalServer.js']
    .map((f) => read(`src/lib/billing/${f}`)).join('\n');
  assert.equal(/billing_cycle|\/v1\/billing\/|\/subscriptions/.test(libs), false, '一回払いの層・Paddle は定期課金 API を使わない');
  assert.match(read('src/lib/billing/paypal/paypalSubscriptionServer.js'), /\/v1\/billing\/subscriptions/);
  assert.deepEqual({ ...SUBSCRIPTION_SALES_OPEN }, { paypal: true }, '月額の本番受付は PR でだけ開く（2026-10-15 PayPal 受付開始）');
  assert.equal(ACTIVE_SUBSCRIPTION_PROVIDER, 'paypal');
});

test('会員権限の書き換えは共通層（entitlementLedger）だけ: アダプタは Airtable を直接 PATCH しない', () => {
  for (const f of ['paddle/paddleServer.js', 'paypal/paypalServer.js']) {
    const s = read(`src/lib/billing/${f}`);
    assert.equal(/\.patch\(/.test(s), false, `${f} は at.patch を呼ばない`);
    assert.match(s, /from '\.\.\/entitlementLedger\.js'/, f);
  }
});

test('カード決済の Function はすべて Airtable 計測を入れ、ログにメール・鍵を出さない', () => {
  const dir = root('netlify/functions');
  const files = readdirSync(dir).filter((f) => /^(paddle-|paypal-(create-order|capture|order-webhook)|card-order-status)/.test(f));
  assert.ok(files.length >= 6, files.join(','));
  for (const f of files) {
    const s = readFileSync(`${dir}/${f}`, 'utf8');
    assert.match(s, /installAirtableCallMeter\(\{ source: '/, f);
    assert.equal(/console\.(log|error)\([^)]*(Email|email|_SECRET|_API_KEY)/.test(s), false, f);
  }
});

test('fincode は使わない（2026-10-15 MK 決定）: コード・Function・設定に残さない', () => {
  assert.equal(Object.keys(CARD_SALES_OPEN).includes('fincode'), false);
  assert.equal(readdirSync(root('netlify/functions')).some((f) => /fincode/i.test(f)), false);
  assert.equal(readdirSync(root('src/lib/billing')).some((f) => /fincode/i.test(f)), false);
  for (const f of ['src/lib/billing/cardCheckout.js', 'src/lib/billing/entitlementLedger.js', 'src/lib/billing/cardE2E.js', 'netlify/functions/card-order-status.js', 'src/pages/checkout/card-complete.astro']) {
    assert.equal(/fincode/i.test(read(f)), false, f);
  }
});

test('料金ページの月額ボタン: 未ログインはログインへ直行・押した直後に反応を出す（2026-10-15「押せない」報告）', () => {
  const s = read('src/pages/pricing.astro');
  const i = s.indexOf('function show(html, btn)'); const j = s.indexOf('})();', i);
  const js = s.slice(i, j);
  assert.match(js, /err === 'login_required'\) \{[^}]*location\.href = '\/login\/\?next=\/pricing\/'/, '未ログインがメッセージ止まり（画面の端に出て押せないように見える）');
  assert.match(js, /btn\.textContent = 'PayPal へ移動しています…'/, '押した直後の表示が無い（PayPal へ移るまで数秒無反応に見える）');
  assert.match(js, /card\.appendChild\(msg\)/, 'メッセージが押したカードの近くに出ない');
  assert.match(js, /addEventListener\('pageshow'/, '戻るで帰ったときにボタンが押せないまま残る');
});
