# fincode byGMO（カード決済・代替決済の優先候補）— 実装と運用の正本

方針の根拠は `docs/decisions.md` 2026-10-11（追記 2）。販売の開始は MK の明示決定まで行わない。

## 0. いまの状態（2026-10-11）

| 項目 | 状態 |
|---|---|
| アカウント | MK が新規登録済み（TIROL DATA LABO）。テスト環境は登録直後から利用可 |
| 本番審査 | **未申請**。取扱可否（競馬データ・予想の有料提供）は一次情報で確認できていない。第三者の記事で FAQ の否認理由に「禁止商材（賭博、ギャンブルなど）」と引用あり。規約 §5.7 は「後日の否認で既決済を遡及解除」できる → **本番申請で事業内容を正確に記載し、全ブランド承認を可否の判断とする**（言い換えて通さない） |
| 販売 | **閉じている**（`CARD_SALES_OPEN = false`・コード。env では開かない）。本番サイトはテストキーも本番キーも受け付けない |
| 売る商品 | 銀行振込と同じ一回払いだけ（Premium 年払い ¥49,800／Light 会員 ¥44,820・買い切り ¥78,000）。**月払いは扱わない** |

## 1. 全体像

```
（ログイン中の会員）POST fincode-create-session { product }
   ├ resolveFincodeMode: 本番サイト = 本番キー かつ CARD_SALES_OPEN だけ／Preview = テストキーだけ
   ├ decideCardPurchase: 買い切り会員・生きている Stripe 月額・資格のない会員価格は 409（決済を作らない）
   └ POST /v1/sessions（job_code=CAPTURE・3DS2 必須・金額はサーバー・client_field_1=recordId・client_field_2=商品）
        → fincode の決済画面 → success_url（POST）= /checkout/card-complete/?order=…（表示だけ・状態を照会）
fincode → POST fincode-webhook（Fincode-Signature を定数時間比較）
   └ handleFincodeEvent: GET /v1/payments/{order} で照会 → 金額・会員・商品・状態を照合
        ├ CAPTURED（exec / capture / secure）→ 会員ロック → 注文ごとの状態（pending→done）→ decideCardGrant → PATCH
        └ CANCELED（cancel）→ 付与前の状態へ戻す（付与後に別の変更があれば戻さず管理者へ）
```

| ファイル | 役割 |
|---|---|
| `src/lib/billing/cardOneTime.js` | 一回払い商品・申込前判定・会員反映（決済会社共通の単一源）|
| `src/lib/billing/fincode/fincodeCore.js` | 販売可否・キーとサイトの組合せ・決済画面の本文・署名・照合・返金の戻し（純粋）|
| `src/lib/billing/fincode/fincodeServer.js` | fincode API・Airtable・Redis（会員ロック・注文の状態）|
| `src/lib/billing/fincode/fincodeNotify.js` | 管理者通知（support@・顧客には送らない）|
| `netlify/functions/fincode-{create-session,webhook,order-status}.js` | 入口 |
| `src/pages/checkout/card-complete.astro` | 決済後の戻り先（SSR・POST を受ける）|
| テスト | `npm run test:billing`（`fincode/fincode.test.mjs`・`cardOneTime.test.mjs`）|

## 2. 二重課金・二重昇格・誤通知・期限誤更新を作らない仕組み

- **申込前**: 買い切り会員・生きている Stripe 月額・資格のない会員価格は決済を作らない。
- **反映は Webhook だけ**。通知の中身は信じず API で照会。success_url は支払いの証明にしない。
- **会員ごとのロック**（`ak:billing:member-lock:{recordId}`）。決済会社をまたいで同じ鍵を使う前提。
- **注文ごとの状態** `ak:card:fincode:applied:{order}`: PATCH の前に pending（付与前の値と付与する値を保存）→ PATCH → done。
  再送で pending を見たら、レコードが付与後の値なら done にするだけ（年払いの二重延長を防ぐ）。Redis が無ければ反映しない（再送させる）。
- **期限**: 年払いは Premium の残りがあればその翌日から 1 年（縮めない）。Light の残りは持ち越さない。買い切りは 2099-12-31。
- **買い切り会員の決済**は権限を変えず管理者へ（返金判断）。
- **顧客への通知**は AK からは送らない（fincode の完了メール設定・決済完了画面で案内）。管理者通知だけ。
- **退会**: 一回払いのため自動更新は無い。退会は既存の退会フロー（銀行振込の年払いと同じ）。
- **更新**: 年払いの再購入（残りから延長）。自動更新（fincode サブスクリプション）は販売開始時に MK 判断。

## 3. env（Deploy Preview のテスト用だけ。production には入れない）

| env | 内容 |
|---|---|
| `FINCODE_SECRET_KEY` | テスト秘密鍵 `m_test_…`（本番サイトでは使われない＝受け付けない）|
| `FINCODE_WEBHOOK_SIGNATURE` | fincode の Webhook 設定に登録する固定文字列（推測できない値）|
| `FINCODE_E2E_SECRET` | E2E 用（24 文字以上）。Deploy Preview はマジックリンクでログインできないため、テストモード限定で `+fincode-e2e` のレコードを指定できる |

⚠️ production の関数 env は Lambda 4KB 上限に近い（`STRIPE_BILLING.md` §3）。本番化のときは先に枠を確認する。
⚠️ 鍵の値は画面・ログ・commit に出さない。

## 4. Sandbox E2E 手順（Deploy Preview）

1. MK: fincode 管理画面（テスト環境）で秘密鍵を発行し、Webhook（`payments.card.exec` / `payments.card.capture` / `payments.card.secure` / `payments.card.cancel`）を
   `https://deploy-preview-<PR>--analytics-keiba.netlify.app/.netlify/functions/fincode-webhook` に、署名文字列を付けて登録。
2. Claude: Deploy Preview の env に上の 3 つを設定 → 再デプロイ。
3. 使い捨てレコード（`…+fincode-e2e@…`）で `fincode-create-session`（`x-ak-e2e-secret`）→ 決済画面でテストカード
   （3DS2 成功 4100 0000 0000 0100 等）→ Webhook → Customers の反映・`fincode-order-status` を確認。
4. 再送（管理画面からの再送）・返金（取消）・再購入・買い切り会員の拒否を確認。
5. 後片付け: 使い捨てレコードを削除・env を外す・Webhook 設定を消す。

## 5. ロールバック

- コード: revert PR（販売は閉じているので顧客影響なし）。
- 反映済みの会員: 注文の状態に付与前の値を保存してある。返金（取消）で自動で戻る。
