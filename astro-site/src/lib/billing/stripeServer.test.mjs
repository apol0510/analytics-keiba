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

/**
 * paid: 購読 ID → 支払い済み期間の終わり（unix 秒）。省略時は購読の current_period_end まで支払い済み。
 * null を入れると「まだ支払われていない」。
 */
function fakeStripe(subs, customers = { cus_1: { email: 'Buyer@Example.com' } }, paid = {}) {
  const updates = [];
  return {
    updates,
    invoices: {
      list: async ({ subscription }) => {
        const end = Object.prototype.hasOwnProperty.call(paid, subscription)
          ? paid[subscription]
          : subs[subscription]?.items?.data?.[0]?.current_period_end;
        return { data: end ? [{ status: 'paid', lines: { data: [{ period: { end } }] } }] : [] };
      },
    },
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
  // checkout.session.completed 以外（allowCreate なし）は作らない
  const early = await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(early.reason, 'no_record_yet');
  assert.equal(at.rows.size, 0);
  const r = await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl, notify: async (k, d) => notes.push([k, d]), allowCreate: true });
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
  const run = (allowCreate) => applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl, redis, allowCreate });
  const [a, b] = await Promise.all([run(true), run(false)]);
  assert.equal(at.rows.size, 1);
  assert.ok(['attached', 'renewed', 'no_record_yet'].includes(b.reason));
  assert.equal(a.ok && b.ok, true);
});

test('Redis が無くても、同時に届いた複数イベントでレコードは 1 件（作成元は 1 本だけ）', async () => {
  // 2026-10-02 E2E の再現: checkout.session.completed / subscription.created / invoice.paid / invoice.payment_succeeded が同時
  const at = fakeAirtable();
  const stripe = fakeStripe({ sub_1: subObj() });
  const runs = [true, false, false, false].map((allowCreate) =>
    applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl, allowCreate }));
  await Promise.all(runs);
  assert.equal(at.rows.size, 1);
  // 後から来る再送（invoice.paid 等）で、作成済みのレコードが更新される
  const again = await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(again.reason, 'renewed');
  assert.equal(at.rows.size, 1);
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

test('解約後の deleted: 支払い済み期間の終わりまで残す（即時失効させない）', async () => {
  const at = fakeAirtable([{ id: 'recEEEEEEEEEEEEE1', fields: { Email: 'buyer@example.com', StripeSubscriptionId: 'sub_1', '有効期限': '2026-11-04' } }]);
  const stripe = fakeStripe({ sub_1: subObj({ status: 'canceled', ended_at: PERIOD_END }) });
  const r = await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(r.reason, 'ended');
  // 支払い済みの終わり 11/02 12:00 JST → 11/03（09:00 JST に切れる）
  assert.equal(at.rows.get('recEEEEEEEEEEEEE1').fields['有効期限'], '2026-11-03');
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


// ═══ 2026-10-02 MK 確定: 解約は期間末失効・最低利用期間なし・日割り返金なし ═══════════════
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { STRIPE_PLANS } from './stripePlans.js';

const at_ = (iso) => Date.parse(iso);
/** レコードの fields → いま中央 / 南関の Premium を見られるか */
function canView(fields, iso) {
  const e = resolveEntitlements(fromAirtableFields(fields), at_(iso));
  return { jra: e.canViewPremiumJra, nankan: e.canViewPremiumNankan };
}

test('期間末失効: 解約予約（cancel_at_period_end）中は支払い済み期間の終わりまで見られる', async () => {
  const at = fakeAirtable([{ id: 'recFFFFFFFFFFFFF1', fields: { Email: 'buyer@example.com', StripeSubscriptionId: 'sub_1', 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', PaymentMethod: 'Stripe', '有効期限': '2026-11-04' } }]);
  const stripe = fakeStripe({ sub_1: subObj({ cancel_at_period_end: true }) });
  await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl });
  const f = at.rows.get('recFFFFFFFFFFFFF1').fields;
  assert.equal(f['有効期限'], '2026-11-04', '解約予約で期限を縮めていない');
  assert.deepEqual(canView(f, '2026-11-02T02:00:00Z'), { jra: true, nankan: true }, '支払い済み期間中は見られる');
});

test('期間末失効: Stripe 画面で即時解約されても、支払い済みの期間は奪わない（日割り返金もしない）', async () => {
  const at = fakeAirtable([{ id: 'recFFFFFFFFFFFFF2', fields: { Email: 'buyer@example.com', StripeSubscriptionId: 'sub_1', 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', PaymentMethod: 'Stripe', '有効期限': '2026-11-04' } }]);
  // 10/10 に即時解約。支払い済みは 11/02 まで
  const stripe = fakeStripe({ sub_1: subObj({ status: 'canceled', ended_at: Math.floor(at_('2026-10-10T00:00:00Z') / 1000) }) });
  const r = await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: new Date('2026-10-10T00:00:00Z'), fetchImpl: at.fetchImpl });
  assert.equal(r.reason, 'ended');
  const f = at.rows.get('recFFFFFFFFFFFFF2').fields;
  assert.equal(f['有効期限'], '2026-11-03');
  assert.deepEqual(canView(f, '2026-10-20T00:00:00Z'), { jra: true, nankan: true }, '解約後も支払い済み期間中は見られる');
  assert.deepEqual(canView(f, '2026-11-02T02:59:00Z'), { jra: true, nankan: true }, '支払い済みの終わりの直前まで見られる');
  assert.deepEqual(canView(f, '2026-11-03T00:00:00Z'), { jra: false, nankan: false }, '支払い済み期間の後は閉じる');
});

test('更新日に決済が失敗したら延ばさない（支払い前に次の期間へ進んでも無料で 1 か月見せない）', async () => {
  const DEC = Math.floor(at_('2026-12-02T03:00:00Z') / 1000);
  const at = fakeAirtable([{ id: 'recFFFFFFFFFFFFF3', fields: { Email: 'buyer@example.com', StripeSubscriptionId: 'sub_1', 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', PaymentMethod: 'Stripe', '有効期限': '2026-11-04' } }]);
  // 購読は 12/02 の期間へ進んだが、支払い済みは 11/02 まで
  const s = subObj({ items: { data: [{ price: { id: 'price_full' }, current_period_end: DEC }] } });
  const unpaid = fakeStripe({ sub_1: s }, undefined, { sub_1: PERIOD_END });
  await applySubscription({ stripe: unpaid, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(at.rows.get('recFFFFFFFFFFFFF3').fields['有効期限'], '2026-11-04', '未払いで延ばした');
  // past_due になっても書かない
  await applySubscription({ stripe: fakeStripe({ sub_1: { ...s, status: 'past_due' } }, undefined, { sub_1: PERIOD_END }), env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(at.rows.get('recFFFFFFFFFFFFF3').fields['有効期限'], '2026-11-04');
  // 再試行で支払われたら延びる
  await applySubscription({ stripe: fakeStripe({ sub_1: s }), env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(at.rows.get('recFFFFFFFFFFFFF3').fields['有効期限'], '2026-12-04');
});

test('初回決済の処理中（支払い済みの請求書なし）は権限を付けない', async () => {
  const at = fakeAirtable([{ id: 'recFFFFFFFFFFFFF4', fields: { Email: 'buyer@example.com', 'プラン': 'Free' } }]);
  const r = await applySubscription({ stripe: fakeStripe({ sub_1: subObj() }, undefined, { sub_1: null }), env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(r.reason, 'awaiting_payment');
  assert.equal(at.rows.get('recFFFFFFFFFFFFF4').fields['プラン'], 'Free');
});

test('各プラン: 契約中は契約した会場だけ・期間末の後はどの会場も閉じる', async () => {
  const PRICE = { 'premium': 'price_full', 'premium-jra': 'price_jra', 'premium-nankan': 'price_nankan' };
  const EXPECT = { 'premium': { jra: true, nankan: true }, 'premium-jra': { jra: true, nankan: false }, 'premium-nankan': { jra: false, nankan: true } };
  for (const plan of STRIPE_PLANS) {
    const at = fakeAirtable();
    const stripe = fakeStripe({ sub_1: subObj({ items: { data: [{ price: { id: PRICE[plan.id] }, current_period_end: PERIOD_END }] } }) });
    await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl, allowCreate: true });
    const f = [...at.rows.values()][0].fields;
    assert.deepEqual(canView(f, '2026-10-15T00:00:00Z'), EXPECT[plan.id], `${plan.id} 契約中`);
    // 解約（期間末）→ 期間後は閉じる
    stripe.subscriptions.retrieve = async () => subObj({ status: 'canceled', ended_at: PERIOD_END, items: { data: [{ price: { id: PRICE[plan.id] }, current_period_end: PERIOD_END }] } });
    await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: new Date('2026-11-02T03:00:00Z'), fetchImpl: at.fetchImpl });
    const g = [...at.rows.values()][0].fields;
    assert.deepEqual(canView(g, '2026-11-02T02:00:00Z'), EXPECT[plan.id], `${plan.id} 期間末の直前まで`);
    assert.deepEqual(canView(g, '2026-11-04T00:00:00Z'), { jra: false, nankan: false }, `${plan.id} 期間後`);
  }
});

test('Webhook 冪等: 同じ購読のイベントを何度処理してもレコードは同じ・通知 1 回・作成 1 件', async () => {
  const at = fakeAirtable();
  const stripe = fakeStripe({ sub_1: subObj({ items: { data: [{ price: { id: 'price_jra' }, current_period_end: PERIOD_END }] } }) });
  const notes = [];
  const notify = async (k) => notes.push(k);
  await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl, notify, allowCreate: true });
  const first = JSON.stringify([...at.rows.values()][0].fields);
  for (const allowCreate of [true, false, true, false]) {
    await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl, notify, allowCreate });
  }
  assert.equal(at.rows.size, 1);
  assert.equal(JSON.stringify([...at.rows.values()][0].fields), first);
  assert.deepEqual(notes, ['attached']);
});

test('他会員に影響しない: 対象以外のレコードは 1 バイトも変わらない', async () => {
  const others = [
    { id: 'recOTHERAAAAAAAA1', fields: { Email: 'other1@example.com', 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2027-05-01' } },
    { id: 'recOTHERAAAAAAAA2', fields: { Email: 'other2@example.com', 'プラン': 'Light', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-10-20', VenueAccess: '' } },
    { id: 'recOTHERAAAAAAAA3', fields: { Email: 'other3@example.com', 'プラン': 'Premium', PlanType: 'Monthly', PaymentMethod: 'Stripe', StripeSubscriptionId: 'sub_other', '有効期限': '2026-10-30', VenueAccess: 'nankan' } },
  ];
  const before = JSON.stringify(others);
  const at = fakeAirtable([...others, { id: 'recTARGETAAAAAAA1', fields: { Email: 'buyer@example.com', 'プラン': 'Free' } }]);
  const stripe = fakeStripe({ sub_1: subObj({ items: { data: [{ price: { id: 'price_jra' }, current_period_end: PERIOD_END }] } }) });
  await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl, allowCreate: true });
  stripe.subscriptions.retrieve = async () => subObj({ status: 'canceled', ended_at: PERIOD_END });
  await applySubscription({ stripe, env: ENV, subscription: 'sub_1', now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(JSON.stringify(others.map((o) => ({ id: o.id, fields: at.rows.get(o.id).fields }))), before);
  assert.equal(at.rows.size, 4, 'レコードを増やしていない');
  assert.equal(at.rows.get('recTARGETAAAAAAA1').fields.VenueAccess, 'jra');
});
