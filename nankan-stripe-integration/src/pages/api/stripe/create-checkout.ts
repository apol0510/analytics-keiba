import type { APIRoute } from 'astro';
import { stripe } from '../../../lib/stripe';
import { PRICE } from '../../../lib/billing/plan';
import { supabaseAdmin } from '../../../lib/supabaseAdmin';

function badRequest(msg: string, extra?: any) {
  console.error('[create-checkout] 400', msg, extra ?? '');
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({}));
    console.log('[create-checkout] Request body:', body);
    
    let { planId, plan, userId, userEmail, email } = (body ?? {}) as {
      planId?: string;
      plan?: string;
      userId?: string;
      userEmail?: string;
      email?: string;
    };

    // planId または plan の両方をサポート
    plan = plan || planId;
    email = email || userEmail;

    plan = (plan ?? '').toString().trim().toLowerCase();
    if (!['standard', 'premium'].includes(plan)) {
      return badRequest('Invalid plan param. Use "standard" or "premium".', { plan });
    }
    if (!userId || !email) return badRequest('Missing userId or email');

    const price = PRICE[plan as 'standard' | 'premium'];
    if (!price) {
      const mode = import.meta.env.STRIPE_MODE ?? 'test';
      const requiredEnv =
        plan === 'standard'
          ? mode === 'live'
            ? 'STRIPE_STANDARD_PRICE_ID_LIVE'
            : 'STRIPE_STANDARD_PRICE_ID_TEST'
          : mode === 'live'
            ? 'STRIPE_PREMIUM_PRICE_ID_LIVE'
            : 'STRIPE_PREMIUM_PRICE_ID_TEST';
      return badRequest(`Price not configured for plan=${plan}. Set ${requiredEnv} in .env and restart server.`);
    }

    console.log('[create-checkout] Plan:', plan, 'Price ID:', price);

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    const sessionParams: any = {
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      success_url: `${import.meta.env.SITE_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${import.meta.env.SITE_URL}/payment/cancel`,
      allow_promotion_codes: true,
      subscription_data: {
        metadata: { plan, supabase_uid: userId },
      },
      metadata: { plan, supabase_uid: userId },
    };

    if (profile?.stripe_customer_id) {
      sessionParams.customer = profile.stripe_customer_id;
    } else {
      sessionParams.customer_email = email;
    }

    const session = await stripe.checkout.sessions.create(
      sessionParams,
      { idempotencyKey: `checkout:${userId}:${plan}` }
    );

    console.log('[create-checkout] Success! Checkout URL:', session.url);
    return new Response(JSON.stringify({ url: session.url }), { status: 200 });
  } catch (e: any) {
    console.error('[create-checkout] 500', e?.message ?? e, e?.stack ?? '');
    return new Response(
      JSON.stringify({ error: 'Internal Server Error', details: e?.message ?? 'unknown' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};