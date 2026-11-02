// Paddle 定期課金の初回実購入・初回実更新の read-only 監視（2026-11-02 MK）
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgePaddleFirstPurchase, judgePaddleFirstRenewal, paddleGrantProblems, runPaddleFirstPurchaseCheck } from './paddleFirstSubscriptionCheck.js';

const row = (f) => ({ fields: { 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', VenueAccess: 'jra', PaymentMethod: 'Paddle', PaidAt: '2026-11-05T03:00:00.000Z', '有効期限': '2026-12-07', ...f } });
const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code; } };

test('初回購入: 0 件は待機中・形が違えば失敗・成立すれば内訳', () => {
  assert.equal(code(() => judgePaddleFirstPurchase({ rows: [] })), 'no_paddle_subscription_purchase_yet');
  assert.equal(code(() => judgePaddleFirstPurchase({ rows: [row({ PlanType: 'Lifetime' })] })), 'paddle_grant_mismatch');
  assert.equal(code(() => judgePaddleFirstPurchase({ rows: [row({ PlanType: 'Annual', VenueAccess: 'jra', '有効期限': '2027-11-07' })] })), 'paddle_grant_mismatch');
  assert.deepEqual(paddleGrantProblems(row({ '有効期限': '2026-11-20' }).fields), ['有効期限が支払い日から 15 日（1 期間 + 2 日に満たない）']);
  const r = judgePaddleFirstPurchase({ rows: [row(), row({ PlanType: 'Annual', VenueAccess: '', '有効期限': '2027-11-07' }), row({ WithdrawalRequested: true, '有効期限': '2026-11-06' })] });
  assert.deepEqual({ ...r, firstPaid: undefined }, { purchases: 3, active: 2, ended: 1, byPlan: { 'Monthly/jra': 2, 'Annual/両方': 1 }, firstPaid: undefined });
});

test('初回更新: 期限が初回分より 20 日以上先なら成功・請求日 + 3 日までは待機中・過ぎたら失敗・年額は 12 か月', () => {
  const now = Date.parse('2026-12-06T00:00:00Z');
  assert.equal(code(() => judgePaddleFirstRenewal({ rows: [row()], nowMs: now })), 'paddle_renewal_not_due_yet');
  assert.equal(code(() => judgePaddleFirstRenewal({ rows: [row()], nowMs: Date.parse('2026-12-09T00:00:00Z') })), 'paddle_renewal_not_seen');
  assert.equal(judgePaddleFirstRenewal({ rows: [row({ '有効期限': '2027-01-07' })], nowMs: now }).renewed, 1);
  assert.equal(code(() => judgePaddleFirstRenewal({ rows: [row({ CancelledAt: '2026-11-20T00:00:00Z' })], nowMs: now })), 'paddle_no_renewal_candidate');
  assert.equal(code(() => judgePaddleFirstRenewal({ rows: [row({ PlanType: 'Annual', VenueAccess: '', '有効期限': '2027-11-07' })], nowMs: Date.parse('2027-06-01T00:00:00Z') })), 'paddle_renewal_not_due_yet');
});

test('読み取りだけ: Customers の Paddle 定期課金を権限の列だけで読む（メールを取らない）', async () => {
  const calls = [];
  const fetchImpl = async (u, init) => { calls.push([String(u), init?.method || 'GET']); return { ok: true, status: 200, json: async () => ({ records: [row()] }) }; };
  const r = await runPaddleFirstPurchaseCheck({ token: 't', fetchImpl });
  assert.equal(r.purchases, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'GET');
  assert.match(decodeURIComponent(calls[0][0]).replace(/\+/g, " "), /\{PaymentMethod\} = "Paddle"/);
  assert.doesNotMatch(decodeURIComponent(calls[0][0]), /Email|氏名/);
  await assert.rejects(runPaddleFirstPurchaseCheck({ token: '', fetchImpl }), /airtable_token_missing/);
});
