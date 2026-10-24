# カード決済（Paddle・PayPal）— 共通層と各社の実装・運用の正本

方針の根拠は `docs/decisions.md` 2026-10-11（追記 3）・2026-10-13・2026-10-15。fincode は 2026-10-15 MK 決定で不使用・コードと手順書（旧 `FINCODE_BILLING.md`）を削除した（必要なら git 履歴の #788 `c94f6e47` を参照）。

## 0. いまの状態（2026-10-15）

| 項目 | Paddle（第一優先） | PayPal（予備） |
|---|---|---|
| アカウント | TIROL DATA LABO 名義で新規開設済み | 新規ビジネスアカウント開設済み |
| Sandbox E2E | **PASS**（2026-10-12・§4）| **PASS**（2026-10-13・§4）|
| 本番審査 | **本番アカウント承認**（2026-10-24 MK 報告・Payoneer 審査通過・Payout settings 保存。dashboard の Verify your account = Complete と API `GET /verifications` の onboarding・domain = completed を Claude が観測）。Website approval `checkout.tirol.link` = approved（Apple Pay verified）| **審査通過**（MK 報告 2026-10-15。承認の書面・メールは MK が保管）|
| 本番の鍵・Webhook | 設定中（2026-10-24〜・§2.1）。Live は**中立ホスト経由**（決済ページ `https://checkout.tirol.link/pay/`・通知先 `https://checkout.tirol.link/hooks/paddle`）| **設定済み（2026-10-15）**: Live Product `PROD-3CX00591EL992881E`・Plan 3 本（`PAYPAL_PLAN_IDS.live`）・Webhook `78F83880DR5445808`（本番 URL・15 イベント）・production env 4 件（scope functions）。⚠️ 関数 env は 4KB 上限ぎりぎり（決済メール v2 カナリア env を外して空けた）|
| 本番受付 | **閉じている**（`CARD_SALES_OPEN.paddle=false`）| 一回払いは**閉じている**（`.paypal=false`）。**月額の定期課金は PayPal で受ける方針**（2026-10-15 MK 決定・§3.5）。**2026-10-15 受付開始**（`SUBSCRIPTION_SALES_OPEN.paypal=true`）|
| 取扱可否（一次情報）| ⚠️ 禁止リストに「Betting-related products」「Sports forecasting/odds making where monetary or material prizes are involved」。**書面確認が要る** | 利用規定で「競馬またはドッグレース」は**事前承認**区分 → 審査通過 |

- 売るのは銀行振込と同じ一回払い（Premium 年払い ¥49,800／Light 会員 ¥44,820・買い切り ¥78,000）だけ。**月払い・定期課金は作らない**（Paddle の定期価格・PayPal Subscriptions は使わない。guard で固定）。
- 本番受付は、その決済会社が AK の取扱商品を承認したあと、MK の明示決定で `src/lib/billing/cardSales.js` の値を変える PR だけで開く。env では開かない。

## 0.5 冗長化の方針（2026-10-13 MK 確定・`decisions.md` 2026-10-13）

Paddle・PayPal は**お客様に選ばせる併設決済ではない**。決済会社の利用停止・障害・契約終了に備える事業継続のための冗長化。

| 項目 | 仕様 | 実装 |
|---|---|---|
| お客様の導線 | 「カードで支払う」1 本。決済会社の選択 UI は作らない | 共通入口 `card-create-checkout`（`cardCheckout.startCardCheckout`）。お客様のページから決済会社別の入口を呼ばない（guard テスト）|
| 受ける決済会社 | 第一 Paddle・予備 PayPal| `cardSales.ACTIVE_CARD_PROVIDER = 'paddle'`・`CARD_PROVIDER_ROLES` |
| 切替 | 運営側の設定 | `ACTIVE_CARD_PROVIDER` を変える PR（env では切り替えない）|
| 本番の申込制限 | 共通入口から、選ばれた 1 社だけ | `checkoutProviderGate`: live は `entry='card'` かつ active だけ（別入口 `use_card_checkout`・非 active `provider_not_active`）。各社の申込作成（`createPaddleCheckout`・`createPaypalOrder`）は必ずこれを通る |
| Sandbox | 各社を個別に検証できる | test モードは gate を通す（決済会社別の入口で E2E）|
| 自動フォールバック | **しない**。作成失敗・例外でも予備へ作り直さない | `startCardCheckout` は active の 1 社だけ呼ぶ（テスト固定）|
| 処理中の誤切替 | 切替前の会社の申込が残る会員は、切替後の会社で申込を作れない | Redis `ak:billing:open-checkout:{recordId}`（申込先・注文 ID・24 時間）。別社なら 409 `checkout_in_progress`。Redis が無い/読めないときは申込を作らない |
| 切替後の既存取引 | 確定・返金の反映は元の決済会社で続ける | Webhook・capture は `resolveCardMode` だけで判定（gate を使わない）|
| 共通 | 会員権限・料金・購入資格・完了画面 | `cardOneTime.js`・`entitlementLedger.js`（30 分以内の別決済は付与せず管理者へ）・`/checkout/card-complete/?provider=` |
| 本番受付 | 各社承認＋既存の販売開始条件 | `CARD_SALES_OPEN`（全社 false のまま）|

Sandbox 実測（2026-10-13・PR #794 の Deploy Preview 経由 `sandbox.checkout.tirol.link`）: 共通入口 `card-create-checkout` → 200 `provider: paddle`・Paddle 取引作成・Redis に申込印（24h）。印を別社（paypal）に書き換えると 409 `checkout_in_progress`（申込を作らない）。後片付け済み（使い捨てレコード削除・印削除・preview の鍵 unset）。

切替手順（運営）: ① 切替先の Sandbox E2E 済み・本番承認済み・`CARD_SALES_OPEN` が開いていることを確認 ② `ACTIVE_CARD_PROVIDER` を変える PR → merge → deploy ③ 本番で `card-create-checkout` の応答の `provider` を確認。切替前の会社の Webhook 設定は残す（既存取引の確定・返金のため）。

## 1. 共通層（決済会社に依存しない会員権限）

```
各社アダプタ（API で照会して確かめた事実だけを渡す）
  paddle/paddleServer.js ─┐
  paypal/paypalServer.js ─┴─▶ entitlementLedger.js ─▶ cardOneTime.decideCardGrant（何を書くか・純粋）
                                 │                    cardRefund.decideRefundRevert（何に戻すか・純粋）
                                 └─ Airtable Customers（PATCH はここだけ）
```

| ファイル | 役割 |
|---|---|
| `cardSales.js` | 販売可否（`CARD_SALES_OPEN`）とサイト×鍵の組合せ（本番サイト=本番鍵かつ販売開始済み／それ以外=Sandbox 鍵だけ）|
| `cardOneTime.js` | 商品・金額・申込前判定（買い切り会員・生きている Stripe 月額・会員価格の資格）・付与内容 |
| `entitlementLedger.js` | 会員ロック・決済ごとの状態・二重購入の疑い・付与・返金の戻し・完了画面の状態 |
| `cardRefund.js` | 返金時に付与前へ戻す判定（付与後に別の変更があれば戻さない）|
| `cardNotify.js` | 管理者通知（support@・顧客には送らない）|
| `cardE2E.js` | Deploy Preview の E2E 用 recordId 指定（テストモード・専用秘密・`+card-e2e` のレコードだけ）|
| `netlify/functions/card-order-status.js` | 完了画面の状態照会（本人の決済だけ）|
| `src/pages/checkout/card-complete.astro` | 共通の完了画面（`?provider=&order=`）|

### 二重課金・二重昇格・誤失効・誤通知を作らない仕組み

- **申込前**: 買い切り会員・生きている Stripe 月額・資格のない会員価格は決済を作らない（409）。
- **反映は API 照会の結果だけ**: 通知の中身・戻り先への遷移は支払いの証明にしない。
- **会員ロック** `ak:billing:member-lock:{recordId}`（決済会社をまたいで同じ鍵）。
- **決済ごとの状態** `ak:card:{provider}:applied:{paymentId}`: pending（付与前の値を保存）→ PATCH → done。再送・同時着信・途中停止でも 1 回。
- **二重購入の疑い**: 同じ会員に別決済の付与が 30 分以内にあれば、権限を変えず管理者へ（返金判断）。一度疑いにした決済は再送でも付与しない。返金で戻した決済は対象外（返金→再購入は通る）。
- **期限**: 年払いは Premium の残りの翌日から 1 年（縮めない）。買い切りは 2099-12-31。
- **返金**: 全額返金・取消・チャージバックだけ付与前へ戻す。一部返金は戻さず管理者へ。付与後に別の変更があれば戻さず管理者へ（誤失効を作らない）。
- **通知**: AK から顧客へは送らない（決済会社の完了メールと完了画面）。管理者通知だけ。

## 2. Paddle（Billing・一回払い）

| 項目 | 内容 |
|---|---|
| API | Sandbox `https://sandbox-api.paddle.com`／本番 `https://api.paddle.com`。鍵 `pdl_sdbx_apikey_…` / `pdl_live_apikey_…`（接頭辞で判定。旧形式の鍵は受け付けない）|
| 申込 | `paddle-create-checkout` → `POST /transactions`（非カタログ価格・JPY `"49800"`・`tax_mode: internal`＝税込・`custom_data {ak_record, ak_product}`・**`checkout.url` は送らない**＝アカウントの Default payment link（承認済みドメイン）に任せ、返ってきた URL が自サイトの `/checkout/paddle/` でなければ `checkout_url_mismatch` で使わない（2026-10-12・明示 URL は未承認ドメインだと 400）→ `/checkout/paddle/?_ptxn=txn_…` で Paddle.js が決済画面を開く → 完了後 `/checkout/card-complete/?provider=paddle&order=txn_…` |
| 付与 | `paddle-webhook`（`Paddle-Signature` = HMAC-SHA256 `ts:rawBody`・時刻のずれ 300 秒まで）→ `GET /transactions/{id}` で origin=api・JPY・総額・custom_data・status paid/completed を照合 → 共通層 |
| 返金 | `adjustment.created/updated` → `GET /adjustments?id=` で approved の refund / chargeback だけ。type=full は戻す・partial は管理者へ |
| 注意 | JPY は支払い通貨としては使えるが入金通貨ではない（USD 等へ換算して入金）。本番は Website approval（ドメイン審査）・既定の支払いリンク設定が要る |

### 2.1 Live（本番・2026-10-24）

Paddle Live は**承認ドメインのページでしか決済画面を開かない**。承認ドメインは中立ホスト `checkout.tirol.link`（§7）なので、会員サイトの `/checkout/paddle/` は Live では使わない（Sandbox・Deploy Preview だけ）。

| 項目 | 内容 | 単一源 |
|---|---|---|
| Default payment link（Live）| `https://checkout.tirol.link/pay/`。取引の `checkout.url` がこれ以外なら本番サイトは `checkout_url_mismatch`（fail closed）| `neutralCheckoutHost.PADDLE_LIVE_PAYMENT_LINK`・`paddleCheckoutPage`・`paddleCore.checkoutUrlMatchesOrigin` |
| 決済ページ | 中立サイトの静的ページ `/pay/`（英語・noindex・ナビ/sitemap 外）。**カード受付中（`CARD_PAYMENTS_AVAILABLE`）かつ build 時に live の client token を渡したときだけ** Paddle.js を読む。それ以外は案内だけ | `ops/checkout-site/site.mjs` `renderPayPage`（build: `PADDLE_LIVE_CLIENT_TOKEN=… node ops/checkout-site/build.mjs <out>`）|
| 完了後 | Paddle.js の successUrl = `/r/paddle/complete?provider=paddle&order=txn_…` → 会員サイト `/checkout/card-complete/` へ 302（クエリはそのまま）。付与は Webhook が正本 | `NEUTRAL_ROUTES` |
| 通知先（Live）| `https://checkout.tirol.link/hooks/paddle` → **中立サイト自身の modern function が受ける**（案B・§2.2）。署名検証＋取引照会は中立サイト（鍵を持つ）、会員付与だけ本番 `internal-paddle-grant` へ署名付きで委譲。イベント `transaction.paid`・`transaction.completed`・`adjustment.created`・`adjustment.updated` | `NEUTRAL_ROUTES`・`ops/checkout-site/netlify/functions/paddle-webhook.mjs`・`internal-paddle-grant.js` |
| 商品・価格 | **Live カタログは作らない**（非カタログ価格を取引ごとに API で渡す方式を維持・§2）| `paddleCore.buildTransactionBody` |
| production env（会員サイト）| `PADDLE_API_KEY` と `PADDLE_WEBHOOK_SECRET` は**置かない**（4KB 上限・Live の鍵は中立サイト側）。会員サイトが持つのは `CARD_GRANT_INTERNAL_SECRET`（中立サイト→会員サイトの内部署名）だけ。鍵が無い本番サイトは取引作成を中立サイトへ委譲し、受付前は `card_sales_not_open`（`CARD_SALES_OPEN.paddle=false` の間は中立サイトも fail closed）| `cardSales.resolveCardModeDelegated`・`paddleServer.createPaddleCheckout` |
| 受付開始 | §5 の条件どおり（MK の明示決定 → `CARD_SALES_OPEN.paddle` と `CARD_PAYMENTS_AVAILABLE` を true にする PR → 中立サイトを live token 付きで再 deploy → 本番の実購入 1 件と全額返金で付与・戻しを確認）| — |

env（Deploy Preview の Sandbox 用だけ。production には入れない）: `PADDLE_API_KEY`（`pdl_sdbx_apikey_…`）・`PADDLE_WEBHOOK_SECRET`（通知先の secret key）・`PADDLE_CLIENT_TOKEN`（`test_…`・公開してよい）・`CARD_E2E_SECRET`（24 文字以上）

### 2.2 分離サイト方式（案B・2026-10-24 MK 確定）

会員サイト（`analytics.keiba.link`）の Functions env は **AWS Lambda 4KB 上限ぎりぎり**で、Live の `PADDLE_API_KEY`・`PADDLE_WEBHOOK_SECRET` を足すと全 Function の作成が失敗する。そこで Paddle Live の**鍵を使う処理だけ**を現代 runtime の独立サイト `checkout.tirol.link`（Netlify site `tirol-checkout`・modern functions＝4KB 制約なし）へ分離する。

| 処理 | どこで | 鍵・secret | 委譲 |
|---|---|---|---|
| **Webhook**（署名検証・取引照会・付与指示）| 中立サイト `paddle-webhook.mjs` | `PADDLE_WEBHOOK_SECRET`・`PADDLE_API_KEY` | 会員付与（Airtable/Redis）だけ本番 `internal-paddle-grant` へ `signTsBody`（ts:rawBody・`CARD_GRANT_INTERNAL_SECRET`）で委譲。冪等性・二重付与防止は本番 `entitlementLedger`（同一 Redis キー）がそのまま担保 |
| **取引作成**（`POST /transactions`）| 中立サイト `paddle-create-checkout.mjs` | `PADDLE_API_KEY` | 会員資格（ログイン・既存契約・買い切り・会員限定価格）は**本番サイトが Airtable で確認**し、確認後に短寿命・署名付き intent（`CARD_GRANT_INTERNAL_SECRET`・`signTsBody`・tolerance 120s）を `PADDLE_CHECKOUT_CREATE_URL` へ渡す。金額・通貨・商品名はクライアント由来を使わず中立サイトがカタログ（`buildTransactionBody`）から組む |

- 本番サイトの入口（`card-create-checkout`・`paddle-create-checkout`・`cardCheckout.startCardCheckout`）は不変。`createPaddleCheckout` が「鍵がローカルに無い本番サイト」を検知し、資格確認のあと取引作成だけを委譲する（`delegate = !PADDLE_API_KEY && CARD_GRANT_INTERNAL_SECRET && origin===本番`）。Sandbox の Deploy Preview は従来どおり鍵がローカルにあるので委譲しない（直接作成）。
- 中立サイトが持つ secret は `PADDLE_API_KEY`・`PADDLE_WEBHOOK_SECRET`・`CARD_GRANT_INTERNAL_SECRET` だけ。会員付与に要る Airtable/Redis/SendGrid の鍵は**本番サイトだけ**が持つ（分離サイトの秘密面を最小化）。
- intent は server-to-server のみ（ブラウザに出さない）＋短窓＋HMAC。リプレイしても増えるのは「未払い」取引だけで、課金はカード入力時にしか起きず、付与は transactionId で冪等＝**二重課金・二重付与は起きない**。
- 検証: `paddleCheckoutDelegation.test.mjs`（委譲＝直接と同一本文・改ざん不可・署名/期限/資格のガード・実関数の 405/401/503/400）/ `paddleDelegation.test.mjs`（Webhook 委譲の冪等・署名）。

## 3. PayPal（Orders v2・一回払い）

| 項目 | 内容 |
|---|---|
| API | Sandbox `https://api-m.sandbox.paypal.com`／本番 `https://api-m.paypal.com`。OAuth2 client_credentials。鍵で環境を見分けられないため `PAYPAL_ENV`（sandbox / live）を必須にする |
| 申込 | `paypal-create-order` → `POST /v2/checkout/orders`（intent=CAPTURE・JPY 小数なし・`custom_id = recordId:商品`・`invoice_id`・配送なし・`PayPal-Request-Id`）→ PayPal の承認画面 → `/checkout/paypal-return/?token=…` |
| 売上確定 | 戻り先が `paypal-capture` を呼ぶ → サーバーが注文を照会し、承認済みなら capture（`PayPal-Request-Id = ak-cap-{注文}`）→ 照会し直して共通層へ。戻り先を閉じても Webhook `CHECKOUT.ORDER.APPROVED` で同じ処理が走る |
| 付与・返金 | `paypal-order-webhook`（`verify-webhook-signature` で SUCCESS だけ）→ 注文を照会。capture COMPLETED で付与、REFUNDED で戻す、PARTIALLY_REFUNDED は管理者へ、`PAYMENT.CAPTURE.REVERSED` は戻す、PENDING は付与しない |
| 注意 | 旧 `paypal-webhook.js`（2026-07-22 廃止・410）は復活させない。新経路は別名 |

env（Deploy Preview の Sandbox 用だけ）: `PAYPAL_CLIENT_ID`・`PAYPAL_CLIENT_SECRET`・`PAYPAL_ENV=sandbox`・`PAYPAL_WEBHOOK_ID`・`CARD_E2E_SECRET`

⚠️ production の関数 env は Lambda 4KB 上限に近い（`STRIPE_BILLING.md` §3）。本番化のときは先に枠を確認する。鍵の値は画面・ログ・commit に出さない。

## 3.5 PayPal 月額（Subscriptions API・定期課金・2026-10-15 MK 決定）

| 項目 | 仕様 | 実装 |
|---|---|---|
| 商品 | 既存の月額 3 プラン（全会場 ¥4,980・中央版 ¥2,980・南関版 ¥2,980）。金額・会場の正本は `stripePlans.STRIPE_PLANS`。**PayPal に出す名前は `paymentDisplayNames.PAYPAL_PLAN_NAMES` の許可リストだけ**（2026-10-15 MK 確定: `Analytics Premium`・`Analytics Premium J`・`Analytics Premium N`・完全一致・説明も同じ文字列。Stripe の productName には依存しない） | PayPal の Product `Analytics Premium`＋Plan 3 本（**暦の 1 か月ごと**＝MONTH×1・無期限 total_cycles 0・JPY・初期費用なし）。Plan ID は `paypalSubscriptionCore.PAYPAL_PLAN_IDS`（秘密ではない・env に置かない）。作成・照合は `scripts/paypal-subscription-setup.mjs <keys-file> [--apply]`（冪等・登録済み Plan ID で読み、名前・説明だけを許可リストへ PATCH・金額や請求設定は変えない・請求設定が想定外なら ⚠️ を出す）|
| 申込 | ログイン必須。共通入口 `monthly-create-checkout`（決済会社を選ばせない）→ PayPal の承認画面 → 戻り先 | `createPaypalSubscription`（`custom_id = recordId:商品コード`＝A/J/N・会場名を渡さない・旧形式も読む）。戻り先・キャンセルは本番だけ `https://checkout.tirol.link/r/paypal/subscription-return`・`/r/paypal/cancel`（中立ホストが会員サイトの `/checkout/paypal-subscription-return/`・`/pricing/?checkout=cancelled` へ 302・`neutralCheckoutHost.js`）。live は `SUBSCRIPTION_SALES_OPEN.paypal` かつ entry='monthly' だけ（`subscriptionProviderGate`）|
| 戻り先の確認（未ログインの購入者・2026-10-22）| 未ログイン（メール入力・#820）で申し込んだブラウザにだけ、申込の直後に短命の鍵を渡す。戻り先はログイン中ならセッション（従来どおり）、未ログインならこの鍵で確認し、完了（active）を返したときだけ GA4 `purchase`。URL だけ・別の購読の鍵・期限切れは 401（照会も反映もしない）。返すのは状態・商品 ID・`viewer`（member/guest）だけ（メール・会員 ID は返さない）。権限の判定・反映（Webhook が正本）は不変 | `subscriptionReturnToken.js`: Cookie `ak_pp_return`（HttpOnly・Secure・SameSite=Lax・Path=確認の Function だけ・2 時間）＝`v1.{購読ID}.{会員ID}.{期限}` に `SESSION_SIGNING_SECRET` から用途別に導出した鍵で HMAC。検証は署名・期限・購読 ID の一致、さらに `confirmPaypalSubscription` が PayPal の custom_id の会員 ID と一致を確認。署名鍵が無ければ発行せず申込は止めない（戻り先はログインの案内）。test `subscriptionReturnToken.test.mjs` |
| 反映 | 戻り先（`paypal-subscription-confirm`）と Webhook（`paypal-order-webhook` に同居）が同じ処理。購読を API で照会し絶対値を書く | `applyPaypalSubscription`（購読ごとのロック）→ `decidePaypalSubscriptionSync`。期限＝最後に支払われた日（JST）+1 ヶ月 +2 日。`next_billing_time` は見ない（決済失敗でも進むため）|
| 会員と購読の対応 | 購読の custom_id で会員を決める。会員のいまの購読は Redis `ak:paypal:sub:member:{recordId}` | Customers に PayPal 購読 ID の列は無い（Functions の鍵に列追加の権限が無い・2026-10-15）|
| 書かないケース | 二重契約（別の PayPal 購読・Stripe 月額が生きている）・買い切り・期間の長い銀行振込 Premium・登録外の Plan・金額不一致 | 申込前に 409（`already_subscribed` / `already_premium`）。成立してしまったら権限は書かず管理者へ（`subscription_conflict`）|
| 退会 | 即時（2026-10-07 の月額退会と同じ）。マイページ「アカウント管理」→ 確認 → 確定 | `paypal-withdraw` → `withdrawPaypalSubscriber`: 購読を `reason=ak_member_withdrawal` で cancel → 退会状態（期限を昨日・退会フラグ）。書込みが失敗しても CANCELLED 通知が印（status_change_note）で同じ状態へ収束 |
| 退会以外の終了 | 決済失敗の上限（SUSPENDED は書かない＝期限で止まる）・管理者の解約 | CANCELLED / EXPIRED で、支払い済み最終日の翌日まで（縮めるだけ）|
| 返金 | 月額は返金しない方針（例外は管理者が手で）| `PAYMENT.SALE.REFUNDED / REVERSED` は権限を自動で戻さず管理者へ通知 |
| 更新リマインド | 自動更新なので送らない | `premiumRenewalPolicy`（PaymentMethod=PayPal を除外）|
| メールだけの退会 | 購読を操作せずマイページへ案内 | `process-withdrawal`（`isPaypalSubscriber`）|
| Webhook イベント | `BILLING.SUBSCRIPTION.*`（CREATED・ACTIVATED・UPDATED・RE-ACTIVATED・CANCELLED・SUSPENDED・EXPIRED・PAYMENT.FAILED）・`PAYMENT.SALE.COMPLETED / REFUNDED / REVERSED` | Sandbox Webhook に追加済み（2026-10-15・setup スクリプト）|
| Webhook の URL | Live: **`https://checkout.tirol.link/hooks/paypal`**（中立ホストが会員サイトの `paypal-order-webhook` へ 200 プロキシ。Function は Host=checkout.tirol.link を本番として判定＝`webhookSiteOrigin`）。Sandbox: `sandbox.checkout.tirol.link` のまま | 切替は `paypal-subscription-setup.mjs <live-keys> --apply --set-webhook-url`（Webhook ID 不変＝`PAYPAL_WEBHOOK_ID` は変えない）。順序: ①checkout.tirol.link に `_redirects` を deploy ②本 PR の deploy ③中立ホスト経由の未署名 POST が 401（`invalid_signature`＝本番として検証まで届く・200 `ignored_*` ではない）④URL を PATCH。rollback は同じ PATCH で `https://analytics.keiba.link/.netlify/functions/paypal-order-webhook` へ |
| 請求の周期と更新 | **暦の 1 か月ごとの自動課金**（30 日間隔ではない）。期限 = 最後に支払われた日（JST）+ 1 か月（月末は丸める）+ 2 日。支払い失敗では延ばさない | 2 回目の自動引き落とし・決済失敗は **実際の課金を伴う E2E では未検証**（偽の PayPal の自動テストのみ）。本番の初回実更新は scheduled-checks `paypal-monthly-first-renewal-2026` が read-only で確認 |

**月額の Sandbox E2E 手順**: deploy-preview に `PAYPAL_*`・`CARD_E2E_SECRET` を入れる → 中立ホストの転送先をその PR の preview へ → 使い捨て `+card-e2e` レコードで `monthly-create-checkout`（`x-ak-e2e-secret`・`e2eRecordId`）→ MK が Sandbox 買い手で承認 → `paypal-subscription-confirm` で付与 → Webhook 再送で 1 回だけ → 申込の重複拒否 → `paypal-withdraw` で即時退会 → 再契約 → API で管理者の解約（終了の縮め）→ 後片付け（レコード・Redis・env）。

**月額の Sandbox E2E 結果（2026-10-15・deploy-preview-800）**（**翌月の 2 回目の自動引き落としと決済失敗は含まない＝未検証**）: 付与（期限＝支払日 JST + 1 ヶ月 + 2 日）・confirm と Webhook 再送で不変・重複申込 409・即時退会と CANCELLED 通知の収束まで PASS。退会済みの CancelledAt を終了通知が書き換えていた点を是正。退会後の再契約・管理者の解約（期限を支払い済みの翌日へ縮める・退会フラグなし）も PASS。後片付け済み（e2e レコード・Sandbox Redis・deploy-preview の鍵）。

Sandbox の Product `PROD-1DB142038K1860725`／Plan: premium `P-67290333XA2635522NLIAFTY`・premium-jra `P-7NF43083F7102171SNLIAFUI`・premium-nankan `P-55C52460MJ2631844NLIAFUY`（2026-10-15 作成）。

## 3.6 PayPal 年額（Subscriptions API・12 か月ごと自動更新・2026-10-20 MK 決定）

| 項目 | 仕様 | 実装 |
|---|---|---|
| 商品 | 年払い ¥49,800（`premium-annual`）・Light 会員の年払い ¥44,820（`premium-annual-light`・資格はサーバー判定）。両会場。**買い切りは銀行振込だけ**（定期課金・カードでは申込も反映もしない＝`lifetime_bank_transfer_only`）| `paypalSubscriptionCore.ANNUAL_SUBSCRIPTION_PLANS`・Plan は YEAR×1・無期限・初期費用なし。名前 `Analytics Premium Annual` / `Analytics Premium Annual L` |
| Plan ID | 月額と同じくコード（秘密ではない） | `PAYPAL_PLAN_IDS.test`（2026-10-20 作成）・`.live` は未作成（setup スクリプト `--apply` で作り ID を足す）。未登録の間は申込 503 `plan_not_configured`・料金ページにボタンを出さない |
| 申込 | 月額と同じ共通入口 `monthly-create-checkout`（`plan: premium-annual`）| 二重課金の防止: 生きている月額・年額の購読（PayPal / Stripe）→ `already_subscribed`、有効な Premium（銀行振込の年払い等）・買い切り → `already_premium`、Light 資格なし → `not_eligible` |
| 反映 | 戻り先・Webhook とも月額と同じ（購読を照会して絶対値・冪等）| プラン=Premium / PlanType=Annual / PaymentMethod=PayPal / VenueAccess=''。期限＝最後に支払われた日（JST）+ 12 か月 + 2 日。更新は翌年の支払いで 12 か月延びる。決済失敗・SUSPENDED では延ばさない |
| 終了 | PayPal 側の停止・決済失敗の上限・管理者の解約 → 支払い済み 12 か月の翌日まで（縮めるだけ）。マイページの退会 → 現行仕様どおり即時 | 月額と同じ判定（`paidThroughYmd(lastPayment, 12)`）|
| Webhook | 月額と同じイベント（Live は購読済み・2026-10-20 確認）| 追加設定なし |
| メール | 年額向けの新しいリマインド・通知は作らない（MK）。月払いの更新リマインド・銀行振込の期限通知の対象外（PaymentMethod=PayPal）| — |

## 3.7 決済完了 → Premium 利用画面への自動遷移（2026-10-22 MK 決定）

利用開始メールは送らない（MK）。決済完了から Premium を使い始めるまで、案内メール・マイページ探し・問い合わせを要らなくする。

| 場面 | 動き | 実装 |
|---|---|---|
| 遷移先 | 両会場（月額 `premium`・年額 2 本）= マイページの Premium 枠 `/dashboard/?from=purchase#premium-predictions`（中央／南関の 2 ボタン・枠を強調）。中央版 = `/premium-prediction/jra/`・南関版 = `/premium-prediction/nankan/`。**この 3 つ以外へは移さない** | `postPurchaseLanding.js`（`destinationForPlan` / `POST_PURCHASE_DESTINATIONS`）。`?from=purchase` はマイページの SSR に会員レコードを読み直させるだけ（10 分キャッシュの古い権限を出さない・`resolveViewer({ forceFresh })`）|
| ログイン済みの購入者 | 戻り先が `active`（PayPal で照会して反映済み）を受け取ったら、完了表示の 2 秒後に遷移先へ | `paypal-subscription-confirm` が `destination` を返す（active のときだけ）。戻り先ページは許可リストと完全一致したときだけ `location.replace` |
| 未ログインの購入者 | 完了表示 → 4 秒後にログイン画面 `/login/?from=paypal`（「お申し込みのときのメールアドレスを入力…そのまま Premium 予想へご案内します」）→ マジックリンク → 遷移先へ | 反映で購読が新たに会員へ結び付いたときだけ、Redis `ak:paypal:post-purchase:v1:{recordId}`（商品 ID・購読 ID・時刻・24 時間）を置く。`verify-magic-link` が成功（有料セッション発行）時に `GETDEL` で取り出し、いまの権限（`resolveEntitlements`）で買った会場がすべて見られるときだけ `redirectTo` にする。**サーバー側の印なので、メールアプリ内ブラウザ・別端末で開いても届く**。決済確認用 Cookie `ak_pp_return` はログインの代わりにしない |
| 確認中 | 「お支払いを確認しています…」のまま（3 秒ごと最大 20 回）。Premium へ移さない | `pending` は `destination` を返さない |
| 確認できない | URL だけ（別のブラウザ）＝401 はログインの案内・404 はマイページ＋お問い合わせ・時間切れは「もう一度お支払いいただく必要はありません」＋マイページ／ログイン＋お問い合わせ。再決済は促さない | `subscriptionReturnCopy.js`（`SUBSCRIPTION_RETURN_CONTACT`）|
| 不変 | 決済・Webhook・権限の反映（`applyPaypalSubscription`）・料金・更新・退会・GA4 `purchase`（active のときだけ 1 回）| 印の失敗は付与・ログインを止めない（best-effort）|

**検証**: `postPurchaseLanding.test.mjs`・`subscriptionReturnToken.test.mjs`（偽の PayPal / Airtable / Redis を通した申込 → 支払い → 戻り先 → 印 → ログイン）。実ブラウザ E2E `npm run e2e:paypal-post-purchase`（`scripts/e2e-paypal-post-purchase/`・偽の外部＋実 Function＋astro dev＋ヘッドレス Chrome・本物の外部へは出ない・ブラウザも localhost 以外を名前解決しない）: 未ログイン（月額 3・年額・スマホ／PC）→ ログイン画面 → **別のブラウザコンテキスト（メールアプリ内ブラウザ相当）**でリンク → 利用画面、ログイン済み Light 会員（全会場・南関版）→ 戻り先から利用画面、確認中は遷移しない、URL だけは 401 の案内、購入なしの通常ログインは `/dashboard/` のまま。

**rollback**: revert（印は 24 時間で消える・権限には影響しない）。

## 4. Sandbox E2E 手順（Deploy Preview）

**MK の操作（アカウント開設は本人しかできない）**

Paddle:
1. https://sandbox-login.paddle.com/signup で Sandbox アカウントを作る（本番アカウントとは別。事業者名 TIROL DATA LABO）。
2. Developer tools → Authentication で API key を作る（権限: transaction・adjustment・notification の read/write）。同じ画面の Client-side tokens で `test_…` を作る。
3. Checkout → Checkout settings の Default payment link に `https://deploy-preview-<PR>--analytics-keiba.netlify.app/checkout/paddle/` を入れる。
4. Developer tools → Notifications で通知先を追加: URL `https://deploy-preview-<PR>--analytics-keiba.netlify.app/.netlify/functions/paddle-webhook`、イベント `transaction.paid`・`transaction.completed`・`adjustment.created`・`adjustment.updated`。表示される secret key を控える。

PayPal:
1. https://developer.paypal.com に新規のビジネスアカウントでログイン → Apps & Credentials（Sandbox）→ Create App。Client ID・Secret を控える。
2. 同じアプリの Webhooks に `https://deploy-preview-<PR>--analytics-keiba.netlify.app/.netlify/functions/paypal-order-webhook` を追加し、イベント `CHECKOUT.ORDER.APPROVED`・`PAYMENT.CAPTURE.COMPLETED`・`PAYMENT.CAPTURE.REFUNDED`・`PAYMENT.CAPTURE.REVERSED` を選ぶ。Webhook ID を控える。
3. Testing Tools → Sandbox Accounts の personal（買い手）アカウントで支払う。
   - 2026-10-13 実施: MK は手順 1（Client ID/Secret）だけ。手順 2 の Webhook は Claude が API（`POST /v1/notifications/webhooks`）で中立ホストの URL に登録し、Webhook ID と `PAYPAL_ENV=sandbox` を keys file に追記（値は出力しない）。スクリプトは冪等（同じ URL が既にあれば再利用）。

**PayPal Sandbox E2E 結果（2026-10-13・PASS）** — レコードは使い捨て `+card-e2e`、MK が Sandbox 買い手で 2 回承認

| 確認 | 結果 |
|---|---|
| 承認前に capture | `mismatch_status_payer_action_required`・付与なし |
| 購入 ¥49,800（年払い） | Premium/Annual/active・期限 2027-10-13・PaymentMethod=paypal。台帳 1 件 |
| Webhook（APPROVED・CAPTURE.COMPLETED）再送＋capture 2 回 | `already_applied`・capture 1 件のまま・レコード不変 |
| 署名なし／偽の署名ヘッダ | 401 `invalid_signature` |
| 全額返金（`/v2/payments/captures/{id}/refund`）| REFUNDED Webhook で購入前と完全一致（差分 0）・台帳 `reverted:true` |
| 返金後に 3 イベント再送＋capture | `already_reverted`・再付与なし |
| 買い切り会員が年払い・買い切りを申込 | 409 `already_lifetime` |
| 再購入（買い切り ¥78,000）→ 返金 | Premium/Lifetime/active（2099-12-31）→ 返金で購入前と一致 |
| 共通入口 `card-create-checkout`（ACTIVE=paddle・Paddle 鍵なし）| 503 `paddle_key_missing`。PayPal へ自動フォールバックしない |
| 本番 paypal-capture | 503 `paypal_key_missing` |

後片付け: e2e レコード削除・Sandbox Redis の検証キー削除・deploy-preview の `PAYPAL_*`／`CARD_E2E_SECRET` を unset。残すもの: PayPal Webhook 登録（Sandbox アプリ）・中立ホストのプロキシ。再実施は keys file の値を deploy-preview に入れ直し、新しい PR の preview へ `_redirects` を向ける。

鍵の受け渡しは 1 つのファイルにまとめる（値は会話に貼らない）:
`~/.analytics-keiba-ops/card-sandbox.env`（`chmod 600`。中身は §2・§3 の env 名=値。`CARD_E2E_SECRET` は Claude が作る）

**Claude の作業**
1. Deploy Preview（deploy-preview context）だけに env を設定 → 再デプロイ。production には入れない。
2. 使い捨てレコード（`…+card-e2e@…`）を作り、`x-ak-e2e-secret` 付きで申込 → Sandbox のテストカード / テスト買い手で支払い。
3. 確認: 付与（Customers・`card-order-status`）→ Webhook 再送（Paddle: `POST /notifications/{id}/replay`／PayPal: `POST /v1/notifications/webhooks-events/{id}/resend`）で 1 回だけ → 全額返金（Paddle: `POST /adjustments`・Sandbox は自動承認まで最大 10 分／PayPal: `POST /v2/payments/captures/{id}/refund`）で付与前へ → 再購入 → 買い切り会員の拒否。
4. 後片付け: 使い捨てレコード削除・deploy-preview の env を外す・通知先 / Webhook を消す（MK）。

### 決済会社に登録する URL（2026-10-12 MK 確定・中立ホスト）

決済会社の管理画面には **Netlify のサブドメイン（`*--analytics-keiba.netlify.app`）を登録しない**。Sandbox は専用の中立ホストを使い、本番とは完全に分ける。

| 用途 | ホスト | 中身 |
|---|---|---|
| **Sandbox 専用** | `https://sandbox.checkout.tirol.link` | Netlify site `tirol-checkout-sandbox`（静的・Functions/cron なし）。`ops/checkout-sandbox/_redirects` の 1 行で Sandbox 用 Deploy Preview へ転送（200 プロキシ）|
| 本番用（将来）| `https://checkout.tirol.link` | §7。本番化（§5）まで決済会社の本番設定には使わない |

Sandbox に登録する値（Paddle）:
- Default payment link: `https://sandbox.checkout.tirol.link/checkout/paddle/`
- Notification destination: `https://sandbox.checkout.tirol.link/.netlify/functions/paddle-webhook`（イベント `transaction.paid`・`transaction.completed`・`adjustment.created`・`adjustment.updated`）

DNS（Cloudflare・MK 設定）: `sandbox.checkout` CNAME `tirol-checkout-sandbox.netlify.app`、Proxy status は **DNS only**（Cloudflare プロキシを挟むと 520/525 と証明書発行失敗の原因になる）。

分離の仕組み:
- 転送先は Deploy Preview（deploy-preview context の env だけ＝Sandbox 鍵だけ）。production の deploy・env・cron には一切つながらない。
- 決済台帳の Redis も Sandbox 専用（Upstash `tirol-sandbox`）。deploy-preview context の `UPSTASH_REDIS_REST_URL/TOKEN` に設定（それまで deploy-preview は値なし＝Webhook は `redis_missing` で 500・付与しない fail closed だった）。本番 Redis は Preview に入れない。
- `stripeRuntime.isAllowedOrigin(origin, host)` は、このオリジンを **Deploy Preview が受けたときだけ**信用する。本番 analytics.keiba.link が受けたら本番オリジン扱いに倒れ、CORS・戻り先・カード受付は広がらない（`sandboxOrigin.test.mjs`）。
- 本番オリジン以外なので `resolveCardMode` はテスト鍵しか通さない（本番鍵は `live_key_outside_production`）。
- Paddle の取引には顧客メールを送らない（`custom_data` は recordId と商品 ID だけ）。決済画面で入力するメールは中立の検証用アドレスにする。
- 転送先を変えるとき（Sandbox 用 PR が変わったとき）は `_redirects` の 1 行を直して `netlify deploy --prod --dir <ops/checkout-sandbox の複製> --no-build --site tirol-checkout-sandbox`（repo 直下の netlify.toml を読ませないため、repo 外の複製から deploy する）。

### 実施記録

| 日付 | 決済会社 | Deploy Preview | 状態 |
|---|---|---|---|
| 2026-10-12 | Paddle | `https://sandbox.checkout.tirol.link`（→ Sandbox 用 Deploy Preview。2026-10-13 から PR #794）| **PASS**（下表）。後片付け済み |

#### Paddle Sandbox E2E 結果（2026-10-12・PASS）

| 項目 | 結果 |
|---|---|
| 決済失敗 | 3DS 失敗カードで `authentication_failed`。会員は不変 |
| 新規購入 | ¥49,800 JPY captured（origin=api・custom_data 一致）|
| 権限反映 | Premium / Annual / active / 有効期限 2027-10-12 / PaymentMethod=paddle |
| 重複通知 | `transaction.paid` と `.completed` を同時＋再度 → 反映 1 回だけ・レコード不変 |
| 署名 | 署名なし・別 secret・10 分前の ts・署名後の本文改ざん → すべて 401 |
| 取り違え | 署名正・未払い取引／本文が別会員を主張 → 変更なし（反映は API 照会の値だけ）|
| 返金 | `POST /adjustments`（full）→ 約 10 分で approved → `adjustment.updated` で自動反映 |
| 返金後 | 購入前と完全一致。返金・旧 paid 通知を再送しても再付与なし |
| 再購入 | Paddle の通知だけで付与（有効期限 2027-10-12）|
| 本番への副作用 | production env に PADDLE_*／CARD_* なし・販売は閉じたまま・本番 Redis 不使用 |

途中で見つけて直したこと:
- Deploy Preview に Redis の値が無く Webhook が `redis_missing`（500・付与なし＝fail closed）→ Sandbox 専用 Upstash を deploy-preview に設定。
- 明示 `checkout.url` は未承認ドメインで 400 → Default payment link に任せ自サイト照合（§2）。
- API 鍵に notification の replay 権限が無い（`forbidden`）→ 重複テストは Paddle が保存した payload をそのまま正しい署名で再配送して代替。Paddle 自身の replay を試すときは鍵に権限を追加する。

観察（仕様どおり・変更なし）: 有効中の Premium 会員も年払い・Light 会員価格・買い切りの取引を作れる（`decideCardPurchase` は銀行振込と同じ会員価格判定 `checkMemberOnlyPricing` を使う。年払いは残期間の翌日から 1 年で縮めない。30 分以内の別決済は付与せず管理者へ）。

後片付け: 使い捨てレコード削除（e2e レコード 0 件）・Sandbox Redis の検証キー削除（DBSIZE 0）・deploy-preview の PADDLE_*／CARD_E2E_SECRET を unset。**残すもの**（Sandbox 基盤として継続利用）: Netlify site `tirol-checkout-sandbox` と DNS、Paddle Sandbox の Default payment link・通知先、deploy-preview の Sandbox Redis、`~/.analytics-keiba-ops/card-sandbox.env`。再実施は鍵 4 つを deploy-preview に戻して再デプロイするだけ。

## 5. 本番化の条件（すべて満たすまで開かない）

1. その決済会社が AK の取扱商品（競馬データ・予想の有料提供）を承認した記録（Paddle: 書面回答＋本番アカウント審査 → **本番アカウント承認（2026-10-24 MK 報告・onboarding completed を観測）**／PayPal: 事前承認 → **2026-10-15 通過（MK 報告）**）。審査では事業内容を正確に申告し、言い換えで通さない。
2. Sandbox E2E 完了。→ **済み**（Paddle 2026-10-12 / PayPal 2026-10-13・§4。同じテストは繰り返さない）
3. MK の販売開始の明示決定 → `cardSales.js` の該当値を true にする PR（このとき pricing のカード導線も追加）。
4. production env（4KB 枠の確認）・本番の Webhook 登録・本番での実購入 1 件の確認と返金。PayPal は MK が developer.paypal.com の **Live** アプリの Client ID / Secret を `~/.analytics-keiba-ops/card-live.env`（`chmod 600`・値は会話に貼らない）に置けば、Claude が production env へ `PAYPAL_CLIENT_ID`・`PAYPAL_CLIENT_SECRET`・`PAYPAL_ENV=live` を設定し、Live の Webhook（`https://analytics.keiba.link/.netlify/functions/paypal-order-webhook`・§3 の 4 イベント）を API で登録して `PAYPAL_WEBHOOK_ID` を入れる。鍵を入れても `CARD_SALES_OPEN.paypal=false`・`ACTIVE_CARD_PROVIDER='paddle'` のため受付は閉じたまま（本番の申込は 503 `card_sales_not_open`）。
5. Paddle 本番の Default payment link のドメインを決め、Paddle の承認ドメインと一致させる（`checkoutUrlMatchesOrigin` は自サイト以外の URL を 502 で拒否する）。→ **`https://checkout.tirol.link/pay/` に決定（2026-10-24・§2.1・中立ホスト方式＝2026-10-15 MK 確定の延長）**

## 6. ロールバック

- コード: revert PR（販売は閉じているので顧客影響なし）。
- 反映済みの会員: 決済ごとの状態に付与前の値を保存してある。全額返金で自動で戻る。

## 7. 決済専用サイト `checkout.tirol.link`（2026-10-12 MK 確定・2026-10-13 構築・独自ドメイン接続・掲載開始）

| 項目 | 確定内容 |
|---|---|
| URL | `https://checkout.tirol.link/`（DNS は Cloudflare・MK 設定。2026-10-12 時点でレコードなし＝未使用を確認）|
| 事業者 | TIROL DATA LABO（日本の個人事業主）|
| 表示言語 | 全面英語 |
| **公開住所** | **契約済みの新宿バーチャルオフィス**。英語表記は `src/pages/legal.astro` の Address 行と同一にそろえる（事業者情報・Terms・Refund・フッター）|
| 非公開 | **自宅住所は公開しない**。Paddle 等の本人確認住所は決済会社の画面にだけ入力し、repo・サイトに載せない |
| 公開の前提 | MK が新宿住所の契約上の利用条件（ウェブ・特商法表記での利用可否、郵便受取、電話の扱い）を確認済みであること |
| 流用禁止 | 旧 `payment.tirol.link` の事業者表示・住所 |
| 決済連携 | #789 の実装（共通会員権限層・Paddle・PayPal）を再利用。本番キー未設定の拒否状態は維持 |


### 7.1 実装（2026-10-13）

| 項目 | 内容 |
|---|---|
| 生成元（単一源） | `ops/checkout-site/site.mjs`。`node ops/checkout-site/build.mjs <repo外の出力先>` で静的 HTML を生成（生成物は repo に置かない）|
| ページ | `/` `/features/` `/pricing/` `/billing/` `/terms/` `/privacy/` `/refund/` `/contact/` |
| 公開表記 | 全面英語・中立ブランド（TIROL DATA LABO・Analytics Premium）。**本文・メタ・リンク表示・フッターに競馬・ギャンブル関連語を出さない**。説明は実機能どおり＝会員制のデータ分析情報サービス（AK 既存英文「statistical analysis results and reference indicators based on sports data」）・成果保証なし・投資助言でない・18 歳以上（AK 既存 privacy と同じ）|
| 会員導線 | 会員サイトへは `https://analytics.keiba.link/login/` へのリンク（表示は「member site」）。ドメイン文字列は画面に出さない |
| **決済会社への申告** | **事実どおり**（公開表記とは別）。申告文（英）: “Online members-only information service (digital content) publishing data analysis reports on Japanese horse racing (JRA and Minami-Kanto local races): per-race evaluations, indices and top-rated selections, plus a results archive. Information only: we do not accept, place or broker bets, do not sell betting tickets and do not hold funds for betting; no outcome is guaranteed. Sold as one-time payments (annual access / lifetime access), no auto-renewal. Customers are adults in Japan.” 商品分類は各社の選択肢から最も実態に近いものを選び、自由記述欄には上記を書く（分類名を通すために言い換えない）。運営側の業種名が各社の制限業種に当たるかは各社の審査判断に委ねる |
| 価格 | `CARD_PRODUCTS` と一致（年払い ¥49,800・買い切り ¥78,000・Light 会員価格 ¥44,820）。自動更新なし |
| カード受付 | `CARD_PAYMENTS_AVAILABLE` は `CARD_SALES_OPEN` と一致（閉の間は「準備中・銀行振込のみ」）。開ける PR で両方を変える |
| 決済会社 | 選択 UI なし。Billing に Paddle（Merchant of Record）を第一として記載・切替時も二重請求なしと明記 |
| 返金 | AK の既存方針どおり（完了後は不可・二重/誤請求・未提供・法令上必要な場合は返金）。⚠️ Paddle の Buyer Terms は購入者に独自の返金を認める場合がある→本番受付前に Paddle 審査で指摘があれば MK が判断 |
| ホスティング | Netlify site `tirol-checkout`（id af09193e-1710-4a8c-bd5c-cfa7068586e9・`https://tirol-checkout.netlify.app`）。deploy は出力先ディレクトリから `netlify deploy --prod --dir <out> --no-build --functions <repo>/ops/checkout-site/netlify/functions --site <id>` |
| Functions（案B・modern runtime）| `paddle-webhook.mjs`（`/hooks/paddle`・署名検証/照会/付与委譲）・`paddle-create-checkout.mjs`（取引作成・本番から署名付き intent を受ける・§2.2）。env: `PADDLE_API_KEY`・`PADDLE_WEBHOOK_SECRET`・`CARD_GRANT_INTERNAL_SECRET` のみ（Airtable/Redis/SendGrid は持たない）|
| index 化 | `INDEXABLE=true`（2026-10-13 DNS 接続後）。robots Allow＋`sitemap.xml`・canonical は `https://checkout.tirol.link`。止めるときは false に戻して再 deploy |
| 独自ドメイン | **接続済み（2026-10-13）**: Cloudflare tirol.link ゾーンの CNAME `checkout` → `tirol-checkout.netlify.app`（DNS only）・Netlify custom domain・Let's Encrypt（自動更新）・`tirol-checkout.netlify.app/*` は `_redirects` で独自ドメインへ 301 |
| Paddle Website approval | 申請ドメイン `checkout.tirol.link`。Paddle の審査項目（商品説明・価格・機能・Terms/Refund/Privacy のナビ到達・HTTPS）は充足。**Terms には会社名または個人事業主の法的氏名が要る**（現状は屋号のみ）→ 氏名掲載は MK 判断。参照: Paddle Help「Domain Review」|
| テスト | `astro-site/src/lib/billing/checkoutSite.guard.test.mjs`（test:billing に含む）: 必須ページ・禁止語（href 以外）・ドメイン非表示・説明の一致・住所・価格・カード準備中・選択 UI なし・noindex |
| 訂正 | 初版（`a1e68625`・未 merge）は公開文言に業種を入れ decisions に「MK 確定」と誤記録 → 同 PR で撤回（decisions 2026-10-13）|
