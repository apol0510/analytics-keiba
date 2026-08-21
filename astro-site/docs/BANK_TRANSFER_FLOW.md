# 銀行振込 入金確認フロー

> CLAUDE.md から集約（2026-08-13）。**ルールの正本はこのファイル**。
> ⚠️ secret の値そのものは絶対に記載しないこと。


**入金確認は `PaymentConfirmed` にチェックを入れる 1 アクションだけ。有効期限は手入力しない。**

### フロー

| 段階 | 何が起きるか |
|---|---|
| **申込フォーム送信** | `bank-transfer-application.js` が `氏名` / `PaymentMethod` / `RequestedPlan` / `RequestedPlanType` / `RequestedAmount` / `PaymentConfirmed=false` のみ書く |
| **入金確認（MK）** | Airtable で `PaymentConfirmed` にチェック |
| **昇格（自動）** | Automation → `confirm-bank-payment.js` が `プラン` / `PlanType` / `Status='active'` / `有効期限`（**入金確認日 JST + 1年**）/ `PaidAt` / `PaymentEmailSent=true` を 1 回の PATCH で確定し、確認メールを送信 |

- **申込時に有料権限を付与しない**。`プラン` / `PlanType` / `有効期限` / `Status='active'` は書かない
- **既存 active Light 会員はフォーム送信だけでは昇格しない**（Light active のまま維持）
- 新規 / 非 active のみ `Status='pending'`（`auth-user.js` の pending ガードで Free 扱い）
- 退会フラグのリセットは**承認時**（未入金の申込で退会申請が消えないように）

### 判定の単一源

`astro-site/src/lib/payments/bankPaymentFlow.js`（純粋関数・Airtable 非依存）

- `buildApplicationFields()` — 申込時に書くフィールド
- `buildConfirmationFields()` — 承認時に書くフィールド。`RequestedPlan` が空なら `null`（fail closed）
- `addOneYearJst()` / `addMonthsJst()` — **JST の暦日**で計算。`toISOString()` の UTC 基準は使わない
  （JST 深夜 0〜9 時に 1 日ズレる）。閏日 2/29 + 1年 は 3/1 ではなく 2/28 に丸める

検証: `npm run test:bank-payment`（`check:safety` に組込済み）

**禁止事項**: Function 内で `プラン` / `有効期限` / `Status='active'` を直書きしない。
必ず `bankPaymentFlow.js` 経由。guard テストが直書きを検知する。

### 🚨 「入金確認・昇格が済んだか」の判定（**`Status=active` だけで判定しない**）

**このフローで一番間違えやすい点。** 申込の時点で既存 active 会員は
**`Status='active'` のまま**であり、権限も変わらない。
したがって **`Status='active'` は「この申込の入金確認が済んだ」を意味しない。**

済んだかどうかは、次の **3 条件がすべて揃ったとき**だけ真とする（**fail closed**）:

| # | 条件 | 根拠 |
|---|---|---|
| 1 | `Status === 'active'`（かつ `プラン` が空でない）| `buildConfirmationFields()` が承認時に確定させる |
| 2 | `RequestedPlan` が**空** | 承認時に `Requested*` をクリアする（下の冪等性）|
| 3 | `PaymentConfirmed === true` | 承認済みの**痕跡として残る**（クリアしない）|

各段階でどう見えるか:

| 段階 | Status | RequestedPlan | PaymentConfirmed | 判定 |
|---|---|---|---|---|
| 申込前（既存 active 会員）| active | 空 | false | **未確定** |
| 申込直後 | active（**変わらない**）| あり | false | **未確定** |
| MK がチェック | active | あり | true | **未確定**（confirm 未実行）|
| confirm 成功後 | active | **空** | **true** | **確定** |

- **`PaymentConfirmed` は厳密に `true` のみ**を受け付ける（`'true'` / `1` / truthy は不可）。
  `confirm-bank-payment.js` の認可（`fields['PaymentConfirmed'] !== true` で 403）と同じ読み方。
- 条件 2 だけ、条件 3 だけでの判定も禁止。**手動で active にした会員・旧データ**を
  「入金確認済み」と読み替えないため、3 つ揃わなければ未確定に倒す。

**判定の実装**: `src/lib/premiumPlus/couponRedeemReconcile.js` の `isCustomerSettled()`。
Premium Plus 再募集クーポンの「利用予約 → 使用済み」の突き合わせに使う。

> **過去事例（2026-08-19）**: `プラン` + `Status='active'` だけを見ていたため、
> **既に active な三連複会員**が Premium Plus を申し込んだ瞬間から「入金確認済み」と
> 判定され、利用予約（`issued`）が**常に「要修復」**に化けていた。
> admin に「クーポン利用予約（入金確認待ち）」が一度も出ない状態だった。
> 同種の判定を新しく書くときも、**必ず上の 3 条件を使うこと**。

検証: `node --test src/lib/premiumPlus/couponRedeemReconcile.test.mjs`
（`check:safety` の `test:premium-plus-media` に組込済み）

### 認可・冪等性・二重メール防止

- **認可**: `confirm-bank-payment.js` は公開 URL。Airtable の `PaymentConfirmed=true` を
  **再読込して検証**し、false なら 403。チェックできるのは Airtable にアクセスできる MK だけ
- **冪等性**: 承認時に `Requested*` をクリア。再チェックしても `RequestedPlan` が空 → 昇格しない
  （有効期限が再延長されない）
- **二重メール防止**: confirm が `PaymentEmailSent=true` を立てるため、
  `send-payment-confirmation-auto.js` の再送ガードでスキップされる。メールは常に 1 通

### Airtable Automation（2 本。触る前に必読）

| Automation | Trigger | 監視 Fields | 条件 | Action |
|---|---|---|---|---|
| 入金確認 → 有料プラン昇格 | When record updated | `PaymentConfirmed` | PaymentConfirmed is checked | `confirm-bank-payment` |
| 入金確認メール自動送信 | When record updated | **`Status` のみ** | Status is active AND PaymentEmailSent is unchecked | `send-payment-confirmation-auto` |

後者は元 `When a record matches conditions`（フィールド監視なし）で**レコード更新全般で発火**していた。
2026-07-10 に `Status` のみ監視へ変更し、役割を「MK が手動で pending→active にしたときの確認メール」に縮小。

**監視 Fields を空欄に戻さないこと。** 空欄 = 全フィールド監視となり、`RequestedAmount` の更新等でも
入金確認メールが誤送信される。

### ⚠️ 再送手順（変更あり）

**`PaymentEmailSent` を空に戻すだけでは再送されない。**
Automation は `Status` の変化でしか発火しないため、再送するには
**`Status` を pending → active に切り替える**必要がある。
これは `send-payment-confirmation-auto.js` が返す `howToResend` メッセージと同じ手順。

### ⚠️ 未使用経路の二重送信リスク（未修正）

`paypal-webhook.js` と `send-payment-confirmation.js` は
**自前で SendGrid を叩き `Status='active'` を書くが `PaymentEmailSent=true` を立てない**。
そのため Automation「入金確認メール自動送信」が発火し、**確認メールが 2 通届く**。

現在 pricing は銀行振込のみを案内しており両経路とも未使用のため実害は無い。
**復活させる場合は、両ファイルで `PaymentEmailSent: true` を同時に書く修正が必須。**

### 🔐 PAYMENT_CONFIRM_SECRET（設定・本番検証済み / 2026-07-11）

`confirm-bank-payment` は公開 URL のため、`PaymentConfirmed=true` 再読込認可に加えて
`x-confirm-secret` ヘッダ認証を本番で有効化済み。**認証機能の有効化に追加のコード変更は不要**
（gating は `if (process.env.PAYMENT_CONFIRM_SECRET)` として既にデプロイ済み。env 投入だけで有効化される）。

- **Netlify**: `PAYMENT_CONFIRM_SECRET` を **production context に設定済み**。
- **Airtable Automation**「入金確認 → 有料プラン昇格」の Run script は
  `confirm-bank-payment` 呼び出し時に **`x-confirm-secret` ヘッダを送信する**
  （`Content-Type: application/json` は残したまま1行追加）。
- **順序厳守**: Automation ヘッダ追加 → その後 env 設定。逆順にすると env 有効化後に
  ヘッダ無し Automation が全て 403 となり昇格が止まる。env 未設定の間はヘッダを送っても
  Function 側が無視する（`if(CONFIRM_SECRET)` が false）ため無害。
- **本番検証済み**:
  - secret **なし** / **不一致** → `403 Forbidden`（認可段で停止・レコード非破壊）を確認済み。
  - **正しい secret** による Premium 昇格（Automation 経由で `プラン=Premium` /
    `PlanType=Annual` / `Status=active` / 有効期限 JST+1年 / `PaymentEmailSent=true` /
    `Requested*` クリア / 確認メール1通）を確認済み。
- **rollback**: `netlify env:unset PAYMENT_CONFIRM_SECRET --context production` →
  正規 production build（Build Hook で origin/main を1回ビルド）で、コード変更なしに
  従来の `PaymentConfirmed` 再読込認可のみへ即復帰する。
- **secret 値そのものは CLAUDE.md / ログ / commit に絶対に記載しない。**

### 残件

- Airtable Customers に `Amount` / `ProductName` フィールドは無い。振込金額は
  `RequestedAmount`（承認時にクリア）と管理者宛メールにしか残らない

### 関連ファイル

| 目的 | ファイル |
|---|---|
| 判定の単一源 | `astro-site/src/lib/payments/bankPaymentFlow.js` |
| 申込 | `astro-site/netlify/functions/bank-transfer-application.js` |
| 昇格 | `astro-site/netlify/functions/confirm-bank-payment.js` |
| 確認メール（手動 active 化用） | `astro-site/netlify/functions/send-payment-confirmation-auto.js` |
| テスト | `astro-site/src/lib/payments/bankPaymentFlow.test.mjs` / `bankPaymentFunctions.guard.test.mjs` |

