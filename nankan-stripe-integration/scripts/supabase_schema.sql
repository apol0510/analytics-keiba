-- プラン種別
CREATE TYPE subscription_plan   AS ENUM ('free','standard','premium');
CREATE TYPE subscription_status AS ENUM ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused');

-- profiles 拡張（事前に profiles(id UUID, user_email TEXT...) がある想定）
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS active_plan subscription_plan DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS active_status subscription_status DEFAULT 'incomplete',
  ADD COLUMN IF NOT EXISTS active_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_uidx ON profiles(user_email);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_customer_uidx ON profiles(stripe_customer_id);

-- subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
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

-- webhook冪等＆監査
CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  payload JSONB NOT NULL
);

-- RLS（課金系はクライアント更新禁止）
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select_self"
ON profiles FOR SELECT USING (auth.uid() = id);

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
