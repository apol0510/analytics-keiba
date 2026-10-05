/**
 * stripe-checkout-complete — 決済完了画面から呼ぶ。Webhook を待たずにその場で反映する
 *
 * GET ?session_id=cs_...
 *   → 200 { ok: true, plan, email, loggedIn }  反映済み（Webhook と同じ判定・同じ排他ロック）
 *   → 202 { ok: false, pending: true }          支払い処理中（画面は数秒後に再試行）
 *   → 409 { ok: false, reason }                 反映できない（管理者へ通知済み）
 *
 * session_id は決済した本人のブラウザにしか渡らない（Stripe の success_url）。
 * 返すメールアドレスは「ログインリンクを送る先」を画面に出すためだけに使う。
 */

import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable API の呼び出し回数を Function 別に数える（月 100,000 回の上限管理 / docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'stripe-checkout-complete' });
import {
  getStripe, corsHeaders, readSessionRecordId, stripeMode,
} from '../../src/lib/billing/stripeRuntime.js';
import { applySubscription } from '../../src/lib/billing/stripeServer.js';
import { makeStripeNotifier } from '../../src/lib/billing/stripeNotify.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';

exports.handler = async (event) => {
  const env = process.env;
  const headers = corsHeaders(event.headers);
  const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') return reply(405, { error: 'method_not_allowed' });

  const sessionId = String(event.queryStringParameters?.session_id || '');
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) return reply(400, { error: 'invalid_session' });

  const stripe = getStripe(env);
  if (!stripe) return reply(503, { error: 'billing_not_configured' });

  try {
    const cs = await stripe.checkout.sessions.retrieve(sessionId);
    if (cs.mode !== 'subscription') return reply(400, { error: 'invalid_session' });
    const subId = typeof cs.subscription === 'string' ? cs.subscription : cs.subscription?.id;
    if (cs.status !== 'complete' || !subId) return reply(202, { ok: false, pending: true });

    const result = await applySubscription({
      stripe,
      env,
      subscription: subId,
      redis: makeRedisCmd(env),
      notify: makeStripeNotifier(env, { mode: stripeMode(env) }),
    });
    if (result.action === 'busy') return reply(202, { ok: false, pending: true });
    if (!result.ok) return reply(409, { ok: false, reason: result.reason });
    if (result.action === 'skip') return reply(202, { ok: false, pending: true, reason: result.reason });

    const loggedIn = Boolean(await readSessionRecordId(event.headers?.cookie || event.headers?.Cookie || '', env));
    return reply(200, {
      ok: true,
      plan: result.planId,
      email: result.email || cs.customer_details?.email || '',
      loggedIn,
    });
  } catch (e) {
    console.error(JSON.stringify({ event: 'stripe_checkout_complete_failed', message: String(e?.message || e).slice(0, 160) }));
    return reply(502, { error: 'complete_failed' });
  }
};
