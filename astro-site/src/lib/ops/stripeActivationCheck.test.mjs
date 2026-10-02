import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStripeActivationCheck, summarizeAccount } from './stripeActivationCheck.js';

const res = (status, body) => ({ status, ok: status < 400, json: async () => body });

test('審査中は待機（stripe_charges_not_enabled）', async () => {
  const f = async () => res(200, { charges_enabled: false, capabilities: { card_payments: 'inactive' }, requirements: { disabled_reason: 'under_review', pending_verification: ['x'] } });
  await assert.rejects(runStripeActivationCheck({ key: 'rk_live_x', fetchImpl: f }), (e) => e.code === 'stripe_charges_not_enabled' && /under_review/.test(e.detail));
});

test('有効になれば完了', async () => {
  const f = async () => res(200, { charges_enabled: true, payouts_enabled: true, capabilities: { card_payments: 'active' }, requirements: {} });
  const r = await runStripeActivationCheck({ key: 'sk_live_x', fetchImpl: f, nowIso: 'T' });
  assert.equal(r.chargesEnabled, true);
  assert.equal(r.cardPayments, 'active');
});

test('鍵なし・テスト鍵・認証失敗は失敗', async () => {
  await assert.rejects(runStripeActivationCheck({ key: '' }), (e) => e.code === 'stripe_key_missing');
  await assert.rejects(runStripeActivationCheck({ key: 'sk_test_x' }), (e) => e.code === 'stripe_key_missing');
  await assert.rejects(runStripeActivationCheck({ key: 'rk_live_x', fetchImpl: async () => res(401, {}) }), (e) => e.code === 'stripe_auth_failed');
});

test('要約は状態だけ（口座・本人情報を持ち出さない）', () => {
  const s = summarizeAccount({ charges_enabled: false, external_accounts: { data: [{ last4: '1234' }] }, individual: { first_name: 'x' } });
  assert.equal(JSON.stringify(s).includes('1234'), false);
  assert.deepEqual(Object.keys(s).sort(), ['cardPayments', 'chargesEnabled', 'currentlyDue', 'disabledReason', 'payoutsEnabled', 'pendingVerification']);
});
