/**
 * stripe-create-checkout — Stripe Checkout（月額定期購読）を開始する
 *
 * POST { plan: 'premium'|'premium-jra'|'premium-nankan', email?: string }
 *   → 200 { url }                       Stripe の決済画面へ遷移する
 *   → 400 invalid_plan / email_required
 *   → 409 already_subscribed / already_premium （二重課金を作らない）
 *   → 503 billing_not_configured / plan_not_configured（推測で続けない）
 *
 * - ログイン中（ak_session）はそのレコードに紐付ける（メールは Airtable の値。入力値を使わない）
 * - 未ログインは入力メールで受け付ける。決済後のログインはマジックリンク（本人のメールに届く）なので、
 *   他人のアドレスで払っても払った人は閲覧できない（＝なりすましの得が無い）
 * - 金額は Stripe の Price が正本。クライアントから金額を受け取らない
 */

import { planById, priceIdFor } from '../../src/lib/billing/stripePlans.js';
import { decideSubscriptionSync } from '../../src/lib/billing/stripeSubscriptionSync.js';
import {
  getStripe, resolveSiteOrigin, corsHeaders, readSessionRecordId,
} from '../../src/lib/billing/stripeRuntime.js';
import { formulaString, normalizeEmail } from '../../src/lib/billing/stripeServer.js';

const LIVE = new Set(['active', 'trialing', 'past_due', 'incomplete', 'unpaid']);

function json(statusCode, headers, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

async function airtableGet(env, path) {
  const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/Customers${path}`, {
    headers: { Authorization: `Bearer ${env.AIRTABLE_API_KEY}` },
  });
  if (!res.ok) throw new Error(`airtable_${res.status}`);
  return res.json();
}

exports.handler = async (event) => {
  const env = process.env;
  const headers = corsHeaders(event.headers);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return json(405, headers, { error: 'method_not_allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, headers, { error: 'invalid_json' }); }

  const plan = planById(body.plan);
  if (!plan) return json(400, headers, { error: 'invalid_plan' });

  const stripe = getStripe(env);
  if (!stripe || !env.AIRTABLE_API_KEY || !env.AIRTABLE_BASE_ID) return json(503, headers, { error: 'billing_not_configured' });
  const priceId = priceIdFor(plan, env);
  if (!priceId) return json(503, headers, { error: 'plan_not_configured' });

  try {
    // ── 誰の申込か ──
    const sessionRecordId = await readSessionRecordId(event.headers?.cookie || event.headers?.Cookie || '', env);
    let record = null;
    let email = '';
    if (sessionRecordId) {
      try {
        record = await airtableGet(env, `/${encodeURIComponent(sessionRecordId)}`);
        email = normalizeEmail(record?.fields?.Email);
      } catch {
        record = null;
      }
    }
    if (!email) {
      email = normalizeEmail(body.email);
      if (!email) return json(400, headers, { error: 'email_required' });
      const found = await airtableGet(env, `?${new URLSearchParams({
        filterByFormula: `LOWER(TRIM({Email})) = ${formulaString(email)}`, maxRecords: '3',
      })}`);
      const recs = found?.records || [];
      // 複数一致は特定できない。決済後の反映で fail closed になるので、ここで止めて問い合わせへ。
      if (recs.length > 1) return json(409, headers, { error: 'account_conflict' });
      record = recs[0] || null;
    }
    const fields = record?.fields || {};

    // ── 二重課金を作らない ──
    const existingSubId = String(fields.StripeSubscriptionId || '');
    if (existingSubId) {
      let live = false;
      try { live = LIVE.has((await stripe.subscriptions.retrieve(existingSubId)).status); } catch { live = false; }
      if (live) {
        return json(409, headers, {
          error: 'already_subscribed',
          // ログイン中ならお支払い管理（プラン変更・解約）へ。未ログインならまずログイン。
          next: sessionRecordId ? 'portal' : 'login',
        });
      }
    }
    // 買い切り・残り期間の長い銀行振込 Premium は、この申込を反映できない（Webhook と同じ判定で先に止める）
    const probe = decideSubscriptionSync({
      fields: { ...fields, StripeSubscriptionId: '' },
      sub: {
        id: 'sub_probe', status: 'active', customerId: '', priceId,
        currentPeriodEnd: Math.floor(Date.now() / 1000) + 31 * 24 * 3600, metadata: {},
      },
      env,
      now: new Date(),
      paidThrough: Math.floor(Date.now() / 1000) + 31 * 24 * 3600,
    });
    if (probe.action === 'conflict' && (probe.reason === 'existing_lifetime' || probe.reason === 'existing_longer_contract')) {
      return json(409, headers, { error: 'already_premium', next: sessionRecordId ? 'dashboard' : 'login' });
    }

    // ── Checkout Session ──
    const origin = resolveSiteOrigin(event.headers);
    const metadata = {
      ak_plan: plan.id,
      ak_email: email,
      ...(record?.id ? { ak_record_id: record.id } : {}),
    };
    const params = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/checkout/success/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/pricing/?checkout=cancelled`,
      locale: 'ja',
      client_reference_id: record?.id || undefined,
      metadata,
      subscription_data: { metadata, description: plan.productName },
      allow_promotion_codes: false,
      // ⚠️ custom_text（決済ボタン下の追加文言）は付けない（2026-10-02 MK 確定の表示方針）。
      //    プラン名・月額・定期購読であることは Stripe が標準で表示する。解約条件は FAQ / legal に記載する。
    };
    const existingCustomer = String(fields.StripeCustomerId || '');
    if (/^cus_/.test(existingCustomer)) params.customer = existingCustomer;
    else params.customer_email = email;

    let session;
    try {
      session = await stripe.checkout.sessions.create(params);
    } catch (e) {
      // 記録済みの Customer が別アカウント・削除済みの場合はメールで作り直す
      if (params.customer && /No such customer/i.test(String(e?.message))) {
        delete params.customer;
        params.customer_email = email;
        session = await stripe.checkout.sessions.create(params);
      } else {
        throw e;
      }
    }
    console.log(JSON.stringify({ event: 'stripe_checkout_created', plan: plan.id, loggedIn: Boolean(sessionRecordId) }));
    return json(200, headers, { url: session.url });
  } catch (e) {
    // Stripe / Airtable の詳細は返さない
    console.error(JSON.stringify({ event: 'stripe_checkout_failed', message: String(e?.message || e).slice(0, 160) }));
    return json(502, headers, { error: 'checkout_failed' });
  }
};
