// 決済会社へ渡す URL を中立ホストへ寄せる（2026-10-15 MK 確定）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_ORIGIN } from './cardSales.js';
import { hasBannedPaymentWord } from './paymentDisplayNames.js';
import { NEUTRAL_ROUTES, PAYPAL_LIVE_WEBHOOK_URL, PADDLE_LIVE_PAYMENT_LINK, PADDLE_LIVE_WEBHOOK_URL, paddleCheckoutPage, paypalReturnUrls, webhookSiteOrigin } from './neutralCheckoutHost.js';
import { checkoutUrlMatchesOrigin } from './paddle/paddleCore.js';
import { buildOrderBody } from './paypal/paypalCore.js';

const REC = 'recAAAAAAAAAAAAAA';
const PREVIEW = 'https://deploy-preview-1--analytics-keiba.netlify.app';

test('本番の戻り先・キャンセル・Webhook の URL に禁止語が無い（会員サイトのドメインを決済会社へ渡さない）', () => {
  for (const k of ['order', 'subscription']) {
    const u = paypalReturnUrls(PRODUCTION_ORIGIN, k);
    for (const v of Object.values(u)) { assert.match(v, /^https:\/\/checkout\.tirol\.link\//); assert.equal(hasBannedPaymentWord(v), false, v); }
  }
  assert.equal(PAYPAL_LIVE_WEBHOOK_URL, 'https://checkout.tirol.link/hooks/paypal');
  assert.equal(hasBannedPaymentWord(PAYPAL_LIVE_WEBHOOK_URL), false);
  // 一回払い（PayPal 注文）も同じ
  const o = buildOrderBody({ productId: 'premium-annual', recordId: REC, origin: PRODUCTION_ORIGIN, invoiceId: 'ak-premium-annual-x' });
  assert.equal(o.payment_source.paypal.experience_context.return_url, 'https://checkout.tirol.link/r/paypal/order-return');
  assert.equal(hasBannedPaymentWord(JSON.stringify(o)), false);
});

test('中継先は戻り先ページ・料金ページ・Webhook の Function だけ（それぞれ実在するルート）', () => {
  const byFrom = Object.fromEntries(NEUTRAL_ROUTES.map((r) => [r.from, r]));
  assert.equal(byFrom['/r/paypal/subscription-return'].to, `${PRODUCTION_ORIGIN}/checkout/paypal-subscription-return/`);
  assert.equal(byFrom['/r/paypal/order-return'].to, `${PRODUCTION_ORIGIN}/checkout/paypal-return/`);
  assert.equal(byFrom['/r/paypal/cancel'].to, `${PRODUCTION_ORIGIN}/pricing/?checkout=cancelled`);
  assert.equal(byFrom['/hooks/paypal'].status, '200!');
  for (const r of NEUTRAL_ROUTES.filter((x) => x.from.startsWith('/r/'))) assert.equal(r.status, '302!', 'ブラウザを移すだけ（Cookie は会員サイトのもの）');
  const root = new URL('../../../', import.meta.url);
  for (const p of ['src/pages/checkout/paypal-subscription-return.astro', 'src/pages/checkout/paypal-return.astro', 'netlify/functions/paypal-order-webhook.js']) {
    const tries = [p, p.replace('.astro', '/index.astro')];
    assert.ok(tries.some((t) => { try { readFileSync(fileURLToPath(new URL(t, root))); return true; } catch { return false; } }), p);
  }
});

test('Sandbox・Deploy Preview は受けたオリジンへ戻す（中立ホストへ寄せるのは本番だけ）', () => {
  assert.deepEqual(paypalReturnUrls(PREVIEW, 'subscription'), { return_url: `${PREVIEW}/checkout/paypal-subscription-return/`, cancel_url: `${PREVIEW}/pricing/?checkout=cancelled` });
  assert.equal(paypalReturnUrls('https://sandbox.checkout.tirol.link', 'order').return_url, 'https://sandbox.checkout.tirol.link/checkout/paypal-return/');
});

test('Webhook: 中立ホスト経由（Host=checkout.tirol.link）は本番として判定、それ以外は受けたホストのまま', () => {
  assert.equal(webhookSiteOrigin('checkout.tirol.link'), PRODUCTION_ORIGIN);
  assert.equal(webhookSiteOrigin('Checkout.Tirol.Link'), PRODUCTION_ORIGIN);
  assert.equal(webhookSiteOrigin('analytics.keiba.link'), PRODUCTION_ORIGIN);
  assert.equal(webhookSiteOrigin('sandbox.checkout.tirol.link'), 'https://sandbox.checkout.tirol.link', 'Sandbox は本番にしない');
  assert.equal(webhookSiteOrigin('deploy-preview-1--analytics-keiba.netlify.app'), PREVIEW);
  const fn = readFileSync(fileURLToPath(new URL('../../../netlify/functions/paypal-order-webhook.js', import.meta.url)), 'utf8');
  assert.match(fn, /const origin = webhookSiteOrigin\(/);
});

test('Paddle Live（2026-10-24）: 決済ページ・通知先は中立ホスト・本番サイトは中立ホストの決済ページだけを受ける', () => {
  assert.equal(PADDLE_LIVE_PAYMENT_LINK, 'https://checkout.tirol.link/pay/');
  assert.equal(PADDLE_LIVE_WEBHOOK_URL, 'https://checkout.tirol.link/hooks/paddle');
  for (const v of [PADDLE_LIVE_PAYMENT_LINK, PADDLE_LIVE_WEBHOOK_URL]) assert.equal(hasBannedPaymentWord(v), false, v);
  assert.equal(paddleCheckoutPage(PRODUCTION_ORIGIN), PADDLE_LIVE_PAYMENT_LINK);
  assert.equal(paddleCheckoutPage(PREVIEW), `${PREVIEW}/checkout/paddle/`);
  const T = 'txn_01abcdefghijklmnop';
  assert.equal(checkoutUrlMatchesOrigin(`https://checkout.tirol.link/pay/?_ptxn=${T}`, PRODUCTION_ORIGIN), true);
  // 本番サイトの自ページ・別ホスト・別パスは使わない（fail closed）
  assert.equal(checkoutUrlMatchesOrigin(`${PRODUCTION_ORIGIN}/checkout/paddle/?_ptxn=${T}`, PRODUCTION_ORIGIN), false);
  assert.equal(checkoutUrlMatchesOrigin(`https://checkout.tirol.link/checkout/paddle/?_ptxn=${T}`, PRODUCTION_ORIGIN), false);
  assert.equal(checkoutUrlMatchesOrigin(`https://evil.example/pay/?_ptxn=${T}`, PRODUCTION_ORIGIN), false);
  assert.equal(checkoutUrlMatchesOrigin('https://checkout.tirol.link/pay/?_ptxn=bad', PRODUCTION_ORIGIN), false);
  // Sandbox（Deploy Preview）は従来どおり自サイトの /checkout/paddle/
  assert.equal(checkoutUrlMatchesOrigin(`${PREVIEW}/checkout/paddle/?_ptxn=${T}`, PREVIEW), true);
  assert.equal(checkoutUrlMatchesOrigin(`https://checkout.tirol.link/pay/?_ptxn=${T}`, PREVIEW), false);
  // 通知は中立ホスト経由で本番サイトとして判定・完了は会員サイトの完了画面へ 302
  assert.equal(webhookSiteOrigin('checkout.tirol.link'), PRODUCTION_ORIGIN);
  const byFrom = Object.fromEntries(NEUTRAL_ROUTES.map((r) => [r.from, r]));
  assert.deepEqual({ ...byFrom['/hooks/paddle'] }, { from: '/hooks/paddle', to: `${PRODUCTION_ORIGIN}/.netlify/functions/paddle-webhook`, status: '200!' });
  assert.deepEqual({ ...byFrom['/r/paddle/complete'] }, { from: '/r/paddle/complete', to: `${PRODUCTION_ORIGIN}/checkout/card-complete/`, status: '302!' });
});

test('paddle-webhook は Host を webhookSiteOrigin で判定する（中立ホスト経由の本番通知を Sandbox 扱いにしない）', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../netlify/functions/paddle-webhook.js', import.meta.url)), 'utf8');
  assert.match(src, /const origin = webhookSiteOrigin\(event\.headers\?\.host/);
});
