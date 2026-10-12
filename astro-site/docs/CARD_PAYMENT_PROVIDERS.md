# カード決済（Paddle・PayPal・fincode）— 共通層と各社の実装・運用の正本

方針の根拠は `docs/decisions.md` 2026-10-11（追記 3）。fincode 固有の手順は `FINCODE_BILLING.md`。

## 0. いまの状態（2026-10-11）

| 項目 | Paddle（第一優先） | PayPal（第二優先） | fincode（審査結果待ち） |
|---|---|---|---|
| アカウント | **未開設**。TIROL DATA LABO 本人名義で新規開設（旧 Paddle アカウントは使わない）| **未開設**。新規のビジネスアカウント | MK 登録済み・本番審査結果待ち |
| Sandbox 実装 | 済み（一回払い・Webhook・返金）| 済み（Orders v2・capture・Webhook・返金）| 済み |
| Sandbox E2E | 鍵待ち（§4）| 鍵待ち（§4）| 鍵待ち（`FINCODE_BILLING.md` §4）|
| 本番受付 | **閉じている**（`CARD_SALES_OPEN.paddle=false`）| **閉じている**（`.paypal=false`）| **閉じている**（`.fincode=false`）|
| 取扱可否（一次情報）| ⚠️ 禁止リストに「Betting-related products」「Sports forecasting/odds making where monetary or material prizes are involved」。**書面確認が要る** | ⚠️ 利用規定で「競馬またはドッグレース」「ギャンブルを助長するその他の事業」が**事前承認が必要**な区分。承認前の受付は規約違反 | ⚠️ 第三者記事に否認理由「禁止商材（賭博、ギャンブルなど）」|

- 売るのは銀行振込と同じ一回払い（Premium 年払い ¥49,800／Light 会員 ¥44,820・買い切り ¥78,000）だけ。**月払い・定期課金は作らない**（Paddle の定期価格・PayPal Subscriptions は使わない。guard で固定）。
- 本番受付は、その決済会社が AK の取扱商品を承認したあと、MK の明示決定で `src/lib/billing/cardSales.js` の値を変える PR だけで開く。env では開かない。

## 1. 共通層（決済会社に依存しない会員権限）

```
各社アダプタ（API で照会して確かめた事実だけを渡す）
  paddle/paddleServer.js ─┐
  paypal/paypalServer.js ─┼─▶ entitlementLedger.js ─▶ cardOneTime.decideCardGrant（何を書くか・純粋）
  fincode/fincodeServer.js┘      │                    cardRefund.decideRefundRevert（何に戻すか・純粋）
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

env（Deploy Preview の Sandbox 用だけ。production には入れない）: `PADDLE_API_KEY`（`pdl_sdbx_apikey_…`）・`PADDLE_WEBHOOK_SECRET`（通知先の secret key）・`PADDLE_CLIENT_TOKEN`（`test_…`・公開してよい）・`CARD_E2E_SECRET`（24 文字以上）

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
| 2026-10-12 | Paddle | `https://sandbox.checkout.tirol.link`（→ PR #792 の Deploy Preview）| 実施中。env は deploy-preview context のみ（production の PADDLE_*／CARD_* は 0 件のまま）。DNS・HTTPS・通知先（4 イベント）登録済み |

## 5. 本番化の条件（すべて満たすまで開かない）

1. その決済会社が AK の取扱商品（競馬データ・予想の有料提供）を承認した記録（Paddle: 書面回答＋本番アカウント審査／PayPal: 事前承認）。審査では事業内容を正確に申告し、言い換えで通さない。
2. Sandbox E2E 完了。
3. MK の販売開始の明示決定 → `cardSales.js` の該当値を true にする PR（このとき pricing のカード導線も追加）。
4. production env（4KB 枠の確認）・本番の Webhook 登録・本番での実購入 1 件の確認と返金。

## 6. ロールバック

- コード: revert PR（販売は閉じているので顧客影響なし）。
- 反映済みの会員: 決済ごとの状態に付与前の値を保存してある。全額返金で自動で戻る。
