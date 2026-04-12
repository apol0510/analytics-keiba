// Supabase Admin Client for server-side operations
import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

// Admin client with service role key for bypassing RLS
export const supabaseAdmin = createClient<Database>(
    import.meta.env.PUBLIC_SUPABASE_URL,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    }
);

// Helper functions for common operations
export async function getProfileByEmail(email: string) {
    const { data: authUsers, error: authError } = await supabaseAdmin.auth.admin.listUsers();
    if (authError || !authUsers?.users) {
        console.error('Failed to list users:', authError);
        return null;
    }

    const user = authUsers.users.find(u => u.email === email);
    if (!user) return null;

    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

    if (error) {
        console.error('Failed to get profile:', error);
        return null;
    }

    return data;
}

export async function getProfileByCustomerId(customerId: string) {
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('stripe_customer_id', customerId)
        .single();

    if (error) {
        console.error('Failed to get profile by customer ID:', error);
        return null;
    }

    return data;
}

export async function updateProfileSubscription(
    profileId: string,
    updates: {
        stripe_customer_id?: string;
        active_plan?: 'free' | 'standard' | 'premium';
        active_status?: string;
        active_subscription_id?: string;
        subscription_current_period_end?: string;
    }
) {
    const { data, error } = await supabaseAdmin
        .from('profiles')
        .update(updates)
        .eq('id', profileId)
        .select()
        .single();

    if (error) {
        console.error('Failed to update profile subscription:', error);
        return null;
    }

    return data;
}

// Event tracking for idempotency
export async function hasProcessedEvent(eventId: string): Promise<boolean> {
    const { data } = await supabaseAdmin
        .from('stripe_events')
        .select('event_id')
        .eq('event_id', eventId)
        .single();

    return !!data;
}

export async function recordEvent(eventId: string, type: string, payload: any) {
    const { error } = await supabaseAdmin
        .from('stripe_events')
        .insert({
            event_id: eventId,
            type,
            payload
        });

    if (error) {
        console.error('Failed to record event:', error);
    }
}

// Subscription management
export async function upsertSubscription(subscription: {
    id: string;
    profile_id: string;
    customer_id: string;
    price_id: string;
    plan: 'free' | 'standard' | 'premium';
    status: string;
    current_period_start?: string;
    current_period_end?: string;
    cancel_at?: string;
    cancel_at_period_end?: boolean;
    default_payment_method?: string;
    latest_invoice?: string;
}) {
    const { data, error } = await supabaseAdmin
        .from('subscriptions')
        .upsert(subscription)
        .select()
        .single();

    if (error) {
        console.error('Failed to upsert subscription:', error);
        return null;
    }

    return data;
}