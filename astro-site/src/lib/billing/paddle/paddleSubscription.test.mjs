/**
 * Paddle の定期課金（月額 3・年額 2・2026-11-02 MK 確定）を偽の Paddle API・Airtable・Redis で通しで確かめる。ネットワークに出ない。
 * 申込（ログイン済み・未ログイン・二重クリック）→ 支払い → 通知（重複・順不同・支払い時点で購読 ID なし）→ 戻り先 → 更新（成功・失敗）
 * → 退会（即時・解約失敗）→ Paddle 側の解約 → 返金 → 別会員への誤付与防止 → 既存 PayPal 契約者 → 切替後の PayPal 新規拒否 → 委譲（本番↔中立サイト）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTION_ORIGIN, subscriptionProviderGate, SUBSCRIPTION_SALES_OPEN } from '../cardSales.js';
import { SUBSCRIPTION_PLAN_NAMES, PAYPAL_PLAN_NAMES, hasBannedPaymentWord } from '../paymentDisplayNames.js';
import { signTsBody, parsePaddleWebhook, verifyPaddleSignature } from './paddleCore.js';
import {
  buildSubscriptionTransactionBody, snapshotPaddleSubscription, decidePaddleSubscriptionSync, decidePaddleSubscriptionPurchase,
  expirationFromPeriodEnd, memberKey, withdrawalMarkKey, checkoutMarkKey, txnResultKey, isPaddleSubscriber, hasLivePaypalSubscription,
  SUBSCRIPTION_PLANS, PADDLE_PLAN_CODES,
} from './paddleSubscriptionCore.js';
import {
  createPaddleSubscriptionCheckout, applyPaddleSubscription, confirmPaddleSubscription, withdrawPaddleSubscriber,
  resolvePaddleSubscriptionMode, resolvePaddleSubscriptionSettleMode, openCheckoutKey,
} from './paddleSubscriptionServer.js';
import { handlePaddleEvent, decidePaddleGrant, applyPaddleGrant } from './paddleServer.js';
import { resolvePaypalSubscriptionMode, resolvePaypalSubscriptionSettleMode } from '../paypal/paypalSubscriptionServer.js';
import { issueReturnToken, verifyReturnToken } from '../paypal/subscriptionReturnToken.js';
import { classifyMemberWithdrawal } from '../memberWithdrawal.js';
import { handleCreateCheckout } from '../../../../../ops/checkout-site/netlify/functions/paddle-create-checkout.mjs';
import { handleCancel } from '../../../../../ops/checkout-site/netlify/functions/paddle-subscription-cancel.mjs';

const PREVIEW = 'https://deploy-preview-1--analytics-keiba.netlify.app';
const REC = 'recAAAAAAAAAAAAAA';
const OTHER = 'recBBBBBBBBBBBBBB';
const ENV = { PADDLE_API_KEY: 'pdl_sdbx_apikey_test0000', AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX' };
const NOW = new Date('2026-11-02T03:00:00Z'); // JST 12:00
const addMonth = (iso, n) => { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString(); };

function world({ fields = { 'プラン': 'Free', Email: 'a+card-e2e@example.com' }, origin = PREVIEW, records } = {}) {
  const st = { records: records || { [REC]: { ...fields } }, txns: {}, subs: {}, adjs: {}, patches: [], creates: [], redis: new Map(), notes: [], cancels: [], n: 0, failCancel: false };
  const res = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body });
  st.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'api.airtable.com') {
      const id = u.pathname.split('/').pop();
      if (init.method === 'POST') {
        const nid = `recNEW${String(++st.n).padStart(11, '0')}`;
        st.records[nid] = { ...JSON.parse(init.body).records[0].fields };
        return res(200, { records: [{ id: nid, fields: st.records[nid] }] });
      }
      if (!u.pathname.match(/\/rec[A-Za-z0-9]{14}$/)) {
        // 一覧（メールで探す）
        const email = String(u.searchParams.get('filterByFormula') || '').match(/["']([^"']+@[^"']+)["']/)?.[1];
        const hits = Object.entries(st.records).filter(([, f]) => String(f.Email || '').toLowerCase() === String(email || '').toLowerCase());
        return res(200, { records: hits.map(([rid, f]) => ({ id: rid, fields: f })) });
      }
      if (!st.records[id]) return res(404, { error: 'NOT_FOUND' });
      if (init.method === 'PATCH') {
        const f = JSON.parse(init.body).fields; st.patches.push([id, f]); Object.assign(st.records[id], f);
      }
      return res(200, { id, fields: st.records[id] });
    }
    assert.ok(/sandbox-api\.paddle\.com|api\.paddle\.com/.test(u.host), `unexpected ${url}`);
    if (u.pathname === '/transactions' && init.method === 'POST') {
      const b = JSON.parse(init.body);
      const id = `txn_test${String(++st.n).padStart(10, '0')}`;
      st.creates.push(b);
      const page = origin === PRODUCTION_ORIGIN ? 'https://checkout.tirol.link/pay/' : `${origin}/checkout/paddle/`;
      st.txns[id] = { id, status: 'ready', origin: 'api', custom_data: b.custom_data, items: b.items, currency_code: 'JPY', subscription_id: null, details: { totals: { grand_total: b.items[0].price.unit_price.amount } }, checkout: { url: `${page}?_ptxn=${id}` } };
      return res(201, { data: st.txns[id] });
    }
    let m = u.pathname.match(/^\/transactions\/(txn_\w+)$/);
    if (m) return st.txns[m[1]] ? res(200, { data: st.txns[m[1]] }) : res(404, { error: { code: 'not_found' } });
    m = u.pathname.match(/^\/subscriptions\/(sub_\w+)(\/cancel)?$/);
    if (m) {
      const s = st.subs[m[1]];
      if (!s) return res(404, { error: { code: 'not_found' } });
      if (m[2]) {
        st.cancels.push(m[1]);
        if (st.failCancel) return res(500, { error: { code: 'internal_error' } });
        s.status = 'canceled'; s.canceled_at = NOW.toISOString(); s.current_billing_period = null;
        return res(200, { data: s });
      }
      return res(200, { data: s });
    }
    if (u.pathname === '/adjustments') return res(200, { data: Object.values(st.adjs).filter((a) => a.id === u.searchParams.get('id')) });
    throw new Error(`unexpected ${url}`);
  };
  st.redisCmd = async ([cmd, key, val, ...rest]) => {
    if (cmd === 'GET') return st.redis.get(key) ?? null;
    if (cmd === 'SET') { if (rest.includes('NX') && st.redis.has(key)) return null; st.redis.set(key, val); return 'OK'; }
    if (cmd === 'DEL') { st.redis.delete(key); return 1; }
    if (cmd === 'GETDEL') { const v = st.redis.get(key) ?? null; st.redis.delete(key); return v; }
    throw new Error(cmd);
  };
  st.notify = async (kind, d) => { st.notes.push([kind, d.reason || '']); };
  /** 買い手が決済画面で支払った（Paddle が購読を作る）。startsAt から 1 期間 */
  st.pay = (txnId, { startsAt = NOW.toISOString(), amount } = {}) => {
    const t = st.txns[txnId];
    const price = t.items[0].price;
    const sid = `sub_test${txnId.slice(8)}`;
    const months = price.billing_cycle.interval === 'year' ? 12 : 1;
    st.subs[sid] = {
      id: sid, status: 'active', custom_data: { ...t.custom_data }, currency_code: 'JPY',
      items: [{ quantity: 1, price: { ...price, unit_price: { ...price.unit_price, amount: String(amount ?? price.unit_price.amount) } } }],
      current_billing_period: { starts_at: startsAt, ends_at: addMonth(startsAt, months) }, scheduled_change: null, canceled_at: null,
    };
    t.status = 'completed'; t.subscription_id = sid; t.billed_at = startsAt;
    return sid;
  };
  /** 更新: 期間を進めて新しい取引（subscription_recurring）を作る。ok=false は支払い失敗（past_due）*/
  st.renew = (sid, { ok = true } = {}) => {
    const s = st.subs[sid];
    const starts = s.current_billing_period.ends_at;
    const months = s.items[0].price.billing_cycle.interval === 'year' ? 12 : 1;
    s.current_billing_period = { starts_at: starts, ends_at: addMonth(starts, months) };
    s.status = ok ? 'active' : 'past_due';
    const id = `txn_renew${String(++st.n).padStart(9, '0')}`;
    st.txns[id] = { id, status: ok ? 'completed' : 'past_due', origin: 'subscription_recurring', custom_data: { ...s.custom_data }, subscription_id: sid, currency_code: 'JPY', details: { totals: { grand_total: s.items[0].price.unit_price.amount } } };
    return id;
  };
  st.event = (eventType, data) => parsePaddleWebhook({ event_type: eventType, data });
  st.handle = (parsed, now = NOW) => handlePaddleEvent({ env: ENV, origin, parsed, redis: st.redisCmd, notify: st.notify, fetchImpl: st.fetch, now });
  st.f = (id = REC) => st.records[id];
  return st;
}
const checkout = (w, over = {}) => createPaddleSubscriptionCheckout({ env: ENV, origin: PREVIEW, recordId: REC, planId: 'premium', entry: 'monthly', redis: w.redisCmd, fetchImpl: w.fetch, now: NOW, ...over });

test('商品: 月額 3・年額 2 は既存の金額と請求周期・名前は許可リストだけ（PayPal と同じ）・custom_data は会員 ID と商品コードだけ・買い切りは作らない', () => {
  assert.deepEqual(SUBSCRIPTION_PLANS.map((p) => [p.id, p.amountYen, p.interval]), [
    ['premium', 4980, 'MONTH'], ['premium-jra', 2980, 'MONTH'], ['premium-nankan', 2980, 'MONTH'], ['premium-annual', 49800, 'YEAR'], ['premium-annual-light', 44820, 'YEAR'],
  ]);
  assert.equal(SUBSCRIPTION_PLAN_NAMES, PAYPAL_PLAN_NAMES);
  for (const p of SUBSCRIPTION_PLANS) {
    const b = buildSubscriptionTransactionBody({ planId: p.id, recordId: REC });
    const price = b.items[0].price;
    assert.equal(price.name, SUBSCRIPTION_PLAN_NAMES[p.id]);
    assert.equal(price.product.name, SUBSCRIPTION_PLAN_NAMES[p.id]);
    assert.equal(price.description, SUBSCRIPTION_PLAN_NAMES[p.id]);
    assert.equal(hasBannedPaymentWord(JSON.stringify(b)), false);
    assert.deepEqual(price.unit_price, { amount: String(p.amountYen), currency_code: 'JPY' });
    assert.deepEqual(price.billing_cycle, { interval: p.interval === 'YEAR' ? 'year' : 'month', frequency: 1 });
    assert.equal(price.tax_mode, 'internal');
    assert.equal(price.trial_period, undefined, '無料期間なし');
    assert.deepEqual(b.custom_data, { ak_record: REC, ak_sub: PADDLE_PLAN_CODES[p.id] });
    assert.equal(b.custom_data.ak_product, undefined, '一回払いの付与経路（ak_product）に入らない');
    assert.equal(b.checkout, undefined, 'checkout.url は送らない（承認ドメインの Default payment link）');
  }
  assert.throws(() => buildSubscriptionTransactionBody({ planId: 'premium-lifetime', recordId: REC }), /lifetime_bank_transfer_only/);
  assert.throws(() => buildSubscriptionTransactionBody({ planId: 'premium-x', recordId: REC }), /invalid_plan/);
  assert.throws(() => buildSubscriptionTransactionBody({ planId: 'premium', recordId: 'bad' }), /invalid_record/);
});

test('Light 特典の資格: 資格のない会員は申込前に not_eligible（年額 ¥44,820 を作らない）・通常の年額は作れる', async () => {
  const w = world();
  assert.deepEqual(await checkout(w, { planId: 'premium-annual-light' }), { ok: false, status: 409, code: 'not_eligible' });
  assert.equal(w.creates.length, 0);
  const r = await checkout(w, { planId: 'premium-annual' });
  assert.equal(r.ok, true);
  assert.equal(w.creates[0].items[0].price.unit_price.amount, '49800');
  assert.equal(decidePaddleSubscriptionPurchase({ planId: 'premium-annual-light', fields: { 'プラン': 'Light', Status: 'active', PlanType: 'Monthly', '有効期限': '2026-12-01' }, now: NOW }).ok,
    decidePaddleSubscriptionPurchase({ planId: 'premium-annual-light', fields: { 'プラン': 'Light', Status: 'active', PlanType: 'Monthly', '有効期限': '2026-12-01' }, now: NOW }).ok, '判定は決定的');
});

test('ログイン済みの購入: 申込 → 戻り先は確認中 → 通知（支払い時点で購読 ID なし → 完了）で反映 → 戻り先は active と行き先', async () => {
  const w = world();
  const r = await checkout(w, { planId: 'premium-jra' });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'paddle');
  assert.match(r.url, /\/checkout\/paddle\/\?_ptxn=txn_\w+&ak=s$/, '定期課金の印つき（決済ページが定期課金の戻り先へ送る）');
  const txn = r.subscriptionId;
  assert.deepEqual(JSON.parse(w.redis.get(checkoutMarkKey(txn))), { recordId: REC, planId: 'premium-jra' });
  // 支払い前: 確認中（Premium へ移さない）
  assert.deepEqual((await confirmPaddleSubscription({ transactionId: txn, recordId: REC, redis: w.redisCmd })).body, { status: 'pending', plan: 'premium-jra' });
  // 支払い済み・購読 ID がまだ無い transaction.paid は何もしない（後続の通知で反映）
  w.txns[txn].status = 'paid';
  assert.equal((await w.handle(w.event('transaction.paid', { id: txn }))).result, 'awaiting_subscription');
  assert.equal(w.patches.length, 0);
  const sid = w.pay(txn);
  const out = await w.handle(w.event('transaction.completed', { id: txn }));
  assert.equal(out.result, 'write_attached');
  assert.deepEqual({ ...w.f(), Email: undefined, PaidAt: undefined }, {
    'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-12-04', VenueAccess: 'jra', PaymentMethod: 'Paddle',
    CancelledAt: null, WithdrawalRequested: false, WithdrawalDate: null, WithdrawalReason: null, Email: undefined, PaidAt: undefined,
    ...Object.fromEntries(Object.entries(w.f()).filter(([k]) => !['プラン', 'PlanType', 'Status', '有効期限', 'VenueAccess', 'PaymentMethod', 'CancelledAt', 'WithdrawalRequested', 'WithdrawalDate', 'WithdrawalReason', 'Email', 'PaidAt'].includes(k))),
  });
  assert.equal(w.redis.get(memberKey(REC)), sid);
  assert.deepEqual((await confirmPaddleSubscription({ transactionId: txn, recordId: REC, redis: w.redisCmd })).body, { status: 'active', plan: 'premium-jra', destination: '/premium-prediction/jra/' });
  assert.ok(w.redis.get(`ak:paypal:post-purchase:v1:${REC}`), '購入直後の印（ログイン後の自動遷移・PayPal と共通）');
  assert.deepEqual(w.notes.map((n) => n[0]), ['subscription_attached']);
});

test('未ログインの購入: 入力メールで会員を作り（二重作成なし）・申込の鍵は取引 ID に結び付く・URL だけ／別会員は見られない', async () => {
  const w = world({ records: {} });
  const r = await createPaddleSubscriptionCheckout({ env: ENV, origin: PREVIEW, recordId: null, email: 'New@Example.com', planId: 'premium', entry: 'monthly', redis: w.redisCmd, fetchImpl: w.fetch, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.guest, true);
  assert.equal(Object.keys(w.records).length, 1);
  const rid = r.recordId;
  assert.equal(w.records[rid].Email, 'new@example.com');
  assert.deepEqual(await createPaddleSubscriptionCheckout({ env: ENV, origin: PREVIEW, recordId: null, email: '', planId: 'premium', entry: 'monthly', redis: w.redisCmd, fetchImpl: w.fetch, now: NOW }), { ok: false, status: 400, code: 'email_required' });
  // 申込の鍵（HttpOnly Cookie）は取引 ID に署名して発行できる
  const secret = 'x'.repeat(64);
  const tok = issueReturnToken({ secret, subscriptionId: r.subscriptionId, recordId: rid, now: NOW.getTime() });
  assert.ok(tok);
  assert.deepEqual(verifyReturnToken({ secret, token: tok, subscriptionId: r.subscriptionId, now: NOW.getTime() }), { ok: true, recordId: rid });
  assert.equal(verifyReturnToken({ secret, token: tok, subscriptionId: 'txn_other00000000', now: NOW.getTime() }).ok, false);
  w.pay(r.subscriptionId);
  await w.handle(w.event('transaction.completed', { id: r.subscriptionId }));
  assert.equal((await confirmPaddleSubscription({ transactionId: r.subscriptionId, recordId: rid, redis: w.redisCmd })).body.status, 'active');
  assert.equal((await confirmPaddleSubscription({ transactionId: r.subscriptionId, recordId: OTHER, redis: w.redisCmd })).status, 404, '別会員');
  assert.equal((await confirmPaddleSubscription({ transactionId: r.subscriptionId, recordId: null, redis: w.redisCmd })).status, 404, '鍵なし');
  assert.equal((await confirmPaddleSubscription({ transactionId: 'bad', recordId: rid, redis: w.redisCmd })).status, 400);
});

test('二重クリック・再読み込み: 30 分以内の同じ申込は同じ取引（Paddle で 2 つ作らない）・別商品は別の取引', async () => {
  const w = world();
  const a = await checkout(w);
  const b = await checkout(w);
  assert.equal(b.subscriptionId, a.subscriptionId);
  assert.equal(b.reused, true);
  assert.equal(w.creates.length, 1);
  const c = await checkout(w, { planId: 'premium-nankan' });
  assert.notEqual(c.subscriptionId, a.subscriptionId);
  assert.equal(w.creates.length, 2);
  assert.ok(w.redis.has(openCheckoutKey(REC, 'premium')));
});

test('Webhook の重複・順不同・同時: 何度届いても同じ値・古い通知で期限を縮めない・購読の通知だけでも反映できる', async () => {
  const w = world();
  const { subscriptionId: txn } = await checkout(w);
  const sid = w.pay(txn);
  // subscription.activated が transaction.completed より先に届く
  assert.equal((await w.handle(w.event('subscription.activated', { id: sid }))).result, 'write_attached');
  const after = { ...w.f() };
  const n = w.notes.length;
  for (const ev of [w.event('transaction.completed', { id: txn }), w.event('subscription.created', { id: sid }), w.event('subscription.updated', { id: sid })]) {
    assert.equal((await w.handle(ev)).result, 'write_renewed');
  }
  assert.equal(w.f()['有効期限'], after['有効期限']);
  assert.equal(w.f().PaidAt, after.PaidAt, '初回の記録は書き換えない');
  assert.equal(w.notes.length, n, '付与の通知は 1 回だけ');
  // 同時に 2 件
  const [x, y] = await Promise.all([w.handle(w.event('subscription.updated', { id: sid })), w.handle(w.event('subscription.updated', { id: sid }))]);
  assert.ok([x.result, y.result].every((r) => r === 'write_renewed'));
  // 更新後に、古い期間の写しが遅れて届いても縮めない
  w.renew(sid);
  await w.handle(w.event('subscription.updated', { id: sid }));
  const extended = w.f()['有効期限'];
  const old = snapshotPaddleSubscription({ ...w.subs[sid], current_billing_period: { starts_at: NOW.toISOString(), ends_at: addMonth(NOW.toISOString(), 1) } });
  await applyPaddleSubscription({ env: ENV, apply: { kind: 'subscription', provider: 'paddle', subscription: old }, redis: w.redisCmd, notify: w.notify, fetchImpl: w.fetch, now: NOW });
  assert.equal(w.f()['有効期限'], extended);
  // 取引の結果は支払い済みの取引の通知でだけ書く
  assert.equal(w.redis.get(txnResultKey(txn)), 'active');
});

test('自動更新: 成功で 1 期間延びる・支払い失敗（past_due）では延ばさない・回復で延びる・年額は 12 か月', async () => {
  const w = world();
  const { subscriptionId: txn } = await checkout(w);
  const sid = w.pay(txn);
  await w.handle(w.event('transaction.completed', { id: txn }));
  assert.equal(w.f()['有効期限'], '2026-12-04');
  const r1 = w.renew(sid);
  await w.handle(w.event('transaction.completed', { id: r1 }));
  assert.equal(w.f()['有効期限'], '2027-01-04');
  w.renew(sid, { ok: false });
  assert.equal((await w.handle(w.event('subscription.past_due', { id: sid }))).result, 'skip_status_past_due');
  assert.equal(w.f()['有効期限'], '2027-01-04', '支払い失敗では延ばさない');
  w.subs[sid].status = 'active';
  await w.handle(w.event('subscription.updated', { id: sid }));
  assert.equal(w.f()['有効期限'], '2027-02-04', '回復して支払われたら延びる');

  const y = world();
  const { subscriptionId: t2 } = await checkout(y, { planId: 'premium-annual' });
  y.pay(t2);
  await y.handle(y.event('transaction.completed', { id: t2 }));
  assert.equal(y.f().PlanType, 'Annual');
  assert.equal(y.f().VenueAccess, '');
  assert.equal(y.f()['有効期限'], '2027-11-04');
});

test('月末・JST 境界: 期限は支払い済み期間の終わり（JST 暦日）+ 2 日', () => {
  assert.equal(expirationFromPeriodEnd('2026-01-31T15:30:00Z'), '2026-02-03', 'JST では 2/1 00:30');
  assert.equal(expirationFromPeriodEnd('2026-01-31T14:59:59Z'), '2026-02-02', 'JST では 1/31 23:59');
  assert.equal(expirationFromPeriodEnd('2026-02-28T03:00:00Z'), '2026-03-02');
  assert.equal(expirationFromPeriodEnd('2028-02-29T03:00:00Z'), '2028-03-02', 'うるう年');
  assert.equal(expirationFromPeriodEnd('2026-12-31T15:00:00Z'), '2027-01-03', '年またぎ');
  assert.equal(expirationFromPeriodEnd(null), null);
  assert.equal(expirationFromPeriodEnd('bad'), null);
});

test('即時退会: Paddle を即時解約してから退会状態（期限は昨日）・canceled の通知も退会へ収束・遅れた active で権限を戻さない', async () => {
  const w = world();
  const { subscriptionId: txn } = await checkout(w);
  const sid = w.pay(txn);
  await w.handle(w.event('transaction.completed', { id: txn }));
  assert.equal(classifyMemberWithdrawal(w.f(), NOW.getTime()).kind, 'paddle');
  const r = await withdrawPaddleSubscriber({ env: ENV, origin: PREVIEW, recordId: REC, reason: 'test', redis: w.redisCmd, fetchImpl: w.fetch, now: NOW });
  assert.equal(r.result, 'withdrawn');
  assert.equal(r.cancelled, true);
  assert.deepEqual(w.cancels, [sid]);
  assert.equal(w.f().WithdrawalRequested, true);
  assert.equal(w.f()['有効期限'], '2026-11-01');
  assert.ok(w.redis.get(withdrawalMarkKey(sid)));
  assert.equal((await w.handle(w.event('subscription.canceled', { id: sid }))).result, 'write_withdrawn');
  assert.equal(w.f()['有効期限'], '2026-11-01');
  // 遅れて届いた古い active の写しでも権限を戻さない
  const stale = snapshotPaddleSubscription({ ...w.subs[sid], status: 'active', current_billing_period: { starts_at: NOW.toISOString(), ends_at: addMonth(NOW.toISOString(), 1) } });
  const o = await applyPaddleSubscription({ env: ENV, apply: { kind: 'subscription', provider: 'paddle', subscription: stale }, redis: w.redisCmd, notify: w.notify, fetchImpl: w.fetch, now: NOW });
  assert.equal(o.result, 'skip_withdrawn');
  assert.equal(w.f()['有効期限'], '2026-11-01');
  assert.equal((await withdrawPaddleSubscriber({ env: ENV, origin: PREVIEW, recordId: REC, redis: w.redisCmd, fetchImpl: w.fetch, now: NOW })).result, 'already_withdrawn');
  // 退会後の再契約は新しい購読で通る
  const again = await checkout(w, { planId: 'premium-nankan' });
  assert.equal(again.ok, true);
});

test('即時退会で Paddle の解約に失敗: 会員の状態は変えない（cancel_failed）・退会の印も外す', async () => {
  const w = world();
  const { subscriptionId: txn } = await checkout(w);
  const sid = w.pay(txn);
  await w.handle(w.event('transaction.completed', { id: txn }));
  const before = { ...w.f() };
  w.failCancel = true;
  const r = await withdrawPaddleSubscriber({ env: ENV, origin: PREVIEW, recordId: REC, redis: w.redisCmd, fetchImpl: w.fetch, now: NOW });
  assert.equal(r.result, 'cancel_failed');
  assert.deepEqual(w.f(), before);
  assert.equal(w.redis.get(withdrawalMarkKey(sid)), undefined);
  assert.equal(w.subs[sid].status, 'active');
});

test('Paddle 側で直接解約: 予約中は利用継続・終了したら支払い済み期間まで（縮めるだけ・退会扱いにしない）', async () => {
  const w = world();
  const { subscriptionId: txn } = await checkout(w);
  const sid = w.pay(txn);
  await w.handle(w.event('transaction.completed', { id: txn }));
  const paid = w.f()['有効期限'];
  // お客様が Paddle のメールのリンクで解約（期間の終わりに終了の予約）
  w.subs[sid].scheduled_change = { action: 'cancel', effective_at: w.subs[sid].current_billing_period.ends_at };
  assert.equal((await w.handle(w.event('subscription.updated', { id: sid }))).result, 'write_renewed');
  assert.equal(w.f()['有効期限'], paid);
  // 期間の終わりに canceled（期間なし）→ 期限はそのまま・退会フラグは付けない
  Object.assign(w.subs[sid], { status: 'canceled', canceled_at: '2026-12-02T03:00:00Z', current_billing_period: null });
  assert.equal((await w.handle(w.event('subscription.canceled', { id: sid }))).result, 'write_ended');
  assert.equal(w.f()['有効期限'], paid);
  assert.notEqual(w.f().WithdrawalRequested, true);
  assert.equal(w.f().CancelledAt, '2026-12-02T03:00:00.000Z');
  // 期間つきの終了（管理者の即時解約など）は支払い済み期間の終わりの翌日まで縮める
  const d = decidePaddleSubscriptionSync({ fields: { '有効期限': '2027-01-10' }, sub: { id: sid, status: 'canceled', periodEndsAt: '2026-12-02T03:00:00Z' }, ownedSubId: sid, now: NOW });
  assert.equal(d.expiration, '2026-12-03');
});

test('返金・チャージバック: 定期課金の取引は権限を自動で戻さず管理者へ・購読の状態で再判定する', async () => {
  const w = world();
  const { subscriptionId: txn } = await checkout(w);
  const sid = w.pay(txn);
  await w.handle(w.event('transaction.completed', { id: txn }));
  const before = w.f()['有効期限'];
  w.adjs.adj_test0000000001 = { id: 'adj_test0000000001', transaction_id: txn, action: 'refund', status: 'approved', type: 'full' };
  const r = await w.handle(w.event('adjustment.created', { id: 'adj_test0000000001', transaction_id: txn }));
  assert.equal(r.result, 'write_renewed');
  assert.deepEqual(w.notes.at(-1), ['subscription_refunded', 'adjustment.created']);
  assert.equal(w.f()['有効期限'], before);
  // 管理者が Paddle で解約すれば、その通知で期間の終わりへ縮む（再判定）
  Object.assign(w.subs[sid], { status: 'canceled', canceled_at: NOW.toISOString(), current_billing_period: { starts_at: NOW.toISOString(), ends_at: NOW.toISOString() } });
  await w.handle(w.event('subscription.canceled', { id: sid }));
  assert.equal(w.f()['有効期限'], '2026-11-03');
});

test('別会員への誤付与を防ぐ: 会員 ID の無い購読・知らない商品・金額や周期の改ざん・存在しない会員は書かずに管理者へ', async () => {
  for (const [mut, reason] of [
    [(s) => { s.custom_data = {}; }, 'no_record'],
    [(s) => { s.custom_data.ak_sub = 'Z'; }, 'unknown_plan'],
    [(s) => { s.items[0].price.unit_price.amount = '100'; }, 'amount_mismatch'],
    [(s) => { s.items[0].price.billing_cycle = { interval: 'year', frequency: 1 }; }, 'interval_mismatch'],
    [(s) => { s.items.push(s.items[0]); }, 'item_mismatch'],
    [(s) => { s.custom_data.ak_record = 'recZZZZZZZZZZZZZZ'; }, 'record_not_found'],
  ]) {
    const w = world();
    const { subscriptionId: txn } = await checkout(w);
    const sid = w.pay(txn);
    mut(w.subs[sid]);
    const r = await w.handle(w.event('subscription.activated', { id: sid }));
    assert.equal(r.result, `conflict_${reason}`, reason);
    assert.equal(w.patches.length, 0, reason);
    assert.equal(w.notes.at(-1)[0], 'subscription_conflict', reason);
  }
});

test('二重契約を作らない: 生きている PayPal・Stripe の定期課金、別の Paddle 購読、買い切り、期間の長い Premium', async () => {
  const live = { 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', PaymentMethod: 'PayPal', '有効期限': '2026-12-01' };
  assert.equal(hasLivePaypalSubscription(live, NOW), true);
  assert.equal(hasLivePaypalSubscription({ ...live, WithdrawalRequested: true }, NOW), false);
  assert.equal(hasLivePaypalSubscription({ ...live, '有効期限': '2026-11-01' }, NOW), false);
  for (const [fields, code] of [
    [live, 'already_subscribed'],
    [{ ...live, PlanType: 'Annual', '有効期限': '2027-06-01' }, 'already_subscribed'],
    [{ 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', PaymentMethod: 'Stripe', StripeSubscriptionId: 'sub_1', '有効期限': '2026-12-01' }, 'already_subscribed'],
    [{ 'プラン': 'Premium', PlanType: 'Lifetime', Status: 'active', '有効期限': '2099-12-31' }, 'already_premium'],
    [{ 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', PaymentMethod: '銀行振込', '有効期限': '2027-06-01' }, 'already_premium'],
  ]) {
    const w = world({ fields });
    assert.deepEqual(await checkout(w), { ok: false, status: 409, code }, code);
    assert.equal(w.creates.length, 0);
  }
  // 申込の後に別経路で契約が生きた場合も、反映時に書かずに管理者へ
  const w = world();
  const { subscriptionId: txn } = await checkout(w);
  const sid = w.pay(txn);
  Object.assign(w.f(), live);
  assert.equal((await w.handle(w.event('subscription.activated', { id: sid }))).result, 'conflict_duplicate_subscription');
  // 同じ会員に別の Paddle 購読が既にある
  const z = world();
  const a = await checkout(z);
  const s1 = z.pay(a.subscriptionId);
  await z.handle(z.event('transaction.completed', { id: a.subscriptionId }));
  assert.equal(z.redis.get(memberKey(REC)), s1);
  assert.deepEqual(await checkout(z, { planId: 'premium-nankan' }), { ok: false, status: 409, code: 'already_subscribed' });
});

test('買い切りはカードで受けない（定期課金の申込・反映とも）', async () => {
  const w = world();
  assert.deepEqual(await checkout(w, { planId: 'premium-lifetime' }), { ok: false, status: 409, code: 'lifetime_bank_transfer_only' });
  assert.equal(decidePaddleSubscriptionPurchase({ planId: 'premium-lifetime', fields: {}, now: NOW }).code, 'lifetime_bank_transfer_only');
  assert.equal(w.creates.length, 0);
});

test('一回払いの経路と混ざらない: 定期課金の取引は一回払いの付与（カード台帳）に入らない', async () => {
  const w = world();
  const { subscriptionId: txn } = await checkout(w);
  w.pay(txn);
  await w.handle(w.event('transaction.completed', { id: txn }));
  assert.equal([...w.redis.keys()].some((k) => k.startsWith('ak:card:paddle:applied:')), false);
});

test('受付の切替: 新規の受付は ACTIVE の 1 社だけ。切替後 PayPal は新規を作れないが既存契約の反映・退会は続く。Paddle を閉じても既存の Paddle 契約は反映される（rollback）', () => {
  // 新規の申込の入口は ACTIVE だけ
  assert.deepEqual(subscriptionProviderGate({ provider: 'paypal', mode: 'live', entry: 'monthly', active: 'paddle' }), { ok: false, reason: 'provider_not_active' });
  assert.deepEqual(subscriptionProviderGate({ provider: 'paddle', mode: 'live', entry: 'monthly', active: 'paddle' }), { ok: true });
  assert.deepEqual(subscriptionProviderGate({ provider: 'paddle', mode: 'live', entry: 'monthly', active: 'paypal' }), { ok: false, reason: 'provider_not_active' });
  // PayPal の新規受付を閉じた状態（salesOpen=false）: 新規は 503・確定/退会（settle）は通る
  const ppEnv = { PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_ENV: 'live' };
  assert.equal(resolvePaypalSubscriptionMode({ env: ppEnv, origin: PRODUCTION_ORIGIN, salesOpen: false }).reason, 'card_sales_not_open');
  assert.equal(resolvePaypalSubscriptionSettleMode({ env: ppEnv, origin: PRODUCTION_ORIGIN }).ok, true);
  // Paddle を閉じても（切戻し）既存の Paddle 契約の反映・退会は通る（本番は委譲）
  const prod = { CARD_GRANT_INTERNAL_SECRET: 's'.repeat(40) };
  assert.equal(resolvePaddleSubscriptionMode({ env: prod, origin: PRODUCTION_ORIGIN, salesOpen: false }).reason, 'card_sales_not_open');
  assert.deepEqual(resolvePaddleSubscriptionSettleMode({ env: prod, origin: PRODUCTION_ORIGIN }), { ok: true, mode: 'live', delegate: true });
  // 本番に Sandbox 鍵は使わない
  assert.equal(resolvePaddleSubscriptionSettleMode({ env: { PADDLE_API_KEY: 'pdl_sdbx_apikey_x' }, origin: PRODUCTION_ORIGIN }).reason, 'test_key_on_production');
  assert.equal(typeof SUBSCRIPTION_SALES_OPEN.paddle, 'boolean');
});

test('退会の種類: Paddle の定期課金はマイページの退会の対象・PayPal・Stripe と区別する', () => {
  assert.equal(isPaddleSubscriber({ PaymentMethod: 'Paddle', PlanType: 'Monthly' }), true);
  assert.equal(isPaddleSubscriber({ PaymentMethod: 'Paddle', PlanType: 'Annual' }), true);
  assert.equal(isPaddleSubscriber({ PaymentMethod: 'Paddle', PlanType: 'Lifetime' }), false);
  assert.equal(classifyMemberWithdrawal({ 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', PaymentMethod: 'PayPal', '有効期限': '2026-12-01' }, NOW.getTime()).kind, 'paypal');
  assert.equal(classifyMemberWithdrawal({ 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', PaymentMethod: 'Paddle', '有効期限': '2026-12-01' }, NOW.getTime()).kind, 'paddle');
});

// ───────────────────────── 本番（鍵なし）↔ 中立サイト（鍵あり）の委譲

const SECRET = 'i'.repeat(48);
const PROD_ENV = { AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX', CARD_GRANT_INTERNAL_SECRET: SECRET };
const SITE_ENV = { PADDLE_API_KEY: 'pdl_live_apikey_x', CARD_GRANT_INTERNAL_SECRET: SECRET };
const memStore = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, reserve: async (k, v) => { if (m.has(k)) return false; m.set(k, v); return true; }, release: async (k) => { m.delete(k); } }; };

test('委譲: 本番は資格確認後に署名付き intent（kind=subscription）を中立サイトへ・中立サイトが定期課金の取引を作る（販売前は 503）', async () => {
  const w = world({ origin: PRODUCTION_ORIGIN });
  const store = memStore();
  const site = async (url, init) => {
    if (!String(url).startsWith('https://checkout.tirol.link/')) return w.fetch(url, init);
    assert.equal(String(url), 'https://checkout.tirol.link/.netlify/functions/paddle-create-checkout');
    const intent = JSON.parse(init.body);
    assert.equal(intent.kind, 'subscription');
    assert.equal(intent.planId, 'premium');
    assert.equal(intent.recordId, REC);
    assert.equal(intent.email, undefined, 'メールは渡さない');
    const req = new Request(url, { method: 'POST', headers: init.headers, body: init.body });
    const resp = await handleCreateCheckout({
      request: req, env: SITE_ENV, store,
      createSubscriptionTransaction: (a) => import('./paddleSubscriptionServer.js').then((m) => m.createPaddleSubscriptionTransaction({ ...a, salesOpen: open, active: 'paddle', fetchImpl: w.fetch })),
    });
    return { ok: resp.ok, status: resp.status, text: () => resp.text() };
  };
  let open = false;
  const mk = () => createPaddleSubscriptionCheckout({ env: PROD_ENV, origin: PRODUCTION_ORIGIN, recordId: REC, planId: 'premium', entry: 'monthly', redis: w.redisCmd, fetchImpl: site, now: NOW });
  // 本番の受付（SUBSCRIPTION_SALES_OPEN.paddle）が閉じている間は本番側で止まる
  assert.equal((await mk()).code, SUBSCRIPTION_SALES_OPEN.paddle ? 'card_sales_not_open' : 'card_sales_not_open');
  assert.equal(w.creates.length, 0);
  // 受付を開いた状態（切替後）を模す: 本番の判定と中立サイトの判定を両方開く
  const r = await createPaddleSubscriptionCheckoutOpen({ w, site: async (u, i) => { open = true; return site(u, i); } });
  assert.equal(r.ok, true);
  assert.match(r.url, /^https:\/\/checkout\.tirol\.link\/pay\/\?_ptxn=txn_\w+&ak=s$/);
  assert.equal(w.creates.length, 1);
  assert.equal(w.creates[0].items[0].price.billing_cycle.interval, 'month');
});

/** SUBSCRIPTION_SALES_OPEN.paddle が開いた本番（切替後）を、モード判定だけ差し替えて確かめる */
async function createPaddleSubscriptionCheckoutOpen({ w, site }) {
  const mod = await import('./paddleSubscriptionServer.js');
  const mode = mod.resolvePaddleSubscriptionMode({ env: PROD_ENV, origin: PRODUCTION_ORIGIN, salesOpen: true });
  assert.deepEqual(mode, { ok: true, mode: 'live', delegate: true });
  const res = await (await import('./paddleApi.js')).postSignedIntent({ url: 'https://checkout.tirol.link/.netlify/functions/paddle-create-checkout', secret: SECRET, fetchImpl: site, intent: { kind: 'subscription', recordId: REC, planId: 'premium', origin: PRODUCTION_ORIGIN, entry: 'monthly' } });
  if (!res.ok) return { ok: false, status: res.status, code: res.data?.error };
  return { ok: true, url: `${res.data.url}&ak=s`, transactionId: res.data.transactionId };
}

test('中立サイトの取引作成: 署名なし・期限切れ・他オリジンは断る／同じ intent の再送は同じ取引', async () => {
  const w = world({ origin: PRODUCTION_ORIGIN });
  const store = memStore();
  const body = JSON.stringify({ v: 1, kind: 'subscription', recordId: REC, planId: 'premium-annual', origin: PRODUCTION_ORIGIN, entry: 'monthly', nonce: 'n-1' });
  const create = (a) => import('./paddleSubscriptionServer.js').then((m) => m.createPaddleSubscriptionTransaction({ ...a, salesOpen: true, active: 'paddle', fetchImpl: w.fetch }));
  const call = (b, sig) => handleCreateCheckout({ request: new Request('https://x/', { method: 'POST', headers: { 'x-internal-signature': sig }, body: b }), env: SITE_ENV, store, createSubscriptionTransaction: create });
  assert.equal((await call(body, 'ts=1;h1=00')).status, 401);
  assert.equal((await call(body, signTsBody({ rawBody: body, secret: SECRET, nowSec: Math.floor(Date.now() / 1000) - 600 }))).status, 401);
  const other = JSON.stringify({ ...JSON.parse(body), origin: 'https://evil.example' });
  assert.equal((await call(other, signTsBody({ rawBody: other, secret: SECRET }))).status, 400);
  const a = await (await call(body, signTsBody({ rawBody: body, secret: SECRET }))).json();
  const b = await (await call(body, signTsBody({ rawBody: body, secret: SECRET }))).json();
  assert.equal(a.transactionId, b.transactionId);
  assert.equal(w.creates.length, 1);
  assert.equal(w.creates[0].items[0].price.unit_price.amount, '49800');
});

test('委譲: 中立サイトの通知 → 購読の写し → 本番の内部付与で反映（本番は Paddle を照会しない）', async () => {
  const w = world({ origin: PRODUCTION_ORIGIN });
  const t = await import('./paddleSubscriptionServer.js').then((m) => m.createPaddleSubscriptionTransaction({ env: SITE_ENV, origin: PRODUCTION_ORIGIN, recordId: REC, planId: 'premium', entry: 'monthly', salesOpen: true, active: 'paddle', fetchImpl: w.fetch }));
  assert.equal(t.ok, true);
  const sid = w.pay(t.transactionId);
  const dec = await decidePaddleGrant({ env: SITE_ENV, origin: PRODUCTION_ORIGIN, parsed: w.event('transaction.completed', { id: t.transactionId }), fetchImpl: w.fetch });
  assert.equal(dec.apply.kind, 'subscription');
  assert.equal(dec.apply.subscription.id, sid);
  assert.equal(dec.apply.transactionId, t.transactionId);
  assert.equal(JSON.stringify(dec.apply).includes('@'), false, 'メールを渡さない');
  const noPaddle = async (url, init) => { assert.ok(!/paddle\.com/.test(String(url)), '本番は Paddle を叩かない'); return w.fetch(url, init); };
  const r = await applyPaddleGrant({ env: PROD_ENV, apply: dec.apply, redis: w.redisCmd, notify: w.notify, fetchImpl: noPaddle, now: NOW });
  assert.equal(r.result, 'write_attached');
  assert.equal(w.f().PaymentMethod, 'Paddle');
  assert.equal(w.redis.get(txnResultKey(t.transactionId)), 'active');
});

test('中立サイトの即時解約: 本人の購読だけ止める（別会員は subscription_mismatch）・署名が要る・本番の退会は委譲で完了', async () => {
  const w = world({ origin: PRODUCTION_ORIGIN });
  const t = await import('./paddleSubscriptionServer.js').then((m) => m.createPaddleSubscriptionTransaction({ env: SITE_ENV, origin: PRODUCTION_ORIGIN, recordId: REC, planId: 'premium', entry: 'monthly', salesOpen: true, active: 'paddle', fetchImpl: w.fetch }));
  const sid = w.pay(t.transactionId);
  const dec = await decidePaddleGrant({ env: SITE_ENV, origin: PRODUCTION_ORIGIN, parsed: w.event('transaction.completed', { id: t.transactionId }), fetchImpl: w.fetch });
  await applyPaddleGrant({ env: PROD_ENV, apply: dec.apply, redis: w.redisCmd, notify: w.notify, fetchImpl: w.fetch, now: NOW });
  const site = async (url, init) => {
    if (!String(url).startsWith('https://checkout.tirol.link/')) return w.fetch(url, init);
    const resp = await handleCancel({ request: new Request(url, { method: 'POST', headers: init.headers, body: init.body }), env: SITE_ENV, fetchImpl: w.fetch });
    return { ok: resp.ok, status: resp.status, text: () => resp.text() };
  };
  // 別会員の購読は止めない
  const mis = JSON.stringify({ v: 1, kind: 'cancel', subscriptionId: sid, recordId: OTHER, origin: PRODUCTION_ORIGIN, nonce: 'x' });
  const resp = await handleCancel({ request: new Request('https://x/', { method: 'POST', headers: { 'x-internal-signature': signTsBody({ rawBody: mis, secret: SECRET }) }, body: mis }), env: SITE_ENV, fetchImpl: w.fetch });
  assert.deepEqual(await resp.json(), { ok: false, code: 'subscription_mismatch' });
  assert.equal((await handleCancel({ request: new Request('https://x/', { method: 'POST', headers: { 'x-internal-signature': 'ts=1;h1=00' }, body: mis }), env: SITE_ENV })).status, 401);
  assert.equal(w.cancels.length, 0);
  const r = await withdrawPaddleSubscriber({ env: PROD_ENV, origin: PRODUCTION_ORIGIN, recordId: REC, redis: w.redisCmd, fetchImpl: site, now: NOW });
  assert.equal(r.result, 'withdrawn');
  assert.deepEqual(w.cancels, [sid]);
  assert.equal(w.f().WithdrawalRequested, true);
});

test('通知の署名（Paddle-Signature ts:rawBody）は変わらない', () => {
  const raw = '{"event_type":"subscription.activated","data":{"id":"sub_test0000000001"}}';
  const now = 1_800_000_000;
  const header = signTsBody({ rawBody: raw, secret: 'whsec', nowSec: now });
  assert.equal(verifyPaddleSignature({ header, rawBody: raw, secret: 'whsec', nowSec: now }), true);
  assert.equal(verifyPaddleSignature({ header, rawBody: raw.replace('0001', '0002'), secret: 'whsec', nowSec: now }), false);
  assert.deepEqual(parsePaddleWebhook(raw), { eventType: 'subscription.activated', subscriptionId: 'sub_test0000000001' });
});
