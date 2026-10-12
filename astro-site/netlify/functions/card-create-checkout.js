/**
 * card-create-checkout — お客様向けの「カードで支払う」共通入口（決済会社を選ばせない）
 *
 * POST { product }（ak_session 必須）→ 200 { url, order, provider }
 *   → 400 invalid_product / 401 login_required
 *   → 409 already_lifetime / stripe_subscription_active / not_eligible / checkout_in_progress
 *   → 503 card_sales_not_open / *_key_missing / redis_missing など（受け付けない）
 *   → 502 checkout_failed（**別の決済会社へは自動で作り直さない**）
 * 申込先は cardSales.ACTIVE_CARD_PROVIDER（2026-10-13 MK 確定・冗長化）。本番の受付条件は各社と同じ（cardSales.CARD_SALES_OPEN）。
 * E2E 経路は cardE2E.js（テストモード限定・専用秘密・使い捨てレコードだけ）。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'card-create-checkout' });
import { corsHeaders, resolveSiteOrigin, readSessionRecordId, isAllowedOrigin } from '../../src/lib/billing/stripeRuntime.js';
import { startCardCheckout, resolveActiveCardMode } from '../../src/lib/billing/cardCheckout.js';
import { ACTIVE_CARD_PROVIDER } from '../../src/lib/billing/cardSales.js';
import { e2eRecordIdFor } from '../../src/lib/billing/cardE2E.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';

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
  // 受け付けない状態（鍵なし・販売前・鍵と環境の不一致）は会員照会より先に止める（各社の入口と同じ順序）
  const mode = resolveActiveCardMode({ env, origin });
  if (!mode.ok) return json(503, headers, { error: mode.reason });
  try {
    const recordId = await readSessionRecordId(event.headers?.cookie || event.headers?.Cookie || '', env)
      || await e2eRecordIdFor({ event, env, body, testMode: mode.mode === 'test' });
    const r = await startCardCheckout({ env, origin, recordId, productId: String(body.product || ''), redis: makeRedisCmd(env) });
    if (!r.ok) return json(r.status, headers, { error: r.code });
    console.log(JSON.stringify({ event: 'card_checkout_created', provider: r.provider, product: String(body.product || '') }));
    return json(200, headers, { url: r.url, order: r.orderId, provider: r.provider });
  } catch (e) {
    console.error(JSON.stringify({ event: 'card_checkout_failed', provider: ACTIVE_CARD_PROVIDER, message: String(e?.message || e).slice(0, 120) }));
    return json(502, headers, { error: 'checkout_failed' });
  }
};
