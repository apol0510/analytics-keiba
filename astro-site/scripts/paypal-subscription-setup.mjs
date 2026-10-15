#!/usr/bin/env node
/**
 * paypal-subscription-setup.mjs — PayPal の月額定期課金（Subscriptions）の商品・プランを作る／確かめる（冪等）
 *
 *   node scripts/paypal-subscription-setup.mjs <keys-file> [--apply] [--webhook-url <url>]
 *
 * - keys-file: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV(sandbox|live) / 任意で PAYPAL_WEBHOOK_ID を持つ env 形式のファイル。
 *   値は出力しない（Plan ID・Product ID は秘密ではないので出す）。
 * - --apply なし: 既存の商品・プランを読んで、コード（paypalSubscriptionCore.PAYPAL_PLAN_IDS）との一致を表示するだけ。
 * - --apply: 無いものだけ作る（名前で突き合わせ。既存プランの金額は変えない＝既存契約者の価格を変えない）。
 *   PAYPAL_WEBHOOK_ID があれば、その Webhook の購読イベントに月額のイベントを足す（一回払いのイベントは残す）。
 * 商品名・プラン名は paymentDisplayNames の禁止語ルールを通ったものだけ（stripePlans の productName と同じ）。
 */
import { readFileSync } from 'node:fs';
import { STRIPE_PLANS } from '../src/lib/billing/stripePlans.js';
import { assertPaymentDisplayName, PAYMENT_BASE_NAME } from '../src/lib/billing/paymentDisplayNames.js';
import { PAYPAL_PLAN_IDS, SUBSCRIPTION_WEBHOOK_EVENTS, buildPlanBody, PAYPAL_PRODUCT_NAME } from '../src/lib/billing/paypal/paypalSubscriptionCore.js';
import { PAYPAL_API, GRANT_EVENTS, APPROVED_EVENTS, REFUND_EVENTS } from '../src/lib/billing/paypal/paypalCore.js';

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('usage: paypal-subscription-setup.mjs <keys-file> [--apply]'); process.exit(2); }
const APPLY = rest.includes('--apply');
const env = Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const mode = env.PAYPAL_ENV === 'live' ? 'live' : env.PAYPAL_ENV === 'sandbox' ? 'test' : null;
if (!mode || !env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) { console.error('keys file: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV が要る'); process.exit(2); }
const API = PAYPAL_API[mode];

const tok = await fetch(`${API}/v1/oauth2/token`, {
  method: 'POST',
  headers: { Authorization: `Basic ${Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
});
if (!tok.ok) { console.error('oauth_failed', tok.status); process.exit(1); }
const { access_token: token } = await tok.json();
async function call(method, path, body, requestId) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  if (requestId) headers['PayPal-Request-Id'] = requestId;
  const r = await fetch(`${API}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

assertPaymentDisplayName(PAYPAL_PRODUCT_NAME);
for (const p of STRIPE_PLANS) assertPaymentDisplayName(p.productName);

// 商品（catalog product）
const products = (await call('GET', '/v1/catalogs/products?page_size=20')).products || [];
let product = products.find((x) => x.name === PAYPAL_PRODUCT_NAME);
if (!product && APPLY) {
  product = await call('POST', '/v1/catalogs/products', { name: PAYPAL_PRODUCT_NAME, description: `${PAYMENT_BASE_NAME} monthly membership`, type: 'SERVICE' }, 'ak-paypal-product-v1');
  console.log('product created', product.id);
}
console.log(`[${mode}] product:`, product ? product.id : '(なし)');

// プラン
const plans = product ? ((await call('GET', `/v1/billing/plans?product_id=${product.id}&page_size=20`)).plans || []) : [];
const found = {};
for (const p of STRIPE_PLANS) {
  let plan = plans.find((x) => x.name === p.productName && x.status === 'ACTIVE');
  if (!plan && APPLY && product) {
    plan = await call('POST', '/v1/billing/plans', buildPlanBody({ productId: product.id, plan: p }), `ak-paypal-plan-${p.id}-v1`);
    console.log('plan created', p.id, plan.id);
  }
  if (plan) {
    const full = await call('GET', `/v1/billing/plans/${plan.id}`);
    const price = full.billing_cycles?.[0]?.pricing_scheme?.fixed_price;
    const ok = price?.currency_code === 'JPY' && Number(price?.value) === p.amountYen;
    found[p.id] = plan.id;
    console.log(`  ${p.id}: ${plan.id} ¥${price?.value} ${ok ? 'OK' : '⚠️ 金額不一致'} code=${PAYPAL_PLAN_IDS[mode]?.[p.id] === plan.id ? '一致' : '不一致（paypalSubscriptionCore を更新）'}`);
  } else console.log(`  ${p.id}: (なし)`);
}
console.log('PAYPAL_PLAN_IDS.' + mode + ' =', JSON.stringify(found));

// Webhook の購読イベント（月額のイベントを足す。一回払いのイベントは残す）
if (env.PAYPAL_WEBHOOK_ID) {
  const wh = await call('GET', `/v1/notifications/webhooks/${env.PAYPAL_WEBHOOK_ID}`);
  const have = new Set((wh.event_types || []).map((e) => e.name));
  const want = [...new Set([...GRANT_EVENTS, ...APPROVED_EVENTS, ...REFUND_EVENTS, ...SUBSCRIPTION_WEBHOOK_EVENTS])];
  const missing = want.filter((n) => !have.has(n));
  console.log('webhook', wh.url, 'missing events:', missing.join(',') || '(なし)');
  if (missing.length && APPLY) {
    await call('PATCH', `/v1/notifications/webhooks/${env.PAYPAL_WEBHOOK_ID}`, [{ op: 'replace', path: '/event_types', value: [...new Set([...have, ...want])].map((name) => ({ name })) }]);
    console.log('webhook events updated');
  }
}
