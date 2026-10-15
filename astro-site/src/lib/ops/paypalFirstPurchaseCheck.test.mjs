import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  judgePaypalFirstPurchase, grantProblems, runPaypalFirstPurchaseCheck, renderPaypalFirstPurchaseMarkdown,
  judgePaypalFirstRenewal, renewalState, addMonthsJstYmd, runPaypalFirstRenewalCheck, renderPaypalFirstRenewalMarkdown,
} from './paypalFirstPurchaseCheck.js';

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

test('読むだけ: Airtable は GET・権限の項目だけ（メール・氏名を取らない）、Webhook は集計 API を読む', async () => {
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

// ── 初回の実更新（paypal-monthly-first-renewal）──
// 10/17 12:00 JST に購入 → 初回の期限 11/19・最初の請求日 11/17（暦の 1 か月）
const at = (iso) => Date.parse(iso);

test('更新: 状態の判定（初回の期限より 20 日以上先＝更新済み・退会/解約＝対象外・それ以外＝更新待ち）', () => {
  assert.equal(addMonthsJstYmd('2026-10-17T03:00:00.000Z', 1), '2026-11-17');
  assert.equal(addMonthsJstYmd('2026-10-31T15:30:00.000Z', 1), '2026-12-01', 'JST の日付で数える');
  assert.equal(addMonthsJstYmd('2027-01-31T03:00:00.000Z', 1), '2027-02-28', '月末は丸める');
  assert.deepEqual(renewalState(ok().fields), { state: 'waiting', due: '2026-11-17', firstExp: '2026-11-19', exp: '2026-11-19' });
  assert.equal(renewalState(ok({ '有効期限': '2026-12-19' }).fields).state, 'renewed');
  assert.equal(renewalState(ok({ '有効期限': '2026-11-20' }).fields).state, 'waiting', '1 日ずれは更新とみなさない');
  assert.equal(renewalState(ok({ WithdrawalRequested: true, '有効期限': '2026-10-19' }).fields).state, 'ended');
  assert.equal(renewalState(ok({ CancelledAt: '2026-11-01T00:00:00Z', '有効期限': '2026-11-18' }).fields).state, 'ended');
});

test('更新: 購入 0 → 待機中／請求日 + 3 日まで → 待機中／更新済みが 1 件でもあれば成功', () => {
  assert.equal(code(() => judgePaypalFirstRenewal({ rows: [], webhooks: null, nowMs: at('2026-11-20T00:00:00Z') })), 'no_paypal_monthly_purchase_yet');
  assert.equal(code(() => judgePaypalFirstRenewal({ rows: [ok()], webhooks: WH, nowMs: at('2026-11-20T14:59:00Z') })), 'paypal_renewal_not_due_yet', '11/17 + 3 日 = 11/20 23:59 JST まで');
  const r = judgePaypalFirstRenewal({ rows: [ok({ '有効期限': '2026-12-19' }), ok()], webhooks: WH, nowMs: at('2026-11-18T00:00:00Z') });
  assert.equal(r.renewed, 1);
  assert.equal(r.waiting, 1);
  assert.equal(r.firstRenewalDue, '2026-11-17');
  assert.equal(r.firstRenewedExpiration, '2026-12-19');
});

test('更新: 期限を過ぎても延びない → 支払い失敗の Webhook があれば待機中（お客様側）、無ければ失敗', () => {
  const late = at('2026-11-21T00:00:00Z');
  assert.equal(code(() => judgePaypalFirstRenewal({ rows: [ok()], webhooks: WH, nowMs: late })), 'paypal_renewal_not_seen');
  const failed = { total: 3, byEvent: { ...WH.byEvent, 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': { count: 1, last: '2026-11-17T03:00:00Z', results: { skip_awaiting_payment: 1 } } } };
  assert.equal(code(() => judgePaypalFirstRenewal({ rows: [ok()], webhooks: failed, nowMs: late })), 'paypal_renewal_payment_failed');
  // 全員が更新前に退会・解約 → 更新を待つ会員なし（待機中）
  assert.equal(code(() => judgePaypalFirstRenewal({ rows: [ok({ WithdrawalRequested: true })], webhooks: WH, nowMs: late })), 'paypal_no_renewal_candidate');
});

test('更新: 読むだけ（GET・権限の項目だけ）・購入 0 なら Webhook の API を呼ばない・成功時の記録', async () => {
  const calls = [];
  const fetchImpl = async (u, init = {}) => {
    calls.push({ url: String(u), method: init.method || 'GET', body: init.body });
    if (String(u).includes('api.airtable.com')) return new Response(JSON.stringify({ records: [ok({ '有効期限': '2026-12-19' })] }), { status: 200 });
    return new Response(JSON.stringify(WH), { status: 200 });
  };
  const check = { title: 't', compare: { siteUrl: 'https://analytics.keiba.link/' } };
  const r = await runPaypalFirstRenewalCheck({ check, token: 't', secret: 's', fetchImpl, now: new Date('2026-11-18T00:00:00Z') });
  assert.equal(calls[0].method, 'GET');
  assert.ok(!new URL(calls[0].url).searchParams.getAll('fields[]').some((f) => /mail|氏名|名前|Email/i.test(f)));
  assert.match(renderPaypalFirstRenewalMarkdown({ check, result: r }), /更新された会員.*\*\*1\*\*/);
  let n = 0;
  const empty = async () => { n += 1; return new Response(JSON.stringify({ records: [] }), { status: 200 }); };
  await assert.rejects(runPaypalFirstRenewalCheck({ check, token: 't', secret: '', fetchImpl: empty }), (e) => e.code === 'no_paypal_monthly_purchase_yet');
  assert.equal(n, 1);
});

