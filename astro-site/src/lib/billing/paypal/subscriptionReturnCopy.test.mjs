/** PayPal 定期課金の戻り先の文言: 全商品に文言があり、年額に「毎月」と出さない（2026-10-21 の誤表示の再発防止）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUBSCRIPTION_PLANS } from './paypalSubscriptionCore.js';
import { SUBSCRIPTION_RETURN_COPY, buildSubscriptionReturnCopy } from './subscriptionReturnCopy.js';

test('every subscription product has return copy', () => {
  for (const p of SUBSCRIPTION_PLANS) assert.ok(SUBSCRIPTION_RETURN_COPY[p.id], p.id);
});

test('annual products say yearly renewal, never monthly', () => {
  for (const id of ['premium-annual', 'premium-annual-light']) {
    const c = SUBSCRIPTION_RETURN_COPY[id];
    assert.match(c.text, /1 年ごとに自動で更新されます/);
    assert.doesNotMatch(c.text, /毎月/);
    assert.deepEqual(c.links.map((l) => l[1]), ['/premium-prediction/jra/', '/premium-prediction/nankan/']);
  }
});

test('monthly products say monthly renewal and link only their venues', () => {
  assert.match(SUBSCRIPTION_RETURN_COPY['premium'].text, /毎月自動で更新されます/);
  assert.deepEqual(SUBSCRIPTION_RETURN_COPY['premium-jra'].links.map((l) => l[1]), ['/premium-prediction/jra/']);
  assert.deepEqual(SUBSCRIPTION_RETURN_COPY['premium-nankan'].links.map((l) => l[1]), ['/premium-prediction/nankan/']);
});

test('a product without copy fails the build instead of falling back to monthly wording', () => {
  assert.throws(() => buildSubscriptionReturnCopy([{ id: 'premium-new', interval: 'YEAR', venues: ['jra'] }]), /premium-new/);
});

test('the return page uses the copy module and no hard-coded renewal wording', () => {
  const page = readFileSync(fileURLToPath(new URL('../../../pages/checkout/paypal-subscription-return.astro', import.meta.url)), 'utf8');
  assert.match(page, /SUBSCRIPTION_RETURN_COPY/);
  assert.doesNotMatch(page, /毎月自動で更新されます/);
  assert.match(page, /purchaseCompleted\(x\.d\.plan, subscription, 'paypal'\)/);
});

test('未ログインの方の案内: お申し込みのメールでログインする手順を出し、確認できないときは完了と言わない', async () => {
  const { SUBSCRIPTION_RETURN_GUEST: g } = await import('./subscriptionReturnCopy.js');
  for (const t of [g.activeNext, g.loginRequired.text, g.timeoutText]) assert.match(t, /お申し込みのメールアドレス/);
  // 購入完了（反映済み）はログイン画面へ自動で移る（購入直後の案内つき）。確認できないときは従来のログイン＋問い合わせ
  assert.deepEqual(g.activeLinks.map((l) => l[1]), ['/login/?from=paypal']);
  assert.equal(g.activeRedirect, '/login/?from=paypal');
  assert.deepEqual(g.loginRequired.links.map((l) => l[1]), ['/login/?next=/dashboard/']);
  assert.deepEqual(g.timeoutLinks.map((l) => l[1]), ['/login/?next=/dashboard/', '/contact/']);
  assert.doesNotMatch(`${g.loginRequired.title}${g.loginRequired.text}`, /完了しました|ご利用いただけます。/);
  assert.match(g.loginRequired.text, /お支払いが完了していれば/);
});
