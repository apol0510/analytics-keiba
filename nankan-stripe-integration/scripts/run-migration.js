// データベースマイグレーション実行スクリプト
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 環境変数を読み込み
const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
    console.error('❌ 環境変数が設定されていません:');
    console.error('PUBLIC_SUPABASE_URL:', !!supabaseUrl);
    console.error('SUPABASE_SERVICE_ROLE_KEY:', !!serviceRoleKey);
    process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

async function runMigration() {
    try {
        console.log('🚀 データベースマイグレーションを開始...');

        // マイグレーションファイルを読み込み
        const migrationPath = join(__dirname, '..', 'supabase', 'migrations', '003_payment_system_upgrade.sql');
        const migrationSQL = readFileSync(migrationPath, 'utf-8');
        
        console.log('📄 マイグレーションファイルを読み込みました');

        // SQLを実行（Supabaseでは rpc を使って SQL を実行）
        const { data, error } = await supabase.rpc('exec_sql', { 
            sql_query: migrationSQL 
        });

        if (error) {
            console.error('❌ マイグレーションエラー:', error);
            
            // 個別にテーブル作成を試行
            console.log('⚡ 個別実行を試行中...');
            await runIndividualMigrationSteps();
        } else {
            console.log('✅ マイグレーション完了:', data);
        }

    } catch (error) {
        console.error('❌ 実行エラー:', error);
        process.exit(1);
    }
}

async function runIndividualMigrationSteps() {
    const steps = [
        // ENUMタイプ作成
        "CREATE TYPE IF NOT EXISTS subscription_plan AS ENUM ('free','standard','premium');",
        "CREATE TYPE IF NOT EXISTS subscription_status AS ENUM ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused');",
        
        // profilesテーブル拡張
        `ALTER TABLE profiles 
         ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE,
         ADD COLUMN IF NOT EXISTS active_plan subscription_plan DEFAULT 'free',
         ADD COLUMN IF NOT EXISTS active_status subscription_status DEFAULT 'incomplete',
         ADD COLUMN IF NOT EXISTS active_subscription_id TEXT,
         ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMPTZ;`,
        
        // subscriptionsテーブル作成
        `CREATE TABLE IF NOT EXISTS subscriptions (
          id TEXT PRIMARY KEY,
          profile_id UUID REFERENCES profiles(id) NOT NULL,
          customer_id TEXT NOT NULL,
          price_id TEXT NOT NULL,
          plan subscription_plan NOT NULL,
          status subscription_status NOT NULL,
          current_period_start TIMESTAMPTZ,
          current_period_end TIMESTAMPTZ,
          cancel_at TIMESTAMPTZ,
          cancel_at_period_end BOOLEAN DEFAULT FALSE,
          default_payment_method TEXT,
          latest_invoice TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );`,
        
        // stripe_eventsテーブル作成
        `CREATE TABLE IF NOT EXISTS stripe_events (
          event_id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          received_at TIMESTAMPTZ DEFAULT NOW(),
          payload JSONB NOT NULL
        );`
    ];

    for (const [index, step] of steps.entries()) {
        try {
            console.log(`🔄 ステップ ${index + 1}/${steps.length} 実行中...`);
            const { error } = await supabase.rpc('exec_sql', { sql_query: step });
            if (error) {
                console.error(`❌ ステップ ${index + 1} エラー:`, error);
            } else {
                console.log(`✅ ステップ ${index + 1} 完了`);
            }
        } catch (err) {
            console.error(`❌ ステップ ${index + 1} 実行エラー:`, err);
        }
    }
}

runMigration();