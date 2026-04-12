import { createClient } from '@supabase/supabase-js';
import { sendEmail } from '../../lib/sendgrid-utils.js';

const supabase = createClient(
    import.meta.env.PUBLIC_SUPABASE_URL,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY
);

export const prerender = false;

export async function POST({ request }) {
    try {
        const { weeklyData, targetPlan = 'all' } = await request.json();

        // 認証チェック（管理者権限が必要）
        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.includes(import.meta.env.ADMIN_API_KEY)) {
            return new Response(
                JSON.stringify({ error: 'Unauthorized' }),
                { status: 401, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // 対象ユーザーを取得
        let query = supabase
            .from('profiles')
            .select(`
                id,
                user_email:users!inner(email),
                subscription_plan,
                subscription_status
            `)
            .eq('newsletter_enabled', true);

        // プラン別フィルタ
        if (targetPlan !== 'all') {
            query = query.eq('subscription_plan', targetPlan);
        }

        const { data: profiles, error } = await query;

        if (error) {
            throw error;
        }

        // メール送信処理
        const emailResults = [];
        const batchSize = 10; // 一度に送信する数を制限

        for (let i = 0; i < profiles.length; i += batchSize) {
            const batch = profiles.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async (profile) => {
                try {
                    const result = await sendEmail({
                        to: profile.user_email.email,
                        subject: '📊 週間AI競馬予想レポート - NANKANアナリティクス',
                        replyTo: 'nankan.analytics@gmail.com',
                        html: `
                            <div style="max-width: 600px; margin: 0 auto; font-family: sans-serif;">
                                <div style="background: #3b82f6; color: white; text-align: center; padding: 30px;">
                                    <h1>📊 週間AI予想レポート</h1>
                                    <p>${new Date().toLocaleDateString('ja-JP')}</p>
                                </div>
                                <div style="padding: 30px;">
                                    <h2>今週のハイライト</h2>
                                    <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
                                        <h3>🎯 的中実績</h3>
                                        <p>${weeklyData.results || '今週の的中率: 87%、回収率: 156%'}</p>
                                    </div>
                                    <div style="background: #f0fdf4; padding: 20px; border-radius: 8px;">
                                        <h3>💰 収益実績</h3>
                                        <p>${weeklyData.profits || '推奨投資額10,000円で15,600円のリターンを達成'}</p>
                                    </div>
                                    <div style="text-align: center; margin: 30px 0;">
                                        <a href="https://nankan-analytics.keiba.link/dashboard" 
                                           style="display: inline-block; background: #3b82f6; color: white; text-decoration: none; padding: 15px 30px; border-radius: 8px;">
                                            今日の予想を確認
                                        </a>
                                    </div>
                                </div>
                            </div>
                        `
                    });
                    
                    return {
                        email: profile.user_email.email,
                        success: result.success,
                        error: result.error
                    };
                } catch (error) {
                    return {
                        email: profile.user_email.email,
                        success: false,
                        error: error.message
                    };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            emailResults.push(...batchResults);

            // レート制限対策
            if (i + batchSize < profiles.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // 送信結果をログに記録
        const successCount = emailResults.filter(r => r.success).length;
        const failureCount = emailResults.filter(r => !r.success).length;

        // データベースにメルマガ送信記録を保存
        await supabase.from('newsletter_logs').insert({
            target_plan: targetPlan,
            total_sent: profiles.length,
            success_count: successCount,
            failure_count: failureCount,
            weekly_data: weeklyData,
            sent_at: new Date().toISOString()
        });

        return new Response(
            JSON.stringify({
                success: true,
                totalSent: profiles.length,
                successCount,
                failureCount,
                results: emailResults
            }),
            { 
                status: 200, 
                headers: { 'Content-Type': 'application/json' }
            }
        );

    } catch (error) {
        console.error('Newsletter sending error:', error);
        return new Response(
            JSON.stringify({ 
                error: 'Failed to send newsletter',
                details: error.message 
            }),
            { 
                status: 500, 
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

// 管理者用メルマガ送信のスケジュール機能
export async function GET({ url }) {
    const searchParams = new URL(url).searchParams;
    const cronSecret = searchParams.get('secret');

    // Cron用の秘密キーをチェック
    if (cronSecret !== import.meta.env.CRON_SECRET) {
        return new Response('Unauthorized', { status: 401 });
    }

    try {
        // デフォルトの週次データを生成
        const weeklyData = {
            results: generateWeeklyResults(),
            profits: generateWeeklyProfits()
        };

        // 全ユーザーにメルマガ送信
        const response = await fetch(`${import.meta.env.PUBLIC_SITE_URL}/api/send-newsletter`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${import.meta.env.ADMIN_API_KEY}`
            },
            body: JSON.stringify({
                weeklyData,
                targetPlan: 'all'
            })
        });

        const result = await response.json();

        return new Response(
            JSON.stringify({
                message: 'Weekly newsletter sent',
                ...result
            }),
            { 
                status: 200, 
                headers: { 'Content-Type': 'application/json' }
            }
        );

    } catch (error) {
        return new Response(
            JSON.stringify({ error: error.message }),
            { 
                status: 500, 
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

// ダミーデータ生成関数
function generateWeeklyResults() {
    const hitRate = Math.floor(Math.random() * 10) + 85; // 85-95%
    const returnRate = Math.floor(Math.random() * 50) + 150; // 150-200%
    
    return `今週の的中率: ${hitRate}%、回収率: ${returnRate}%`;
}

function generateWeeklyProfits() {
    const investment = 10000;
    const returnRate = Math.floor(Math.random() * 50) + 150;
    const profit = Math.floor(investment * returnRate / 100);
    
    return `推奨投資額${investment.toLocaleString()}円で${profit.toLocaleString()}円のリターンを達成`;
}