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

### 🧑‍💼 運営者による代理入金連絡（2026-09-16 確定 / 応急・例外運用）

**入金は確認できているのに、顧客本人が入金連絡フォームを送れていない**場合の経路。
高齢・PC/スマホ操作が苦手・ログインできない等で、通常の入金連絡操作を本人へ
求めることが現実的でない場合に**限って**使う。**通常の申込経路ではない。**

#### なぜ要ったか（2026-09-16 / MK 報告）

銀行着金は確認できているのに、運営者が代わりに申込を通す手段が無かった。

| 詰まり | 実体 |
|---|---|
| 運営者が代理でフォーム送信できない | 申込アドレスは**ログイン中のセッションに固定**（`applicationIdentity.js`）。代理送信すると運営者のアドレスで記録される |
| キャンペーン価格で申し込めない | 会員限定価格は**その会員のティアにしか画面へ出ない**（`data-plan-tier`）。運営者の画面には出ない |
| Airtable の手修正が現実的でない | `プラン` / `PlanType` / `Status` / `有効期限` / `PaidAt` / `PaymentEmailSent` / 退会フラグ を人間が揃える必要があり、間違えれば権限事故になる |

結果として**入金済みの顧客を昇格させる手段が事実上無い**状態だった。
`confirm-bank-payment` も `admin-promote-customer` も入口が `RequestedPlan` なので、
**フォーム未送信の顧客は構造的に昇格できない**（fail closed が正しく効いている）。

#### 何をする機能か（範囲を誤解しないこと）

**顧客としてログインし直す機能ではない（なりすましではない）。**
本人がフォームを送ったのと**同じ申込情報**（`Requested*`）を運営者が登録するだけ。

| 書く | 書かない |
|---|---|
| `RequestedPlan` / `RequestedPlanType` / `RequestedAmount` / `PaymentConfirmed=false` / 非 active なら `Status='pending'` | `プラン` / `PlanType` / `Status='active'` / `有効期限` / `PaidAt` / `PaymentEmailSent` / `LifetimeSanrenpuku` |

登録後の昇格は**従来どおり `PaymentConfirmed` を起点にした既存の単一経路だけ**が行う。
運営者の残作業は Airtable で `PaymentConfirmed` にチェックを入れる 1 アクション。

#### 実入金額は捏造しない

掲載価格と着金額はずれることがある（例: 掲載 ¥44,820 / 着金 ¥44,800）。
**`RequestedAmount` には運営者が確認した実入金額をそのまま入れる。**
通常フォームでもキャンペーン・クーポンが無ければ `RequestedAmount` は顧客申告の
振込額そのものなので、意味は一致している。

⚠️ ただし `RequestedAmount` は**入金確認時にクリアされる**（下の「残件」と同じ制約）。
昇格後も実入金額を残すには Airtable に列が要るため、**本番 schema 変更は行わず**、
`PROXY_PAYMENT_NOTICE_FIELDS_READY=1` が立っているときだけ監査列へ書く
（`SaleTargetDate` と同じ env gate。列が無い本番では書かない＝ 422 にならない）。
列が無い間も、代理登録の事実は Function の構造化ログ
（`event: 'admin_proxy_payment_notice'`）に必ず 1 行残る。

#### 対象外（迂回させない）

- **Premium Plus**: 対象日（16:30 境界）・クーポン・会員別の販売停止をサーバーで
  確定させる商品。代理登録から迂回させない → `premium_plus_unsupported` で拒否
- **会員レコードの新規作成**: しない。未登録アドレスは `customer_not_found` で拒否
  （打ち間違いで空レコードを生やさない）
- **顧客宛メール**: 送らない。利用開始メールは昇格側の責務

#### 認可（fail closed・多層）

`premiumPlus/mediaAuth.js` の `decideAdminWrite` をそのまま使う。
POST 限定 / 管理者 secret 設定済み / timing-safe 一致 / 本番 context /
Origin 完全一致。**1 つでも欠ければ Airtable に到達しない。**
secret は **`PROXY_NOTICE_ADMIN_SECRET` 専用**。**他の管理 secret へ fallback しない。**
管理画面は `/admin/*` の Basic 認証背後。

> ⚠️ **2026-09-16 の実測事故**: 当初 `PAYMENT_ADMIN_SECRET` → `PREMIUM_PLUS_ADMIN_SECRET` の
> fallback を持たせていたが、本番には**既に両方とも設定済み**だった。そのため
> 「専用 secret を入れるまで 503 で不活性」という前提が deploy 時点で崩れ、
> 本番の正規形式 POST が **503 ではなく 403**（＝ secret さえ合えば通る状態）を返した。
> 他機能のために配った secret で顧客の申込レコードを書ける状態を作らないため、
> fallback を撤去した。**再導入は guard テストが禁止する。**

#### 二重登録の防止

未確認の申込（`RequestedPlan` が空でない）が残っているときは `already_pending` で拒否する。
置き換えるには画面で明示的にチェックを入れる必要があり、その事実は
`replacedPending` としてログに残る。昇格済みレコードへの再登録は**正当な更新**なので
塞がないが、`PaymentConfirmed` は `false` へ戻るため、昇格には改めてチェックが要る。

#### 運用手順

1. `/admin/proxy-payment-notice` を開く（Basic 認証）
2. 顧客メール / プラン / **実入金額** / 入金日 / 理由 / 操作者 / 管理者 secret を入力
3. **「内容を確認」** を押す（この時点で Airtable は 1 バイトも書かれない）
4. 書き込まれる内容を目で確認して **「この内容で登録する」**
5. Airtable で該当会員の **`PaymentConfirmed` にチェック** → 既存経路が昇格 ＋ 利用開始メール

#### rollback

登録直後（`PaymentConfirmed` を押す前）なら、Airtable で `RequestedPlan` /
`RequestedPlanType` / `RequestedAmount` を空へ戻すだけで元に戻る。
**権限は 1 つも動いていない**ので、会員の見え方は変わらない。

#### 関連ファイル

| 目的 | ファイル |
|---|---|
| 判定・組み立ての単一源 | `astro-site/src/lib/payments/proxyPaymentNotice.js` |
| Function | `astro-site/netlify/functions/admin-proxy-payment-notice.js` |
| 管理画面 | `astro-site/src/pages/admin/proxy-payment-notice.astro` |
| テスト | `proxyPaymentNotice.test.mjs` / `proxyPaymentNoticeFunction.guard.test.mjs`（`test:bank-payment`）|
| 実 DOM E2E | `astro-site/scripts/e2e-admin-proxy-notice.mjs`（`npm run e2e:proxy-notice`・CI 必須）|

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

