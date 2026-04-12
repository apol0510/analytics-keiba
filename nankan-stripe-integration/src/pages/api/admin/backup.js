import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    import.meta.env.PUBLIC_SUPABASE_URL,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY
);

export const prerender = false;

export async function POST({ request }) {
    try {
        // 管理者権限チェック
        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.includes(import.meta.env.ADMIN_API_KEY)) {
            return new Response(
                JSON.stringify({ error: 'Unauthorized' }),
                { status: 401, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const { type = 'full' } = await request.json();
        
        let backupData = {};
        let backupSize = 0;

        switch (type) {
            case 'users':
                backupData = await backupUsers();
                break;
            case 'predictions':
                backupData = await backupPredictions();
                break;
            case 'full':
            default:
                backupData = await backupAll();
                break;
        }

        // バックアップサイズ計算
        backupSize = JSON.stringify(backupData).length;

        // バックアップ記録を保存
        const { error: logError } = await supabase
            .from('backup_logs')
            .insert({
                backup_type: type,
                backup_size: backupSize,
                status: 'completed',
                created_at: new Date().toISOString()
            });

        if (logError) {
            console.error('Backup log error:', logError);
        }

        return new Response(
            JSON.stringify({
                success: true,
                type,
                size: backupSize,
                timestamp: new Date().toISOString(),
                data: backupData
            }),
            { 
                status: 200, 
                headers: { 
                    'Content-Type': 'application/json',
                    'Content-Disposition': `attachment; filename="nankan_backup_${type}_${Date.now()}.json"`
                }
            }
        );
    } catch (error) {
        console.error('Backup error:', error);
        
        // エラーログを記録
        try {
            await supabase
                .from('backup_logs')
                .insert({
                    backup_type: type || 'unknown',
                    status: 'failed',
                    error_message: error.message,
                    created_at: new Date().toISOString()
                });
        } catch (logError) {
            console.error('Error logging backup failure:', logError);
        }

        return new Response(
            JSON.stringify({ 
                error: 'Backup failed',
                details: error.message 
            }),
            { 
                status: 500, 
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

// ユーザーデータバックアップ
async function backupUsers() {
    const { data: profiles, error } = await supabase
        .from('profiles')
        .select(`
            *,
            users!inner(email, created_at)
        `);

    if (error) throw error;

    return {
        table: 'users_and_profiles',
        count: profiles.length,
        data: profiles,
        exported_at: new Date().toISOString()
    };
}

// 予想データバックアップ
async function backupPredictions() {
    const { data: predictions, error } = await supabase
        .from('race_predictions')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) throw error;

    return {
        table: 'race_predictions',
        count: predictions.length,
        data: predictions,
        exported_at: new Date().toISOString()
    };
}

// 全データバックアップ
async function backupAll() {
    const [users, predictions, newsletterLogs] = await Promise.all([
        backupUsers(),
        backupPredictions(),
        backupNewsletterLogs()
    ]);

    return {
        backup_type: 'full',
        tables: {
            users: users,
            predictions: predictions,
            newsletter_logs: newsletterLogs
        },
        total_records: users.count + predictions.count + newsletterLogs.count,
        exported_at: new Date().toISOString()
    };
}

// メルマガログバックアップ
async function backupNewsletterLogs() {
    try {
        const { data: logs, error } = await supabase
            .from('newsletter_logs')
            .select('*')
            .order('sent_at', { ascending: false })
            .limit(100); // 最新100件

        if (error) throw error;

        return {
            table: 'newsletter_logs',
            count: logs?.length || 0,
            data: logs || [],
            exported_at: new Date().toISOString()
        };
    } catch (error) {
        console.error('Newsletter logs backup error:', error);
        return {
            table: 'newsletter_logs',
            count: 0,
            data: [],
            error: error.message,
            exported_at: new Date().toISOString()
        };
    }
}

// バックアップ履歴取得
export async function GET({ request }) {
    try {
        // 管理者権限チェック
        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.includes(import.meta.env.ADMIN_API_KEY)) {
            return new Response(
                JSON.stringify({ error: 'Unauthorized' }),
                { status: 401, headers: { 'Content-Type': 'application/json' } }
            );
        }

        const { data: backupLogs, error } = await supabase
            .from('backup_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;

        return new Response(
            JSON.stringify({
                backups: backupLogs,
                count: backupLogs.length
            }),
            { 
                status: 200, 
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        return new Response(
            JSON.stringify({ 
                error: 'Failed to fetch backup history',
                details: error.message 
            }),
            { 
                status: 500, 
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}