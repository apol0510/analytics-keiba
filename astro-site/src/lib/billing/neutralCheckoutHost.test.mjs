// 決済会社へ渡す URL を中立ホストへ寄せる（2026-10-15 MK 確定）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_ORIGIN } from './cardSales.js';
import { hasBannedPaymentWord } from './paymentDisplayNames.js';
import { NEUTRAL_ROUTES, PAYPAL_LIVE_WEBHOOK_URL, paypalReturnUrls, webhookSiteOrigin } from './neutralCheckoutHost.js';
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
