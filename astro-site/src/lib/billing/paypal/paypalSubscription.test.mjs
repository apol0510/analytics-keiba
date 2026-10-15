/**
 * PayPal 月額（定期課金）を偽の PayPal API・Airtable・Redis で通しで確かめる。ネットワークに出ない。
 * 申込 → 承認 → 戻り先で反映 → Webhook 再送・同時 → 毎月の更新 → 退会（即時）→ 解約通知で収束 → 再契約。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRIPE_PLANS } from '../stripePlans.js';
import { PRODUCTION_ORIGIN } from '../cardSales.js';
import { hasBannedPaymentWord } from '../paymentDisplayNames.js';
import {
  PAYPAL_PLAN_IDS, buildPlanBody, buildSubscriptionBody, decidePaypalSubscriptionSync, decidePaypalSubscriptionPurchase,
  snapshotPaypalSubscription, parseSubscriptionWebhook, memberKey, MEMBER_WITHDRAWAL_NOTE, isPaypalSubscriber,
} from './paypalSubscriptionCore.js';
import {
  createPaypalSubscription, applyPaypalSubscription, confirmPaypalSubscription, withdrawPaypalSubscriber,
  handlePaypalSubscriptionEvent, resolvePaypalSubscriptionMode, resolvePaypalSubscriptionSettleMode,
} from './paypalSubscriptionServer.js';

const PREVIEW = 'https://deploy-preview-1--analytics-keiba.netlify.app';
const REC = 'recAAAAAAAAAAAAAA';
const ENV = { PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_ENV: 'sandbox', PAYPAL_WEBHOOK_ID: 'WH-1', AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX' };
const NOW = new Date('2026-10-15T03:00:00Z'); // JST 12:00
const PID = PAYPAL_PLAN_IDS.test;

function world({ fields = { 'プラン': 'Free', Email: 'a+card-e2e@example.com' } } = {}) {
  const st = { fields: { ...fields }, subs: {}, patches: [], redis: new Map(), notes: [], cancels: [], creates: 0 };
  const res = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body });
  st.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'api.airtable.com') {
      if (init.method === 'PATCH') {
        if (st.failPatch) { st.failPatch = false; return res(500, { error: 'x' }); }
        const f = JSON.parse(init.body).fields; st.patches.push(f); Object.assign(st.fields, f);
      }
      return res(200, { id: REC, fields: st.fields });
    }
    if (u.pathname === '/v1/oauth2/token') return res(200, { access_token: 'tok' });
    if (u.pathname === '/v1/billing/subscriptions' && init.method === 'POST') {
      const b = JSON.parse(init.body);
      st.creates += 1;
      const id = `I-TESTSUB${String(st.creates).padStart(6, '0')}`;
      st.subs[id] = { id, status: 'APPROVAL_PENDING', plan_id: b.plan_id, custom_id: b.custom_id, body: b, links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${id}` }] };
      return res(201, st.subs[id]);
    }
    const m = u.pathname.match(/^\/v1\/billing\/subscriptions\/(I-[A-Z0-9]+)(\/cancel)?$/);
    if (m) {
      const s = st.subs[m[1]];
      if (!s) return res(404, { name: 'RESOURCE_NOT_FOUND' });
      if (m[2]) { st.cancels.push(m[1]); s.status = 'CANCELLED'; s.status_change_note = JSON.parse(init.body).reason; return res(204); }
      return res(200, s);
    }
    const sale = u.pathname.match(/^\/v1\/payments\/sale\/(\w+)$/);
    if (sale) return res(200, { id: sale[1], billing_agreement_id: st.saleSub });
    throw new Error(`unexpected ${url}`);
  };
  st.redisCmd = async ([cmd, key, val, ...rest]) => {
    if (cmd === 'GET') return st.redis.get(key) ?? null;
    if (cmd === 'SET') { if (rest.includes('NX') && st.redis.has(key)) return null; st.redis.set(key, val); return 'OK'; }
    if (cmd === 'DEL') { st.redis.delete(key); return 1; }
    throw new Error(cmd);
  };
  st.notify = async (kind, d) => { st.notes.push([kind, d.reason || '']); };
  /** PayPal で買い手が承認し、初回の支払いが済んだ状態にする */
  st.pay = (id, time = NOW, amount) => {
    const s = st.subs[id];
    const plan = STRIPE_PLANS.find((p) => PID[p.id] === s.plan_id);
    s.status = 'ACTIVE';
    s.billing_info = { last_payment: { amount: { currency_code: 'JPY', value: String(amount ?? plan.amountYen) }, time: time.toISOString() } };
  };
  return st;
}
const common = (w) => ({ env: ENV, origin: PREVIEW, redis: w.redisCmd, notify: w.notify, fetchImpl: w.fetch, now: NOW });

test('商品: 既存の月額 3 プランと同じ金額・名前は禁止語なし・毎月無期限・JPY 小数なし', () => {
  assert.deepEqual(STRIPE_PLANS.map((p) => [p.id, p.amountYen]), [['premium', 4980], ['premium-jra', 2980], ['premium-nankan', 2980]]);
  for (const p of STRIPE_PLANS) {
    const b = buildPlanBody({ productId: 'PROD-1', plan: p });
    assert.equal(hasBannedPaymentWord(b.name), false);
    assert.deepEqual(b.billing_cycles[0].frequency, { interval_unit: 'MONTH', interval_count: 1 });
    assert.equal(b.billing_cycles[0].total_cycles, 0);
    assert.deepEqual(b.billing_cycles[0].pricing_scheme.fixed_price, { value: String(p.amountYen), currency_code: 'JPY' });
    assert.ok(PID[p.id], `${p.id} の Sandbox Plan ID`);
  }
  const body = buildSubscriptionBody({ planId: 'premium-jra', recordId: REC, origin: PREVIEW, mode: 'test' });
  assert.equal(body.custom_id, `${REC}:premium-jra`);
  assert.equal(body.plan_id, PID['premium-jra']);
  assert.equal(body.application_context.return_url, `${PREVIEW}/checkout/paypal-subscription-return/`);
  assert.throws(() => buildSubscriptionBody({ planId: 'premium', recordId: REC, origin: PREVIEW, mode: 'live', ids: { ...PAYPAL_PLAN_IDS, live: {} } }), /plan_not_configured/, 'live の Plan 未作成なら作らない');
  // Live の Plan（2026-10-15 作成）: 3 プランとも登録済み・Sandbox と混ざらない
  for (const p of STRIPE_PLANS) {
    assert.match(PAYPAL_PLAN_IDS.live[p.id] || '', /^P-[A-Z0-9]+$/, `${p.id} の Live Plan ID`);
    assert.notEqual(PAYPAL_PLAN_IDS.live[p.id], PID[p.id]);
  }
  assert.equal(buildSubscriptionBody({ planId: 'premium', recordId: REC, origin: PRODUCTION_ORIGIN, mode: 'live' }).plan_id, PAYPAL_PLAN_IDS.live.premium);
});

test('本番: 月額の販売を開くまで受け付けない（Sandbox 鍵も拒否）・既存契約の反映は鍵とサイトが合えば続ける', () => {
  assert.equal(resolvePaypalSubscriptionMode({ env: { ...ENV, PAYPAL_ENV: 'live' }, origin: PRODUCTION_ORIGIN }).reason, 'card_sales_not_open');
  assert.equal(resolvePaypalSubscriptionMode({ env: ENV, origin: PRODUCTION_ORIGIN }).reason, 'test_key_on_production');
  assert.equal(resolvePaypalSubscriptionMode({ env: {}, origin: PRODUCTION_ORIGIN }).reason, 'paypal_key_missing');
  assert.equal(resolvePaypalSubscriptionSettleMode({ env: { ...ENV, PAYPAL_ENV: 'live' }, origin: PRODUCTION_ORIGIN }).mode, 'live');
  assert.equal(resolvePaypalSubscriptionSettleMode({ env: ENV, origin: PRODUCTION_ORIGIN }).ok, false);
  assert.equal(resolvePaypalSubscriptionMode({ env: { ...ENV, PAYPAL_ENV: 'live' }, origin: PREVIEW }).reason, 'live_key_outside_production');
});

test('通しで: 申込 → 承認 → 戻り先で付与（支払い日 +1 ヶ月 +2 日）→ Webhook 再送・同時は同じ結果', async () => {
  const w = world();
  const c = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium' });
  assert.equal(c.ok, true);
  assert.match(c.url, /^https:\/\/www\.sandbox\.paypal\.com\//);
  // 承認前（APPROVAL_PENDING）は何も書かない
  assert.equal((await confirmPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId, recordId: REC })).body.status, 'pending');
  assert.equal(w.patches.length, 0);
  w.pay(c.subscriptionId);
  const r = await confirmPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId, recordId: REC });
  assert.deepEqual(r.body, { status: 'active', plan: 'premium' });
  assert.equal(w.fields['プラン'], 'Premium');
  assert.equal(w.fields.PlanType, 'Monthly');
  assert.equal(w.fields.PaymentMethod, 'PayPal');
  assert.equal(w.fields.VenueAccess, '');
  assert.equal(w.fields['有効期限'], '2026-11-17');
  assert.equal(w.redis.get(memberKey(REC)), c.subscriptionId);
  assert.deepEqual(w.notes.map((n) => n[0]), ['subscription_attached']);
  // 再送・同時着信: 何回来ても同じ値（新規の通知は 1 回だけ・PaidAt は 1 回だけ）
  await Promise.all([1, 2, 3].map(() => handlePaypalSubscriptionEvent({ ...common(w), event: { event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: c.subscriptionId } } })));
  assert.equal(w.fields['有効期限'], '2026-11-17');
  assert.equal(w.notes.filter((n) => n[0] === 'subscription_attached').length, 1);
  assert.equal(w.patches.filter((p) => p.PaidAt).length, 1);
  // 本人以外のログインでは状態を見せない
  assert.equal((await confirmPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId, recordId: 'recBBBBBBBBBBBBBB' })).status, 404);
});

test('毎月の更新: 支払いが来たら延びる・支払いが来なければ延びない（next_billing_time は見ない）', async () => {
  const w = world();
  const c = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium-nankan' });
  w.pay(c.subscriptionId);
  await applyPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId });
  assert.equal(w.fields.VenueAccess, 'nankan');
  assert.equal(w.fields['有効期限'], '2026-11-17');
  // 決済失敗（ACTIVE のまま next_billing_time だけ進む）→ 延びない
  w.subs[c.subscriptionId].billing_info.next_billing_time = '2026-12-15T10:00:00Z';
  await handlePaypalSubscriptionEvent({ ...common(w), event: { event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED', resource: { id: c.subscriptionId } } });
  assert.equal(w.fields['有効期限'], '2026-11-17');
  // 翌月の支払い（PAYMENT.SALE.COMPLETED）→ 延びる
  w.pay(c.subscriptionId, new Date('2026-11-15T03:00:00Z'));
  const r = await handlePaypalSubscriptionEvent({ ...common(w), event: { event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'SALE1', billing_agreement_id: c.subscriptionId } } });
  assert.equal(r.result, 'write_renewed');
  assert.equal(w.fields['有効期限'], '2026-12-17');
  // SUSPENDED（決済失敗の上限）は書かない＝期限で自然に止まる
  w.subs[c.subscriptionId].status = 'SUSPENDED';
  assert.equal((await applyPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId })).reason, 'status_suspended');
});

test('退会: 即時（期限を昨日へ・退会フラグ）・PayPal の購読を印付きで cancel・二重退会は 409 相当', async () => {
  const w = world();
  const c = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium' });
  w.pay(c.subscriptionId);
  await applyPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId });
  assert.equal(isPaypalSubscriber(w.fields), true);
  const r = await withdrawPaypalSubscriber({ ...common(w), recordId: REC, reason: 'test' });
  assert.equal(r.result, 'withdrawn');
  assert.deepEqual(w.cancels, [c.subscriptionId]);
  assert.equal(w.subs[c.subscriptionId].status_change_note, MEMBER_WITHDRAWAL_NOTE);
  assert.equal(w.fields.WithdrawalRequested, true);
  assert.equal(w.fields['有効期限'], '2026-10-14');
  assert.equal((await withdrawPaypalSubscriber({ ...common(w), recordId: REC })).result, 'already_withdrawn');
  // 後から届く解約通知は同じ退会状態のまま（期限を延ばさない）
  await handlePaypalSubscriptionEvent({ ...common(w), event: { event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: c.subscriptionId } } });
  assert.equal(w.fields['有効期限'], '2026-10-14');
  // 再契約は新規: 退会フラグが戻る
  const c2 = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium' });
  assert.equal(c2.ok, true);
  w.pay(c2.subscriptionId);
  await applyPaypalSubscription({ ...common(w), subscriptionId: c2.subscriptionId });
  assert.equal(w.fields.WithdrawalRequested, false);
  assert.equal(w.fields['有効期限'], '2026-11-17');
  assert.equal(w.redis.get(memberKey(REC)), c2.subscriptionId);
});

test('退会: cancel 後に Customers の書込みが失敗しても、解約通知の印で同じ退会状態へ収束する', async () => {
  const w = world();
  const c = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium' });
  w.pay(c.subscriptionId);
  await applyPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId });
  w.failPatch = true;
  assert.equal((await withdrawPaypalSubscriber({ ...common(w), recordId: REC })).result, 'record_write_failed');
  assert.equal(w.fields['有効期限'], '2026-11-17');
  await handlePaypalSubscriptionEvent({ ...common(w), event: { event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: c.subscriptionId } } });
  assert.equal(w.fields.WithdrawalRequested, true);
  assert.equal(w.fields['有効期限'], '2026-10-14');
});

test('退会以外の終了（管理者の解約）: 支払い済みの最終日の翌日まで見られる（縮めるだけ）', async () => {
  const w = world();
  const c = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium' });
  w.pay(c.subscriptionId);
  await applyPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId });
  Object.assign(w.subs[c.subscriptionId], { status: 'CANCELLED', status_change_note: 'admin' });
  await handlePaypalSubscriptionEvent({ ...common(w), event: { event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: c.subscriptionId } } });
  assert.equal(w.fields['有効期限'], '2026-11-16');
  assert.equal(w.fields.WithdrawalRequested, false, '退会扱いにしない');
});

test('二重課金を作らない: 契約中の PayPal・Stripe 月額・買い切り・期間の長い銀行振込 Premium は申込前に 409', async () => {
  const w = world();
  const c = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium' });
  w.pay(c.subscriptionId);
  await applyPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId });
  assert.equal((await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium-jra' })).code, 'already_subscribed');
  const stripe = { 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', PaymentMethod: 'Stripe', StripeSubscriptionId: 'sub_1', '有効期限': '2026-11-01' };
  assert.equal(decidePaypalSubscriptionPurchase({ planId: 'premium', fields: stripe, now: NOW }).code, 'already_subscribed');
  assert.equal(decidePaypalSubscriptionPurchase({ planId: 'premium', fields: { 'プラン': 'Premium', PlanType: 'Lifetime', Status: 'active' }, now: NOW }).code, 'already_premium');
  assert.equal(decidePaypalSubscriptionPurchase({ planId: 'premium', fields: { 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2027-06-01' }, now: NOW }).code, 'already_premium');
  assert.equal(decidePaypalSubscriptionPurchase({ planId: 'premium', fields: { 'プラン': 'Light', Status: 'active', '有効期限': '2026-11-30' }, now: NOW }).ok, true, 'Light 会員は申込める');
  assert.equal(decidePaypalSubscriptionPurchase({ planId: 'nope', fields: {}, now: NOW }).code, 'invalid_plan');
});

test('二重契約が成立してしまったら権限は書かず管理者へ（承認待ちのまま別タブで承認された等）', async () => {
  const w = world();
  const a = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium' });
  const b = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium-jra' });
  w.pay(a.subscriptionId);
  await applyPaypalSubscription({ ...common(w), subscriptionId: a.subscriptionId });
  w.pay(b.subscriptionId);
  const r = await applyPaypalSubscription({ ...common(w), subscriptionId: b.subscriptionId });
  assert.equal(r.reason, 'duplicate_subscription');
  assert.equal(w.fields.VenueAccess, '');
  assert.equal(w.redis.get(memberKey(REC)), a.subscriptionId);
  assert.ok(w.notes.some((n) => n[0] === 'subscription_conflict' && n[1] === 'duplicate_subscription'));
});

test('照会結果が合わなければ書かない: 金額・登録外の Plan・custom_id の商品違い', () => {
  const base = { id: 'I-TESTSUB000001', status: 'ACTIVE', paypalPlanId: PID.premium, recordId: REC, planId: 'premium', lastPayment: { currency: 'JPY', amount: 4980, time: NOW } };
  assert.equal(decidePaypalSubscriptionSync({ sub: base, mode: 'test', now: NOW }).action, 'write');
  assert.equal(decidePaypalSubscriptionSync({ sub: { ...base, lastPayment: { ...base.lastPayment, amount: 100 } }, mode: 'test', now: NOW }).reason, 'amount_mismatch');
  assert.equal(decidePaypalSubscriptionSync({ sub: { ...base, paypalPlanId: 'P-OTHER' }, mode: 'test', now: NOW }).reason, 'unknown_plan');
  assert.equal(decidePaypalSubscriptionSync({ sub: { ...base, planId: 'premium-jra' }, mode: 'test', now: NOW }).reason, 'plan_mismatch');
  assert.equal(decidePaypalSubscriptionSync({ sub: { ...base, lastPayment: null }, mode: 'test', now: NOW }).reason, 'awaiting_payment');
  assert.equal(decidePaypalSubscriptionSync({ sub: base, mode: 'live', now: NOW }).reason, 'unknown_plan', 'Sandbox の Plan は本番で通らない');
  // custom_id の会員 ID が壊れていれば会員を決めない
  assert.equal(snapshotPaypalSubscription({ id: 'I-X', custom_id: 'bad:premium' }).recordId, null);
});

test('Webhook: 購読・売上のイベントだけを拾う。返金は自動で権限を戻さず管理者へ', async () => {
  assert.equal(parseSubscriptionWebhook({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'X' } }), null, '一回払いは一回払いの処理へ');
  assert.deepEqual(parseSubscriptionWebhook({ event_type: 'PAYMENT.SALE.REFUNDED', resource: { sale_id: 'S1' } }), { eventType: 'PAYMENT.SALE.REFUNDED', saleId: 'S1', refund: true });
  const w = world();
  const c = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium' });
  w.pay(c.subscriptionId);
  await applyPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId });
  w.saleSub = c.subscriptionId;
  const before = { ...w.fields };
  const r = await handlePaypalSubscriptionEvent({ ...common(w), event: { event_type: 'PAYMENT.SALE.REFUNDED', resource: { sale_id: 'S1' } } });
  assert.equal(r.result, 'refund_notified');
  assert.deepEqual(w.fields, before);
  assert.ok(w.notes.some((n) => n[0] === 'subscription_refunded'));
});
