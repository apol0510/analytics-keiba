/** Premium Plus 案内メールの成果集計（2026-09-29）の重要仕様 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeOfferOutcome } from './premiumPlusOfferOutcome.js';

const A = 'recOFFERTEST00001'; const B = 'recOFFERTEST00002';
const SENT = '2026-09-29T01:25:14.375Z'; const T = Date.parse(SENT);
const del = (rid, key, over = {}) => ({ Status: 'sent', SentAt: SENT, CustomerRecordId: rid, DeliveryKey: key, ...over });

test('送信後に起きたことだけを段ごとに数える（送信前の閲覧は数えない）', () => {
  const o = summarizeOfferOutcome({
    deliveries: [del(A, 'k1'), del(B, 'k2'), del(B, 'k3', { Status: 'failed' })],
    events: new Map([['k1', { deliveredAtMs: T + 1, firstOpenAtMs: T + 60 }], ['k2', { deliveredAtMs: T + 1 }]]),
    funnel: new Map([[A, { page: { lastAtMs: T + 120 }, checkout: { lastAtMs: T + 200 }, purchase: null }], [B, { page: { lastAtMs: T - 1000 } }]]),
    orders: [{ recordId: A, receivedAt: T + 200, status: 'confirmed', metricState: 'counted' }, { recordId: A, receivedAt: T - 5, status: 'awaiting_payment' }],
  });
  assert.equal(o.recipients, 2); assert.equal(o.sent, 2);
  assert.equal(o.delivered, 2); assert.equal(o.opened, 1);
  assert.equal(o.reachedPlusPage, 1); assert.equal(o.checkoutStarted, 1);
  assert.equal(o.orders, 1); assert.equal(o.ordersConfirmed, 1);
  assert.equal(o.attribution, 'correlated');
});

test('計測を読めないときは 0 ではなく null', () => {
  const o = summarizeOfferOutcome({ deliveries: [del(A, 'k1')], events: null, funnel: null, orders: [] });
  assert.equal(o.opened, null); assert.equal(o.reachedPlusPage, null);
});

test('識別子を返さない・テスト注文は数えない', () => {
  const o = summarizeOfferOutcome({ deliveries: [del(A, 'k1')], events: new Map(), funnel: new Map(), orders: [{ recordId: A, receivedAt: T + 1, canary: true, status: 'confirmed', metricState: 'counted' }] });
  assert.equal(o.orders, 0);
  assert.equal(/rec[A-Za-z0-9]{14}/.test(JSON.stringify(o)), false);
});

test('成果の読み取り API は書き込みを持たず、自動確認が 7 日後に登録されている', () => {
  const fn = readFileSync(new URL('../../../netlify/functions/admin-payment-funnel.js', import.meta.url), 'utf8');
  assert.match(fn, /action === 'plusOfferOutcome'/);
  assert.equal(/HSET|HDEL|HINCRBY|method: 'PATCH'|method: 'POST', headers: \{ Authorization/.test(fn), false);
  const reg = JSON.parse(readFileSync(new URL('../../../../ops/scheduled-checks.json', import.meta.url), 'utf8'));
  const c = reg.checks.find((x) => x.id === 'premium-plus-offer-2026-09-29-outcome');
  assert.equal(c.kind, 'premium-plus-offer-outcome');
  assert.equal(c.runFrom, '2026-10-06');
});
