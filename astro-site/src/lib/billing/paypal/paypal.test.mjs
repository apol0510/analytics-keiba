/**
 * PayPal 連携（Sandbox 相当）を偽の PayPal API・Airtable・Redis で通しで確かめる。ネットワークに出ない。
 * 注文作成 → 承認 → capture（戻り先）→ 支払い確認（API 照会）→ 付与 → Webhook 再送・同時着信 → 返金 → 再購入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CARD_SALES_OPEN, resolvePaypalMode, buildOrderBody, matchOrder, parsePaypalWebhook, buildVerifyBody } from './paypalCore.js';
import { createPaypalOrder, settlePaypalOrder, handlePaypalWebhook, readPaypalOrderStatus } from './paypalServer.js';
import { PRODUCTION_ORIGIN } from '../cardSales.js';
import { hasBannedPaymentWord } from '../paymentDisplayNames.js';

const PREVIEW = 'https://deploy-preview-1--analytics-keiba.netlify.app';
const REC = 'recAAAAAAAAAAAAAA';
const ENV = { PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_ENV: 'sandbox', PAYPAL_WEBHOOK_ID: 'WH-1', AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX' };
const HDR = {
  'PAYPAL-AUTH-ALGO': 'SHA256withRSA', 'PAYPAL-CERT-URL': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'PAYPAL-TRANSMISSION-ID': 't1', 'PAYPAL-TRANSMISSION-SIG': 'sig', 'PAYPAL-TRANSMISSION-TIME': '2026-10-11T03:00:00Z',
};

function world({ fields = { 'プラン': 'Free', Email: 'a+card-e2e@example.com' }, verify = 'SUCCESS' } = {}) {
  const st = { fields: { ...fields }, orders: {}, captures: {}, patches: [], calls: [], requestIds: [], captureCalls: 0, redis: new Map(), notes: [] };
  const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body });
  let n = 0;
  st.fetch = async (url, init = {}) => {
    st.calls.push(url);
    const u = new URL(url);
    if (u.host === 'api.airtable.com') {
      if (init.method === 'PATCH') { const f = JSON.parse(init.body).fields; st.patches.push(f); Object.assign(st.fields, f); }
      return res(200, { id: REC, fields: st.fields });
    }
    if (u.pathname === '/v1/oauth2/token') return res(200, { access_token: 'tok' });
    assert.equal(init.headers.Authorization, 'Bearer tok');
    if (init.headers['PayPal-Request-Id']) st.requestIds.push(init.headers['PayPal-Request-Id']);
    if (u.pathname === '/v2/checkout/orders' && init.method === 'POST') {
      const b = JSON.parse(init.body);
      n += 1;
      const id = `5O19012${n}TN364715T`;
      st.orders[id] = { id, status: 'CREATED', purchase_units: [{ ...b.purchase_units[0] }], body: b };
      return res(201, { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
    }
    let m = u.pathname.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/);
    if (m) {
      const o = st.orders[m[1]];
      if (!o) return res(404, { name: 'RESOURCE_NOT_FOUND' });
      if (m[2]) {
        st.captureCalls += 1;
        if (o.status === 'COMPLETED') return res(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
        if (o.status !== 'APPROVED') return res(422, { details: [{ issue: 'ORDER_NOT_APPROVED' }] });
        const capId = `CAP${m[1]}`;
        o.status = 'COMPLETED';
        o.purchase_units[0].payments = { captures: [{ id: capId, status: 'COMPLETED', amount: o.purchase_units[0].amount, create_time: '2026-10-11T03:00:00Z' }] };
        st.captures[capId] = { id: capId, supplementary_data: { related_ids: { order_id: m[1] } } };
      }
      return res(200, o);
    }
    m = u.pathname.match(/^\/v2\/payments\/captures\/([A-Z0-9]+)$/);
    if (m) return st.captures[m[1]] ? res(200, st.captures[m[1]]) : res(404, {});
    if (u.pathname === '/v1/notifications/verify-webhook-signature') {
      const b = JSON.parse(init.body);
      assert.equal(b.webhook_id, 'WH-1');
      return res(200, { verification_status: verify });
    }
    return res(404, {});
  };
  st.redisCmd = async ([cmd, key, val, ...rest]) => {
    if (cmd === 'GET') return st.redis.has(key) ? st.redis.get(key) : null;
    if (cmd === 'DEL') { st.redis.delete(key); return 1; }
    if (cmd === 'SET') { if (rest.includes('NX') && st.redis.has(key)) return null; st.redis.set(key, val); return 'OK'; }
    throw new Error(`unexpected ${cmd}`);
  };
  st.notify = async (kind, d) => { st.notes.push([kind, d.reason || '']); };
  st.approve = (id) => { st.orders[id].status = 'APPROVED'; };
  st.setCapture = (id, status) => { st.orders[id].purchase_units[0].payments.captures[0].status = status; };
  return st;
}
const order = async (w, productId = 'premium-annual') => {
  const r = await createPaypalOrder({ env: ENV, origin: PREVIEW, recordId: REC, productId, fetchImpl: w.fetch });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.orderId;
};
const capture = (w, orderId, now) => settlePaypalOrder({ env: ENV, origin: PREVIEW, orderId, redis: w.redisCmd, notify: w.notify, fetchImpl: w.fetch, capture: true, ...(now ? { now } : {}) });
const hook = (w, event_type, resource, headers = HDR) => handlePaypalWebhook({
  env: ENV, origin: PREVIEW, headers, rawBody: JSON.stringify({ id: 'WH-EVT', event_type, resource }), redis: w.redisCmd, notify: w.notify, fetchImpl: w.fetch,
});
const capRes = (orderId) => ({ id: `CAP${orderId}`, status: 'COMPLETED', supplementary_data: { related_ids: { order_id: orderId } } });

test('一回払いの受付は開いている（MK の決定＝PR merge）。本番サイトは sandbox を受け付けず、閉じれば live も受け付けない。Preview は live を受け付けない', () => {
  assert.equal(CARD_SALES_OPEN, true);
  assert.equal(resolvePaypalMode({ env: ENV, origin: PRODUCTION_ORIGIN }).reason, 'test_key_on_production');
  assert.deepEqual(resolvePaypalMode({ env: { ...ENV, PAYPAL_ENV: 'live' }, origin: PRODUCTION_ORIGIN }), { ok: true, mode: 'live', apiBase: 'https://api-m.paypal.com' });
  assert.equal(resolvePaypalMode({ env: { ...ENV, PAYPAL_ENV: 'live' }, origin: PRODUCTION_ORIGIN, salesOpen: false }).reason, 'card_sales_not_open');
  assert.equal(resolvePaypalMode({ env: { ...ENV, PAYPAL_ENV: 'live' }, origin: PREVIEW }).reason, 'live_key_outside_production');
  assert.equal(resolvePaypalMode({ env: { ...ENV, PAYPAL_ENV: '' }, origin: PREVIEW }).reason, 'paypal_key_missing', '環境の明示がなければ使わない');
  assert.equal(resolvePaypalMode({ env: { ...ENV, PAYPAL_CLIENT_SECRET: '' }, origin: PREVIEW }).reason, 'paypal_key_missing');
  assert.equal(resolvePaypalMode({ env: ENV, origin: PREVIEW }).apiBase, 'https://api-m.sandbox.paypal.com');
});

test('注文: 即時売上（CAPTURE）・JPY 小数なし・メールを載せない・禁止語なし・月払いは作れない', () => {
  const b = buildOrderBody({ productId: 'premium-annual', recordId: REC, origin: PREVIEW, invoiceId: 'ak-premium-annual-x' });
  assert.equal(b.intent, 'CAPTURE');
  assert.deepEqual(b.purchase_units[0].amount, { currency_code: 'JPY', value: '49800' });
  assert.equal(b.purchase_units[0].custom_id, `${REC}:premium-annual`);
  assert.equal(b.payment_source.paypal.experience_context.shipping_preference, 'NO_SHIPPING');
  assert.equal(b.payment_source.paypal.experience_context.return_url, `${PREVIEW}/checkout/paypal-return/`);
  assert.equal(JSON.stringify(b).includes('@'), false);
  assert.equal([b.purchase_units[0].description, b.payment_source.paypal.experience_context.brand_name].some(hasBannedPaymentWord), false);
  assert.throws(() => buildOrderBody({ productId: 'premium-monthly', recordId: REC, origin: PREVIEW, invoiceId: 'x' }));
});

test('E2E: 注文 → 承認 → capture → 照会で確認 → 付与 → 戻り先の再読込・Webhook 再送は 1 回だけ', async () => {
  const w = world();
  assert.equal((await createPaypalOrder({ env: ENV, origin: PREVIEW, recordId: null, productId: 'premium-annual', fetchImpl: w.fetch })).code, 'login_required');
  assert.equal((await createPaypalOrder({ env: ENV, origin: PRODUCTION_ORIGIN, recordId: REC, productId: 'premium-annual', fetchImpl: w.fetch })).code, 'test_key_on_production');
  assert.equal(w.calls.length, 0, '止めるときは何も呼ばない');
  const o = await order(w);
  assert.match(w.requestIds[0], /^ak-premium-annual-[0-9a-f]+$/, '注文作成は冪等キー付き');
  assert.equal((await capture(w, o)).result, 'mismatch_status_created', '未承認なら何もしない');
  assert.equal(w.captureCalls, 0);
  w.approve(o);
  assert.equal((await settlePaypalOrder({ env: ENV, origin: PREVIEW, orderId: o, redis: w.redisCmd, fetchImpl: w.fetch })).result, 'approved_not_captured', 'capture 指定なしでは売上にしない');
  assert.equal((await capture(w, o)).result, 'granted');
  assert.ok(w.requestIds.includes(`ak-cap-${o}`), 'capture は冪等キー付き');
  assert.equal(w.fields['プラン'], 'Premium');
  assert.equal(w.fields['有効期限'], '2027-10-11');
  assert.equal(w.fields.PaymentMethod, 'paypal');
  assert.equal((await capture(w, o)).result, 'already_applied', '戻り先の再読込');
  assert.equal((await hook(w, 'PAYMENT.CAPTURE.COMPLETED', capRes(o))).result, 'already_applied', 'Webhook');
  assert.equal((await hook(w, 'PAYMENT.CAPTURE.COMPLETED', capRes(o))).result, 'already_applied', 'Webhook 再送');
  assert.equal(w.captureCalls, 1, 'capture は 1 回だけ（完了済みは照会で進む）');
  assert.equal(w.patches.length, 1);
  assert.equal((await readPaypalOrderStatus({ redis: w.redisCmd, orderId: o, recordId: REC })).status, 'active');
  assert.deepEqual(w.notes.map((x) => x[0]), ['granted']);
});

test('戻り先を閉じても Webhook（承認）で capture・付与される／戻り先と Webhook が同時でも 1 回', async () => {
  const w = world();
  const o = await order(w);
  w.approve(o);
  const rs = await Promise.all([capture(w, o), hook(w, 'CHECKOUT.ORDER.APPROVED', { id: o })]);
  assert.deepEqual(rs.map((r) => r.result).sort(), ['already_applied', 'granted']);
  assert.equal(w.patches.length, 1);
});

test('Webhook: 検証 API が SUCCESS 以外・ヘッダ欠落・PayPal 以外の証明書 URL は 401（何も照会しない）', async () => {
  const w = world({ verify: 'FAILURE' });
  const o = await order(w);
  w.approve(o);
  const before = w.calls.length;
  assert.deepEqual(await hook(w, 'CHECKOUT.ORDER.APPROVED', { id: o }), { status: 401, result: 'invalid_signature' });
  const w2 = world();
  assert.equal((await hook(w2, 'CHECKOUT.ORDER.APPROVED', { id: o }, { ...HDR, 'PAYPAL-TRANSMISSION-SIG': '' })).status, 401);
  assert.equal((await hook(w2, 'CHECKOUT.ORDER.APPROVED', { id: o }, { ...HDR, 'PAYPAL-CERT-URL': 'https://evil.example/cert' })).status, 401);
  assert.equal(w2.calls.length, 0);
  assert.equal(w.calls.length - before, 2, 'token と検証 API だけ');
  assert.equal(buildVerifyBody(HDR, '', {}), null, 'webhook_id 未設定は検証しない');
});

test('照会結果が違えば書かない（金額・通貨・会員・商品・保留中）', async () => {
  const w = world();
  const o = await order(w);
  w.approve(o);
  await capture(w, o);
  w.patches.length = 0;
  const pu = w.orders[o].purchase_units[0];
  const base = JSON.parse(JSON.stringify(pu));
  const set = (fn) => { w.orders[o].purchase_units[0] = fn(JSON.parse(JSON.stringify(base))); };
  w.redis.clear();
  set((p) => ({ ...p, amount: { currency_code: 'JPY', value: '100' } }));
  assert.equal((await capture(w, o)).result, 'mismatch_amount_mismatch');
  set((p) => ({ ...p, custom_id: 'x:premium-annual' }));
  assert.equal((await capture(w, o)).result, 'mismatch_invalid_record');
  set((p) => ({ ...p, custom_id: `${REC}:premium-monthly` }));
  assert.equal((await capture(w, o)).result, 'mismatch_invalid_product');
  set((p) => { p.payments.captures[0].amount = { currency_code: 'USD', value: '49800' }; return p; });
  assert.equal((await capture(w, o)).result, 'mismatch_capture_amount_mismatch');
  set((p) => { p.payments.captures[0].status = 'PENDING'; return p; });
  assert.equal((await capture(w, o)).result, 'capture_pending', '保留中（審査・eCheck）は付与しない');
  assert.equal(w.patches.length, 0);
  assert.equal(matchOrder(null).ok, false);
});

test('返金: 全額返金・リバーサルは付与前へ戻す／一部返金は戻さず管理者へ → 再購入できる', async () => {
  const w = world();
  const o = await order(w);
  w.approve(o);
  await capture(w, o);
  const refundRes = { id: 'REF1', status: 'COMPLETED', links: [{ rel: 'up', href: `https://api-m.sandbox.paypal.com/v2/payments/captures/CAP${o}` }] };
  assert.deepEqual(parsePaypalWebhook({ event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: refundRes }).captureId, `CAP${o}`);
  w.setCapture(o, 'PARTIALLY_REFUNDED');
  assert.equal((await hook(w, 'PAYMENT.CAPTURE.REFUNDED', refundRes)).result, 'partial_refund_no_change');
  assert.equal(w.fields['プラン'], 'Premium');
  w.setCapture(o, 'REFUNDED');
  assert.equal((await hook(w, 'PAYMENT.CAPTURE.REFUNDED', refundRes)).result, 'reverted');
  assert.equal(w.fields['プラン'], 'Free');
  assert.equal((await hook(w, 'PAYMENT.CAPTURE.REFUNDED', refundRes)).result, 'already_reverted', '再送');
  assert.equal((await readPaypalOrderStatus({ redis: w.redisCmd, orderId: o, recordId: REC })).status, 'refunded');
  // 再購入（返金直後でも二重購入扱いにしない）→ リバーサル（チャージバック）で戻る
  const o2 = await order(w, 'premium-lifetime');
  w.approve(o2);
  assert.equal((await capture(w, o2)).result, 'granted');
  assert.equal(w.fields['有効期限'], '2099-12-31');
  assert.equal((await hook(w, 'PAYMENT.CAPTURE.REVERSED', capRes(o2))).result, 'reverted');
  assert.equal(w.fields['プラン'], 'Free');
});

test('買い切り会員・生きている Stripe 月額は注文を作らない／30 分以内の 2 本目は権限を変えず管理者へ', async () => {
  const lw = world({ fields: { 'プラン': 'Premium', PlanType: 'Lifetime', '有効期限': '2099-12-31' } });
  assert.equal((await createPaypalOrder({ env: ENV, origin: PREVIEW, recordId: REC, productId: 'premium-annual', fetchImpl: lw.fetch })).code, 'already_lifetime');
  const sw = world({ fields: { 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', PaymentMethod: 'stripe', StripeSubscriptionId: 'sub_1', '有効期限': '2099-01-01' } });
  assert.equal((await createPaypalOrder({ env: ENV, origin: PREVIEW, recordId: REC, productId: 'premium-annual', fetchImpl: sw.fetch })).code, 'stripe_subscription_active');
  assert.equal(lw.calls.filter((u) => u.includes('paypal')).length + sw.calls.filter((u) => u.includes('paypal')).length, 0);
  const w = world();
  const o1 = await order(w);
  const o2 = await order(w);
  w.approve(o1); w.approve(o2);
  assert.equal((await capture(w, o1)).result, 'granted');
  assert.equal((await capture(w, o2)).result, 'conflict_possible_duplicate_purchase');
  assert.equal(w.fields['有効期限'], '2027-10-11');
  assert.deepEqual(w.notes.at(-1), ['conflict', 'possible_duplicate_purchase']);
});

test('旧 paypal-webhook.js は 410 のまま・新経路は別名で検証 API と Airtable 計測を通す', () => {
  const read = (f) => readFileSync(fileURLToPath(new URL(`../../../../netlify/functions/${f}`, import.meta.url)), 'utf8');
  assert.match(read('paypal-webhook.js'), /statusCode: 410/);
  const wh = read('paypal-order-webhook.js');
  assert.match(wh, /installAirtableCallMeter\(\{ source: 'paypal-order-webhook' \}\)/);
  assert.match(wh, /handlePaypalWebhook/);
  for (const f of ['paypal-create-order.js', 'paypal-capture.js', 'paypal-order-webhook.js']) {
    assert.equal(/console\.(log|error)\([^)]*(Email|email|PAYPAL_CLIENT_SECRET)/.test(read(f)), false, `${f}: ログにメール・秘密を出さない`);
  }
});
