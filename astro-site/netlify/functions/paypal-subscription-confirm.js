/**
 * paypal-subscription-confirm — PayPal 月額の戻り先から呼ぶ。本人の購読を PayPal で照会して反映し、状態を返す
 *
 * GET ?subscription=I-…（ak_session 必須。E2E はテストモード限定の cardE2E 経路）
 *   → 200 { status: 'active'|'pending'|'needs_support'|'unknown' } / 404 { status: 'not_found' }（本人の購読でない）
 * ⚠️ 戻り先への遷移は支払いの証明ではない。反映は PayPal API の照会結果（last_payment）だけで決める。Webhook でも同じ処理が走る。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'paypal-subscription-confirm' });
import { corsHeaders, resolveSiteOrigin, readSessionRecordId } from '../../src/lib/billing/stripeRuntime.js';
import { confirmPaypalSubscription, resolvePaypalSubscriptionSettleMode } from '../../src/lib/billing/paypal/paypalSubscriptionServer.js';
import { makeCardNotifier } from '../../src/lib/billing/cardNotify.js';
import { e2eRecordIdFor } from '../../src/lib/billing/cardE2E.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';

exports.handler = async (event) => {
  const env = process.env;
  const headers = { ...corsHeaders(event.headers), 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: '{"error":"method_not_allowed"}' };
  const origin = resolveSiteOrigin(event.headers);
  const mode = resolvePaypalSubscriptionSettleMode({ env, origin });
  try {
    const q = event.queryStringParameters || {};
    const recordId = await readSessionRecordId(event.headers?.cookie || event.headers?.Cookie || '', env)
      || await e2eRecordIdFor({ event, env, body: { e2eRecordId: q.e2eRecordId }, testMode: mode.ok && mode.mode === 'test' });
    if (!recordId) return { statusCode: 401, headers, body: '{"error":"login_required"}' };
    const r = await confirmPaypalSubscription({
      env, origin, subscriptionId: String(q.subscription || ''), recordId, redis: makeRedisCmd(env),
      notify: makeCardNotifier(env, { mode: mode.ok ? mode.mode : 'test', provider: 'paypal' }),
    });
    return { statusCode: r.status, headers, body: JSON.stringify(r.body) };
  } catch (e) {
    console.error(JSON.stringify({ event: 'paypal_subscription_confirm_failed', message: String(e?.message || e).slice(0, 120) }));
    return { statusCode: 502, headers, body: '{"error":"confirm_failed"}' };
  }
};
