-- ===============================================
-- 決済システム完全版マイグレーション
-- ===============================================

-- 1. ENUMタイプ作成
CREATE TYPE subscription_plan   AS ENUM ('free','standard','premium');
CREATE TYPE subscription_status AS ENUM ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused');

-- 2. profilesテーブルの拡張
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS active_plan subscription_plan DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS active_status subscription_status DEFAULT 'incomplete',
  ADD COLUMN IF NOT EXISTS active_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMPTZ;

-- 既存の重複カラム削除（存在する場合）
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='subscription_tier') THEN
        ALTER TABLE profiles DROP COLUMN subscription_tier;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='subscription_period_end') THEN
        ALTER TABLE profiles DROP COLUMN subscription_period_end;
    END IF;
END $$;

-- インデックス作成
CREATE UNIQUE INDEX IF NOT EXISTS profiles_customer_uidx ON profiles(stripe_customer_id);
CREATE INDEX IF NOT EXISTS profiles_active_plan_idx ON profiles(active_plan);
CREATE INDEX IF NOT EXISTS profiles_active_status_idx ON profiles(active_status);

-- 3. subscriptionsテーブル（Stripe サブスクリプションの正規化）
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,                         -- stripe_subscription_id
  profile_id UUID REFERENCES profiles(id) NOT NULL,
  customer_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  plan subscription_plan NOT NULL,
  status subscription_status NOT NULL,
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  cancel_at            TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  default_payment_method TEXT,
  latest_invoice TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- subscriptions インデックス
CREATE INDEX IF NOT EXISTS subscriptions_profile_idx ON subscriptions(profile_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions(status);
CREATE INDEX IF NOT EXISTS subscriptions_customer_idx ON subscriptions(customer_id);

-- 4. stripe_events（Webhook冪等性＆監査）
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  payload JSONB NOT NULL
);

-- stripe_events インデックス
CREATE INDEX IF NOT EXISTS stripe_events_type_idx ON stripe_events(type);
CREATE INDEX IF NOT EXISTS stripe_events_received_idx ON stripe_events(received_at);

-- 5. RLS強化（課金情報の保護）
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;

-- 既存のポリシーを削除
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;

-- 新しいポリシーも削除（存在する場合）
DROP POLICY IF EXISTS "profiles_select_self" ON profiles;
DROP POLICY IF EXISTS "profiles_update_self_non_billing" ON profiles;
DROP POLICY IF EXISTS "profiles_insert_self" ON profiles;

-- 新しいRLSポリシー
-- profiles: 読み取りは本人のみ
CREATE POLICY "profiles_select_self"
ON profiles FOR SELECT
USING (auth.uid() = id);

-- profiles: 更新は本人のみ、ただし課金系フィールドは除外
CREATE POLICY "profiles_update_self_non_billing"
ON profiles FOR UPDATE
USING (auth.uid() = id)
WITH CHECK (
  auth.uid() = id
  AND (stripe_customer_id IS NOT DISTINCT FROM OLD.stripe_customer_id)
  AND (active_plan IS NOT DISTINCT FROM OLD.active_plan)
  AND (active_status IS NOT DISTINCT FROM OLD.active_status)
  AND (active_subscription_id IS NOT DISTINCT FROM OLD.active_subscription_id)
  AND (subscription_current_period_end IS NOT DISTINCT FROM OLD.subscription_current_period_end)
);

-- profiles: 挿入は本人のみ
CREATE POLICY "profiles_insert_self"
ON profiles FOR INSERT
WITH CHECK (auth.uid() = id);

-- subscriptions / stripe_events は Service Role のみアクセス可能
-- （一般ユーザーはRLSにより自動的に拒否される）

-- 6. 自動更新関数とトリガー
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- subscriptions の updated_at 自動更新
DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER update_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 7. 新規ユーザー自動プロファイル作成（既存関数の更新）
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, display_name, active_plan, active_status)
    VALUES (
        new.id, 
        new.raw_user_meta_data->>'display_name',
        'free',
        'incomplete'
    );
    RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 既存トリガーの再設定
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 8. 既存データの移行（必要に応じて）
-- 注意: 既存のsubscription_tier, subscription_status データを新しいスキーマに移行
UPDATE profiles 
SET active_plan = 
    CASE 
        WHEN subscription_tier = 'standard' THEN 'standard'::subscription_plan
        WHEN subscription_tier = 'premium' THEN 'premium'::subscription_plan
        ELSE 'free'::subscription_plan
    END,
    active_status = 
    CASE 
        WHEN subscription_status = 'active' THEN 'active'::subscription_status
        WHEN subscription_status = 'canceled' THEN 'canceled'::subscription_status
        WHEN subscription_status = 'past_due' THEN 'past_due'::subscription_status
        ELSE 'incomplete'::subscription_status
    END
WHERE subscription_tier IS NOT NULL OR subscription_status IS NOT NULL;

-- 9. ヘルパービュー（管理用）
CREATE OR REPLACE VIEW active_subscriptions AS
SELECT 
    p.id as profile_id,
    p.display_name,
    p.stripe_customer_id,
    p.active_plan,
    p.active_status,
    s.current_period_end,
    s.cancel_at_period_end,
    s.created_at as subscription_created
FROM profiles p
LEFT JOIN subscriptions s ON p.active_subscription_id = s.id
WHERE p.active_status IN ('active', 'trialing');

-- 管理者のみこのビューを閲覧可能
REVOKE ALL ON active_subscriptions FROM PUBLIC;
GRANT SELECT ON active_subscriptions TO service_role;

-- 決済システム完全版マイグレーション完了
-- ENUMタイプ、subscriptions、stripe_events、強化されたRLS を追加