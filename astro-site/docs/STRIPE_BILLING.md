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
| `src/lib/billing/stripeWithdrawal.js` | 退会（即時退会）の判定と状態遷移（単一源）|
| `netlify/functions/stripe-{create-checkout,checkout-complete,webhook,portal,withdraw}.js` | 入口 |
| `src/pages/checkout/success.astro` | 決済完了画面 |
| `scripts/stripe-setup.mjs` | 商品・価格・Webhook・ポータル設定を API で用意し Netlify env へ入れる |
| テスト | `npm run test:billing`（`check:safety` に組込）|

## 2. Customers に書く値

| 状態 | 書く値 |
|---|---|
| 有効（active / trialing）| `プラン=Premium` `PlanType=Monthly` `Status=active` `PaymentMethod=Stripe` `有効期限=支払い済み期間の終わり(JST)+2日`（**支払い済み請求書の期間末**。購読の current_period_end は支払い前に進むので使わない） `VenueAccess=''/jra/nankan` `StripeCustomerId` `StripeSubscriptionId`。初回だけ `PaidAt` と退会フラグのリセット、Light からなら `PremiumConvertedFrom/At` |
| **会員の退会**（stripe-withdraw・2026-10-07 MK 確定）| 購読を**即時解約**（`prorate:false`・`invoice_now:false`・`cancellation_details.comment=ak_member_withdrawal`・idempotency key）→ `WithdrawalRequested=true` `WithdrawalDate` `WithdrawalReason` `CancelledAt` `有効期限=昨日(JST)`（縮めるだけ）。**有料権限は即時停止・残り期間は使えない** |
| 終了（canceled / unpaid / incomplete_expired）で**退会の印あり** | 上と同じ退会状態（退会 API の Customers 書込みが失敗しても、終了イベントで収束する）|
| 終了で退会の印なし（決済失敗の再試行切れ・管理者の解約）| 自分の購読なら `有効期限` を**支払い済み期間末の翌暦日**へ（縮めるだけ・延ばさない）+ `CancelledAt` |
| 解約予約（cancel_at_period_end）| AK は作らない（ポータルの解約は無効・期間末解約は廃止）。Stripe 画面で付けられても期限は変えない |
| 支払い済み請求書なし（初回決済の処理中）| 書かない（`awaiting_payment`）|
| 支払い待ち（past_due）・未完了 | 書かない（期限で自然に閉じる。Stripe の再試行で払えれば延びる）|
| 未登録の人のレコード作成 | **Webhook の `checkout.session.completed` だけ**が作る（Stripe は同じイベントを並行に送らない）。他のイベント・決済完了画面は作成を待つ（`no_record_yet`、画面は「確認中」で再試行）。2026-10-02 の E2E で複数イベントが同時に届き 2 レコード作られたため（Redis の無い Deploy Preview ではロックが効かない）|
| 書かない＋管理者通知 | 別の購読が生きている（二重課金）／買い切り会員／年払いの残りが長い／未登録 Price／同じメールのレコードが複数 |

- 権限判定は既存の `resolveEntitlements`。`VenueAccess` は**有料 Premium 契約だけ**を会場で絞る（無料特典・三連複買い切りには効かない）。
- 会場別の有料ページは `gatePaidPage({ requiredPlan: 'premium-jra' | 'premium-nankan' })`。両会場の Premium は両方通る。
- 銀行振込の入金確認（`buildConfirmationFields`）は `VenueAccess=''` に戻す（会場版から年払いへ移った人を両会場に）。

### 退会（2026-10-07 MK 確定・期間末解約は廃止）

```
マイページ「アカウント管理」（Stripe 月額会員だけ・退会済みは出さない）
  ├ カード変更・請求書 / プラン変更 → stripe-portal（Stripe カスタマーポータル。解約は無効）
  └ 退会する → 確認画面（すぐ利用できなくなる・残り期間を使うなら退会しない）→ 退会を確定する
       └ POST stripe-withdraw { confirm: true }（ak_session 必須・許可オリジンのみ）
            → 購読ごとのロック（applySubscription と同じ鍵）の中で最新レコードを読み直す
            → 退会済み 409 / 本人の購読と不一致 409 / Stripe 月額でない 404
            → Stripe 即時解約 → Customers に退会状態 → 本人へ完了メール・管理者通知 → セッション Cookie を消す
            → /withdrawal-complete/
```

- 予約停止・次回更新から停止・期間末解約・解約取消は提供しない。再利用は新規契約（新しい購読の反映が退会フラグを戻す）。
- Stripe の解約に失敗したら Customers を書かない（食い違わない）。Customers の書込みだけ失敗したら管理者通知、終了イベントが同じ退会状態へ収束。
- メールアドレスだけで呼べる `process-withdrawal` は Stripe 会員の購読を操作しない（案内メールだけ）。
- 仕様テスト: `src/lib/billing/stripeWithdrawal.test.mjs`（即時利用不可・未来の期限でも不可・予約停止を作らない・取消導線なし・ポータルで解約不可・他会員へ影響なし・二重退会防止・直 URL で回避不可・再契約可能）。
- ⚠️ 既知の残り: 有料ページの認可は Function ごとに Customers を最大 10 分キャッシュする（`purchaseAnchorLookup`）。
  退会の応答でセッション Cookie は消すが、**退会前の Cookie を別に保存して再送した場合**、そのインスタンスのキャッシュが切れるまで（最大 10 分）通る余地がある。

### 表示方針（2026-10-02 MK 確定・2026-10-07 退会条件を更新）

退会条件（即時に利用終了・残り期間は使えない・取消不可・最低利用期間なし・日割り返金なし）は
`/refund/`・`/terms/`・`/legal/` に正確に、FAQ に通常の説明として書く。`/pricing/` のカード・見出しと
Checkout の custom_text では強調しない（guard: `stripeDisplayPolicy.guard.test.mjs`）。

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

**商品名だけを揃える**（Product 名は `stripePlans.js` の `productName` が単一源。Price・Webhook・ポータル・env には触れない）:

```bash
STRIPE_KEY_FILE=~/.analytics-keiba-ops/stripe-live-key node <worktree>/astro-site/scripts/stripe-setup.mjs \
  --context production --site https://analytics.keiba.link --products-only [--apply]
```

⚠️ `--products-only` を付けずに `--apply` すると Webhook を作り直し、署名鍵が変わる（env 更新と再デプロイが要る）。
スクリプトは test 鍵を production に、live 鍵を production 以外に入れると止まる。

| env | 内容 |
|---|---|
| `STRIPE_SECRET_KEY` | 秘密鍵（context ごと: production=live / deploy-preview=test）。**鍵の種類で live / test を決める** |
| `STRIPE_WEBHOOK_SECRET` | Webhook 署名鍵（スクリプトが作成時に設定）|

⚠️ **env はこの 2 つだけ**。Price ID・ポータル設定 ID は秘密ではないので `stripePlans.js` の `STRIPE_IDS`（test / live）に持つ。
2026-10-02 に 6 つを production の env に入れたところ、関数の環境変数が **AWS Lambda の上限 4KB を超えて本番デプロイが全部失敗**した
（09:01〜10:17 の自動取込も未反映。env を外して復旧）。`STRIPE_PRICE_*` / `STRIPE_PORTAL_CONFIGURATION_ID` は上書き用として読むが、通常は設定しない。
production の env を増やすときは本番ビルドが通ることを先に確かめる（env だけ入れて Build Hook で 1 回ビルド）。

Stripe ダッシュボードで人が行うのは: アカウント作成・本人確認・入金口座・（Live）領収書メールの ON。

## 4. E2E（テストモード・Deploy Preview）

| # | 確認 | 期待 |
|---|---|---|
| 1 | `/pricing/` で中央版 → メール入力 → Stripe Checkout | ¥2,980/月・カード 4242 4242 4242 4242 |
| 2 | 決済完了画面 | 「お申し込みが完了しました」・ログインリンク送信 |
| 3 | Customers | 新規または既存レコードに §2 の値・`VenueAccess=jra` |
| 4 | Webhook（Stripe ダッシュボード / ログ）| 200・2 回目以降 `renewed`（重複で壊れない）|
| 5 | 購読を Premium の Price へ変更（API）| `VenueAccess=''` |
| 6 | 購読を即時解約（API・退会の印なし）| `有効期限` が支払い済み期間末へ縮む・`CancelledAt` |
| 6b | 退会（stripe-withdraw の状態遷移）| 購読 canceled・`WithdrawalRequested=true`・`有効期限`=昨日・有料ページ拒否。2 回目は 409 |
| 7 | 同じメールでもう一度申込 | 有効中は 409 already_subscribed |
| 後片付け | テスト顧客レコード・Stripe テスト顧客を削除 | Customers 件数が元に戻る |

⚠️ Deploy Preview は本番の Airtable を使う。テストのメールアドレスは使い捨て（`+stripe-e2e` 等）にし、終わったら削除する。
⚠️ マジックリンクは本番 URL 固定のため、Deploy Preview では会員画面のログイン確認はできない（本番で確認する）。

## 5. ロールバック

- 販売を止める: production の `STRIPE_PRICE_*` を unset → 再デプロイ（ボタンは「準備中」表示・503）。既存契約の課金は Stripe 側で継続する。
- コードを戻す: revert PR → merge。`VenueAccess` が入った会員がいる場合、旧コードは会場を見ないため**両会場が開く**（閉じる方向の事故にはならない）。
- 課金を止める: Stripe ダッシュボードで該当購読を解約（Webhook が期限を縮める）。
- 退会機能（2026-10-07）を戻す: revert PR → merge。マイページの「退会する」が消えるだけで、退会済みの会員の状態（退会フラグ・期限）は戻さない（再利用は新規契約）。
  ポータル設定（解約無効）は Stripe 側の設定なので別に戻す必要がある（`subscription_cancel` を再有効化）。期間末解約に戻すかは MK の事業判断。
