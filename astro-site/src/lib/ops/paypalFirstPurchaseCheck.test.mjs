import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgePaypalFirstPurchase, grantProblems, runPaypalFirstPurchaseCheck, renderPaypalFirstPurchaseMarkdown } from './paypalFirstPurchaseCheck.js';

const NOW = Date.parse('2026-10-20T01:00:00Z');
const ok = (o = {}) => ({ fields: { 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-11-19', VenueAccess: 'jra', PaymentMethod: 'PayPal', PaidAt: '2026-10-17T03:00:00.000Z', ...o } });
const WH = { total: 2, byEvent: { 'BILLING.SUBSCRIPTION.ACTIVATED': { count: 1, last: '2026-10-17T03:00:01Z', results: { write_attached: 1 } }, 'PAYMENT.SALE.COMPLETED': { count: 1, last: '2026-10-17T03:00:02Z', results: { write_renewed: 1 } } } };
const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code; } };

test('購入 0 件は待機中（no_paypal_monthly_purchase_yet）', () => {
  assert.equal(code(() => judgePaypalFirstPurchase({ rows: [], webhooks: null, nowMs: NOW })), 'no_paypal_monthly_purchase_yet');
});

test('購入あり・権限が月額の形・Webhook あり → 成功（件数と内訳）', () => {
  const r = judgePaypalFirstPurchase({ rows: [ok(), ok({ VenueAccess: '' })], webhooks: WH, nowMs: NOW });
  assert.equal(r.purchases, 2);
  assert.deepEqual(r.byVenue, { jra: 1, '両方': 1 });
  assert.equal(r.webhooks.total, 2);
});

test('権限が月額の形でなければ失敗（paypal_grant_mismatch）', () => {
  assert.equal(code(() => judgePaypalFirstPurchase({ rows: [ok({ Status: 'pending' })], webhooks: WH, nowMs: NOW })), 'paypal_grant_mismatch');
  assert.equal(code(() => judgePaypalFirstPurchase({ rows: [ok({ '有効期限': '2026-10-18' })], webhooks: WH, nowMs: NOW })), 'paypal_grant_mismatch');
  assert.equal(code(() => judgePaypalFirstPurchase({ rows: [ok({ 'プラン': 'Light' })], webhooks: WH, nowMs: NOW })), 'paypal_grant_mismatch');
});

test('顧客自身が退会した会員は期間を見ない（期限は前日に縮むため）', () => {
  assert.deepEqual(grantProblems(ok({ WithdrawalRequested: true, Status: 'active', '有効期限': '2026-10-18' }).fields), []);
});

test('Webhook 0 件: 48 時間は待機中、過ぎたら失敗', () => {
  const rows = [ok({ PaidAt: '2026-10-19T12:00:00.000Z' })];
  assert.equal(code(() => judgePaypalFirstPurchase({ rows, webhooks: { total: 0 }, nowMs: NOW })), 'paypal_webhook_not_seen_yet');
  assert.equal(code(() => judgePaypalFirstPurchase({ rows: [ok()], webhooks: { total: 0 }, nowMs: Date.parse('2026-10-21T01:00:00Z') })), 'paypal_webhook_not_seen');
});

test('読むだけ: Airtable は GET・権限 8 項目だけ（メール・氏名を取らない）、Webhook は集計 API を読む', async () => {
  const calls = [];
  const fetchImpl = async (u, init = {}) => {
    calls.push({ url: String(u), method: init.method || 'GET', body: init.body });
    if (String(u).includes('api.airtable.com')) return new Response(JSON.stringify({ records: [ok()] }), { status: 200 });
    return new Response(JSON.stringify(WH), { status: 200 });
  };
  const check = { title: 't', compare: { siteUrl: 'https://analytics.keiba.link/' } };
  const r = await runPaypalFirstPurchaseCheck({ check, token: 't', secret: 's', fetchImpl, now: new Date(NOW) });
  assert.equal(calls[0].method, 'GET');
  const fields = new URL(calls[0].url).searchParams.getAll('fields[]');
  assert.ok(!fields.some((f) => /mail|氏名|名前|Email/i.test(f)), fields.join(','));
  assert.equal(JSON.parse(calls[1].body).action, 'paypalSubscriptionWebhooks');
  assert.match(renderPaypalFirstPurchaseMarkdown({ check, result: r }), /PAYMENT\.SALE\.COMPLETED \| 1/);
});

test('購入 0 件なら Webhook の API は呼ばない', async () => {
  let n = 0;
  const fetchImpl = async () => { n += 1; return new Response(JSON.stringify({ records: [] }), { status: 200 }); };
  await assert.rejects(runPaypalFirstPurchaseCheck({ check: { compare: { siteUrl: 'https://x/' } }, token: 't', secret: '', fetchImpl }), (e) => e.code === 'no_paypal_monthly_purchase_yet');
  assert.equal(n, 1);
});
