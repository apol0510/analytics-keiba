/**
 * stripe-portal — Stripe のお支払い管理（カード変更・プラン変更・解約）を開く
 *
 * POST（ログイン必須 / ak_session）
 *   → 200 { url }
 *   → 401 login_required
 *   → 404 no_subscription（Stripe で契約していない会員。銀行振込の会員など）
 */

import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable API の呼び出し回数を Function 別に数える（月 100,000 回の上限管理 / docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'stripe-portal' });
import {
  getStripe, corsHeaders, readSessionRecordId, resolveSiteOrigin,
} from '../../src/lib/billing/stripeRuntime.js';
import { portalConfigurationFor } from '../../src/lib/billing/stripePlans.js';

exports.handler = async (event) => {
  const env = process.env;
  const headers = corsHeaders(event.headers);
  const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method_not_allowed' });

  const stripe = getStripe(env);
  if (!stripe || !env.AIRTABLE_API_KEY || !env.AIRTABLE_BASE_ID) return reply(503, { error: 'billing_not_configured' });

  const recordId = await readSessionRecordId(event.headers?.cookie || event.headers?.Cookie || '', env);
  if (!recordId) return reply(401, { error: 'login_required' });

  try {
    const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/Customers/${encodeURIComponent(recordId)}`, {
      headers: { Authorization: `Bearer ${env.AIRTABLE_API_KEY}` },
    });
    if (!res.ok) return reply(502, { error: 'lookup_failed' });
    const customerId = String((await res.json())?.fields?.StripeCustomerId || '');
    if (!/^cus_/.test(customerId)) return reply(404, { error: 'no_subscription' });

    const params = {
      customer: customerId,
      return_url: `${resolveSiteOrigin(event.headers)}/dashboard/`,
      locale: 'ja',
    };
    // scripts/stripe-setup.mjs が作る AK 用の設定（プラン切替・期間末解約）。未設定なら Stripe の既定
    const conf = portalConfigurationFor(env);
    if (/^bpc_/.test(String(conf || ''))) params.configuration = conf;
    const portal = await stripe.billingPortal.sessions.create(params);
    return reply(200, { url: portal.url });
  } catch (e) {
    console.error(JSON.stringify({ event: 'stripe_portal_failed', message: String(e?.message || e).slice(0, 160) }));
    return reply(502, { error: 'portal_failed' });
  }
};
