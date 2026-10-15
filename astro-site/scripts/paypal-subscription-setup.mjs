#!/usr/bin/env node
/**
 * paypal-subscription-setup.mjs — PayPal の月額定期課金（Subscriptions）の商品・プランを作る／確かめる（冪等）
 *
 *   node scripts/paypal-subscription-setup.mjs <keys-file> [--apply] [--set-webhook-url]
 *
 * - keys-file: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV(sandbox|live) / 任意で PAYPAL_WEBHOOK_ID を持つ env 形式のファイル。
 *   値は出力しない（Plan ID・Product ID は秘密ではないので出す）。
 * - --apply なし: 既存の商品・プランを読んで、コード（paypalSubscriptionCore.PAYPAL_PLAN_IDS）との一致を表示するだけ。
 * - --apply: 無いものだけ作る。登録済みの Plan（PAYPAL_PLAN_IDS）は ID で読み、名前・説明が許可リストと違えば
 *   **名前と説明だけ** PATCH で直す（同じ Plan ID のまま。金額・請求周期・支払い設定・既存の購読には触らない＝
 *   既存契約者の価格を変えない・新しい Plan を作らない）。再実行しても旧名称へは戻らない。
 *   PAYPAL_WEBHOOK_ID があれば、その Webhook の購読イベントに月額のイベントを足す（一回払いのイベントは残す）。
 * - --set-webhook-url（--apply と一緒・Live だけ）: Webhook の URL を中立ホスト（neutralCheckoutHost.PAYPAL_LIVE_WEBHOOK_URL）へ。
 *   Webhook ID は変わらない（PAYPAL_WEBHOOK_ID の env は不変）。rollback は同じ PATCH で元の URL へ。
 * 商品名・プラン名は paymentDisplayNames の許可リスト（PAYPAL_PLAN_NAMES）と禁止語ルールを通ったものだけ。
 * Stripe の productName は使わない（2026-10-15 MK: Stripe は停止・不使用）。
 */
import { readFileSync } from 'node:fs';
import { STRIPE_PLANS } from '../src/lib/billing/stripePlans.js';
import { assertPaymentDisplayName, PAYMENT_BASE_NAME } from '../src/lib/billing/paymentDisplayNames.js';
import { PAYPAL_PLAN_IDS, SUBSCRIPTION_WEBHOOK_EVENTS, buildPlanBody, PAYPAL_PRODUCT_NAME, paypalPlanDisplay } from '../src/lib/billing/paypal/paypalSubscriptionCore.js';
import { PAYPAL_LIVE_WEBHOOK_URL } from '../src/lib/billing/neutralCheckoutHost.js';
import { PAYPAL_API, GRANT_EVENTS, APPROVED_EVENTS, REFUND_EVENTS } from '../src/lib/billing/paypal/paypalCore.js';

const [file, ...rest] = process.argv.slice(2);
if (!file) { console.error('usage: paypal-subscription-setup.mjs <keys-file> [--apply]'); process.exit(2); }
const APPLY = rest.includes('--apply');
const SET_WEBHOOK_URL = rest.includes('--set-webhook-url');
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
for (const p of STRIPE_PLANS) paypalPlanDisplay(p.id); // 許可リストに無い商品があれば止める

// 商品（catalog product）
const products = (await call('GET', '/v1/catalogs/products?page_size=20')).products || [];
let product = products.find((x) => x.name === PAYPAL_PRODUCT_NAME);
if (!product && APPLY) {
  product = await call('POST', '/v1/catalogs/products', { name: PAYPAL_PRODUCT_NAME, description: `${PAYMENT_BASE_NAME} monthly membership`, type: 'SERVICE' }, 'ak-paypal-product-v1');
  console.log('product created', product.id);
}
console.log(`[${mode}] product:`, product ? product.id : '(なし)');

// プラン（登録済みの Plan ID を正とする。名前での突き合わせは未登録のときだけ）
const plans = product ? ((await call('GET', `/v1/billing/plans?product_id=${product.id}&page_size=20`)).plans || []) : [];
const found = {};
for (const p of STRIPE_PLANS) {
  const want = paypalPlanDisplay(p.id);
  const registered = PAYPAL_PLAN_IDS[mode]?.[p.id];
  let planId = registered || plans.find((x) => x.name === want.name && x.status === 'ACTIVE')?.id || null;
  if (!planId && APPLY && product) {
    planId = (await call('POST', '/v1/billing/plans', buildPlanBody({ productId: product.id, plan: p }), `ak-paypal-plan-${p.id}-v2`)).id;
    console.log('plan created', p.id, planId);
  }
  if (!planId) { console.log(`  ${p.id}: (なし)`); continue; }
  let full = await call('GET', `/v1/billing/plans/${planId}`);
  const nameOk = () => full.name === want.name && full.description === want.description;
  if (!nameOk() && APPLY) {
    // 名前と説明だけ。金額・billing_cycles・payment_preferences は送らない
    await call('PATCH', `/v1/billing/plans/${planId}`, [
      { op: 'replace', path: '/name', value: want.name },
      { op: 'replace', path: '/description', value: want.description },
    ]);
    full = await call('GET', `/v1/billing/plans/${planId}`);
    console.log(`  ${p.id}: 名前・説明を更新`);
  }
  const c = full.billing_cycles?.[0] || {};
  const price = c.pricing_scheme?.fixed_price;
  const billingOk = full.billing_cycles?.length === 1 && c.frequency?.interval_unit === 'MONTH' && c.frequency?.interval_count === 1
    && c.total_cycles === 0 && c.tenure_type === 'REGULAR' && price?.currency_code === 'JPY' && Number(price?.value) === p.amountYen
    && full.payment_preferences?.auto_bill_outstanding === true && !(Number(full.payment_preferences?.setup_fee?.value) > 0);
  found[p.id] = planId;
  console.log(`  ${p.id}: ${planId} ${full.status} name=${JSON.stringify(full.name)} ${nameOk() ? 'OK' : '⚠️ 名前・説明が許可リストと違う'} `
    + `¥${price?.value} ${c.frequency?.interval_unit}×${c.frequency?.interval_count} total_cycles=${c.total_cycles} ${billingOk ? 'OK' : '⚠️ 請求設定が想定外'} `
    + `code=${registered === planId ? '一致' : '不一致（paypalSubscriptionCore を更新）'}`);
}
console.log('PAYPAL_PLAN_IDS.' + mode + ' =', JSON.stringify(found));

// Webhook の購読イベント（月額のイベントを足す。一回払いのイベントは残す）
if (env.PAYPAL_WEBHOOK_ID) {
  const wh = await call('GET', `/v1/notifications/webhooks/${env.PAYPAL_WEBHOOK_ID}`);
  const have = new Set((wh.event_types || []).map((e) => e.name));
  const want = [...new Set([...GRANT_EVENTS, ...APPROVED_EVENTS, ...REFUND_EVENTS, ...SUBSCRIPTION_WEBHOOK_EVENTS])];
  const missing = want.filter((n) => !have.has(n));
  console.log('webhook', wh.url, 'missing events:', missing.join(',') || '(なし)');
  if (SET_WEBHOOK_URL && APPLY) {
    if (mode !== 'live') { console.error('--set-webhook-url は Live だけ（Sandbox は sandbox.checkout.tirol.link のまま）'); process.exit(2); }
    if (wh.url !== PAYPAL_LIVE_WEBHOOK_URL) {
      await call('PATCH', `/v1/notifications/webhooks/${env.PAYPAL_WEBHOOK_ID}`, [{ op: 'replace', path: '/url', value: PAYPAL_LIVE_WEBHOOK_URL }]);
      console.log('webhook url updated', wh.url, '→', PAYPAL_LIVE_WEBHOOK_URL);
    } else console.log('webhook url OK');
  }
  if (missing.length && APPLY) {
    await call('PATCH', `/v1/notifications/webhooks/${env.PAYPAL_WEBHOOK_ID}`, [{ op: 'replace', path: '/event_types', value: [...new Set([...have, ...want])].map((name) => ({ name })) }]);
    console.log('webhook events updated');
  }
}
