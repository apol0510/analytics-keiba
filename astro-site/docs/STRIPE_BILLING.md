# Stripe 定期購読（Premium / 中央版 / 南関版）— 実装と運用の正本

商品・価格の決定は `docs/spec.md`「Stripe 定期購読」、経緯は `docs/decisions.md` 2026-10-02。

## 1. 全体像

```
/pricing/（data-checkout ボタン）
  └ POST stripe-create-checkout { plan, email? }   ← 金額は受け取らない（Stripe の Price が正本）
       ├ ログイン中（ak_session）→ そのレコードに紐付け（metadata.ak_record_id）
       ├ 未ログイン → 入力メール（Customers と照合。無ければ反映時に新規作成）
       └ 二重課金を作らない: 生きている購読がある / 買い切り / 年払い残存 → 409
  └ Stripe Checkout（カード）
       ├ success_url → /checkout/success/?session_id=…
       │     └ GET stripe-checkout-complete → applySubscription（その場で反映）→ 未ログインならマジックリンク送信
       └ Webhook → stripe-webhook → applySubscription（同じ判定・同じ排他ロック）
```

| ファイル | 役割 |
|---|---|
| `src/lib/billing/stripePlans.js` | 商品の単一源（planId・金額・会場・Price の env 名）|
| `src/lib/billing/stripeSubscriptionSync.js` | 購読 → Customers に書く値（純粋・判定の正本）|
| `src/lib/billing/stripeServer.js` | レコード特定・二重課金検知・PATCH・Redis 排他ロック |
| `src/lib/billing/stripeRuntime.js` / `stripeNotify.js` | Stripe クライアント・戻り先許可リスト・管理者通知 |
| `netlify/functions/stripe-{create-checkout,checkout-complete,webhook,portal}.js` | 入口 |
| `src/pages/checkout/success.astro` | 決済完了画面 |
| `scripts/stripe-setup.mjs` | 商品・価格・Webhook・ポータル設定を API で用意し Netlify env へ入れる |
| テスト | `npm run test:billing`（`check:safety` に組込）|

## 2. Customers に書く値

| 状態 | 書く値 |
|---|---|
| 有効（active / trialing）| `プラン=Premium` `PlanType=Monthly` `Status=active` `PaymentMethod=Stripe` `有効期限=請求期間の終わり(JST)+2日` `VenueAccess=''/jra/nankan` `StripeCustomerId` `StripeSubscriptionId`。初回だけ `PaidAt` と退会フラグのリセット、Light からなら `PremiumConvertedFrom/At` |
| 終了（canceled / unpaid / incomplete_expired）| 自分の購読なら `有効期限` を終了日へ**縮めるだけ** + `CancelledAt` |
| 支払い待ち（past_due）・未完了 | 書かない（期限で自然に閉じる。Stripe の再試行で払えれば延びる）|
| 書かない＋管理者通知 | 別の購読が生きている（二重課金）／買い切り会員／年払いの残りが長い／未登録 Price／同じメールのレコードが複数 |

- 権限判定は既存の `resolveEntitlements`。`VenueAccess` は**有料 Premium 契約だけ**を会場で絞る（無料特典・三連複買い切りには効かない）。
- 会場別の有料ページは `gatePaidPage({ requiredPlan: 'premium-jra' | 'premium-nankan' })`。両会場の Premium は両方通る。
- 銀行振込の入金確認（`buildConfirmationFields`）は `VenueAccess=''` に戻す（会場版から年払いへ移った人を両会場に）。

## 3. 初期設定（Stripe アカウント作成後）

**鍵は画面・ログ・commit に出さない。** 鍵ファイルは本人がコピーして作る（1 行・権限 600）:

```bash
pbpaste > ~/.analytics-keiba-ops/stripe-test-key && chmod 600 ~/.analytics-keiba-ops/stripe-test-key
```

```bash
cd /Users/user/Projects/analytics-keiba/astro-site   # netlify link 済みの場所で実行する
STRIPE_KEY_FILE=~/.analytics-keiba-ops/stripe-test-key \
  node <worktree>/astro-site/scripts/stripe-setup.mjs --context deploy-preview \
  --site https://deploy-preview-<PR>--analytics-keiba.netlify.app            # 下見
# 確認後に --apply を付けて実行 → 再デプロイ
```

Live は `--context production --site https://analytics.keiba.link` と `stripe-live-key`（`sk_live_`）。
スクリプトは test 鍵を production に、live 鍵を production 以外に入れると止まる。

| env | 内容 |
|---|---|
| `STRIPE_SECRET_KEY` | 秘密鍵（context ごと: production=live / deploy-preview=test）|
| `STRIPE_WEBHOOK_SECRET` | Webhook 署名鍵（スクリプトが作成時に設定）|
| `STRIPE_PRICE_PREMIUM` / `_JRA` / `_NANKAN` | Price ID |
| `STRIPE_PORTAL_CONFIGURATION_ID` | ポータル設定（期間末解約・会場版 ⇄ Premium の切替）|

Stripe ダッシュボードで人が行うのは: アカウント作成・本人確認・入金口座・（Live）領収書メールの ON。

## 4. E2E（テストモード・Deploy Preview）

| # | 確認 | 期待 |
|---|---|---|
| 1 | `/pricing/` で中央版 → メール入力 → Stripe Checkout | ¥2,980/月・カード 4242 4242 4242 4242 |
| 2 | 決済完了画面 | 「お申し込みが完了しました」・ログインリンク送信 |
| 3 | Customers | 新規または既存レコードに §2 の値・`VenueAccess=jra` |
| 4 | Webhook（Stripe ダッシュボード / ログ）| 200・2 回目以降 `renewed`（重複で壊れない）|
| 5 | 購読を Premium の Price へ変更（API）| `VenueAccess=''` |
| 6 | 購読を即時解約（API）| `有効期限` が終了日へ縮む・`CancelledAt` |
| 7 | 同じメールでもう一度申込 | 有効中は 409 already_subscribed |
| 後片付け | テスト顧客レコード・Stripe テスト顧客を削除 | Customers 件数が元に戻る |

⚠️ Deploy Preview は本番の Airtable を使う。テストのメールアドレスは使い捨て（`+stripe-e2e` 等）にし、終わったら削除する。
⚠️ マジックリンクは本番 URL 固定のため、Deploy Preview では会員画面のログイン確認はできない（本番で確認する）。

## 5. ロールバック

- 販売を止める: production の `STRIPE_PRICE_*` を unset → 再デプロイ（ボタンは「準備中」表示・503）。既存契約の課金は Stripe 側で継続する。
- コードを戻す: revert PR → merge。`VenueAccess` が入った会員がいる場合、旧コードは会場を見ないため**両会場が開く**（閉じる方向の事故にはならない）。
- 課金を止める: Stripe ダッシュボードで該当購読を解約（Webhook が期限を縮める）。
