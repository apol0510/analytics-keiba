// applySubscription の結合テスト（Stripe / Airtable / Redis は差し替え。本番・テストモードとも非接触）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySubscription, subscriptionIdFromEvent } from './stripeServer.js';

const ENV = {
  AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX',
  STRIPE_PRICE_PREMIUM: 'price_full', STRIPE_PRICE_PREMIUM_JRA: 'price_jra', STRIPE_PRICE_PREMIUM_NANKAN: 'price_nankan',
};
const NOW = new Date('2026-10-02T03:00:00Z');
const PERIOD_END = Math.floor(Date.parse('2026-11-02T03:00:00Z') / 1000);

/** メモリ上の Airtable（filterByFormula は本実装が使う 2 形だけ解釈する） */
function fakeAirtable(initial = []) {
  const rows = new Map(initial.map((r) => [r.id, { id: r.id, fields: { ...r.fields } }]));
  let seq = 0;
  const log = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const parts = u.pathname.split('/').filter(Boolean); // v0, base, Customers, [id]
    const id = parts[3] ? decodeURIComponent(parts[3]) : null;
    const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    log.push(method);
    if (method === 'GET' && id) {
      const r = rows.get(id);
      return r ? ok(r) : { ok: false, status: 404, text: async () => '{}' };
    }
    if (method === 'GET') {
      const f = u.searchParams.get('filterByFormula');
      let m;
      let out = [];
      if ((m = f.match(/^\{StripeSubscriptionId\} = '(.*)'$/))) {
        out = [...rows.values()].filter((r) => r.fields.StripeSubscriptionId === m[1]);
      } else if ((m = f.match(/^LOWER\(TRIM\(\{Email\}\)\) = '(.*)'$/))) {
        out = [...rows.values()].filter((r) => String(r.fields.Email || '').trim().toLowerCase() === m[1]);
      } else throw new Error(`unexpected formula ${f}`);
      return ok({ records: out });
    }
    if (method === 'PATCH') {
      const r = rows.get(id);
      Object.assign(r.fields, JSON.parse(init.body).fields);
      return ok(r);
    }
    if (method === 'POST') {
      // 同時実行の取りこぼしを再現しやすくするため一拍おく
      await new Promise((res) => setTimeout(res, 5));
      seq += 1;
      const rec = { id: `recNEW${String(seq).padStart(11, '0')}`, fields: JSON.parse(init.body).records[0].fields };
      rows.set(rec.id, rec);
      return ok({ records: [rec] });
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rows, fetchImpl, log };
}

function fakeStripe(subs, customers = { cus_1: { email: 'Buyer@Example.com' } }) {
  const updates = [];
  return {
    updates,
    subscriptions: {
      retrieve: async (id) => {
        await new Promise((r) => setTimeout(r, 1));
        if (!subs[id]) throw new Error('No such subscription');
        return subs[id];
      },
      update: async (id, p) => { updates.push([id, p]); return subs[id]; },
    },
    customers: { retrieve: async (id) => customers[id] },
  };
}

const subObj = (over = {}) => ({
  id: 'sub_1', status: 'active', customer: 'cus_1', metadata: {},
  items: { data: [{ price: { id: 'price_full' }, current_period_end: PERIOD_END }] },
  ...over,
});

function fakeRedis() {
  const m = new Map();
  return async ([cmd, key, val, nx]) => {
    if (cmd === 'SET' && nx === 'NX') { if (m.has(key)) return null; m.set(key, val); return 'OK'; }
    if (cmd === 'GET') return m.get(key) ?? null;
    if (cmd === 'DEL') { m.delete(key); return 1; }
    return null;
  };
}

test('未登録の人: レコードを作り Premium を付与・管理者へ 1 回通知', async () => {
  const at = fakeAirtable();
  const stripe = fakeStripe({ sub_1: subObj() });
  const notes = [];
  const r = await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl, notify: async (k, d) => notes.push([k, d]) });
  assert.equal(r.action, 'write');
  assert.equal(at.rows.size, 1);
  const rec = [...at.rows.values()][0];
  assert.equal(rec.fields.Email, 'buyer@example.com');
  assert.equal(rec.fields.Source, 'stripe-checkout');
  assert.equal(rec.fields['プラン'], 'Premium');
  assert.equal(rec.fields['有効期限'], '2026-11-04');
  assert.equal(rec.fields.StripeSubscriptionId, 'sub_1');
  assert.deepEqual(notes.map((n) => n[0]), ['attached']);
  assert.equal(stripe.updates[0][1].metadata.ak_record_id, rec.id);

  // 2 回目（Webhook の再送）: 作らない・通知しない・結果は同じ
  const r2 = await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl, notify: async (k, d) => notes.push([k, d]) });
  assert.equal(r2.reason, 'renewed');
  assert.equal(at.rows.size, 1);
  assert.equal(notes.length, 1);
});

test('同時に 2 本（Webhook と決済完了画面）来てもレコードは 1 件', async () => {
  const at = fakeAirtable();
  const stripe = fakeStripe({ sub_1: subObj() });
  const redis = fakeRedis();
  const run = () => applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl, redis });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(at.rows.size, 1);
  assert.deepEqual([a.reason, b.reason].sort(), ['attached', 'renewed']);
});

test('既存の無料会員はメールで照合して更新（新規作成しない）', async () => {
  const at = fakeAirtable([{ id: 'recAAAAAAAAAAAAA1', fields: { Email: ' buyer@example.com ', 'プラン': 'Free' } }]);
  const stripe = fakeStripe({ sub_1: subObj({ items: { data: [{ price: { id: 'price_nankan' }, current_period_end: PERIOD_END }] } }) });
  const r = await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(r.recordId, 'recAAAAAAAAAAAAA1');
  assert.equal(at.rows.size, 1);
  assert.equal(at.rows.get('recAAAAAAAAAAAAA1').fields.VenueAccess, 'nankan');
});

test('ログイン中の申込は metadata のレコードへ（メールが違っても）', async () => {
  const at = fakeAirtable([{ id: 'recBBBBBBBBBBBBB1', fields: { Email: 'member@example.com', 'プラン': 'Light', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-10-10' } }]);
  const stripe = fakeStripe({ sub_1: subObj({ metadata: { ak_record_id: 'recBBBBBBBBBBBBB1' } }) });
  const r = await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(r.recordId, 'recBBBBBBBBBBBBB1');
  const f = at.rows.get('recBBBBBBBBBBBBB1').fields;
  assert.equal(f['プラン'], 'Premium');
  // Light → Premium 転換履歴
  assert.equal(f.PremiumConvertedFrom, 'Light/Monthly');
});

test('同じメールのレコードが複数: 書かずに要確認', async () => {
  const at = fakeAirtable([
    { id: 'recCCCCCCCCCCCCC1', fields: { Email: 'buyer@example.com' } },
    { id: 'recCCCCCCCCCCCCC2', fields: { Email: 'BUYER@example.com' } },
  ]);
  const notes = [];
  const r = await applySubscription({ stripe: fakeStripe({ sub_1: subObj() }), env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl, notify: async (k, d) => notes.push(d.reason) });
  assert.equal(r.reason, 'duplicate_email_records');
  assert.deepEqual(notes, ['duplicate_email_records']);
  assert.ok(!at.log.includes('PATCH') && !at.log.includes('POST'));
});

test('別の購読が生きている会員: 書かずに要確認（二重課金の検知）', async () => {
  const at = fakeAirtable([{ id: 'recDDDDDDDDDDDDD1', fields: { Email: 'buyer@example.com', StripeSubscriptionId: 'sub_old' } }]);
  const stripe = fakeStripe({ sub_1: subObj(), sub_old: subObj({ id: 'sub_old' }) });
  const r = await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(r.reason, 'duplicate_subscription');
  assert.equal(at.rows.get('recDDDDDDDDDDDDD1').fields.StripeSubscriptionId, 'sub_old');
});

test('解約後の deleted: 期限を終了日へ', async () => {
  const at = fakeAirtable([{ id: 'recEEEEEEEEEEEEE1', fields: { Email: 'buyer@example.com', StripeSubscriptionId: 'sub_1', '有効期限': '2026-11-04' } }]);
  const stripe = fakeStripe({ sub_1: subObj({ status: 'canceled', ended_at: PERIOD_END }) });
  const r = await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(r.reason, 'ended');
  assert.equal(at.rows.get('recEEEEEEEEEEEEE1').fields['有効期限'], '2026-11-02');
});

test('Webhook イベント → 購読 ID（対象外は null）', () => {
  assert.equal(subscriptionIdFromEvent({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1' } } }), 'sub_1');
  assert.equal(subscriptionIdFromEvent({ type: 'checkout.session.completed', data: { object: { mode: 'payment' } } }), null);
  assert.equal(subscriptionIdFromEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_2' } } }), 'sub_2');
  assert.equal(subscriptionIdFromEvent({ type: 'invoice.paid', data: { object: { parent: { subscription_details: { subscription: 'sub_3' } } } } }), 'sub_3');
  assert.equal(subscriptionIdFromEvent({ type: 'invoice.payment_succeeded', data: { object: { subscription: 'sub_4' } } }), 'sub_4');
  assert.equal(subscriptionIdFromEvent({ type: 'invoice.payment_failed', data: { object: { subscription: 'sub_5' } } }), null);
  assert.equal(subscriptionIdFromEvent({ type: 'charge.refunded', data: { object: {} } }), null);
});
