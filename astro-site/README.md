# 🏇 NANKANアナリティクス - AI競馬予想プラットフォーム

南関競馬専門のAI予想システム with Stripe決済システム

## ⚠️ **削除厳禁ファイル**

以下のファイルは絶対に削除してはいけません：
- `../CLAUDE.md` - プロジェクト全体の設定・ルール
- `../DAILY_UPDATE_PROCEDURES.md` - 日常更新作業手順（馬単・三連複・予想・穴馬・画像）
- `../DAILY_UPDATE_PROCEDURES.BACKUP.md` - バックアップファイル

## 🚀 クイックスタート

### 1. 依存関係のインストール
```bash
npm install
```

### 2. 環境変数の設定
```bash
cp .env.example .env
# .envを編集してStripe、Supabase、SendGridの設定を入力
```

### 3. データベースセットアップ
1. Supabase SQL Editorにアクセス
2. `supabase/migrations/003_payment_system_upgrade.sql` を実行

### 4. Stripe Webhook（ローカル開発）
```bash
# 別ターミナルで実行
stripe listen --forward-to http://localhost:4321/api/stripe/webhook
```

### 5. 開発サーバー起動
```bash
npm run dev
```

ブラウザで http://localhost:4321 にアクセス

## 📋 プラン構成

| プラン | 料金 | アクセス範囲 |
|--------|------|--------------|
| 無料 | ¥0 | メインレース（11R）のみ |
| スタンダード | ¥5,980/月 | 後半3レース（10R、11R、12R） |
| プレミアム | ¥9,980/月 | 全レース（1R〜12R） |

## 🏗️ アーキテクチャ

### フロントエンド
- **Astro** - Static Site Generator with SSR
- **TypeScript** - 型安全な開発
- **TailwindCSS** - ユーティリティファーストCSS

### バックエンド
- **Supabase** - データベース、認証、リアルタイム
- **Stripe** - 決済処理、サブスクリプション管理
- **SendGrid** - メール送信

### ホスティング
- **Netlify** - 自動デプロイ、サーバーレス関数

## 📁 プロジェクト構造

```
├── docs/
│   └── stripe-spec.md          # Stripe仕様書
├── src/
│   ├── lib/
│   │   ├── stripe.ts           # Stripe統合
│   │   ├── supabaseAdmin.ts    # Supabase管理者クライアント
│   │   ├── billing/
│   │   │   └── plan.ts         # プラン定義
│   │   ├── access.ts           # アクセス制御
│   │   └── mail.ts             # SendGridメール送信
│   ├── pages/
│   │   ├── pricing.astro       # 料金プランページ
│   │   ├── payment/
│   │   │   └── success.astro   # 決済完了ページ
│   │   └── api/stripe/
│   │       ├── create-checkout.ts  # Checkout作成
│   │       ├── webhook.ts          # Webhook処理
│   │       └── portal.ts           # Billing Portal
│   └── layouts/
│       └── Layout.astro        # 基本レイアウト
├── supabase/migrations/
│   └── 003_payment_system_upgrade.sql  # DBマイグレーション
└── scripts/
    └── run-migration.js        # マイグレーション実行
```

## 🛠️ 開発コマンド

```bash
# 開発サーバー起動
npm run dev

# 本番ビルド
npm run build

# プレビュー
npm run preview

# 型チェック
npm run typecheck
```

## 🔧 環境設定

### 必須環境変数

```bash
# Stripe
STRIPE_MODE=test
STRIPE_SECRET_KEY=sk_test_...
PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET_TEST=whsec_...
STRIPE_STANDARD_PRICE_ID_TEST=price_...
STRIPE_PREMIUM_PRICE_ID_TEST=price_...

# Supabase
PUBLIC_SUPABASE_URL=https://xxx.supabase.co
PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# SendGrid
SENDGRID_API_KEY=SG...

# App
SITE_URL=http://localhost:4321
```

### Stripeダッシュボード設定

1. **Products/Prices** - Test/Live環境で作成
2. **Customer Portal** - 有効化（プラン変更・解約許可）
3. **Webhooks** - Test: `http://localhost:4321/api/stripe/webhook`
4. **Emails** - Send receipts ON

### Supabaseセットアップ

1. **SQL実行** - マイグレーションファイルを実行
2. **RLS有効化** - profiles、subscriptions、stripe_eventsテーブル
3. **Service Role Key** - サーバーサイドでのみ使用

## 🔄 決済フロー

```
プラン選択 → Stripe Checkout → 決済完了 → Webhook処理 → DB更新 → メール送信
```

### Webhook処理（冪等性対応）

1. `event_id`で重複チェック
2. `stripe_events`テーブルに記録
3. イベント別処理：
   - `checkout.session.completed` - 初回購入
   - `invoice.paid` - 定期支払い成功
   - `invoice.payment_failed` - 支払い失敗
   - `customer.subscription.updated` - プラン変更
   - `customer.subscription.deleted` - 解約

## 🧪 テスト

### ローカル開発テスト

1. Stripe CLIでWebhookリスニング
2. テスト決済実行（`/pricing`から）
3. DB更新確認（profiles/subscriptionsテーブル）
4. メール送信確認

### 本番前チェック

1. 環境変数の本番用切り替え
2. Stripe価格IDの確認
3. Webhook URLの本番登録
4. 実際の低額決済テスト

## 📊 監視・運用

### 重要指標
- Webhook成功率: 100%目標
- 決済→DB反映時間: 3分以内
- エラー発生時の自動復旧

### トラブルシューティング
1. Stripeダッシュボードでイベント確認
2. `stripe_events`テーブルで処理履歴確認
3. 必要に応じて手動データ同期

## 🚢 デプロイ

### Netlify設定
1. GitHubリポジトリ連携
2. ビルドコマンド: `npm run build`
3. 出力ディレクトリ: `dist/`
4. Node.js 18+
5. 環境変数を本番用に設定

### 本番チェックリスト
- [ ] Stripe本番キー設定
- [ ] Supabase本番URL設定
- [ ] SendGrid本番キー設定
- [ ] Webhook本番URL登録
- [ ] DNS設定完了
- [ ] SSL証明書有効

## 📄 ライセンス

MIT License

## 🤝 サポート

- Email: support@nankan-analytics.keiba.link
- Issues: [GitHub Issues](https://github.com/your-repo/issues)

---

**最終更新**: 2025-08-30  
**バージョン**: 1.0.0 - 完全自動化対応版