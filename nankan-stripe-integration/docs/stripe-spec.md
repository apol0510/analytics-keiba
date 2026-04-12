# Stripe決済システム完全仕様書

## 概要

NANKANアナリティクスの有料会員向けStripe決済システムの完全仕様書です。

## プラン構成

### 料金体系
- **無料プラン**: ¥0 - メインレース（11R）のみ
- **スタンダードプラン**: ¥5,980/月 - 後半3レース（10R、11R、12R）
- **プレミアムプラン**: ¥9,980/月 - 全レース（1R〜12R）

### レースアクセス権限
```typescript
// 12レース開催時の例
11R: free (メインレース)
10R, 12R: standard
1R-9R: premium
```

## アーキテクチャ

### 1. フロントエンド
- **プラン選択**: `/pricing` - Astroページ
- **決済完了**: `/payment/success` - 仮完了画面（Webhook待ち）
- **課金管理**: `/billing` - Stripe Customer Portal

### 2. APIエンドポイント
- `POST /api/stripe/create-checkout` - Checkout Session作成
- `POST /api/stripe/webhook` - Webhook処理（冪等性対応）
- `POST /api/stripe/portal` - Billing Portal作成

### 3. データベース

#### profiles テーブル（既存拡張）
```sql
-- 新規追加カラム
stripe_customer_id TEXT UNIQUE
active_plan subscription_plan DEFAULT 'free'
active_status subscription_status DEFAULT 'incomplete'
active_subscription_id TEXT
subscription_current_period_end TIMESTAMPTZ
```

#### subscriptions テーブル（新規）
```sql
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,              -- stripe_subscription_id
  profile_id UUID REFERENCES profiles(id),
  customer_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  plan subscription_plan NOT NULL,
  status subscription_status NOT NULL,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### stripe_events テーブル（新規）
```sql
CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  payload JSONB NOT NULL
);
```

## 決済フロー

### 1. 購入フロー
```
プラン選択 → Stripe Checkout → 決済完了 → Webhook処理 → アカウント有効化
```

### 2. Webhook処理（冪等性対応）
```typescript
1. event_idで重複チェック
2. stripe_eventsテーブルに記録
3. 各イベントタイプ別処理：
   - checkout.session.completed
   - invoice.paid / invoice.payment_succeeded  
   - invoice.payment_failed
   - customer.subscription.updated
   - customer.subscription.deleted
```

### 3. データ同期
- `subscriptions`テーブル：Stripe情報の正規化
- `profiles`テーブル：UI表示用スナップショット

## 環境設定

### テスト環境 (.env)
```bash
STRIPE_MODE=test
STRIPE_SECRET_KEY=sk_test_...
PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET_TEST=whsec_...
STRIPE_STANDARD_PRICE_ID_TEST=price_test_...
STRIPE_PREMIUM_PRICE_ID_TEST=price_test_...
```

### 本番環境 (.env.production)
```bash
STRIPE_MODE=live
STRIPE_SECRET_KEY=sk_live_...
PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET_LIVE=whsec_...
STRIPE_STANDARD_PRICE_ID_LIVE=price_live_...
STRIPE_PREMIUM_PRICE_ID_LIVE=price_live_...
```

## セキュリティ

### Row Level Security (RLS)
```sql
-- 課金情報は本人のみ閲覧可
CREATE POLICY "profiles_select_self" ON profiles FOR SELECT 
USING (auth.uid() = id);

-- 課金系フィールドは更新不可（Webhookのみ）
CREATE POLICY "profiles_update_self_non_billing" ON profiles FOR UPDATE
USING (auth.uid() = id)
WITH CHECK (
  stripe_customer_id IS NOT DISTINCT FROM OLD.stripe_customer_id
  AND active_plan IS NOT DISTINCT FROM OLD.active_plan
  -- その他の課金フィールドも同様
);
```

## テスト仕様

### ローカル開発
1. `stripe listen --forward-to http://localhost:4321/api/stripe/webhook`
2. テスト決済実行
3. Webhook受信確認
4. DB更新確認

### 本番前チェック
1. 環境変数の完全分離確認
2. Price IDの本番用設定
3. Webhook URLの本番登録
4. 実際の低額決済テスト

## 監視・運用

### 重要指標
- Webhook成功率（100%目標）
- 決済→DB反映時間（3分以内）
- エラー発生時の自動復旧

### トラブルシュート
- `stripe_events`テーブルでイベント履歴確認
- Stripeダッシュボードでエラーログ確認
- 必要に応じて手動データ同期

## 依存関係

### 必須パッケージ
```json
{
  "dependencies": {
    "stripe": "^16.0.0",
    "@supabase/supabase-js": "^2.48.0",
    "@sendgrid/mail": "^8.1.0",
    "astro": "^4.10.0"
  }
}
```

### 必須環境変数
- Stripe: SECRET_KEY, PUBLISHABLE_KEY, WEBHOOK_SECRET
- Supabase: URL, ANON_KEY, SERVICE_ROLE_KEY  
- SendGrid: API_KEY

---

**最終更新**: 2025-08-30
**バージョン**: 1.0.0 - 完全自動化対応版