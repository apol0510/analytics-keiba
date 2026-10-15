import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordPaypalSubscriptionWebhook, readPaypalWebhookLedger, PAYPAL_WEBHOOK_LEDGER_KEY } from './paypalWebhookLedger.js';

function fakeRedis() {
  const h = new Map();
  const cmds = [];
  const redis = async (args) => {
    cmds.push(args);
    const [c, key, f, v] = args;
    assert.equal(key, PAYPAL_WEBHOOK_LEDGER_KEY);
    if (c === 'HINCRBY') { h.set(f, (Number(h.get(f)) || 0) + v); return h.get(f); }
    if (c === 'HSET') { h.set(f, v); return 1; }
    if (c === 'HGETALL') return [...h.entries()].flat().map(String);
    throw new Error(c);
  };
  return { redis, cmds };
}

test('件数・最終受信だけを残し、読み出しで種別・結果別に集計する', async () => {
  const { redis, cmds } = fakeRedis();
  await recordPaypalSubscriptionWebhook(redis, { eventType: 'BILLING.SUBSCRIPTION.ACTIVATED', result: 'write_attached', now: new Date('2026-10-17T03:00:00Z') });
  await recordPaypalSubscriptionWebhook(redis, { eventType: 'PAYMENT.SALE.COMPLETED', result: 'write_renewed' });
  await recordPaypalSubscriptionWebhook(redis, { eventType: 'PAYMENT.SALE.COMPLETED', result: 'write_renewed' });
  const r = await readPaypalWebhookLedger(redis);
  assert.equal(r.total, 3);
  assert.equal(r.byEvent['PAYMENT.SALE.COMPLETED'].count, 2);
  assert.deepEqual(r.byEvent['PAYMENT.SALE.COMPLETED'].results, { write_renewed: 2 });
  assert.equal(r.byEvent['BILLING.SUBSCRIPTION.ACTIVATED'].last, '2026-10-17T03:00:00.000Z');
  // 識別子（購読 ID・会員 ID）を書かない
  assert.ok(!JSON.stringify(cmds).match(/I-[A-Z0-9]{6,}|rec[A-Za-z0-9]{14}/));
});

test('記録の失敗は Webhook の処理を止めない（false を返すだけ）', async () => {
  assert.equal(await recordPaypalSubscriptionWebhook(async () => { throw new Error('down'); }, { eventType: 'X', result: 'y' }), false);
  assert.equal(await recordPaypalSubscriptionWebhook(null, { eventType: 'X', result: 'y' }), false);
});

test('Webhook の Function は月額イベントの処理結果を記録している（署名検証の後だけ）', () => {
  const s = readFileSync(new URL('../../../../netlify/functions/paypal-order-webhook.js', import.meta.url), 'utf8');
  assert.match(s, /onSubscriptionEvent: async \(evt\) => \{[\s\S]*?handlePaypalSubscriptionEvent[\s\S]*?recordPaypalSubscriptionWebhook\(redis, \{ eventType: evt\?\.event_type, result: sr\.result \}\)/);
});
