/**
 * paypal-create-order — PayPal（一回払い）の注文を作り、承認画面の URL を返す
 *
 * POST { product }（ak_session 必須）→ 200 { url, order } / 400 / 401 / 409 / 503（paddle-create-checkout と同じ語彙）
 * 2026-10-11 MK 確定: 本番サイトでは cardSales.CARD_SALES_OPEN.paypal（コード）が true になるまで受け付けない。
 * Deploy Preview は PAYPAL_ENV=sandbox だけ。月払い（Subscriptions）は作らない。
 * ⚠️ 旧 paypal-webhook.js（410・廃止）とは別の経路。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'paypal-create-order' });
import { corsHeaders, resolveSiteOrigin, readSessionRecordId, isAllowedOrigin } from '../../src/lib/billing/stripeRuntime.js';
import { createPaypalOrder } from '../../src/lib/billing/paypal/paypalServer.js';
import { resolvePaypalMode } from '../../src/lib/billing/paypal/paypalCore.js';
import { e2eRecordIdFor } from '../../src/lib/billing/cardE2E.js';

const json = (statusCode, headers, body) => ({ statusCode, headers, body: JSON.stringify(body) });

exports.handler = async (event) => {
  const env = process.env;
  const headers = corsHeaders(event.headers);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return json(405, headers, { error: 'method_not_allowed' });
  const reqOrigin = event.headers?.origin || event.headers?.Origin || '';
  if (reqOrigin && !isAllowedOrigin(reqOrigin, event.headers?.host || event.headers?.Host || '')) return json(403, headers, { error: 'forbidden_origin' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, headers, { error: 'invalid_json' }); }
  const origin = resolveSiteOrigin(event.headers);
  const mode = resolvePaypalMode({ env, origin });
  if (!mode.ok) return json(503, headers, { error: mode.reason });
  try {
    const recordId = await readSessionRecordId(event.headers?.cookie || event.headers?.Cookie || '', env)
      || await e2eRecordIdFor({ event, env, body, testMode: mode.mode === 'test' });
    const r = await createPaypalOrder({ env, origin, recordId, productId: String(body.product || '') });
    if (!r.ok) return json(r.status, headers, { error: r.code });
    console.log(JSON.stringify({ event: 'paypal_order_created', product: String(body.product || '') }));
    return json(200, headers, { url: r.url, order: r.orderId });
  } catch (e) {
    console.error(JSON.stringify({ event: 'paypal_order_failed', message: String(e?.message || e).slice(0, 120) }));
    return json(502, headers, { error: 'order_failed' });
  }
};
