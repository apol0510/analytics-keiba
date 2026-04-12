// Stripe Billing Portal API
import type { APIRoute } from 'astro';
import Stripe from 'stripe';
import { supabaseAdmin } from '../../../lib/supabaseAdmin';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2024-06-20',
});

export const POST: APIRoute = async ({ request }) => {
    try {
        const { customerId } = await request.json();

        if (!customerId) {
            return new Response(
                JSON.stringify({ error: 'Customer ID is required' }),
                { status: 400, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Validate customer exists in our database
        const profile = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .single();

        if (!profile.data) {
            return new Response(
                JSON.stringify({ error: 'Customer not found' }),
                { status: 404, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // Create billing portal session
        const returnUrl = import.meta.env.STRIPE_BILLING_PORTAL_RETURN_URL || `${new URL(request.url).origin}/dashboard`;
        
        const portalSession = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: returnUrl,
        });

        return new Response(
            JSON.stringify({ 
                success: true,
                url: portalSession.url 
            }),
            { 
                status: 200,
                headers: { 'Content-Type': 'application/json' } 
            }
        );

    } catch (error: any) {
        console.error('Portal creation error:', error);
        
        return new Response(
            JSON.stringify({ 
                error: 'Failed to create portal session',
                details: error.message 
            }),
            { 
                status: 500,
                headers: { 'Content-Type': 'application/json' } 
            }
        );
    }
};