/**
 * paypal-order-webhook — PayPal の通知（承認・capture 完了・返金・リバーサル）を受けて会員へ反映する
 *
 * - PayPal の検証 API（verify-webhook-signature・PAYPAL_WEBHOOK_ID）で SUCCESS のものだけ。それ以外は 401。
 * - 通知の中身は信じない。注文を PayPal API で照会して確かめてから反映（paypalServer → entitlementLedger）。
 * - 応答: 処理済み・無視は 200。再送させたいときは 500（PayPal が最大 25 回・3 日再送）。
 * ⚠️ 旧 paypal-webhook.js（2026-07-22 廃止・410）は復活させない。この Function が新しい経路。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'paypal-order-webhook' });
import { rawBody } from '../../src/lib/billing/stripeRuntime.js';
import { handlePaypalWebhook } from '../../src/lib/billing/paypal/paypalServer.js';
import { resolvePaypalMode } from '../../src/lib/billing/paypal/paypalCore.js';
import { makeCardNotifier } from '../../src/lib/billing/cardNotify.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';

const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: '{"error":"method_not_allowed"}' };
  const env = process.env;
  const origin = `https://${String(event.headers?.host || event.headers?.Host || '')}`;
  const mode = resolvePaypalMode({ env, origin });
  try {
    const r = await handlePaypalWebhook({
      env, origin, headers: event.headers || {}, rawBody: rawBody(event), redis: makeRedisCmd(env),
      notify: makeCardNotifier(env, { mode: mode.ok ? mode.mode : 'test', provider: 'paypal' }),
    });
    console.log(JSON.stringify({ event: 'paypal_webhook', result: r.result }));
    return { statusCode: r.status, headers: H, body: JSON.stringify({ result: r.result }) };
  } catch (e) {
    console.error(JSON.stringify({ event: 'paypal_webhook_failed', message: String(e?.message || e).slice(0, 120) }));
    return { statusCode: 500, headers: H, body: '{"error":"apply_failed"}' };
  }
};
