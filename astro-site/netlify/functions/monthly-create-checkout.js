/**
 * monthly-create-checkout — お客様向けの「月額で申し込む」共通入口（決済会社を選ばせない）
 *
 * POST { plan: 'premium'|'premium-jra'|'premium-nankan' }（ak_session 必須）→ 200 { url, subscription, provider }
 *   → 400 invalid_plan / 401 login_required
 *   → 409 already_subscribed（PayPal・Stripe の月額が生きている）/ already_premium（買い切り・期間の長い Premium）
 *   → 503 card_sales_not_open / paypal_key_missing / plan_not_configured / redis_missing（受け付けない）
 *   → 502 checkout_failed（**別の決済会社へは自動で作り直さない**）
 * 2026-10-15 MK 決定: 月額は PayPal の定期課金で受け付ける（cardSales.ACTIVE_SUBSCRIPTION_PROVIDER）。
 * 本番の受付は cardSales.SUBSCRIPTION_SALES_OPEN を true にする PR だけで開く。
 * E2E 経路は cardE2E.js（テストモード限定・専用秘密・使い捨てレコードだけ）。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'monthly-create-checkout' });
import { corsHeaders, resolveSiteOrigin, readSessionRecordId, isAllowedOrigin } from '../../src/lib/billing/stripeRuntime.js';
import { ACTIVE_SUBSCRIPTION_PROVIDER } from '../../src/lib/billing/cardSales.js';
import { createPaypalSubscription, resolvePaypalSubscriptionMode } from '../../src/lib/billing/paypal/paypalSubscriptionServer.js';
import { e2eRecordIdFor } from '../../src/lib/billing/cardE2E.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';

const CREATORS = Object.freeze({ paypal: { mode: resolvePaypalSubscriptionMode, create: createPaypalSubscription } });
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
  const provider = CREATORS[ACTIVE_SUBSCRIPTION_PROVIDER];
  if (!provider) return json(503, headers, { error: 'subscription_provider_unset' });
  // 受け付けない状態（鍵なし・販売前・鍵と環境の不一致）は会員照会より先に止める
  const mode = provider.mode({ env, origin });
  if (!mode.ok) return json(503, headers, { error: mode.reason });
  try {
    const recordId = await readSessionRecordId(event.headers?.cookie || event.headers?.Cookie || '', env)
      || await e2eRecordIdFor({ event, env, body, testMode: mode.mode === 'test' });
    const r = await provider.create({ env, origin, recordId, planId: String(body.plan || ''), entry: 'monthly', redis: makeRedisCmd(env) });
    if (!r.ok) return json(r.status, headers, { error: r.code });
    console.log(JSON.stringify({ event: 'monthly_checkout_created', provider: r.provider, plan: String(body.plan || '') }));
    return json(200, headers, { url: r.url, subscription: r.subscriptionId, provider: r.provider });
  } catch (e) {
    console.error(JSON.stringify({ event: 'monthly_checkout_failed', provider: ACTIVE_SUBSCRIPTION_PROVIDER, message: String(e?.message || e).slice(0, 120) }));
    return json(502, headers, { error: 'checkout_failed' });
  }
};
