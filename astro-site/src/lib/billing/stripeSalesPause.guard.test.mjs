/**
 * Stripe アカウントが決済を受け付けない間（2026-10-11 閉鎖通知）の新規申込の止め方を固定する。
 * - stripe-create-checkout は、顧客レコードの読込・Stripe 操作より前に販売ゲート（stripeSalesGate の単一源）で止める
 * - /pricing/ は汎用エラーではなく「カード決済の一時停止」と既存の銀行振込の入口を示す
 * - 再有効化は scheduled-checks が毎日検知する（人の記憶に頼らない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkStripeLiveSales } from './stripeSalesGate.js';
import { renderStripeActivationMarkdown } from '../ops/stripeActivationCheck.js';
import { validateRegistry } from '../ops/scheduledChecks.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('create-checkout: 販売ゲートは顧客レコード・Stripe 操作より前にあり、閉じていれば 503 stripe_sales_paused', () => {
  const code = stripComments(read('../../../netlify/functions/stripe-create-checkout.js'));
  const gate = code.indexOf('await checkStripeLiveSales(env)');
  assert.ok(gate > 0, '販売ゲートが無い');
  for (const later of ['readSessionRecordId(', 'await airtableGet(', 'stripe.subscriptions.retrieve(', 'stripe.checkout.sessions.create(']) {
    const at = code.indexOf(later);
    assert.ok(at > gate, `${later} が販売ゲートより前にある`);
  }
  assert.match(code, /if \(!sales\.open\)[\s\S]{0,200}json\(503, headers, \{ error: 'stripe_sales_paused' \}\)/);
});

test('販売ゲート: 閉鎖・審査・読めない・鍵なしはすべて受付不可（fail closed）', async () => {
  const fake = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });
  const K = { STRIPE_SECRET_KEY: 'rk_live_x' };
  assert.equal((await checkStripeLiveSales(K, { fetchImpl: fake({ charges_enabled: false, capabilities: { card_payments: 'inactive' } }) })).open, false);
  assert.equal((await checkStripeLiveSales(K, { fetchImpl: fake({}, false, 401) })).open, false); // 閉鎖で鍵が無効化
  assert.equal((await checkStripeLiveSales(K, { fetchImpl: async () => { throw new Error('x'); } })).open, false);
  assert.equal((await checkStripeLiveSales({})).open, false);
  assert.equal((await checkStripeLiveSales(K, { fetchImpl: fake({ charges_enabled: true, capabilities: { card_payments: 'active' } }) })).open, true);
});

test('scheduled-checks: 再有効化の検知が登録され、完了時の次の作業は登録の next を使う', () => {
  const reg = JSON.parse(read('../../../../ops/scheduled-checks.json'));
  assert.deepEqual(validateRegistry(reg), []);
  const c = reg.checks.find((x) => x.id === 'stripe-live-reactivation-2026');
  assert.ok(c);
  assert.equal(c.kind, 'stripe-live-activation');
  const md = renderStripeActivationMarkdown({ check: c, result: { ranAt: 'T', chargesEnabled: true, cardPayments: 'active', payoutsEnabled: true } });
  assert.ok(md.includes(c.next));
  assert.equal(md.includes('#677'), false);
});
