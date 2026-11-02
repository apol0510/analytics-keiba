/**
 * 更新リマインドのゲートは「実際に開いている月額の経路」で判定する（2026-10-20）。
 * 旧ゲートは Stripe（MONTHLY_SALES_OPEN=false）だけを見て、PayPal 月額が 2026-10-15 に開いた後も常に dry-run だった。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveMonthlySalesChannel, MONTHLY_PROVIDER_LABEL } from './monthlySalesChannel.js';
import { gateModeOnStripeSales } from './stripeSalesGate.js';
import { SUBSCRIPTION_SALES_OPEN, ACTIVE_SUBSCRIPTION_PROVIDER } from './cardSales.js';
import { MONTHLY_SALES_OPEN } from './stripePlans.js';
import { subscriptionProviderCopy } from './subscriptionProviderCopy.js';
/** 料金ページの決済会社別の説明（{providerCopy.x}）を受付先（ACTIVE）の値で展開する（2026-11-02・subscriptionProviderCopy.js）*/
const expandProviderCopy = (src) => src.replace(/\{providerCopy\.(\w+)\}/g, (_, k) => subscriptionProviderCopy()[k]);

const LIVE = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_ENV: 'live' };
const noFetch = async () => { throw new Error('Stripe を呼んではいけない'); };
/** PayPal で受け付けていた期間（2026-10-15〜11-02）の判定を名指しで確かめる（受付先の切替に依らない）*/
const PP = { subscriptionOpen: { paypal: true }, activeProvider: 'paypal' };
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('前提: 新規の月額は ACTIVE の 1 社（2026-10-15 PayPal → 2026-11-02 MK 確定で Paddle へ一本化）・Stripe の新規月払いは閉じたまま', () => {
  assert.equal(SUBSCRIPTION_SALES_OPEN[ACTIVE_SUBSCRIPTION_PROVIDER], true);
  assert.deepEqual(Object.entries(SUBSCRIPTION_SALES_OPEN).filter(([, v]) => v).map(([k]) => k), [ACTIVE_SUBSCRIPTION_PROVIDER]);
  assert.equal(MONTHLY_SALES_OPEN, false);
});

test('Paddle（2026-11-02〜）: 本番は鍵を持たず委譲の内部鍵があれば開いている・どちらも無ければ閉じている', async () => {
  const opts = { fetchImpl: noFetch, subscriptionOpen: { paddle: true }, activeProvider: 'paddle' };
  assert.deepEqual(await resolveMonthlySalesChannel({ CARD_GRANT_INTERNAL_SECRET: 's' }, opts), { open: true, provider: 'paddle', reason: 'ok' });
  assert.equal((await resolveMonthlySalesChannel({}, opts)).reason, 'paddle_key_missing');
  assert.equal((await resolveMonthlySalesChannel({ PADDLE_API_KEY: 'pdl_sdbx_apikey_x' }, opts)).reason, 'test_key_on_production');
});

test('PayPal 月額が開いていて本番鍵があれば開いている（Stripe は見ない）→ live のまま', async () => {
  const s = await resolveMonthlySalesChannel(LIVE, { fetchImpl: noFetch, ...PP });
  assert.deepEqual(s, { open: true, provider: 'paypal', reason: 'ok' });
  assert.equal(gateModeOnStripeSales('live', s), 'live');
});

test('fail closed: 鍵なし・Sandbox 鍵・受付を閉じた・どの経路も無い → dry-run（広げる方向に変えない）', async () => {
  const cases = [
    [await resolveMonthlySalesChannel({}, { fetchImpl: noFetch, ...PP }), 'paypal_key_missing'],
    [await resolveMonthlySalesChannel({ ...LIVE, PAYPAL_ENV: 'sandbox' }, { fetchImpl: noFetch, ...PP }), 'test_key_on_production'],
    [await resolveMonthlySalesChannel({ ...LIVE, PAYPAL_ENV: '' }, { fetchImpl: noFetch, ...PP }), 'paypal_key_missing'],
    [await resolveMonthlySalesChannel(LIVE, { fetchImpl: noFetch, subscriptionOpen: { paypal: false }, activeProvider: 'paypal' }), 'monthly_sales_ended'],
    [await resolveMonthlySalesChannel(LIVE, { fetchImpl: noFetch, activeProvider: 'unknown', subscriptionOpen: { unknown: true } }), 'paypal_key_missing'.replace('paypal', 'unknown')],
  ];
  for (const [s, reason] of cases) {
    assert.equal(s.open, false, reason);
    assert.equal(s.reason, reason);
    assert.equal(gateModeOnStripeSales('live', s), 'dry-run');
  }
  // off / dry-run は開いていても広げない
  const open = await resolveMonthlySalesChannel(LIVE, { fetchImpl: noFetch, ...PP });
  assert.equal(gateModeOnStripeSales('off', open), 'off');
  assert.equal(gateModeOnStripeSales('dry-run', open), 'dry-run');
});

test('PayPal が閉じていて Stripe 月払いが開いていれば、従来どおり Stripe の live 決済で判定する', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ charges_enabled: true, capabilities: { card_payments: 'active' } }) });
  const ng = async () => ({ ok: true, json: async () => ({ charges_enabled: false, requirements: { disabled_reason: 'x' } }) });
  const env = { STRIPE_SECRET_KEY: 'rk_live_x' };
  const opts = { subscriptionOpen: { paypal: false }, stripeMonthlyOpen: true };
  assert.deepEqual(await resolveMonthlySalesChannel(env, { ...opts, fetchImpl: ok }), { open: true, provider: 'stripe', reason: 'ok' });
  assert.equal((await resolveMonthlySalesChannel(env, { ...opts, fetchImpl: ng })).open, false);
});

test('両方の cron が同じ経路判定を使い、Stripe だけのゲートに戻らない（受信者の判定・送信の流れは変えない）', () => {
  for (const [f, runner] of [['cron-premium-renewal-reminder.js', 'runPremiumRenewal'], ['cron-light-renewal-reminder.js', 'runLightRenewal']]) {
    const code = stripComments(read(`../../../netlify/functions/${f}`));
    assert.match(code, /const sales = await resolveMonthlySalesChannel\(process\.env\);/, f);
    assert.match(code, /const mode = gateModeOnStripeSales\(resolveMode\(process\.env\), sales\);/, f);
    assert.equal(/MONTHLY_SALES_OPEN|checkStripeLiveSales/.test(code), false, `${f}: Stripe だけのゲートが残っている`);
    assert.match(code, new RegExp(`await ${runner}\\(\\{ mode, env: process\\.env, nowMs: Date\\.now\\(\\), redisCmd \\}\\)`), f);
  }
});

test('案内文の決済代行は月額を受け付けている決済会社（/pricing/ の注記と同じ）', () => {
  // 受付先（ACTIVE）の名前と料金ページの注記が一致する（Paddle へ切り替えると両方 Paddle になる・2026-11-02）
  assert.equal(MONTHLY_PROVIDER_LABEL[ACTIVE_SUBSCRIPTION_PROVIDER], subscriptionProviderCopy().label);
  assert.match(expandProviderCopy(read('../../pages/pricing.astro')), new RegExp(`自動継続のお支払い（決済代行：${MONTHLY_PROVIDER_LABEL[ACTIVE_SUBSCRIPTION_PROVIDER]}）`));
});
