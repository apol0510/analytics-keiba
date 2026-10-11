/**
 * paypal-capture — 承認後の戻り先から呼ばれ、注文を capture して会員へ反映する
 *
 * POST { order }（PayPal の注文 ID）→ 200 { result }
 * - 誰の注文かは PayPal の照会結果（custom_id）だけで決まる。呼び出し元の言い分は使わない。
 * - capture は PayPal-Request-Id で冪等、反映は entitlementLedger で決済ごとに 1 回（Webhook と同時でも 1 回）。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'paypal-capture' });
import { corsHeaders, resolveSiteOrigin, isAllowedOrigin } from '../../src/lib/billing/stripeRuntime.js';
import { settlePaypalOrder } from '../../src/lib/billing/paypal/paypalServer.js';
import { resolvePaypalMode, isOrderId } from '../../src/lib/billing/paypal/paypalCore.js';
import { makeCardNotifier } from '../../src/lib/billing/cardNotify.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';

const json = (statusCode, headers, body) => ({ statusCode, headers, body: JSON.stringify(body) });

exports.handler = async (event) => {
  const env = process.env;
  const headers = corsHeaders(event.headers);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return json(405, headers, { error: 'method_not_allowed' });
  const reqOrigin = event.headers?.origin || event.headers?.Origin || '';
  if (reqOrigin && !isAllowedOrigin(reqOrigin)) return json(403, headers, { error: 'forbidden_origin' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, headers, { error: 'invalid_json' }); }
  const orderId = String(body.order || '');
  if (!isOrderId(orderId)) return json(400, headers, { error: 'invalid_order' });
  const origin = resolveSiteOrigin(event.headers);
  const mode = resolvePaypalMode({ env, origin });
  if (!mode.ok) return json(503, headers, { error: mode.reason });
  try {
    const r = await settlePaypalOrder({
      env, origin, orderId, redis: makeRedisCmd(env), capture: true,
      notify: makeCardNotifier(env, { mode: mode.mode, provider: 'paypal' }),
    });
    console.log(JSON.stringify({ event: 'paypal_capture', result: r.result }));
    return json(r.retry ? 503 : 200, headers, { result: r.result });
  } catch (e) {
    console.error(JSON.stringify({ event: 'paypal_capture_failed', message: String(e?.message || e).slice(0, 120) }));
    return json(502, headers, { error: 'capture_failed' });
  }
};
