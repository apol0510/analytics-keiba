-- ===============================================
-- シンプル決済システムセットアップ（新規DB用）
-- ===============================================

-- 1. ENUMタイプ作成
CREATE TYPE subscription_plan AS ENUM ('free','standard','premium');
CREATE TYPE subscription_status AS ENUM ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused');

-- 2. profilesテーブル作成
CREATE TABLE profiles (
  id UUID REFERENCES auth.users PRIMARY KEY,
  display_name TEXT,
  stripe_customer_id TEXT UNIQUE,
  active_plan subscription_plan DEFAULT 'free',
  active_status subscription_status DEFAULT 'incomplete',
  active_subscription_id TEXT,
  subscription_current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. subscriptionsテーブル
CREATE TABLE subscriptions (
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
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. stripe_eventsテーブル（Webhook冪等性）
CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  payload JSONB NOT NULL
);

-- 5. インデックス作成
CREATE UNIQUE INDEX profiles_customer_uidx ON profiles(stripe_customer_id);
CREATE INDEX profiles_active_plan_idx ON profiles(active_plan);
CREATE INDEX subscriptions_profile_idx ON subscriptions(profile_id);
CREATE INDEX subscriptions_status_idx ON subscriptions(status);
CREATE INDEX stripe_events_type_idx ON stripe_events(type);

-- 6. RLS設定
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;

-- profilesポリシー: 読み取りは本人のみ
CREATE POLICY "profiles_select_self" ON profiles FOR SELECT USING (auth.uid() = id);

-- profilesポリシー: 更新は本人のみ（課金系フィールド除外）
CREATE POLICY "profiles_update_self_non_billing" ON profiles FOR UPDATE 
USING (auth.uid() = id)
WITH CHECK (
  auth.uid() = id AND
  stripe_customer_id IS NOT DISTINCT FROM OLD.stripe_customer_id AND
  active_plan IS NOT DISTINCT FROM OLD.active_plan AND
  active_status IS NOT DISTINCT FROM OLD.active_status
);

-- profilesポリシー: 挿入は本人のみ
CREATE POLICY "profiles_insert_self" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- 7. 自動プロフィール作成関数
CREATE OR REPLACE FUNCTION handle_new_user()
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

-- 8. 新規ユーザートリガー
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- セットアップ完了