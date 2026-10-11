/**
 * paddle-create-checkout — カード決済（Paddle・一回払い）の取引を作り、決済画面の URL を返す
 *
 * POST { product: 'premium-annual'|'premium-annual-light'|'premium-lifetime' }（ak_session 必須）
 *   → 200 { url, order }  url = /checkout/paddle/?_ptxn=txn_…（Paddle.js が決済画面を開く）
 *   → 400 invalid_product / 401 login_required
 *   → 409 already_lifetime / stripe_subscription_active / not_eligible（二重課金・資格なしを作らない）
 *   → 503 card_sales_not_open / test_key_on_production / live_key_outside_production / paddle_key_missing
 *
 * 2026-10-11 MK 確定: 本番サイトでは cardSales.CARD_SALES_OPEN.paddle（コード）が true になるまで受け付けない。
 * Deploy Preview は Sandbox 鍵だけ。E2E 経路は cardE2E.js（テストモード限定・専用秘密・使い捨てレコードだけ）。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'paddle-create-checkout' });
import { corsHeaders, resolveSiteOrigin, readSessionRecordId, isAllowedOrigin } from '../../src/lib/billing/stripeRuntime.js';
import { createPaddleCheckout } from '../../src/lib/billing/paddle/paddleServer.js';
import { resolvePaddleMode } from '../../src/lib/billing/paddle/paddleCore.js';
import { e2eRecordIdFor } from '../../src/lib/billing/cardE2E.js';

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
  const origin = resolveSiteOrigin(event.headers);
  const mode = resolvePaddleMode({ key: env.PADDLE_API_KEY, origin });
  if (!mode.ok) return json(503, headers, { error: mode.reason });
  try {
    const recordId = await readSessionRecordId(event.headers?.cookie || event.headers?.Cookie || '', env)
      || await e2eRecordIdFor({ event, env, body, testMode: mode.mode === 'test' });
    const r = await createPaddleCheckout({ env, origin, recordId, productId: String(body.product || '') });
    if (!r.ok) return json(r.status, headers, { error: r.code });
    console.log(JSON.stringify({ event: 'paddle_checkout_created', product: String(body.product || '') }));
    return json(200, headers, { url: r.url, order: r.transactionId });
  } catch (e) {
    console.error(JSON.stringify({ event: 'paddle_checkout_failed', message: String(e?.message || e).slice(0, 120) }));
    return json(502, headers, { error: 'checkout_failed' });
  }
};
