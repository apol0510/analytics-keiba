// Stripe Webhook処理（冪等性対応版）
import { verifyWebhookSignature, getSubscription, getPlanFromPriceId } from '../../../lib/stripe.js';
import { createClient } from '@supabase/supabase-js';
import { sendWelcomeEmail } from '../../../lib/sendgrid-utils.js';

const supabase = createClient(
    import.meta.env.PUBLIC_SUPABASE_URL,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function POST({ request }) {
    try {
        // Webhook署名検証
        const payload = await request.text();
        const signature = request.headers.get('stripe-signature');
        const endpointSecret = import.meta.env.STRIPE_WEBHOOK_SECRET;

        if (!endpointSecret) {
            console.error('STRIPE_WEBHOOK_SECRET not configured');
            return new Response('Webhook secret not configured', { status: 500 });
        }

        const event = verifyWebhookSignature(payload, signature, endpointSecret);
        console.log(`Stripe webhook received: ${event.type}`);

        // 冪等性チェック：既に処理済みのイベントをスキップ
        const { data: existingEvent } = await supabase
            .from('stripe_events')
            .select('event_id')
            .eq('event_id', event.id)
            .single();

        if (existingEvent) {
            console.log(`Event ${event.id} already processed, skipping`);
            return new Response(
                JSON.stringify({ received: true, status: 'already_processed' }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // イベントを記録（処理前）
        await supabase
            .from('stripe_events')
            .insert({
                event_id: event.id,
                type: event.type,
                payload: event
            });

        // イベント処理
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutCompleted(event.data.object);
                break;

            case 'invoice.paid':
            case 'invoice.payment_succeeded':
                await handlePaymentSucceeded(event.data.object);
                break;

            case 'invoice.payment_failed':
                await handlePaymentFailed(event.data.object);
                break;

            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(event.data.object);
                break;

            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object);
                break;

            default:
                console.log(`Unhandled event type: ${event.type}`);
        }

        return new Response(
            JSON.stringify({ received: true }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

    } catch (error) {
        console.error('Webhook error:', error);
        return new Response(`Webhook error: ${error.message}`, { status: 400 });
    }
}

// Checkoutセッション完了処理（新仕様対応版）
async function handleCheckoutCompleted(session) {
    try {
        const customerId = session.customer;
        const subscriptionId = session.subscription;
        const customerEmail = session.customer_details?.email;

        if (!customerId || !subscriptionId) {
            console.error('Missing customer or subscription ID');
            return;
        }

        // サブスクリプション情報を取得
        const subscription = await getSubscription(subscriptionId);
        if (!subscription) {
            console.error('Failed to retrieve subscription');
            return;
        }

        const priceId = subscription.items.data[0]?.price?.id;
        const planName = getPlanFromPriceId(priceId);

        // ユーザープロファイルを取得（email で検索）
        const { data: authUsers, error: authError } = await supabase.auth.admin.listUsers();
        if (authError || !authUsers?.users) {
            console.error('Failed to list users:', authError);
            return;
        }

        const user = authUsers.users.find(u => u.email === customerEmail);
        if (!user) {
            console.error('Unable to find user profile for email:', customerEmail);
            return;
        }

        // subscriptionsテーブルとprofilesテーブルを同期更新
        await upsertSubscriptionAndSnapshot({
            subscriptionId: subscription.id,
            profileId: user.id,
            customerId,
            priceId,
            plan: planName,
            status: subscription.status,
            currentPeriodStart: subscription.current_period_start,
            currentPeriodEnd: subscription.current_period_end,
            cancelAt: subscription.cancel_at,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            defaultPaymentMethod: subscription.default_payment_method,
            latestInvoice: subscription.latest_invoice
        });

        // ウェルカムメール送信（新規登録の場合）
        if (customerEmail && planName !== 'free') {
            await sendWelcomeEmail(customerEmail);
        }

        console.log(`Subscription activated for ${customerEmail}: ${planName}`);
    } catch (error) {
        console.error('Error handling checkout completion:', error);
    }
}

// 決済成功処理（新仕様対応版）
async function handlePaymentSucceeded(invoice) {
    try {
        const customerId = invoice.customer;
        const subscriptionId = invoice.subscription;

        if (!subscriptionId) return;

        const subscription = await getSubscription(subscriptionId);
        if (!subscription) return;

        const priceId = subscription.items.data[0]?.price?.id;
        const planName = getPlanFromPriceId(priceId);

        // subscriptionsとprofilesを同期更新
        await upsertSubscriptionAndSnapshot({
            subscriptionId: subscription.id,
            customerId,
            priceId,
            plan: planName,
            status: 'active', // 決済成功なのでactive
            currentPeriodStart: subscription.current_period_start,
            currentPeriodEnd: subscription.current_period_end,
            cancelAt: subscription.cancel_at,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            defaultPaymentMethod: subscription.default_payment_method,
            latestInvoice: subscription.latest_invoice
        });

        console.log(`Payment succeeded for customer: ${customerId}`);
    } catch (error) {
        console.error('Error handling payment success:', error);
    }
}

// 決済失敗処理（新仕様対応版）
async function handlePaymentFailed(invoice) {
    try {
        const customerId = invoice.customer;
        const subscriptionId = invoice.subscription;

        if (subscriptionId) {
            const subscription = await getSubscription(subscriptionId);
            if (subscription) {
                const priceId = subscription.items.data[0]?.price?.id;
                const planName = getPlanFromPriceId(priceId);

                // subscriptionsとprofilesを同期更新（past_due状態）
                await upsertSubscriptionAndSnapshot({
                    subscriptionId: subscription.id,
                    customerId,
                    priceId,
                    plan: planName,
                    status: 'past_due', // 決済失敗なのでpast_due
                    currentPeriodStart: subscription.current_period_start,
                    currentPeriodEnd: subscription.current_period_end,
                    cancelAt: subscription.cancel_at,
                    cancelAtPeriodEnd: subscription.cancel_at_period_end,
                    defaultPaymentMethod: subscription.default_payment_method,
                    latestInvoice: subscription.latest_invoice
                });
            }
        } else {
            // サブスクリプションIDがない場合は profiles のみ更新
            await supabase
                .from('profiles')
                .update({
                    active_status: 'past_due'
                })
                .eq('stripe_customer_id', customerId);
        }

        console.log(`Payment failed for customer: ${customerId}`);
    } catch (error) {
        console.error('Error handling payment failure:', error);
    }
}

// サブスクリプション更新処理（新仕様対応版）
async function handleSubscriptionUpdated(subscription) {
    try {
        const customerId = subscription.customer;
        const priceId = subscription.items.data[0]?.price?.id;
        const planName = getPlanFromPriceId(priceId);

        // subscriptionsとprofilesを同期更新
        await upsertSubscriptionAndSnapshot({
            subscriptionId: subscription.id,
            customerId,
            priceId,
            plan: planName,
            status: subscription.status,
            currentPeriodStart: subscription.current_period_start,
            currentPeriodEnd: subscription.current_period_end,
            cancelAt: subscription.cancel_at,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            defaultPaymentMethod: subscription.default_payment_method,
            latestInvoice: subscription.latest_invoice
        });

        console.log(`Subscription updated for customer: ${customerId}`);
    } catch (error) {
        console.error('Error handling subscription update:', error);
    }
}

// サブスクリプション削除処理（新仕様対応版）
async function handleSubscriptionDeleted(subscription) {
    try {
        const customerId = subscription.customer;

        // subscriptionsとprofilesを同期更新（キャンセル状態）
        await upsertSubscriptionAndSnapshot({
            subscriptionId: subscription.id,
            customerId,
            priceId: subscription.items.data[0]?.price?.id || null,
            plan: 'free', // キャンセル時は free プランに戻す
            status: 'canceled',
            currentPeriodStart: subscription.current_period_start,
            currentPeriodEnd: subscription.current_period_end,
            cancelAt: subscription.cancel_at,
            cancelAtPeriodEnd: subscription.cancel_at_period_end,
            defaultPaymentMethod: subscription.default_payment_method,
            latestInvoice: subscription.latest_invoice
        });

        console.log(`Subscription canceled for customer: ${customerId}`);
    } catch (error) {
        console.error('Error handling subscription deletion:', error);
    }
}

// subscriptionsテーブルとprofilesテーブルを同期更新する共通関数
async function upsertSubscriptionAndSnapshot({
    subscriptionId,
    profileId = null,
    customerId,
    priceId,
    plan,
    status,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAt = null,
    cancelAtPeriodEnd = false,
    defaultPaymentMethod = null,
    latestInvoice = null
}) {
    try {
        // profileId が提供されていない場合は customer_id から取得
        if (!profileId) {
            const { data: profile } = await supabase
                .from('profiles')
                .select('id')
                .eq('stripe_customer_id', customerId)
                .single();
            
            if (!profile) {
                console.error(`Profile not found for customer: ${customerId}`);
                return;
            }
            profileId = profile.id;
        }

        // subscriptionsテーブルを更新/挿入
        const { error: subscriptionError } = await supabase
            .from('subscriptions')
            .upsert({
                id: subscriptionId,
                profile_id: profileId,
                customer_id: customerId,
                price_id: priceId,
                plan,
                status,
                current_period_start: currentPeriodStart ? new Date(currentPeriodStart * 1000).toISOString() : null,
                current_period_end: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
                cancel_at: cancelAt ? new Date(cancelAt * 1000).toISOString() : null,
                cancel_at_period_end: cancelAtPeriodEnd,
                default_payment_method: defaultPaymentMethod,
                latest_invoice: latestInvoice,
                updated_at: new Date().toISOString()
            });

        if (subscriptionError) {
            console.error('Failed to upsert subscription:', subscriptionError);
            return;
        }

        // profilesテーブルを更新（スナップショット情報）
        const { error: profileError } = await supabase
            .from('profiles')
            .update({
                stripe_customer_id: customerId,
                active_plan: plan,
                active_status: status,
                active_subscription_id: subscriptionId,
                subscription_current_period_end: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null
            })
            .eq('id', profileId);

        if (profileError) {
            console.error('Failed to update profile:', profileError);
        }

        console.log(`Successfully synced subscription ${subscriptionId} for profile ${profileId}`);
    } catch (error) {
        console.error('Error in upsertSubscriptionAndSnapshot:', error);
    }
}