/**
 * PayPal 年額の定期課金（2026-10-20 MK 決定）を偽の PayPal API・Airtable・Redis で通しで確かめる。ネットワークに出ない。
 * - 年払いは PayPal の年額定期課金（12 か月ごと自動更新）。買い切りは銀行振込だけ（カード・PayPal では申込も反映もしない）
 * - 価格・権利は不変（年払い ¥49,800／Light 会員特典 ¥44,820／買い切り ¥78,000）
 * - 初回支払い → 付与（支払い日 +12 か月 +2 日）・毎年の更新・決済失敗・解約・期限・Webhook の冪等・二重課金の防止
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRODUCTION_ORIGIN } from '../cardSales.js';
import { hasBannedPaymentWord, PAYPAL_PLAN_NAMES } from '../paymentDisplayNames.js';
import { CARD_PRODUCTS, decideCardPurchase, decideCardGrant } from '../cardOneTime.js';
import {
  PAYPAL_PLAN_IDS, ANNUAL_SUBSCRIPTION_PLANS, SUBSCRIPTION_PLANS, buildPlanBody, buildSubscriptionBody,
  decidePaypalSubscriptionPurchase, decidePaypalSubscriptionSync, planFromPaypalPlanId, planIdFromCustomCode,
  PAYPAL_PLAN_CODES, memberKey, isPaypalSubscriber, hasValidPaidPremium, LIFETIME_BANK_ONLY,
} from './paypalSubscriptionCore.js';
import {
  createPaypalSubscription, applyPaypalSubscription, confirmPaypalSubscription, withdrawPaypalSubscriber, handlePaypalSubscriptionEvent,
} from './paypalSubscriptionServer.js';
import { classifyMemberWithdrawal } from '../memberWithdrawal.js';

const PREVIEW = 'https://deploy-preview-1--analytics-keiba.netlify.app';
const REC = 'recAAAAAAAAAAAAAA';
const ENV = { PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_ENV: 'sandbox', PAYPAL_WEBHOOK_ID: 'WH-1', AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX' };
const NOW = new Date('2026-10-20T03:00:00Z'); // JST 12:00
const PID = PAYPAL_PLAN_IDS.test;
const LIGHT_ACTIVE = { 'プラン': 'Light', PlanType: 'Monthly', Status: 'active', PaidAt: '2026-10-01T00:00:00Z', '有効期限': '2026-10-31', Email: 'a+card-e2e@example.com' };

function world({ fields = { 'プラン': 'Free', Email: 'a+card-e2e@example.com' } } = {}) {
  const st = { fields: { ...fields }, subs: {}, patches: [], redis: new Map(), notes: [], cancels: [], creates: 0 };
  const res = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body });
  st.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'api.airtable.com') {
      if (init.method === 'PATCH') { const f = JSON.parse(init.body).fields; st.patches.push(f); Object.assign(st.fields, f); }
      return res(200, { id: REC, fields: st.fields });
    }
    if (u.pathname === '/v1/oauth2/token') return res(200, { access_token: 'tok' });
    if (u.pathname === '/v1/billing/subscriptions' && init.method === 'POST') {
      const b = JSON.parse(init.body);
      st.creates += 1;
      const id = `I-ANNUAL${String(st.creates).padStart(6, '0')}`;
      st.subs[id] = { id, status: 'APPROVAL_PENDING', plan_id: b.plan_id, custom_id: b.custom_id, links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${id}` }] };
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
  st.pay = (id, time = NOW, amount) => {
    const s = st.subs[id];
    const plan = SUBSCRIPTION_PLANS.find((p) => PID[p.id] === s.plan_id);
    s.status = 'ACTIVE';
    s.billing_info = { last_payment: { amount: { currency_code: 'JPY', value: String(amount ?? plan.amountYen) }, time: time.toISOString() } };
  };
  return st;
}
const common = (w, now = NOW) => ({ env: ENV, origin: PREVIEW, redis: w.redisCmd, notify: w.notify, fetchImpl: w.fetch, now });

// ── 価格・商品の対応 ─────────────────────────────────────
test('価格は不変: 年額 2 本は銀行振込の年払いと同額・買い切りは定期課金の商品に無い', () => {
  assert.deepEqual(ANNUAL_SUBSCRIPTION_PLANS.map((p) => [p.id, p.amountYen, p.interval, p.months, p.planType]), [
    ['premium-annual', 49800, 'YEAR', 12, 'Annual'],
    ['premium-annual-light', 44820, 'YEAR', 12, 'Annual'],
  ]);
  const byId = Object.fromEntries(CARD_PRODUCTS.map((p) => [p.id, p.amountYen]));
  assert.equal(byId['premium-annual'], 49800);
  assert.equal(byId['premium-annual-light'], 44820);
  assert.equal(byId['premium-lifetime'], 78000, '買い切りの価格は不変（銀行振込）');
  assert.equal(SUBSCRIPTION_PLANS.some((p) => /lifetime/i.test(p.id) || p.planType === 'Lifetime'), false);
  const pricing = readFileSync(new URL('../../../pages/pricing.astro', import.meta.url), 'utf8');
  assert.match(pricing, /openBankModal\('Premium Annual', 49800, 'annual'\)/);
  assert.match(pricing, /openBankModal\('Premium Annual - Campaign', 44820, 'annual'\)/);
  assert.match(pricing, /openBankModal\('Premium Lifetime', 78000, 'lifetime'\)/);
});

test('Plan の対応: 1 年ごと・無期限・JPY 小数なし・初期費用なし・名前は許可リスト・custom_id は商品コード（Y / L）', () => {
  for (const p of ANNUAL_SUBSCRIPTION_PLANS) {
    const b = buildPlanBody({ productId: 'PROD-1', plan: p });
    assert.equal(b.name, PAYPAL_PLAN_NAMES[p.id]);
    assert.equal(hasBannedPaymentWord(JSON.stringify(b)), false);
    assert.deepEqual(b.billing_cycles[0].frequency, { interval_unit: 'YEAR', interval_count: 1 });
    assert.equal(b.billing_cycles[0].total_cycles, 0);
    assert.deepEqual(b.billing_cycles[0].pricing_scheme.fixed_price, { value: String(p.amountYen), currency_code: 'JPY' });
    assert.equal(b.payment_preferences.setup_fee, undefined);
    assert.match(PID[p.id] || '', /^P-[A-Z0-9]+$/, `${p.id} の Sandbox Plan ID`);
    assert.equal(planFromPaypalPlanId(PID[p.id], 'test').id, p.id);
    const sb = buildSubscriptionBody({ planId: p.id, recordId: REC, origin: PREVIEW, mode: 'test' });
    assert.equal(sb.plan_id, PID[p.id]);
    assert.equal(sb.custom_id, `${REC}:${PAYPAL_PLAN_CODES[p.id]}`);
    assert.equal(planIdFromCustomCode(PAYPAL_PLAN_CODES[p.id]), p.id);
    // 月額の Plan とは混ざらない
    assert.equal(Object.values(PID).filter((x) => x === PID[p.id]).length, 1);
  }
  assert.deepEqual([PAYPAL_PLAN_CODES['premium-annual'], PAYPAL_PLAN_CODES['premium-annual-light']], ['Y', 'L']);
  // 月額の Plan は 1 か月ごとのまま
  assert.deepEqual(buildPlanBody({ productId: 'PROD-1', plan: SUBSCRIPTION_PLANS[0] }).billing_cycles[0].frequency, { interval_unit: 'MONTH', interval_count: 1 });
  // Live の年額 Plan（2026-10-20 作成）: 両方登録済み・Sandbox と混ざらない・申込は Live の ID を使う
  for (const p of ANNUAL_SUBSCRIPTION_PLANS) {
    assert.match(PAYPAL_PLAN_IDS.live[p.id] || '', /^P-[A-Z0-9]+$/, `${p.id} の Live Plan ID`);
    assert.notEqual(PAYPAL_PLAN_IDS.live[p.id], PID[p.id]);
    assert.equal(buildSubscriptionBody({ planId: p.id, recordId: REC, origin: PRODUCTION_ORIGIN, mode: 'live' }).plan_id, PAYPAL_PLAN_IDS.live[p.id]);
  }
  // Live の Plan が無ければ申込を作らない（fail closed）
  for (const p of ANNUAL_SUBSCRIPTION_PLANS) {
    assert.throws(() => buildSubscriptionBody({ planId: p.id, recordId: REC, origin: PRODUCTION_ORIGIN, mode: 'live', ids: { ...PAYPAL_PLAN_IDS, live: {} } }), /plan_not_configured/);
  }
});

// ── 買い切りは銀行振込だけ（サーバーで拒否）───────────────────────
test('【重要】買い切りはカード・PayPal で申込も反映もしない（fail closed）', () => {
  assert.deepEqual(decidePaypalSubscriptionPurchase({ planId: 'premium-lifetime', fields: {}, now: NOW }), { ok: false, code: LIFETIME_BANK_ONLY });
  assert.equal(decideCardPurchase({ productId: 'premium-lifetime', fields: null, now: NOW }).code, 'lifetime_bank_transfer_only');
  assert.equal(decideCardPurchase({ productId: 'premium-lifetime', fields: LIGHT_ACTIVE, now: NOW }).code, 'lifetime_bank_transfer_only');
  assert.deepEqual(
    decideCardGrant({ productId: 'premium-lifetime', fields: {}, paidAt: NOW, provider: 'paypal' }),
    { action: 'conflict', reason: 'lifetime_bank_transfer_only' },
    'カードで成立してしまっても権限を書かない',
  );
  assert.throws(() => buildSubscriptionBody({ planId: 'premium-lifetime', recordId: REC, origin: PREVIEW, mode: 'test' }), /invalid_plan/);
});

test('【重要】買い切りの申込はサーバーの共通入口でも拒否する（PayPal へ何も作らない）', async () => {
  const w = world();
  const r = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium-lifetime' });
  assert.deepEqual([r.ok, r.status, r.code], [false, 409, LIFETIME_BANK_ONLY]);
  assert.equal(w.creates, 0);
});

test('料金ページ: 買い切りのカードは銀行振込だけ（カード・PayPal の入口を置かない）・年払いに自動更新の条件を明記', () => {
  const s = readFileSync(new URL('../../../pages/pricing.astro', import.meta.url), 'utf8');
  const lifetime = s.slice(s.indexOf('data-bank-plan="lifetime"'), s.indexOf('<!-- 無料プラン -->'));
  assert.ok(lifetime.length > 100);
  assert.equal(/data-subscription|data-card-product|data-monthly|plan-button-credit|PayPal|card-create-checkout/.test(lifetime), false, '買い切りにカード・PayPal の入口がある');
  assert.match(lifetime, /openBankModal\('Premium Lifetime', 78000, 'lifetime'\)/);
  const annual = s.slice(s.indexOf('data-bank-plan="annual"'), s.indexOf('data-bank-plan="lifetime"'));
  assert.match(annual, /data-hide-for="light" data-subscription="premium-annual"/);
  assert.match(annual, /data-only-for="light" data-subscription="premium-annual-light"/);
  for (const w of ['自動更新です', '12 か月ごとに、お申し込み時と同じ金額で自動的に更新・請求されます', '決済代行：PayPal',
    'PayPal のアカウントで自動支払いを停止', '支払い済みの 12 か月が終わるまでご利用いただけます', '退会はその時点でご利用終了', '残りの期間の返金はありません']) {
    assert.ok(annual.includes(w), `年払いの自動更新の条件に「${w}」が無い`);
  }
  // 送るのは商品 ID だけ（共通入口・金額を送らない）。Live の年額 Plan が無い間はボタンを出さない
  assert.match(s, /startMonthly\(btn\.getAttribute\('data-monthly'\) \|\| btn\.getAttribute\('data-subscription'\), btn\)/);
  assert.match(s, /const showAnnualSub = \(SUBSCRIPTION_SALES_OPEN\[ACTIVE_SUBSCRIPTION_PROVIDER\] === true && annualLivePlans\)/);
});

// ── 申込前の二重課金防止・Light 資格 ─────────────────────────────
test('【重要】申込前: 生きている月額・年額の購読／有効な Premium（銀行振込の年払い等）／買い切りには年額を作らない', () => {
  const ok = (planId, fields, extra = {}) => decidePaypalSubscriptionPurchase({ planId, fields, now: NOW, ...extra });
  assert.equal(ok('premium-annual', { 'プラン': 'Free' }).ok, true);
  assert.equal(ok('premium-annual', {}, { ownedSubLive: true }).code, 'already_subscribed', 'PayPal の月額・年額が生きている');
  assert.equal(ok('premium-annual', { 'プラン': 'Premium', PlanType: 'Monthly', PaymentMethod: 'Stripe', StripeSubscriptionId: 'sub_1', '有効期限': '2026-11-01' }).code, 'already_subscribed');
  assert.equal(ok('premium-annual', { 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', PaymentMethod: 'Bank Transfer', '有効期限': '2027-03-01' }).code, 'already_premium', '銀行振込の年払いが有効');
  assert.equal(ok('premium-annual', { 'プラン': 'Premium', PlanType: 'Lifetime', Status: 'active' }).code, 'already_premium', '買い切り');
  assert.equal(ok('premium-annual', { 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2026-10-19' }).ok, true, '期限切れ');
  assert.equal(ok('premium-annual', { 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', PaymentMethod: 'PayPal', WithdrawalRequested: true, '有効期限': '2026-10-19' }).ok, true, '退会済み');
  assert.equal(hasValidPaidPremium({ 'プラン': 'Light', Status: 'active', '有効期限': '2026-12-01' }, NOW), false, 'Light は乗り換え特典の対象');
});

test('Light 会員特典 ¥44,820 は資格をサーバーで判定する（無料・期限切れ・新規は不可）', () => {
  const d = (fields) => decidePaypalSubscriptionPurchase({ planId: 'premium-annual-light', fields, now: NOW });
  assert.equal(d(LIGHT_ACTIVE).ok, true);
  assert.equal(d(LIGHT_ACTIVE).plan.amountYen, 44820);
  assert.equal(d({ 'プラン': 'Free' }).code, 'not_eligible');
  assert.equal(d(null).code, 'not_eligible');
  assert.equal(d({ ...LIGHT_ACTIVE, '有効期限': '2026-08-01' }).code, 'not_eligible');
});

// ── 通しの状態遷移 ─────────────────────────────────────
test('通しで: 申込 → 承認 → 初回支払いで付与（PlanType=Annual・支払い日 +12 か月 +2 日）→ Webhook 再送・同時でも 1 回', async () => {
  const w = world();
  const c = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium-annual' });
  assert.equal(c.ok, true);
  assert.equal(w.subs[c.subscriptionId].plan_id, PID['premium-annual']);
  assert.equal((await confirmPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId, recordId: REC })).body.status, 'pending');
  assert.equal(w.patches.length, 0, '承認前は何も書かない');
  w.pay(c.subscriptionId);
  const r = await confirmPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId, recordId: REC });
  assert.deepEqual(r.body, { status: 'active', plan: 'premium-annual' });
  assert.deepEqual(
    [w.fields['プラン'], w.fields.PlanType, w.fields.Status, w.fields.PaymentMethod, w.fields.VenueAccess, w.fields['有効期限']],
    ['Premium', 'Annual', 'active', 'PayPal', '', '2027-10-22'],
  );
  assert.equal(w.redis.get(memberKey(REC)), c.subscriptionId);
  await Promise.all([1, 2, 3].map(() => handlePaypalSubscriptionEvent({ ...common(w), event: { event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: c.subscriptionId } } })));
  await handlePaypalSubscriptionEvent({ ...common(w), event: { event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'SALE1', billing_agreement_id: c.subscriptionId } } });
  assert.equal(w.fields['有効期限'], '2027-10-22');
  assert.equal(w.patches.filter((p) => p.PaidAt).length, 1, '付与は 1 回だけ');
  assert.equal(w.notes.filter((n) => n[0] === 'subscription_attached').length, 1);
  assert.equal(isPaypalSubscriber(w.fields), true);
  assert.equal(classifyMemberWithdrawal(w.fields, NOW.getTime()).kind, 'paypal', '年額もマイページの退会で自動課金を止められる');
});

test('毎年の更新: 翌年の支払いで 12 か月延びる・決済失敗では延びない・SUSPENDED は書かない（期限で自然に止まる）', async () => {
  const w = world();
  const c = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium-annual' });
  w.pay(c.subscriptionId);
  await applyPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId });
  assert.equal(w.fields['有効期限'], '2027-10-22');
  // 更新日の決済失敗（ACTIVE のまま next_billing_time だけ進む）→ 延びない
  w.subs[c.subscriptionId].billing_info.next_billing_time = '2028-10-20T10:00:00Z';
  const later = new Date('2027-10-20T03:00:00Z');
  await handlePaypalSubscriptionEvent({ ...common(w, later), event: { event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED', resource: { id: c.subscriptionId } } });
  assert.equal(w.fields['有効期限'], '2027-10-22');
  // 翌年の支払い → 2028-10-20 + 2 日
  w.pay(c.subscriptionId, new Date('2027-10-21T03:00:00Z'));
  const r = await handlePaypalSubscriptionEvent({ ...common(w, later), event: { event_type: 'PAYMENT.SALE.COMPLETED', resource: { id: 'SALE2', billing_agreement_id: c.subscriptionId } } });
  assert.equal(r.result, 'write_renewed');
  assert.equal(w.fields['有効期限'], '2028-10-23');
  assert.equal(w.fields.PlanType, 'Annual');
  w.subs[c.subscriptionId].status = 'SUSPENDED';
  assert.equal((await applyPaypalSubscription({ ...common(w, later), subscriptionId: c.subscriptionId })).reason, 'status_suspended');
  assert.equal(w.fields['有効期限'], '2028-10-23');
});

test('PayPal 側での解約・決済失敗の上限による終了: 支払い済みの 12 か月の翌日まで（縮めるだけ・延ばさない）', async () => {
  const w = world();
  const c = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium-annual' });
  w.pay(c.subscriptionId);
  await applyPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId });
  w.subs[c.subscriptionId].status = 'CANCELLED';
  const r = await handlePaypalSubscriptionEvent({ ...common(w), event: { event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: c.subscriptionId } } });
  assert.equal(r.result, 'write_ended');
  assert.equal(w.fields['有効期限'], '2027-10-21', '支払い済みの最終日（2027-10-20）の翌日まで');
  assert.ok(w.fields.CancelledAt);
  // 再送・EXPIRED でも延びない
  w.subs[c.subscriptionId].status = 'EXPIRED';
  await handlePaypalSubscriptionEvent({ ...common(w), event: { event_type: 'BILLING.SUBSCRIPTION.EXPIRED', resource: { id: c.subscriptionId } } });
  assert.equal(w.fields['有効期限'], '2027-10-21');
});

test('マイページの退会: 年額も購読を cancel し即時終了（現行の退会仕様）・二重退会しない', async () => {
  const w = world();
  const c = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium-annual' });
  w.pay(c.subscriptionId);
  await applyPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId });
  const r = await withdrawPaypalSubscriber({ ...common(w), recordId: REC, reason: 'test' });
  assert.equal(r.result, 'withdrawn');
  assert.deepEqual(w.cancels, [c.subscriptionId]);
  assert.equal(w.fields.WithdrawalRequested, true);
  assert.equal(w.fields['有効期限'], '2026-10-19');
  assert.equal((await withdrawPaypalSubscriber({ ...common(w), recordId: REC })).result, 'already_withdrawn');
  await handlePaypalSubscriptionEvent({ ...common(w), event: { event_type: 'BILLING.SUBSCRIPTION.CANCELLED', resource: { id: c.subscriptionId } } });
  assert.equal(w.fields['有効期限'], '2026-10-19', '後から届く解約通知で延ばさない');
});

test('【重要】二重課金: 生きている購読があれば 2 本目の年額は申込で止め、成立してしまっても権限を書かず管理者へ', async () => {
  const w = world();
  const a = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium' });
  w.pay(a.subscriptionId);
  await applyPaypalSubscription({ ...common(w), subscriptionId: a.subscriptionId });
  assert.equal(w.fields.PlanType, 'Monthly');
  // 月額が生きている間は年額の申込を作らない
  const b = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium-annual' });
  assert.deepEqual([b.ok, b.code], [false, 'already_subscribed']);
  // 別経路で年額が成立してしまった（PayPal 側の画面など）→ 書かない・通知
  const id = 'I-ANNUAL999999';
  w.subs[id] = { id, status: 'ACTIVE', plan_id: PID['premium-annual'], custom_id: `${REC}:Y`, billing_info: { last_payment: { amount: { currency_code: 'JPY', value: '49800' }, time: NOW.toISOString() } } };
  const before = { ...w.fields };
  const r = await applyPaypalSubscription({ ...common(w), subscriptionId: id });
  assert.deepEqual([r.action, r.reason], ['conflict', 'duplicate_subscription']);
  assert.deepEqual(w.fields, before);
  assert.equal(w.redis.get(memberKey(REC)), a.subscriptionId, '会員の購読は元のまま');
  assert.ok(w.notes.some((n) => n[0] === 'subscription_conflict' && n[1] === 'duplicate_subscription'));
});

test('【重要】反映時も: 有効な銀行振込の Premium・買い切り・Light 資格なし・金額違いには権限を書かない', () => {
  const sub = (planId, amount = ANNUAL_SUBSCRIPTION_PLANS.find((p) => p.id === planId).amountYen) => ({
    id: 'I-ANNUAL000777', status: 'ACTIVE', paypalPlanId: PID[planId], recordId: REC, planId,
    lastPayment: { currency: 'JPY', amount, time: NOW }, memberWithdrawal: false,
  });
  const d = (fields, s) => decidePaypalSubscriptionSync({ fields, sub: s, mode: 'test', now: NOW });
  assert.equal(d({ 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2027-01-01' }, sub('premium-annual')).reason, 'existing_paid_membership');
  assert.equal(d({ 'プラン': 'Premium', PlanType: 'Lifetime', Status: 'active' }, sub('premium-annual')).reason, 'existing_lifetime');
  assert.equal(d({ 'プラン': 'Free' }, sub('premium-annual-light')).reason, 'not_eligible');
  assert.equal(d(LIGHT_ACTIVE, sub('premium-annual-light')).action, 'write');
  assert.equal(d({ 'プラン': 'Free' }, sub('premium-annual', 44820)).reason, 'amount_mismatch');
  assert.equal(d({ 'プラン': 'Free' }, { ...sub('premium-annual'), paypalPlanId: 'P-UNKNOWN' }).reason, 'unknown_plan');
  // 自分の購読の更新（owned）は特典の資格を見直さない（同じ金額で更新する）
  const owned = decidePaypalSubscriptionSync({ fields: { 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', PaymentMethod: 'PayPal', '有効期限': '2026-10-22' }, sub: sub('premium-annual-light'), mode: 'test', ownedSubId: 'I-ANNUAL000777', now: NOW });
  assert.deepEqual([owned.action, owned.reason, owned.fields['有効期限']], ['write', 'renewed', '2027-10-22']);
});

test('返金・リバーサルは権限を自動で戻さず管理者へ（月額と同じ）', async () => {
  const w = world();
  const c = await createPaypalSubscription({ ...common(w), recordId: REC, planId: 'premium-annual' });
  w.pay(c.subscriptionId);
  await applyPaypalSubscription({ ...common(w), subscriptionId: c.subscriptionId });
  const exp = w.fields['有効期限'];
  const r = await handlePaypalSubscriptionEvent({ ...common(w), event: { event_type: 'PAYMENT.SALE.REFUNDED', resource: { id: 'R1', billing_agreement_id: c.subscriptionId } } });
  assert.equal(r.result, 'refund_notified');
  assert.equal(w.fields['有効期限'], exp);
});

test('年額の会員には月払いの更新リマインド・銀行振込の期限通知を送らない（自動更新）・年額の新しいメールは作らない', async () => {
  const { isPaidPremiumMonthly } = await import('../../marketing/premiumRenewal/premiumRenewalPolicy.js');
  const f = { 'プラン': 'Premium', PlanType: 'Annual', PaymentMethod: 'PayPal', PaidAt: '2026-10-20', Status: 'active', Email: 'a@example.com', '有効期限': '2027-10-22' };
  assert.equal(isPaidPremiumMonthly(f).ok, false);
  for (const fn of ['expiry-warning-notification.js', 'expiry-notification.js']) {
    assert.match(readFileSync(new URL(`../../../../netlify/functions/${fn}`, import.meta.url), 'utf8'), /\{PaymentMethod\} = 'Bank Transfer'/, fn);
  }
});
