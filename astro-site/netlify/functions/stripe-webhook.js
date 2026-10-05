/**
 * stripe-webhook — Stripe のイベントを Customers へ反映する
 *
 * 購読に関わるイベントはすべて「その購読を Stripe から読み直して、同じ判定で絶対値を書く」に寄せる
 * （stripeServer.applySubscription）。届く順番・重複・再送に関係なく同じ結果になる。
 *
 * | イベント | 何をするか |
 * |---|---|
 * | checkout.session.completed | 初回の付与 |
 * | customer.subscription.created / updated / deleted | 付与・プラン変更（ポータル）・終了 |
 * | invoice.paid / invoice.payment_succeeded | 毎月の更新で有効期限を延ばす |
 * | invoice.payment_failed | 何も書かない（期限で自然に止まる。Stripe が再試行する）|
 *
 * 応答: 反映・対象外・要確認（管理者へ通知済み）は 200。一時的な失敗は 500（Stripe が再送する）。
 */

import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable API の呼び出し回数を Function 別に数える（月 100,000 回の上限管理 / docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'stripe-webhook' });
import {
  getStripe, rawBody, stripeMode,
} from '../../src/lib/billing/stripeRuntime.js';
import { applySubscription, subscriptionIdFromEvent } from '../../src/lib/billing/stripeServer.js';
import { makeStripeNotifier } from '../../src/lib/billing/stripeNotify.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const env = process.env;
  const stripe = getStripe(env);
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return reply(503, { error: 'not_configured' });

  let evt;
  try {
    const sig = event.headers?.['stripe-signature'] || event.headers?.['Stripe-Signature'] || '';
    evt = stripe.webhooks.constructEvent(rawBody(event), sig, secret);
  } catch {
    return reply(400, { error: 'invalid_signature' });
  }

  const subId = subscriptionIdFromEvent(evt);
  if (!subId) return reply(200, { received: true, ignored: evt.type });

  try {
    const result = await applySubscription({
      stripe,
      env,
      subscription: subId,
      redis: makeRedisCmd(env),
      notify: makeStripeNotifier(env, { mode: stripeMode(env) }),
      // 未登録の人のレコードを作れるのは決済完了イベントだけ（作成元を 1 本にして重複作成を防ぐ）
      allowCreate: evt.type === 'checkout.session.completed',
    });
    console.log(JSON.stringify({ event: 'stripe_webhook', type: evt.type, action: result.action, reason: result.reason }));
    if (result.action === 'busy') return reply(500, { error: 'busy' });
    // 作成役（checkout.session.completed）が支払い確定より先に届いたら、Stripe に再送させる
    // （ここで 200 を返すと、作成役のイベントが二度と来ずレコードが作られない）
    if (evt.type === 'checkout.session.completed' && result.reason === 'awaiting_payment') {
      return reply(500, { error: 'awaiting_payment' });
    }
    return reply(200, { received: true, action: result.action, reason: result.reason });
  } catch (e) {
    console.error(JSON.stringify({ event: 'stripe_webhook_failed', type: evt.type, message: String(e?.message || e).slice(0, 160) }));
    return reply(500, { error: 'apply_failed' });
  }
};
