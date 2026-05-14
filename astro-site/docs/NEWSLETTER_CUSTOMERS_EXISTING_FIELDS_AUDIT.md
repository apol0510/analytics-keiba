# Customers テーブル 既存挙動 調査レポート

**調査日**: 2026-05-14  
**目的**: [NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md](./NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md) で追加する10フィールドが既存挙動と衝突しないかを READ ONLY で精査  
**Airtable API 呼び出し**: なし（コード grep のみ）  
**SendGrid API 呼び出し**: なし  
**コード変更**: なし

---

## 1. 調査対象ファイル一覧（Customers テーブルにアクセスする10ファイル）

| # | ファイル | 操作 | 概要 |
|---|---|---|---|
| 1 | `netlify/functions/verify-magic-link.js` | READ | 認証時に Email で1件取得（多くのフィールドを参照） |
| 2 | `netlify/functions/bank-transfer-application.js` | CREATE + PATCH | 銀振申込時に新規作成 or 更新（プラン/Status/期限/退会フラグ） |
| 3 | `netlify/functions/process-withdrawal.js` | PATCH | 退会処理（WithdrawalRequested 等） |
| 4 | `netlify/functions/send-payment-confirmation.js` | PATCH | 入金確認時に `Status='active'` 上書き |
| 5 | `netlify/functions/unsubscribe.js` | PATCH | 配信停止時に `メール配信='OFF'` / `配信停止日` 上書き |
| 6 | `netlify/functions/send-newsletter.js` | READ | プラン/MailingList/退会フラグでフィルタ |
| 7 | `netlify/functions/create-newsletter-queue.js` | READ | WithdrawalRequested=FALSE + プラン でフィルタ |
| 8 | `netlify/functions/execute-scheduled-emails.js` | READ | プラン/有効期限 でフィルタ（getRecipientsList） |
| 9 | `netlify/functions/get-customer-stats.js` | READ | 全件 + プラン集計 |
| 10 | `src/pages/admin-newsletter-simple.astro` | READ（クライアント） | admin画面 ブラウザ側で全件 + プラン値分析 |

⚠️ ②〜⑤ は WRITE する関数。`Customers` テーブルの既存フィールドを実際に更新している。

---

## 2. 既存フィールド名 一覧（コード使用実績）

コード上で実際に参照されている Customers フィールドを書き出す。  
**この一覧は「コードから見えるもの」**であり、Airtable 上の実フィールドは [NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md §6](./NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md) の手動確認で最終確定する。

### 2.1 顧客特定系

| フィールド名 | 型推定 | 使用関数 | 備考 |
|---|---|---|---|
| `Email` | Email | 全関数（カノニカル） | `LOWER(TRIM(...))` で比較される |
| `氏名` | Text | bank-transfer / verify-magic-link | 日本語名 |
| `Name` | Text | verify-magic-link | 英語名（alt） |
| `お名前` | Text | verify-magic-link | 旧名（alt） |

### 2.2 プラン・課金系

| フィールド名 | 型推定 | 使用関数 | 備考 |
|---|---|---|---|
| `プラン` | Text or Single select | bank-transfer / send-newsletter / create-newsletter-queue / execute-scheduled-emails / get-customer-stats / admin-newsletter-simple | **値の例**: `Free`, `Standard`, `Premium`, `Premium Predictions`, `Premium Sanrenpuku`, `Premium Combo`, `Premium Plus`, `Test`, 等 |
| `Plan` | Text | get-customer-stats / admin-newsletter-simple | 英語名（alt、まれ） |
| `PlanType` | Single select | bank-transfer / verify-magic-link | **値の例**: `Lifetime`, `Annual`, `Monthly`（買い切り判定用） |
| `Status` | **Single select（既存）** | bank-transfer / send-payment-confirmation / verify-magic-link | **値の例**: `active`, `pending` |
| `PaymentMethod` | Text | bank-transfer | 例: `Bank Transfer` |
| `PaymentEmailSent` | Checkbox | verify-magic-link コメント | 入金確認メール送信済フラグ |
| `VenueAccess` | Single select | verify-magic-link | 例: `all`, `jra` |
| `LifetimeSanrenpuku` | Checkbox | verify-magic-link | 三連複買い切り判定 |
| `三連複Lifetime` | Checkbox | verify-magic-link | 旧名（alt） |

### 2.3 有効期限系（**4種類混在！**）

| フィールド名 | 使用関数 | 備考 |
|---|---|---|
| `有効期限` | bank-transfer / process-withdrawal / verify-magic-link / send-newsletter / execute-scheduled-emails | **主用** |
| `ValidUntil` | send-newsletter / execute-scheduled-emails | alt |
| `ExpirationDate` | verify-magic-link | alt |
| `ExpiryDate` | send-newsletter / execute-scheduled-emails | alt |

⚠️ **4つの別名フィールドが各関数で個別に参照されている**。実際に Airtable 側にどれが存在するか手動確認が必須。  
最新の `verify-magic-link.js` では `customer.ExpirationDate || customer['有効期限']` という fallback 形になっているため、両方存在する可能性あり。

### 2.4 退会・配信停止系

| フィールド名 | 型推定 | 使用関数 | 備考 |
|---|---|---|---|
| `WithdrawalRequested` | Checkbox | bank-transfer / process-withdrawal / send-newsletter / create-newsletter-queue | 退会要求フラグ |
| `WithdrawalDate` | Date | bank-transfer / process-withdrawal | 退会日 |
| `WithdrawalReason` | Text | bank-transfer / process-withdrawal | 退会理由 |
| `メール配信` | Text/Single select? | unsubscribe.js | unsubscribe で `'OFF'` 上書き。**ただし send-newsletter.js コメントには「フィールドが存在しないため無効化」とある（要確認）** |
| `配信停止日` | Date | unsubscribe.js | `YYYY-MM-DD` 形式 |
| `MailingList` | Multi-select? | send-newsletter | 例: `退会者` / その他のセグメント |

### 2.5 その他

| フィールド名 | 使用関数 | 備考 |
|---|---|---|
| `Source` | bank-transfer | 例: `nankan-analytics`（登録元サイト） |

---

## 3. WRITE される既存フィールド（最重要）

新規フィールド追加時、**既存 WRITE 経路と命名衝突するとデータ破壊リスク**があるため特に注意。

### 3.1 bank-transfer-application.js
- CREATE 時に書く: `Email`, `氏名`, `プラン`, `PlanType`, `Status='pending'`, `PaymentMethod`, `有効期限`, `Source`
- UPDATE 時に書く: `氏名`, `プラン`, `PlanType`, `PaymentMethod`, `有効期限`, `WithdrawalRequested=false`, `WithdrawalDate=null`, `WithdrawalReason=null`, `Status='pending'`（既存 active ならスキップ）

### 3.2 process-withdrawal.js
- UPDATE 時に書く: `WithdrawalRequested`, `WithdrawalDate`, `WithdrawalReason`, `有効期限`

### 3.3 send-payment-confirmation.js
- UPDATE 時に書く: `Status='active'`

### 3.4 unsubscribe.js
- UPDATE 時に書く: `メール配信='OFF'`, `配信停止日='YYYY-MM-DD'`
- ⚠️ ただし send-newsletter.js が `{メール配信}` フィールド存在を否定するコメントを持つ → **`unsubscribe.js` が書き込み先と読み取り側でズレている可能性**

---

## 4. 退会・停止・期限・支払い 関連まとめ

新システムが既存挙動を踏襲・改修する必要がある領域:

| カテゴリ | 既存フィールド | 既存挙動 | 新仕様での対応 |
|---|---|---|---|
| 退会フラグ | `WithdrawalRequested` (bool) + `WithdrawalDate` + `WithdrawalReason` | process-withdrawal が UPDATE | 新 `Status='withdrawn'` に統合予定。当面は両方並走 |
| 配信停止 | `メール配信='OFF'` + `配信停止日` | unsubscribe.js が UPDATE。ただし送信側で読まれていない疑いあり | **新 `UnsubscribedAnalyticsKeiba` / `UnsubscribedKeibaIntelligence` で完全置換**。既存は当面温存、別タスクで unsubscribe.js を `brand` 必須化して改修 |
| 期限切れ | `有効期限` / `ValidUntil` / `ExpirationDate` / `ExpiryDate` の4種混在 | 各関数で個別に参照 | 新 `Status='expired'` に統合予定。期限日自体は1本に統一する別タスクが必要 |
| 支払い状態 | `Status='pending'` / `Status='active'`（既存 Single select） | bank-transfer で pending、send-payment-confirmation で active | **新 `Status` の値集合と統合**（後述§5の致命的衝突） |
| 配信ターゲット | `プラン` / `PlanType` | send-newsletter / create-newsletter-queue でフィルタ | 新 `AudienceType` を並走させ、移行スクリプトで遡及付与 |
| ブランド識別 | （**該当フィールドなし**） | コードでは判定できず、SendGrid 側カスタムフィールド `registered_analytics` / `registered_intelligence` でのみ識別 | 新 `Brand` / `ServiceType` で完全に欠けていた素地を埋める |

---

## 5. 今回追加予定10フィールドとの衝突有無

### 5.1 結論サマリ

| 提案フィールド | 既存衝突 | 対応方針 |
|---|---|---|
| `Brand` | ❌ なし | 新規追加でOK |
| `ServiceType` | ❌ なし | 新規追加でOK |
| `AudienceType` | ❌ なし（既存 `プラン`/`PlanType` と**意味重複**だがフィールド名は別） | 新規追加でOK。当面並走 |
| **`Status`** | ⚠️ **あり（既存 Single select、値 `active`/`pending`）** | **新規追加してはいけない**。既存フィールドの**選択肢を追加**で対応 |
| `UnsubscribedAnalyticsKeiba` | ❌ なし | 新規追加でOK |
| `UnsubscribedKeibaIntelligence` | ❌ なし | 新規追加でOK |
| `UnsubscribedAtAnalyticsKeiba` | ❌ なし | 新規追加でOK |
| `UnsubscribedAtKeibaIntelligence` | ❌ なし | 新規追加でOK |
| `LastNewsletterSentAt` | ❌ なし | 新規追加でOK |
| `LastNewsletterBrand` | ❌ なし | 新規追加でOK |

### 5.2 重大: `Status` フィールド衝突の詳細

**既存 `Status`**:
- 型: Single select（推定）
- 既存値: `active`, `pending`（コード grep より）
- 書く関数: `bank-transfer-application.js`（`pending`）, `send-payment-confirmation.js`（`active`）
- 読む関数: `verify-magic-link.js`, `bank-transfer-application.js`

**新規追加で提案している値**:
- `active`（既存と一致）
- `expired`（新）
- `unpaid`（新）
- `cancelled`（新）
- `refunded`（新）
- `withdrawn`（新）
- `test`（新）

**衝突回避策**（Airtable UI 作業）:
1. **既存 `Status` フィールドはそのまま使う**（削除・リネーム禁止）
2. その Single select に **追加で6つの選択肢を足す**: `expired`, `unpaid`, `cancelled`, `refunded`, `withdrawn`, `test`
3. 既存 `pending` の値も残す（bank-transfer-application が書き続ける）
4. 結果として `Status` の取りうる値: `active` / `pending` / `expired` / `unpaid` / `cancelled` / `refunded` / `withdrawn` / `test`
5. 既存レコードの `Status` 値は変更しない

⚠️ これは [NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md §3](./NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md) の「Status を新規追加」という記述と矛盾するため、**手順書の修正が必要**（別タスク）。

### 5.3 セマンティック重複（衝突ではないが要設計）

| 提案 | 既存（意味重複） | 当面の方針 |
|---|---|---|
| `AudienceType`（`free`/`standard`/`premium`/...） | `プラン`（`Free`/`Standard`/`Premium`...）+ `PlanType`（`Lifetime`/`Annual`/`Monthly`） | 新 `AudienceType` を**追加して並走**。配信側は当面 `プラン` を参照し続け、移行は別タスク |
| `LastNewsletterSentAt` | （なし） | 新規。完全自動化後の配信履歴管理用 |
| `LastNewsletterBrand` | （なし） | 新規 |

---

## 6. Airtable 手動セットアップ前に注意すべき点

### 6.1 必ず先に確認すること（マコさん作業前）

1. **`Status` フィールドが既存テーブルに本当に存在するか**を Airtable UI で目視確認
   - 既存値の集計（何件が `active` / 何件が `pending` / その他）
   - Single select かどうか
   - これが見つからない場合は、手順書 §3 通りに新規追加で OK
2. **`プラン` フィールドの取りうる値の全リスト**を Airtable UI で確認
   - 想定: `Free`, `Standard`, `Light`, `Premium`, `Premium Predictions`, `Premium Sanrenpuku`, `Premium Combo`, `Premium Plus`, `Test`
   - 想定外の値が混じっていれば記録（後の遡及付与で考慮）
3. **`メール配信` フィールドが存在するか**
   - 存在 → unsubscribe.js は書き込み成立しているが、send-newsletter.js のコメントは古い情報の可能性
   - 不存在 → unsubscribe.js は実質エラーで動作している（要別タスク）
4. **期限関連 4 フィールド (`有効期限` / `ValidUntil` / `ExpirationDate` / `ExpiryDate`) のどれが実在するか**
5. **`WithdrawalRequested` の現在値分布**（true/false の件数）

### 6.2 手順書の改訂が必要な点（このレポートからのフィードバック）

1. **§3 ④ `Status` を「新規追加」から「既存に選択肢追加」に変更**
2. **§4 既存フィールド対応表に以下を明記**:
   - `Status` は既存（active/pending）
   - `WithdrawalRequested` は既存（process-withdrawal が書く）
   - `MailingList` は既存（send-newsletter で参照）
   - `Source` は既存（bank-transfer が書く）
   - `VenueAccess` / `LifetimeSanrenpuku` / `三連複Lifetime` / `PaymentMethod` / `PaymentEmailSent` は既存
   - 期限フィールドは4種混在の可能性
3. **§6 作業前チェックに「Status の既存値集計」「メール配信 の存否確認」を追加**

→ これらは **別 commit でチェックリスト改訂版**として反映する想定。本レポートでは方針提示のみ。

### 6.3 衝突しない新規フィールドの追加は問題なし

`Status` 以外の9フィールドは既存と衝突しないため、手順書 §3 通りに新規追加可能。

---

## 7. 次に Airtable 画面で確認すべき項目

マコさんが手順書に従う前、**まず以下を Airtable UI で「見るだけ」**で記録する:

```
■ Airtable Customers テーブル 事前調査ログ（マコさん記入）

調査日時: YYYY-MM-DD HH:MM JST
Base 名: ___

【既存フィールド一覧】（左から右へ）
1. ___（型: ___）
2. ___（型: ___）
...

【Single select の選択肢確認】
- Status: ☐ 存在 / ☐ なし
  - 存在する場合の選択肢: [ active / pending / その他___ ]
  - 件数分布: active=___, pending=___, その他=___
- プラン: 取りうる値の全リスト = ___
- PlanType: 取りうる値の全リスト = ___
- VenueAccess: 取りうる値の全リスト = ___
- MailingList: 取りうる値の全リスト = ___

【Boolean / Checkbox 確認】
- WithdrawalRequested: ☐ 存在 / ☐ なし（件数: true=___, false=___）
- PaymentEmailSent: ☐ 存在 / ☐ なし
- LifetimeSanrenpuku: ☐ 存在 / ☐ なし
- メール配信: ☐ 存在 / ☐ なし（型: ___、件数: OFF=___）

【期限フィールド確認（4種類混在の可能性）】
- 有効期限: ☐ 存在 / ☐ なし
- ValidUntil: ☐ 存在 / ☐ なし
- ExpirationDate: ☐ 存在 / ☐ なし
- ExpiryDate: ☐ 存在 / ☐ なし

【既存レコード総件数】
___ records
```

これを Claude（私）に報告 → 私が手順書を最終調整 → マコさんがフィールド追加作業に進む、という順序を推奨。

---

## 8. 禁止事項（再掲・本レポート作成中ずっと有効だった）

- ❌ コード変更
- ❌ Airtable API 呼び出し
- ❌ Airtable READ / WRITE
- ❌ SendGrid API 呼び出し
- ❌ `NEWSLETTER_AUTOMATION_ENABLED` の設定変更
- ❌ 既存7関数のガード解除
- ❌ nankan-analytics 側の変更

すべて遵守。

---

## 9. 参照

- [NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md](./NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md) §4「Customers テーブル拡張案」
- [NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md](./NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md) §3「追加フィールド一覧」§4「既存フィールド対応」
- 既存関数: `verify-magic-link.js`, `bank-transfer-application.js`, `process-withdrawal.js`, `send-payment-confirmation.js`, `unsubscribe.js`, `send-newsletter.js`（ガード済）, `create-newsletter-queue.js`（ガード済）, `execute-scheduled-emails.js`（ガード済）, `get-customer-stats.js`, `admin-newsletter-simple.astro`
