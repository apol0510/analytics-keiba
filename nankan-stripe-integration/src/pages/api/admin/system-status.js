import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    import.meta.env.PUBLIC_SUPABASE_URL,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY || import.meta.env.PUBLIC_SUPABASE_ANON_KEY
);

export const prerender = false;

export async function GET({ request }) {
    try {
        // 管理者権限チェック（簡略化）
        const authHeader = request.headers.get('authorization');
        if (!authHeader) {
            return new Response(
                JSON.stringify({ error: 'Unauthorized' }),
                { status: 401, headers: { 'Content-Type': 'application/json' } }
            );
        }

        // システム各種ヘルスチェック
        const healthChecks = await Promise.allSettled([
            checkDatabase(),
            checkEmailService(),
            checkStorage()
        ]);

        const results = {
            database: getResultStatus(healthChecks[0]),
            email: getResultStatus(healthChecks[1]),
            storage: getResultStatus(healthChecks[2]),
            timestamp: new Date().toISOString()
        };

        return new Response(
            JSON.stringify(results),
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

// データベース接続確認
async function checkDatabase() {
    try {
        const { data, error } = await supabase
            .from('profiles')
            .select('count', { count: 'exact', head: true });

        if (error) throw error;
        return { status: 'ok', message: 'Database connection successful' };
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}

// メール配信サービス確認
async function checkEmailService() {
    try {
        // Resend API確認（実際のメール送信はしない）
        if (!import.meta.env.RESEND_API_KEY) {
            return { status: 'warning', message: 'Email service not configured' };
        }
        
        const response = await fetch('https://api.resend.com/domains', {
            headers: {
                'Authorization': `Bearer ${import.meta.env.RESEND_API_KEY}`,
            },
        });

        if (!response.ok) {
            throw new Error('Email service API error');
        }

        return { status: 'ok', message: 'Email service accessible' };
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}

// ストレージ確認
async function checkStorage() {
    try {
        const { data, error } = await supabase
            .storage
            .listBuckets();

        if (error) throw error;
        return { status: 'ok', message: 'Storage accessible' };
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}

// 結果ステータス取得ヘルパー
function getResultStatus(result) {
    if (result.status === 'fulfilled') {
        return result.value;
    } else {
        return {
            status: 'error',
            message: result.reason?.message || 'Unknown error'
        };
    }
}