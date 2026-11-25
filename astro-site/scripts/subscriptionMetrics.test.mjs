// 月額継続課金の 4 指標（docs/decisions.md 2026-11-24）。決済会社は全て偽物（fetch は mock・実 API を呼ばない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonthsMs, buildSubscriptionMetrics, computeSubscriptionMetrics, monthlyAmount, normalizePaddle, normalizePaypal, normalizeStripe,
} from './subscriptionMetrics.mjs';
import { measurementPeriod } from './revenueMonthly.mjs';
import { PAYPAL_PLAN_IDS } from '../src/lib/billing/paypal/paypalSubscriptionCore.js';

const T = (iso) => Date.parse(iso);
const NOV_END = T('2026-12-01T01:00:00Z'); // JST 12/1 10:00
const nov = measurementPeriod('2026-11', NOV_END);
const REC_A = 'recAAAAAAAAAAAAAA';
const REC_B = 'recBBBBBBBBBBBBBB';

const paddleTxn = ({ sub, start, end, billed = start, amount = '4980', interval = 'month', rec = REC_A, svc, status = 'completed', akSub = 'A' }) => ({
  id: `txn_${sub}_${start}`, status, subscription_id: sub, billed_at: billed, currency_code: 'JPY', origin: 'web',
  billing_period: { starts_at: start, ends_at: end },
  custom_data: { ...(svc ? { svc, member_id: 'h1', plan_code: 'P-M' } : { ak_record: rec, ak_sub: akSub }) },
  items: [{ quantity: 1, price: { unit_price: { amount, currency_code: 'JPY' }, billing_cycle: { interval, frequency: 1 } } }],
  details: { totals: { grand_total: '1000' } },
});

test('月あたりの金額（年額は 1/12）と暦の月足し', () => {
  assert.equal(monthlyAmount(4980, 'month'), 4980);
  assert.equal(monthlyAmount(49800, 'year'), 4150);
  assert.equal(monthlyAmount(0, 'month'), null);
  assert.equal(monthlyAmount(100, 'week'), null);
  assert.equal(new Date(addMonthsMs(T('2026-10-31T03:00:00Z'), 1)).toISOString(), '2026-11-30T03:00:00.000Z');
  assert.equal(new Date(addMonthsMs(T('2026-10-15T03:00:00Z'), 12)).toISOString(), '2027-10-15T03:00:00.000Z');
});

test('Paddle: AK の購読だけ（KL・HIBI・一回払い・未払いは除く）・更新額は値引き前の通常料金', () => {
  const subs = normalizePaddle([
    paddleTxn({ sub: 'sub_1', start: '2026-11-03T00:00:00Z', end: '2026-12-03T00:00:00Z', amount: '4980' }),
    paddleTxn({ sub: 'sub_hibi', start: '2026-11-24T00:00:00Z', end: '2026-12-24T00:00:00Z', svc: 'hibi' }),
    { ...paddleTxn({ sub: 'sub_one', start: '2026-11-03T00:00:00Z', end: '2026-12-03T00:00:00Z' }), subscription_id: null },
    paddleTxn({ sub: 'sub_2', start: '2026-11-05T00:00:00Z', end: '2026-12-05T00:00:00Z', status: 'past_due' }),
    paddleTxn({ sub: 'sub_3', start: '2026-11-06T00:00:00Z', end: '2027-11-06T00:00:00Z', amount: '49800', interval: 'year', rec: REC_B, akSub: 'Y' }),
  ]);
  assert.deepEqual(subs.map((s) => [s.ref, s.monthlyJpy, s.periods.length]), [['sub_1', 4980, 1], ['sub_3', 4150, 1]]);
  assert.equal(subs[0].member, REC_A);
  assert.throws(() => normalizePaddle([{ ...paddleTxn({ sub: 's', start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' }), currency_code: 'USD' }]), /non-JPY/);
});

test('PayPal: AK の Plan だけ・完了した周期数から支払い済み期間を作る', () => {
  const live = PAYPAL_PLAN_IDS.live;
  const subs = normalizePaypal([
    { id: 'I-1', plan_id: live.premium, custom_id: `${REC_A}:A`, start_time: '2026-10-20T03:00:00Z',
      billing_info: { cycle_executions: [{ tenure_type: 'REGULAR', cycles_completed: 2 }] } },
    { id: 'I-2', plan_id: 'P-OTHER', custom_id: `${REC_B}:A`, start_time: '2026-10-20T03:00:00Z',
      billing_info: { cycle_executions: [{ tenure_type: 'REGULAR', cycles_completed: 1 }] } },
    { id: 'I-3', plan_id: live['premium-annual'], custom_id: `${REC_B}:Y`, start_time: '2026-10-21T03:00:00Z',
      billing_info: { cycle_executions: [{ tenure_type: 'REGULAR', cycles_completed: 0 }] } },
  ]);
  assert.equal(subs.length, 1);
  assert.deepEqual(subs[0].periods.map((p) => new Date(p.endMs).toISOString()), ['2026-11-20T03:00:00.000Z', '2026-12-20T03:00:00.000Z']);
  assert.equal(subs[0].member, REC_A);
  assert.ok(subs[0].monthlyJpy > 0);
});

test('Stripe: 支払い済みの請求書の期間（新旧の API 形）', () => {
  const subs = normalizeStripe(
    [{ id: 'sub_s1', metadata: { ak_record_id: REC_A }, items: { data: [{ quantity: 1, price: { unit_amount: 4980, recurring: { interval: 'month', interval_count: 1 } } }] } },
      { id: 'sub_s2', metadata: {}, items: { data: [{ price: { unit_amount: 2980, recurring: { interval: 'month', interval_count: 1 } } }] } }],
    [{ subscription: 'sub_s1', amount_paid: 4980, currency: 'jpy', created: T('2026-10-06T00:00:00Z') / 1000,
      lines: { data: [{ period: { start: T('2026-10-06T00:00:00Z') / 1000, end: T('2026-11-06T00:00:00Z') / 1000 } }] } },
    { parent: { subscription_details: { subscription: 'sub_s2' } }, amount_paid: 0, currency: 'jpy', lines: { data: [] } }],
  );
  assert.equal(subs.length, 1);
  assert.equal(subs[0].monthlyJpy, 4980);
  assert.equal(subs[0].member, REC_A);
});

test('4 指標: 新規（再開は内訳）・更新日の来た購読の継続 / 解約 / 確認中・月初の有効数・MRR', () => {
  const mk = (provider, ref, member, firstPaid, periods, monthlyJpy = 4980) => ({
    provider, ref, member, firstPaidMs: T(firstPaid), periods: periods.map(([a, b]) => ({ startMs: T(a), endMs: T(b) })), monthlyJpy,
  });
  const subs = [
    // Stripe の月額（10/6〜）: 11/6 の更新が払われず解約。同じ会員が 11/10 に Paddle で再開
    mk('stripe', 's1', REC_A, '2026-10-06T00:00:00Z', [['2026-10-06T00:00:00Z', '2026-11-06T00:00:00Z']]),
    mk('paddle', 'p1', REC_A, '2026-11-10T00:00:00Z', [['2026-11-10T00:00:00Z', '2026-12-10T00:00:00Z']]),
    // PayPal 10/20〜: 11/20 に更新済み
    mk('paypal', 'q1', REC_B, '2026-10-20T03:00:00Z', [['2026-10-20T03:00:00Z', '2026-11-20T03:00:00Z'], ['2026-11-20T03:00:00Z', '2026-12-20T03:00:00Z']]),
    // Paddle 新規（会員 ID 無し）: 年額
    mk('paddle', 'p2', null, '2026-11-15T00:00:00Z', [['2026-11-15T00:00:00Z', '2027-11-15T00:00:00Z']], 4150),
    // 10/28〜: 11/28 の更新が未確認（集計時点から 7 日以内）
    mk('paypal', 'q2', null, '2026-10-28T00:00:00Z', [['2026-10-28T00:00:00Z', '2026-11-28T00:00:00Z']]),
  ];
  const m = computeSubscriptionMetrics({ subs, period: nov, nowMs: NOV_END, providers: { paddle: true, paypal: true, stripe: true } });
  assert.equal(m.new_subscriptions, 2);
  assert.equal(m.new_reactivations, 1);
  assert.deepEqual([m.renewals_due, m.renewed, m.churned, m.renewal_pending], [3, 1, 1, 1]);
  assert.equal(m.retention_rate, 0.5);
  assert.equal(m.churn_rate, 0.5);
  assert.equal(m.active_at_start, 3);
  assert.equal(m.churn_rate_of_start_active, 0.3333);
  assert.equal(m.active_at_end, 3); // p1・q1・p2（q2 は 11/28 で切れている）
  assert.equal(m.mrr_jpy, 4980 + 4980 + 4150);
  assert.deepEqual(m.by_provider.stripe, { measured: true, new_subscriptions: 0, renewals_due: 1, renewed: 0, churned: 1, active_at_end: 0, mrr_jpy: 0 });
  assert.ok(m.data_quality.some((q) => q.includes('確認中の購読 1 件')));
});

test('鍵なし・取得失敗の決済会社は未計上（0 件にしない）・出力に識別子と鍵を含めない', async () => {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.host === 'api.paddle.com') {
      return { ok: true, status: 200, json: async () => ({ data: [paddleTxn({ sub: 'sub_secretref', start: '2026-11-03T00:00:00Z', end: '2026-12-03T00:00:00Z' })], meta: { pagination: { has_more: false } } }) };
    }
    if (u.host === 'api.stripe.com') return { ok: false, status: 403, json: async () => ({}) };
    throw new Error('unexpected host');
  };
  const m = await buildSubscriptionMetrics({ env: { PADDLE_READ_KEY: 'pdl-key-x', STRIPE_READ_KEY: 'rk-key-x' }, period: nov, nowMs: NOV_END, fetchImpl });
  assert.equal(m.new_subscriptions, 1);
  assert.equal(m.by_provider.paddle.measured, true);
  assert.deepEqual(m.by_provider.paypal, { measured: false });
  assert.deepEqual(m.by_provider.stripe, { measured: false });
  assert.ok(m.data_quality.includes('Stripe: 未計上（取得失敗: stripe subscriptions: HTTP 403）'));
  assert.ok(m.data_quality.includes('PayPal: 未計上（読取り鍵が未設定）'));
  const text = JSON.stringify(m);
  for (const s of ['pdl-key-x', 'rk-key-x', 'sub_secretref', REC_A, 'txn_']) assert.ok(!text.includes(s), s);
});

test('PayPal の取得: 31 日ごとに Transaction Search で購読 ID を集め、購読を GET で読む', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method || 'GET', search: u.searchParams });
    if (u.pathname === '/v1/oauth2/token') return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
    if (u.pathname === '/v1/reporting/transactions') {
      return { ok: true, status: 200, json: async () => ({ total_pages: 1, transaction_details: [
        { transaction_info: { paypal_reference_id: 'I-AAA', paypal_reference_id_type: 'RP', transaction_event_code: 'T0002', transaction_status: 'S', transaction_amount: { value: '4980', currency_code: 'JPY' } } },
        { transaction_info: { paypal_reference_id: 'O-1', paypal_reference_id_type: 'ODR' } },
      ] }) };
    }
    if (u.pathname === '/v1/billing/subscriptions/I-AAA') {
      return { ok: true, status: 200, json: async () => ({ id: 'I-AAA', plan_id: PAYPAL_PLAN_IDS.live.premium, custom_id: `${REC_A}:A`, start_time: '2026-10-20T03:00:00Z',
        billing_info: { cycle_executions: [{ tenure_type: 'REGULAR', cycles_completed: 1 }] } }) };
    }
    throw new Error(`unexpected ${u.pathname}`);
  };
  const m = await buildSubscriptionMetrics({ env: { PAYPAL_READ_CLIENT_ID: 'id', PAYPAL_READ_CLIENT_SECRET: 'sec' }, period: nov, nowMs: NOV_END, fetchImpl });
  const searches = calls.filter((c) => c.path === '/v1/reporting/transactions');
  assert.ok(searches.length >= 2);
  for (const s of searches) assert.ok(Date.parse(s.search.get('end_date')) - Date.parse(s.search.get('start_date')) <= 31 * 86400000);
  assert.ok(calls.every((c) => c.method === 'GET' || c.path === '/v1/oauth2/token'));
  assert.equal(m.renewals_due, 1);
  assert.equal(m.churned, 1); // 11/20 の更新が支払われていない
  const n = searches.length; // 偽の API は窓ごとに同じ入金を返す
  assert.ok(m.data_quality.includes(`PayPal: 入金 ${n} 件（T0002/RP=${n}）・購読 ID 1 件・AK の Plan 1 件・支払い済み 1 件`));
  assert.ok(!JSON.stringify(m).includes('I-AAA'));
});
