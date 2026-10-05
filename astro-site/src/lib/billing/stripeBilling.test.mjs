import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STRIPE_PLANS, planById, priceIdFor, planFromPriceId, venueAccessValue, isFullPremiumPlan, hasStripeSecret,
} from './stripePlans.js';
import {
  snapshotSubscription, decideSubscriptionSync, expirationFromPeriodEnd, expirationAfterEnd, paidThroughFromInvoices,
} from './stripeSubscriptionSync.js';

/** 既定では「今の請求期間は支払い済み」（paidThrough = 期間末）として判定する */
const decide = (args) => decideSubscriptionSync({ paidThrough: args.sub?.currentPeriodEnd ?? null, ...args });

const ENV = {
  STRIPE_PRICE_PREMIUM: 'price_full',
  STRIPE_PRICE_PREMIUM_JRA: 'price_jra',
  STRIPE_PRICE_PREMIUM_NANKAN: 'price_nankan',
};
const NOW = new Date('2026-10-02T03:00:00Z'); // 12:00 JST
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);

function sub({ id = 'sub_1', status = 'active', price = 'price_full', periodEnd = '2026-11-02T03:00:00Z', endedAt } = {}) {
  return snapshotSubscription({
    id, status, customer: 'cus_1',
    items: { data: [{ price: { id: price }, current_period_end: sec(periodEnd) }] },
    ended_at: endedAt ? sec(endedAt) : null,
  });
}

test('プラン: 3 商品・金額・会場', () => {
  assert.deepEqual(STRIPE_PLANS.map((p) => [p.id, p.amountYen]), [
    ['premium', 4980], ['premium-jra', 2980], ['premium-nankan', 2980],
  ]);
  // 両方買うより Premium の方が安い（「両方ならお得」の前提）
  assert.ok(planById('premium').amountYen < planById('premium-jra').amountYen + planById('premium-nankan').amountYen);
  assert.equal(venueAccessValue('premium'), '');
  assert.equal(venueAccessValue('premium-jra'), 'jra');
  assert.equal(venueAccessValue('premium-nankan'), 'nankan');
  assert.equal(isFullPremiumPlan('premium'), true);
  assert.equal(isFullPremiumPlan('premium-jra'), false);
  assert.equal(planById('light'), null);
});

test('プラン: Price ID は env 登録分だけ・未設定は null', () => {
  assert.equal(priceIdFor('premium', ENV), 'price_full');
  assert.equal(priceIdFor('premium', {}), null);
  assert.equal(planFromPriceId('price_jra', ENV).id, 'premium-jra');
  assert.equal(planFromPriceId('price_other', ENV), null);
  assert.equal(planFromPriceId('', ENV), null);
  assert.equal(hasStripeSecret({ STRIPE_SECRET_KEY: 'sk_test_abc' }), true);
  assert.equal(hasStripeSecret({ STRIPE_SECRET_KEY: 'pk_test_abc' }), false);
  assert.equal(hasStripeSecret({}), false);
});

test('期限: 請求期間の終わり + 猶予 2 日（JST 暦日）', () => {
  // 2026-11-02 12:00 JST + 2日 = 11-04
  assert.equal(expirationFromPeriodEnd(sec('2026-11-02T03:00:00Z')), '2026-11-04');
  // JST 深夜（UTC 前日）でも JST の暦日
  assert.equal(expirationFromPeriodEnd(sec('2026-11-01T16:30:00Z')), '2026-11-04');
  assert.equal(expirationFromPeriodEnd(null), null);
});

test('snapshot: 旧 API 形（subscription 直下の current_period_end）も読む', () => {
  const s = snapshotSubscription({ id: 'sub_x', status: 'active', customer: { id: 'cus_x' }, current_period_end: 100, items: { data: [{ plan: { id: 'price_full' } }] } });
  assert.equal(s.customerId, 'cus_x');
  assert.equal(s.priceId, 'price_full');
  assert.equal(s.currentPeriodEnd, 100);
});

test('新規契約: 無料会員 → Premium（両会場）', () => {
  const r = decide({ fields: { 'プラン': 'Free' }, sub: sub(), env: ENV, now: NOW });
  assert.equal(r.action, 'write');
  assert.equal(r.newlyAttached, true);
  assert.equal(r.fields['プラン'], 'Premium');
  assert.equal(r.fields.PlanType, 'Monthly');
  assert.equal(r.fields.Status, 'active');
  assert.equal(r.fields['有効期限'], '2026-11-04');
  assert.equal(r.fields.VenueAccess, '');
  assert.equal(r.fields.PaymentMethod, 'Stripe');
  assert.equal(r.fields.StripeSubscriptionId, 'sub_1');
  assert.equal(r.fields.StripeCustomerId, 'cus_1');
  assert.equal(r.fields.PaidAt, NOW.toISOString());
  assert.equal(r.fields.WithdrawalRequested, false);
});

test('新規契約: 中央版は VenueAccess=jra', () => {
  const r = decide({ fields: {}, sub: sub({ price: 'price_jra' }), env: ENV, now: NOW });
  assert.equal(r.fields.VenueAccess, 'jra');
  assert.equal(r.plan.id, 'premium-jra');
});

test('更新（同じ購読）: 期限だけ延びる・PaidAt を上書きしない', () => {
  const fields = { 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-11-04', StripeSubscriptionId: 'sub_1', PaidAt: 'X' };
  const r = decide({ fields, sub: sub({ periodEnd: '2026-12-02T03:00:00Z' }), env: ENV, now: NOW });
  assert.equal(r.reason, 'renewed');
  assert.equal(r.fields['有効期限'], '2026-12-04');
  assert.equal('PaidAt' in r.fields, false);
  assert.equal(r.newlyAttached, false);
});

test('冪等: 同じ入力を 2 回通しても同じ書き込み', () => {
  const fields = { StripeSubscriptionId: 'sub_1' };
  const a = decide({ fields, sub: sub(), env: ENV, now: NOW });
  const b = decide({ fields, sub: sub(), env: ENV, now: NOW });
  assert.deepEqual(a, b);
});

test('プラン変更（ポータル）: 中央版 → Premium で VenueAccess が両会場へ', () => {
  const fields = { 'プラン': 'Premium', StripeSubscriptionId: 'sub_1', VenueAccess: 'jra' };
  const r = decide({ fields, sub: sub({ price: 'price_full' }), env: ENV, now: NOW });
  assert.equal(r.fields.VenueAccess, '');
});

test('未知の Price では権限を付けない', () => {
  const r = decide({ fields: {}, sub: sub({ price: 'price_x' }), env: ENV, now: NOW });
  assert.equal(r.action, 'conflict');
  assert.equal(r.reason, 'unknown_price');
});

test('二重課金防止: 別の購読が生きていれば書かない', () => {
  const fields = { StripeSubscriptionId: 'sub_old' };
  const r = decide({ fields, sub: sub(), env: ENV, now: NOW, otherSubscriptionLive: true });
  assert.equal(r.reason, 'duplicate_subscription');
  // 古い購読が終わっていれば乗り換えとして書く
  const ok = decide({ fields, sub: sub(), env: ENV, now: NOW, otherSubscriptionLive: false });
  assert.equal(ok.action, 'write');
});

test('買い切り会員は月額に化けさせない', () => {
  const fields = { 'プラン': 'Premium', PlanType: 'Lifetime', Status: 'active' };
  const r = decide({ fields, sub: sub(), env: ENV, now: NOW });
  assert.equal(r.reason, 'existing_lifetime');
});

test('年払い残りが長い Premium は縮めない（会場限定でも）', () => {
  const fields = { 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2027-05-01' };
  assert.equal(decide({ fields, sub: sub(), env: ENV, now: NOW }).reason, 'existing_longer_contract');
  assert.equal(decide({ fields, sub: sub({ price: 'price_jra' }), env: ENV, now: NOW }).reason, 'existing_longer_contract');
  // 年払いの残りが今回の期限より短い（継続のための切替）なら書く
  const near = { ...fields, '有効期限': '2026-10-10' };
  assert.equal(decide({ fields: near, sub: sub(), env: ENV, now: NOW }).action, 'write');
});

test('Light 会員の乗り換え: 書く', () => {
  const fields = { 'プラン': 'Light', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-10-20' };
  assert.equal(decide({ fields, sub: sub(), env: ENV, now: NOW }).action, 'write');
});

test('三連複買い切り（LifetimeSanrenpuku）には触れない', () => {
  const r = decide({ fields: { LifetimeSanrenpuku: true }, sub: sub(), env: ENV, now: NOW });
  assert.equal('LifetimeSanrenpuku' in r.fields, false);
});

test('終了（期間末の解約）: 支払い済み期間の終わりまで残し、猶予分だけ縮める（延ばさない）', () => {
  const fields = { StripeSubscriptionId: 'sub_1', '有効期限': '2026-11-04' };
  const r = decide({ fields, sub: sub({ status: 'canceled', endedAt: '2026-11-02T03:00:00Z' }), env: ENV, now: NOW });
  assert.equal(r.action, 'write');
  // 支払い済みの終わり 11/02 12:00 JST → 11/03 09:00 JST まで見られる（その前に切らない）
  assert.equal(r.fields['有効期限'], '2026-11-03');
  assert.equal(r.fields.CancelledAt, NOW.toISOString());
  const earlier = decide({ fields: { ...fields, '有効期限': '2026-10-01' }, sub: sub({ status: 'canceled', endedAt: '2026-11-02T03:00:00Z' }), env: ENV, now: NOW });
  assert.equal(earlier.fields['有効期限'], '2026-10-01');
});

test('終了: 他人（記録と違う購読）の終了では何もしない', () => {
  const r = decide({ fields: { StripeSubscriptionId: 'sub_new' }, sub: sub({ status: 'canceled' }), env: ENV, now: NOW });
  assert.equal(r.action, 'skip');
});

test('支払い待ち・未完了は書かない（期限で自然に止まる）', () => {
  for (const status of ['past_due', 'incomplete', 'paused']) {
    assert.equal(decide({ fields: {}, sub: sub({ status }), env: ENV, now: NOW }).action, 'skip');
  }
});

test('Price ID・ポータル設定は鍵のモードでコードの値を使う（env は秘密 2 つだけで足りる・Lambda 4KB 対策）', async () => {
  const { STRIPE_IDS, stripeModeOf, portalConfigurationFor } = await import('./stripePlans.js');
  assert.equal(stripeModeOf({ STRIPE_SECRET_KEY: 'rk_live_x' }), 'live');
  assert.equal(stripeModeOf({ STRIPE_SECRET_KEY: 'sk_test_x' }), 'test');
  assert.equal(stripeModeOf({}), null);
  for (const mode of ['test', 'live']) {
    const env = { STRIPE_SECRET_KEY: mode === 'live' ? 'sk_live_x' : 'sk_test_x' };
    for (const p of STRIPE_PLANS) {
      assert.match(priceIdFor(p, env), /^price_/);
      assert.equal(planFromPriceId(priceIdFor(p, env), env).id, p.id);
    }
    assert.match(portalConfigurationFor(env), /^bpc_/);
  }
  // test と live の ID は混ざらない
  assert.equal(planFromPriceId(STRIPE_IDS.live.prices.premium, { STRIPE_SECRET_KEY: 'sk_test_x' }), null);
  // 鍵が無ければ何も返さない（推測しない）
  assert.equal(priceIdFor('premium', {}), null);
});

test('Stripe の Product 名（Checkout・領収書・明細に出る）は productName が単一源で、競馬固有の語を含まない', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  assert.deepEqual(STRIPE_PLANS.map((p) => p.productName), [
    'Analytics Premium（中央＋南関）', 'Analytics Premium 中央', 'Analytics Premium 南関',
  ]);
  for (const p of STRIPE_PLANS) assert.equal(/KEIBA|keiba|競馬|JRA|予想|馬券/.test(p.productName), false, p.productName);
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  // セットアップと Checkout はどちらも productName を使う（文字列を組み立て直さない）
  assert.match(read('../../../scripts/stripe-setup.mjs'), /name: plan\.productName/);
  assert.match(read('../../../netlify/functions/stripe-create-checkout.js'), /description: plan\.productName/);
  for (const f of ['../../../scripts/stripe-setup.mjs', '../../../netlify/functions/stripe-create-checkout.js']) {
    assert.equal(/KEIBA Analytics \$\{plan/.test(read(f)), false, `${f}: 旧商品名の組み立てが残っている`);
  }
});
