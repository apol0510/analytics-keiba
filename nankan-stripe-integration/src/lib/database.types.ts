// Supabase Database Types
export type Database = {
    public: {
        Tables: {
            profiles: {
                Row: {
                    id: string;
                    display_name: string | null;
                    avatar_url: string | null;
                    stripe_customer_id: string | null;
                    active_plan: 'free' | 'standard' | 'premium';
                    active_status: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
                    active_subscription_id: string | null;
                    subscription_current_period_end: string | null;
                    created_at: string;
                    updated_at: string;
                };
                Insert: {
                    id: string;
                    display_name?: string | null;
                    avatar_url?: string | null;
                    stripe_customer_id?: string | null;
                    active_plan?: 'free' | 'standard' | 'premium';
                    active_status?: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
                    active_subscription_id?: string | null;
                    subscription_current_period_end?: string | null;
                    created_at?: string;
                    updated_at?: string;
                };
                Update: {
                    id?: string;
                    display_name?: string | null;
                    avatar_url?: string | null;
                    stripe_customer_id?: string | null;
                    active_plan?: 'free' | 'standard' | 'premium';
                    active_status?: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
                    active_subscription_id?: string | null;
                    subscription_current_period_end?: string | null;
                    created_at?: string;
                    updated_at?: string;
                };
            };
            subscriptions: {
                Row: {
                    id: string;
                    profile_id: string;
                    customer_id: string;
                    price_id: string;
                    plan: 'free' | 'standard' | 'premium';
                    status: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
                    current_period_start: string | null;
                    current_period_end: string | null;
                    cancel_at: string | null;
                    cancel_at_period_end: boolean;
                    default_payment_method: string | null;
                    latest_invoice: string | null;
                    created_at: string;
                    updated_at: string;
                };
                Insert: {
                    id: string;
                    profile_id: string;
                    customer_id: string;
                    price_id: string;
                    plan: 'free' | 'standard' | 'premium';
                    status: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
                    current_period_start?: string | null;
                    current_period_end?: string | null;
                    cancel_at?: string | null;
                    cancel_at_period_end?: boolean;
                    default_payment_method?: string | null;
                    latest_invoice?: string | null;
                    created_at?: string;
                    updated_at?: string;
                };
                Update: {
                    id?: string;
                    profile_id?: string;
                    customer_id?: string;
                    price_id?: string;
                    plan?: 'free' | 'standard' | 'premium';
                    status?: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
                    current_period_start?: string | null;
                    current_period_end?: string | null;
                    cancel_at?: string | null;
                    cancel_at_period_end?: boolean;
                    default_payment_method?: string | null;
                    latest_invoice?: string | null;
                    created_at?: string;
                    updated_at?: string;
                };
            };
            stripe_events: {
                Row: {
                    event_id: string;
                    type: string;
                    received_at: string;
                    payload: any;
                };
                Insert: {
                    event_id: string;
                    type: string;
                    received_at?: string;
                    payload: any;
                };
                Update: {
                    event_id?: string;
                    type?: string;
                    received_at?: string;
                    payload?: any;
                };
            };
        };
        Enums: {
            subscription_plan: 'free' | 'standard' | 'premium';
            subscription_status: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
        };
    };
};