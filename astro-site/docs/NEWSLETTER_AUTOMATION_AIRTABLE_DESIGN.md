# 完全自動化メルマガ配信システム Airtable / 運用設計書

**最終更新**: 2026-05-14  
**追補**: 2026-05-15（Airtable 実測結果反映: **2 Base 構成**を確定）  
**対象 repo**: analytics-keiba（正） + 参照: keiba-intelligence  
**現状フェーズ**: 止血完了 → dry-run 基盤稼働 → **本設計書の確定（実会員READ前の最終仕様固め）**

---

## 0. Airtable Base 構成（2026-05-15 実測で確定）

⚠️ **メルマガ配信対象の Airtable Base は 2 つに分離**（共有ではない）。本設計書は当初「同一 Base 共有」を想定していたが、実測で否定された。

| Base | レコード数 | 名前フィールド | プランフィールド | Status 既存値 | 退会フラグ | 期限フィールド |
|---|---|---|---|---|---|---|
| `analytics-keiba` | 1,121 | `名前` | `プラン` | active / pending / cancelled / suspended | `WithdrawalRequested` あり | `有効期限` + `ExpiryDate` |
| `keiba-intelligence` | 32 | `Name` | `PlanType` / `plan_type` / `Plan` | pending / active / cancelled / expired | **なし** | `有効期限` + `ExpirationDate` |

### コード側のフォールバック方針

両 Base を共通コードで扱うため、以下のフォールバック順で読み取る:

| 項目 | フォールバック順（先勝ち） |
|---|---|
| 名前 | `Name` → `名前` |
| プラン | `PlanType` → `plan_type` → `Plan` → `プラン` |
| 期限（analytics-keiba） | `有効期限` → `ExpiryDate` |
| 期限（keiba-intelligence） | `有効期限` → `ExpirationDate` |
| 退会判定 | analytics-keiba: `WithdrawalRequested=true` または `Status='withdrawn'`<br>keiba-intelligence: `Status='withdrawn'` のみ |

### 新規追加フィールドは英語名で統一

両 Base に同じ名前で追加する（`Brand` / `ServiceType` / `AudienceType` / `Unsubscribed*` / `LastNewsletter*`）。日本語の既存フィールドはリネームしない。

### `Status` 統一目標

両 Base で取りうる値を以下9種に統一する:
```
active / pending / cancelled / suspended / expired / unpaid / refunded / withdrawn / test
```

| Base | 既存 | 追加 |
|---|---|---|
| analytics-keiba | active, pending, cancelled, suspended | expired, unpaid, refunded, withdrawn, test |
| keiba-intelligence | pending, active, cancelled, expired | suspended, unpaid, refunded, withdrawn, test |

### `メール配信` / `配信停止日` は両 Base に存在しない

既存 `unsubscribe.js` は両 Base で**サイレント失敗**していた（書き込み先のフィールド自体がない）。新システムでは `UnsubscribedAnalyticsKeiba` / `UnsubscribedKeibaIntelligence` で代替する。既存 `unsubscribe.js` の改修は別タスク。

→ 詳細手順は [NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md](./NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md)、実測根拠は [NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md §0](./NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md#0-airtable-実測結果2026-05-15-取得) を参照。

---

## 1. 現在の状態（2026-05-14 時点）

### 安全状況

| 経路 | ガード | 本番動作確認 |
|---|---|---|
| `cron-email-scheduler`（15分毎） | ✅ | `skipped: true` 確認済 |
| `execute-scheduled-emails` | ✅ | `skipped: true` 確認済 |
| `send-newsletter` | ✅ | `skipped: true` 確認済 |
| `schedule-email` | ✅ | `skipped: true` 確認済 |
| `create-newsletter-queue` | ✅ | `skipped: true` 確認済 |
| `send-newsletter-worker-background` | ✅ | HTTP 202（背景関数仕様。ガードはログのみ） |
| `retry-failed-emails` | ✅ | `skipped: true` 確認済 |

- `NEWSLETTER_AUTOMATION_ENABLED` は本番で **未設定**（`flagValue: null`）
- SendGrid / Airtable / Queue / ScheduledEmails には**一切到達していない**
- `newsletter-preview` は副作用ゼロの dry-run として稼働確認済（モック受信者2名・brand-from検証あり）

### 反映済み commit（origin/main）

```
93cf6f5 ✨ feat(newsletter): 副作用ゼロのdry-run preview基盤を追加
55c37c8 🛡️ feat(newsletter): 全送信系Functionに自動配信停止ガードを追加
```

---

## 2. 今後のメルマガ種別

### A. ステップメール（StepEmail）
- 個人イベント起点（登録日・期限切れ日 等）→ ユーザー個別のタイミング
- 例: 登録直後 / 登録1日後 / 3日後 / 7日後 / 入金確認後 / 期限切れ後 / 申込後未入金 / 一定期間ログインなし

### B. デイリーメルマガ（DailyNewsletter）
- 全対象者へ同一内容を1日1回（または開催日のみ）
- 下記3サブタイプ:

| campaignType | 主旨 | brand | 想定頻度 |
|---|---|---|---|
| `daily-main-race-nankan` | 南関メインレース案内 | analytics-keiba | 南関開催日 |
| `daily-main-race-jra` | JRA メインレース案内 | analytics-keiba / keiba-intelligence | JRA 開催日 |
| `daily-grade-race-jra` | JRA 重賞単発案内 | analytics-keiba / keiba-intelligence | 重賞日のみ |

### C. キャンペーンメルマガ（Campaign）
- 訴求型・期間性あり
- 例: `promo` / `winback` / `premium-upgrade` / `annual-plan` / `lifetime-plan` / `feature-release`
- 同一キャンペーンを期間内に複数回打つ場合は `CampaignId` を世代化（例: `winback-2026-W20`, `-W21`）

---

## 3. ブランド別配信ルール

### ホワイトリスト（コード上で強制）

| brand | 許可 fromEmail ドメイン | デフォルト fromEmail | デフォルト fromName |
|---|---|---|---|
| `analytics-keiba` | `keiba.link` | `analytics@keiba.link` | `KEIBA Analytics` |
| `keiba-intelligence` | `keiba-intelligence.jp`, `em8410.keiba-intelligence.jp` | `newsletter@em8410.keiba-intelligence.jp` | `競馬インテリジェンス` |

### バリデーションルール

- `validateBrandFromEmail(brand, fromEmail)` を **dry-run / test / production すべてで必ず通す**
- 不正な組み合わせは 400 で弾く（`/.netlify/functions/newsletter-preview` で本番確認済）
- 例:
  - ❌ `brand=analytics-keiba` + `fromEmail=newsletter@em8410.keiba-intelligence.jp` → reject
  - ❌ `brand=keiba-intelligence` + `fromEmail=analytics@keiba.link` → reject
  - ❌ 未知の brand → reject

### 同一アドレス両ブランド共存

- 同じ `recipientEmail` が両サービスに登録している場合、**`brand` 違いで別配信扱い**とする（deliveryKey に brand を含めるため自然分離）
- `Customers.Brand` を **Multi-select** にして両方フラグを持てるようにする
- 配信停止も brand 別（[11章](#11-配信停止設計) 参照）

### SendGrid Sender Authentication

- keiba-intelligence は `em8410.keiba-intelligence.jp` で Domain Authentication 済（既存稼働）
- analytics-keiba は `keiba.link` の Sender Auth 状況を **手動確認必須**
  - 確定後、`NEWSLETTER_FROM_ANALYTICS_KEIBA` 環境変数で fromEmail 最終値を設定
  - 未確認なら `analytics@keiba.link` でも届かない可能性 → test モード前に必ず SendGrid 管理画面で確認

---

## 4. Customers テーブル拡張案

⚠️ **2026-05-15 改訂**: 本章は 2 Base 構成（[§0](#0-airtable-base-構成2026-05-15-実測で確定)）を前提に書き直し。両 Base に同じ新規フィールドを追加し、`Status` は Base 別の追加リストで運用する。実行手順詳細は [NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md](./NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md) を参照。

### 現状（実測 2026-05-15）

詳細は [§0](#0-airtable-base-構成2026-05-15-実測で確定) 参照。要点:
- analytics-keiba: `Email` / `名前` / `プラン` / `Status`(active/pending/cancelled/suspended) / `WithdrawalRequested` / `有効期限` / `ExpiryDate`
- keiba-intelligence: `Email` / `Name` / `PlanType` / `plan_type` / `Plan` / `Status`(pending/active/cancelled/expired) / `有効期限` / `ExpirationDate`
- 両 Base とも `メール配信` / `配信停止日` は**存在しない**

### 追加フィールド案（両 Base 共通・**英語名で統一**）

| フィールド | 型 | 必須 | 操作 | 説明 |
|---|---|---|---|---|
| `Brand` | Multi-select | ✅ | **新規** | `analytics-keiba`, `keiba-intelligence` の片方または両方 |
| `ServiceType` | Multi-select | ✅ | **新規** | 当面は Brand と同一値（将来分離用） |
| `AudienceType` | Single select | ✅ | **新規** | `free` / `light` / `standard` / `premium` / `premium-combo` / `expired` / `unpaid` / `admin-test` |
| `Status` | Single select | ✅ | **既存・選択肢追加** | Base 別に [§0](#0-airtable-base-構成2026-05-15-実測で確定) の追加リストで運用 |
| `UnsubscribedAnalyticsKeiba` | Checkbox | ✅ | **新規** | デフォルト false |
| `UnsubscribedKeibaIntelligence` | Checkbox | ✅ | **新規** | デフォルト false |
| `UnsubscribedAtAnalyticsKeiba` | Datetime | ❌ | **新規** | 停止日時 |
| `UnsubscribedAtKeibaIntelligence` | Datetime | ❌ | **新規** | 停止日時 |
| `LastNewsletterSentAt` | Datetime | ❌ | **新規** | 直近メルマガ送信日時 |
| `LastNewsletterBrand` | Single select | ❌ | **新規** | `analytics-keiba` / `keiba-intelligence` |

→ 既存フィールド（`Email` / `名前` / `Name` / `プラン` / `PlanType` / `plan_type` / `Plan` / `有効期限` / `ExpiryDate` / `ExpirationDate` / `WithdrawalRequested` 等）は**リネームせず温存**。コード側でフォールバックする。

### 既存フィールドとの整合（Base 別）

- **analytics-keiba**:
  - `WithdrawalRequested=true` → `Status='withdrawn'` に統合（次タスクの遡及スクリプト）
  - `プラン` の値 → `AudienceType` に正規化マッピング
  - `有効期限` / `ExpiryDate` は当面温存、コード側で fallback
- **keiba-intelligence**:
  - 退会は `Status='withdrawn'` 一本（`WithdrawalRequested` フィールドが存在しない）
  - `PlanType` / `plan_type` / `Plan` の値 → `AudienceType` に正規化マッピング
  - `有効期限` / `ExpirationDate` は当面温存、コード側で fallback

どちらも **READ ONLY 移行 → ダブルライト → 半年様子見 → 旧フィールド廃止** の手順を取る。

### マイグレーション方針

1. **手動で両 Base に同じ9個の新規フィールドを追加**（[NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md](./NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md) に従う）
2. **両 Base の既存 `Status` に Base 別の5選択肢を追加**（既存値削除禁止）
3. **遡及付与スクリプト**（READ ONLY 集計 → 別途UPDATE案を出力するのみ、自動実行しない）:
   - SendGrid `registered_analytics='true'` → analytics-keiba Base の該当 Customer の `Brand += 'analytics-keiba'`
   - SendGrid `registered_intelligence='true'` → keiba-intelligence Base の該当 Customer の `Brand += 'keiba-intelligence'`
   - analytics-keiba: `WithdrawalRequested=true` → `Status='withdrawn'` 案
4. 出力 CSV を**人間レビュー後に手動で各 Base に手動インポート**
5. 新規登録は `register-free.js` / `verify-magic-link.js` で最初から付与する仕様変更（別タスク、Base ごとに routing）

---

## 5. Campaigns テーブル設計

**役割**: メルマガ配信1回分のメタデータ（dry-run も含む全モード共通）

### フィールド一覧

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `CampaignId` | Single text (unique) | ✅ | `<brand>:<campaignType>:<YYYY-MM-DD>:<extraKey8>`（例: `analytics-keiba:daily-main-race-nankan:2026-05-14:kaw11`） |
| `CampaignName` | Single text | ✅ | 人間用ラベル |
| `CampaignType` | Single select | ✅ | `step-*` / `daily-*` / `promo` / `winback` / `premium-upgrade` / `annual-plan` / `lifetime-plan` / `feature-release` |
| `Brand` | Single select | ✅ | `analytics-keiba` / `keiba-intelligence` |
| `ServiceType` | Single select | ✅ | 当面 Brand と同一値 |
| `AudienceType` | Single select | ✅ | Customers.AudienceType と同じ値域 + `admin-test` |
| `AudienceSegmentId` | Link → AudienceSegments | ❌ | 詳細セグメント |
| `CampaignDate` | Date (JST) | ✅ | 代表日 |
| `TargetRaceId` | Single text | ❌ | daily-* のみ。例: `nankan:2026-05-14:大井:R11` |
| `RaceName` / `Venue` / `RaceNumber` / `Grade` / `PostTime` | text/number/text | ❌ | daily-* のみ |
| `FromEmail` | Email | ✅ | `validateBrandFromEmail` 検証済 |
| `FromName` | Single text | ✅ | |
| `Subject` | Single text | ✅ | |
| `ContentHash` | Single text | ✅ | sha256(subject + '\n\n' + bodyHtml) |
| `ContentPreview` | Long text | ✅ | bodyHtml の先頭 2000 字 |
| `Mode` | Single select | ✅ | `dry-run` / `test` / `production` |
| `Status` | Single select | ✅ | `draft` / `previewed` / `approved` / `queued` / `sending` / `completed` / `paused` / `aborted` |
| `TotalRecipients` | Number | ✅ | 0 初期値 |
| `SentSuccess` / `SentFailed` | Number | ✅ | 0 初期値 |
| `Trigger` | Single text | ✅ | `manual:<adminId>` / `cron:morning` / `dispatch:prediction-updated` |
| `AutomationEnabledAtCreation` | Checkbox | ✅ | 作成時の `NEWSLETTER_AUTOMATION_ENABLED` 値（監査用） |
| `LockOwner` | Single text | ❌ | worker LeaseId |
| `LockedAt` | Datetime | ❌ | リース開始 |
| `CreatedAt` / `ApprovedAt` / `QueuedAt` / `CompletedAt` | Datetime | | |
| `Notes` | Long text | ❌ | dry-run 時のサンプル受信者・除外内訳など |

### Status 遷移

```
draft ──preview実行──▶ previewed ──手動approve──▶ approved ──worker起動──▶ queued ──▶ sending ──▶ completed
                                                                            │           │
                                                                          paused      paused
                                                                            │           │
                                                                         aborted     aborted
```

### 重複防止

- `CampaignId` を unique にして同 ID 二重作成を防ぐ
- production worker は `Status=approved AND Mode=production` のみ pick
- `LockOwner` / `LockedAt` で worker 二重起動防止（リース10分）

---

## 6. CampaignDeliveries テーブル設計

**役割**: 受信者1人=1レコードの配信ログ（dry-run も含む）

### フィールド一覧

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `DeliveryKey` | Single text (unique, Duplicate不可) | ✅ | sha256（[10章](#10-deliverykey-設計) 参照） |
| `CampaignId` | Link → Campaigns | ✅ | |
| `Brand` | Single select | ✅ | Campaign と同じ |
| `ServiceType` | Single select | ✅ | |
| `RecipientEmail` | Email (lowercase) | ✅ | |
| `RecipientName` | Single text | ❌ | |
| `AudienceType` | Single select | ✅ | |
| `FromEmail` / `FromName` | Email / text | ✅ | Campaign と同じ |
| `Status` | Single select | ✅ | `queued` / `sent` / `failed` / `skipped-blacklist` / `skipped-unsubscribed` / `skipped-expired` / `skipped-brand-mismatch` / `skipped-other` |
| `SentAt` | Datetime | ❌ | |
| `SendgridMessageId` | Single text | ❌ | |
| `LastError` | Long text | ❌ | |
| `ClaimedAt` / `ClaimedBy` | Datetime / text | ❌ | リース（worker 単位の二重送信防止） |

### 重複防止（最重要）

- **`DeliveryKey` フィールドで Duplicate records are not allowed 必須**
- `performUpsert` API + `fieldsToMergeOn: ['DeliveryKey']` で構造的に二重送信を防ぐ
- 同じキャンペーンを何度再投入しても、同一受信者には1レコードしか作られない

### Status 遷移

```
queued ──worker送信──▶ sent
   │
   ├──ブラックリスト──▶ skipped-blacklist
   ├──配信停止──────▶ skipped-unsubscribed
   ├──期限切れ──────▶ skipped-expired
   ├──ブランド不一致──▶ skipped-brand-mismatch
   └──SendGrid失敗──▶ failed ──retry──▶ queued
```

---

## 7. StepEmail* テーブル設計

### 7.1 StepEmailSequences（シーケンス定義）

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `StepSequenceId` | Single text (unique) | ✅ | 例: `analytics-keiba:signup-onboarding` |
| `Brand` / `ServiceType` | Single select | ✅ | |
| `SequenceName` | Single text | ✅ | 人間用ラベル |
| `TriggerType` | Single select | ✅ | `signup` / `payment-confirmed` / `expired` / `inactive-7d` / `unpaid-3d` |
| `IsActive` | Checkbox | ✅ | |
| `Description` | Long text | ❌ | |

### 7.2 StepEmailSteps（各ステップ）

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `StepId` | Single text (unique) | ✅ | `<sequenceId>:step-<n>` |
| `StepSequenceId` | Link → StepEmailSequences | ✅ | |
| `StepNumber` | Number | ✅ | 1, 2, 3, ... |
| `DelayDays` / `DelayHours` | Number | ✅ | EnrolledAt + delay = SendAt |
| `SubjectTemplate` | Single text | ✅ | `{{firstName}}` 等の placeholder |
| `BodyTemplate` | Long text | ✅ | |
| `CampaignType` | Single text | ✅ | `step-signup-d1` 等の固定命名 |
| `FromEmail` / `FromName` | Email / text | ❌ | 未指定なら brand-config のデフォルト |
| `IsActive` | Checkbox | ✅ | |

### 7.3 StepEnrollments（ユーザー登録状態）

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `EnrollmentId` | Single text (unique) | ✅ | uuid v4 |
| `StepSequenceId` | Link → StepEmailSequences | ✅ | |
| `Brand` / `ServiceType` | Single select | ✅ | |
| `RecipientEmail` | Email (lowercase) | ✅ | |
| `EnrolledAt` | Datetime | ✅ | トリガー発火時刻 |
| `TriggerType` | Single select | ✅ | |
| `CurrentStepNumber` | Number | ✅ | 次に送るステップ番号（初期 1） |
| `Status` | Single select | ✅ | `active` / `completed` / `unsubscribed` / `paused` / `removed` |
| `LastSentAt` | Datetime | ❌ | |
| `Metadata` | Long text (JSON) | ❌ | `{ "planType": "...", "expiryDate": "..." }` |

### Cron 起動フロー

```
毎時0分: GitHub Actions workflow `collect-due-step-emails`
 → StepEnrollments を Brand × Sequence で走査
 → EnrolledAt + delay <= now() AND CurrentStepNumber == step.StepNumber AND Status=active
 → 各 enrollment ごとに Campaign（CampaignType=step-*）を生成し、CampaignDeliveries に1件作成
 → mode別に dry-run / test / production
 → 送信完了後、CurrentStepNumber++ と LastSentAt 更新（atomic）
```

---

## 8. NewsletterTemplates 設計

**役割**: daily / campaign 用の subject + body テンプレ（ステップは StepEmailSteps を使うので除く）

### フィールド一覧

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `TemplateId` | Single text (unique) | ✅ | 例: `analytics-keiba:daily-main-race-nankan:v1` |
| `Brand` / `ServiceType` | Single select | ✅ | |
| `CampaignType` | Single text | ✅ | `daily-main-race-nankan` / `daily-main-race-jra` / `daily-grade-race-jra` / `step-signup` / `step-expired` / `campaign-promo` / ... |
| `TemplateName` | Single text | ✅ | |
| `SubjectTemplate` | Single text | ✅ | placeholder 含む |
| `BodyTemplate` | Long text | ✅ | placeholder 含む |
| `FromEmail` / `FromName` | Email / text | ❌ | デフォルト値（Campaign 側で上書き可） |
| `IsActive` | Checkbox | ✅ | |
| `Notes` | Long text | ❌ | |

### Placeholder 仕様（提案）

`{{venue}}`, `{{raceNumber}}`, `{{raceName}}`, `{{grade}}`, `{{postTime}}`, `{{dateLabel}}`, `{{brandLabel}}` 等。  
Handlebars 風のシンプル置換で十分。複雑なロジック（条件分岐 / ループ）はテンプレ側ではなくコード側のrender関数で処理。

### 既存 render-daily-main-race.js との関係

- 初期は **コード内 render 関数のみで運用**（Airtable Templates テーブル不使用）
- テンプレ管理を admin UI に出したくなったら、Templates テーブルから読んで render 関数に渡す形に拡張

---

## 9. AudienceSegments 設計

**役割**: 配信対象セグメントの定義（Airtable Customers 側へのクエリ条件を JSON で持つ）

### フィールド一覧

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `SegmentId` | Single text (unique) | ✅ | 例: `analytics-keiba:active-premium` |
| `Brand` / `ServiceType` | Single select | ✅ | |
| `SegmentName` | Single text | ✅ | 人間用ラベル |
| `ConditionsJson` | Long text | ✅ | 含める条件 |
| `ExclusionsJson` | Long text | ✅ | 除外条件 |
| `Description` | Long text | ❌ | |

### 標準セグメント（提案）

| SegmentId | 内容 |
|---|---|
| `analytics-keiba:all-active` | Brand contains analytics-keiba AND Status=active AND Unsubscribed*=false |
| `analytics-keiba:free` | 上記 + AudienceType=free |
| `analytics-keiba:paid` | 上記 + AudienceType IN (standard, premium, premium-sanrenpuku, premium-combo, premium-plus) |
| `analytics-keiba:premium-all` | 上記 + AudienceType LIKE 'premium*' |
| `analytics-keiba:expired` | 上記 + Status=expired |
| `analytics-keiba:unpaid` | 上記 + PaymentStatus=pending |
| `analytics-keiba:inactive-30d` | 上記 + LastLoginAt < now()-30d |
| `keiba-intelligence:all-active` | Brand contains keiba-intelligence AND Status=active AND Unsubscribed*=false |
| `keiba-intelligence:free` | 上記 + AudienceType=free |
| ... | 以下同様 |

### ExclusionsJson 共通項目

- `Customers.UnsubscribedAnalyticsKeiba=true`（brand=analytics-keiba の場合）
- `Customers.UnsubscribedKeibaIntelligence=true`（brand=keiba-intelligence の場合）
- `EmailBlacklist` に存在
- `Customers.Status IN ('bounced', 'blacklisted', 'withdrawn')`
- 直近24時間以内に**同ブランドの他キャンペーン**を受け取っている（cooldown、キャンペーン系のみ）

---

## 10. deliveryKey 設計

### 正式定義

```
deliveryKey = sha256(
  [
    brand,                  // 'analytics-keiba' | 'keiba-intelligence'
    serviceType,            // 当面 brand と同じ
    campaignType,           // 'daily-main-race-nankan' | 'step-signup-d1' | 'promo-winback-2026-W20' ...
    campaignDate,           // 'YYYY-MM-DD' (JST)
    audienceType,           // 'free' | 'standard' | 'premium' | 'expired' | 'admin-test' ...
    recipientEmail.toLowerCase().trim(),
    contentHash,            // sha256(subject + '\n\n' + bodyHtml)
    fromEmail.toLowerCase().trim(),
    extraKey                // 'race:nankan:2026-05-14:大井:R11' / 'step:<sequenceId>:<n>' / 'cmp:<campaignId>' / ''
  ].join('|')
)
```

### 既存実装

`astro-site/src/lib/newsletter/delivery-key.js` の `computeDeliveryKey()` で実装済（dry-run preview で稼働確認済）。

### 設計理由

| 構成要素 | 入れる理由 |
|---|---|
| `brand` | 同一アドレスでも別ブランドは別配信扱い（keiba-intelligence と analytics-keiba は別契約） |
| `serviceType` | 将来サービスを分離したとき互換性を保つため |
| `campaignType` | 同日に daily と step が重なっても別配信 |
| `campaignDate` | 翌日に同 audience で再送できる |
| `audienceType` | free/paid で同人に別配信できる |
| `recipientEmail` | 受信者単位の冪等性 |
| `contentHash` | 文面修正後の再送は自然と別配信扱い |
| `fromEmail` | 誤送信元差し替え時の事故吸収（誤組合せ自体は validate で先に弾く） |
| `extraKey` | 同日同 campaignType を複数回打つケースに対応（重賞複数 / 朝発昼発） |

### CampaignDeliveries Key の運用

- Airtable `CampaignDeliveries.DeliveryKey` を **unique** 制約
- `performUpsert { fieldsToMergeOn: ['DeliveryKey'] }` で投入
- → 同一 key の二度目以降は upsert（更新のみ）になり、二重 row が物理的に生成されない

---

## 11. 配信停止設計

### 基本方針: **ブランド別停止**

| ユーザー操作 | analytics-keiba 停止 | keiba-intelligence 停止 |
|---|---|---|
| analytics-keiba のメール内 unsubscribe リンク | ✅ | ❌（影響なし） |
| keiba-intelligence のメール内 unsubscribe リンク | ❌（影響なし） | ✅ |
| 両方一括停止リクエスト（サポート問い合わせ等） | ✅ | ✅ |

### 実装

- `Customers.UnsubscribedAnalyticsKeiba` / `Customers.UnsubscribedKeibaIntelligence` の **2つの独立Checkbox**
- それぞれ `UnsubscribedAt*` の日時を保持
- 配信時のフィルタ: `brand=X` のキャンペーンは `Customers.Unsubscribed<Brand>=false` のみ対象
- `EmailBlacklist`（既存）は両ブランド共通の最終フィルタ（ハードバウンス / スパム報告）

### 既存 `unsubscribe.js` との整合

| 項目 | 現状 | 新仕様 |
|---|---|---|
| エンドポイント | `/.netlify/functions/unsubscribe?email=...` | 同左 + `&brand=analytics-keiba` を必須化 |
| Customers 更新 | `WithdrawalRequested=true`（粗い） | `Unsubscribed<Brand>=true, UnsubscribedAt<Brand>=now()` |
| SendGrid 側 | List-Unsubscribe ヘッダ経由 | List-Unsubscribe URL に brand を付与 |

→ **既存 unsubscribe.js を改修する必要あり**（本設計書時点では未着手、別タスク）。  
改修順序: (a) ブランド別フィールド追加 → (b) unsubscribe.js を brand 必須化 → (c) メール本文の List-Unsubscribe URL に brand 付与

### 配信時の除外フロー

```
audience 抽出 (AudienceSegment)
  ↓
Customers.Unsubscribed<Brand>=true を除外
  ↓
EmailBlacklist にあるアドレスを除外
  ↓
Customers.Status IN ('bounced','blacklisted','withdrawn') を除外
  ↓
Customers.Status='expired' は AudienceType=expired のキャンペーンのみ通す
  ↓
CampaignDeliveries に performUpsert
```

各段階で除外件数を集計し、Campaigns.Notes に保存（admin が後で内訳確認できる）。

---

## 12. 実装順序

**1ステップずつ commit を分け、各ステップは前ステップが本番で動作確認できてから次へ進む**。

| # | ステップ | 副作用 | 完了条件 |
|---|---|---|---|
| **a** | Airtable設計書（本書）作成 | なし | 本書 commit & レビュー承認 |
| **b** | Customers の `Brand` / `Unsubscribed*` / `Status` 列を **手動で Airtable に追加** | 既存レコードに影響なし（新規列、既存値は NULL/false） | Airtable 上で列追加確認 |
| **c** | 既存顧客の Brand 遡及付与スクリプト（READ ONLY → CSV 出力） | Airtable WRITE なし | CSV 確認 → 人間レビュー → 手動インポート |
| **d** | `newsletter-preview` に Airtable READ オプションを追加（`audienceMode: "real-count-only"`） | Airtable READ のみ、WRITE なし、SendGrid なし | 本番 curl で実会員カウントだけ返ることを確認 |
| **e** | `Campaigns` / `CampaignDeliveries` テーブルを **手動で Airtable に作成** | 既存テーブル影響なし | Airtable 上で2テーブル存在確認 |
| **f** | `newsletter-preview` に **WRITE オプション**を追加（Campaigns に `Mode=dry-run, Status=previewed` で1レコード作成、CampaignDeliveries は作らない） | Campaigns WRITE のみ、Deliveries / SendGrid なし | dry-run 結果が Airtable に1行残ることを確認 |
| **g** | `newsletter-preview` を CampaignDeliveries まで投入（`Mode=dry-run, Status=queued`、SendGrid呼ばない） | Campaigns + Deliveries WRITE のみ、SendGrid なし | deliveryKey 重複排除が機能することを確認 |
| **h** | `newsletter-send-test`（新規Function）: `NEWSLETTER_TEST_RECIPIENTS` 宛のみ SendGrid 送信 | SendGrid 呼ぶ（管理者宛のみ） | テスト宛に1通届くこと、Deliveries に sent 記録 |
| **i** | `newsletter-worker`（新規 background Function）: `Status=approved AND Mode=production AND NEWSLETTER_AUTOMATION_ENABLED=true` のみ pick | 設計上 production 動作するが、フラグ立てない限り no-op | フラグ立てずに 202 確認のみ |
| **j** | admin UI（`/admin/newsletter/new`, `/admin/newsletter/preview/[id]` 等） | フロントエンドのみ、API は (d)〜(i) を呼ぶ | dry-run と test 操作が UI からできること |
| **k** | Step / Daily / Campaign 各種テンプレ追加（`daily-main-race-jra`, `keiba-intelligence` brand 等） | render 関数の純粋追加、副作用なし | 各種 dry-run preview が通ること |
| **l** | StepEnrollments + cron 起動 | 単独 dry-run 確認のみ、production 配信なし | dry-run で enrollment が due 判定されること |
| **m** | **production 有効化検討（最終段階・別タスクで再評価）** | フラグ立てると本番送信開始 | 別途レビュー会で判断 |

各ステップで実装する Function / テーブル / md は **必ず 1 PR / 1 commit** とし、ロールバック可能性を確保する。

### 重要マイルストーン
- (d) 完了時点: 「実会員数は数えられるが、Airtable には何も書かない / SendGrid も呼ばない」状態
- (g) 完了時点: 「全自動化に必要なデータが Airtable に揃うが、送信は一切しない」状態
- (h) 完了時点: 「管理者宛 test だけ届く」状態
- (m) 検討時点: 全データ・全機能が揃っており、フラグ1個で production 開始可能

---

## 13. 禁止事項（再掲・本設計フェーズ中ずっと有効）

- ❌ **本番送信しない**
- ❌ **SendGrid API 呼び出ししない**（test モード実装まで全工程禁止）
- ❌ **Airtable 既存レコードを変更しない**（既存 `ScheduledEmails` / `NewsletterJobs` / `NewsletterQueue` / `Customers` の既存列）
- ❌ **`NEWSLETTER_AUTOMATION_ENABLED=true` にしない**
- ❌ **既存7関数のガードを外さない**
- ❌ **nankan-analytics 側を触らない**
- ❌ **本書のスコープ外（例: keiba-intelligence の bank-transfer フロー）を変更しない**

例外的に許可される操作:
- ✅ Airtable に **新規テーブル / 新規列を追加**（既存データに影響しない）
- ✅ Airtable READ（次ステップ d 以降）
- ✅ 副作用ゼロの新規 Function 追加
- ✅ ドキュメント追加

---

## 付録 A. 既存資産と本設計の対応

| 既存 | 本設計での扱い |
|---|---|
| `astro-site/src/lib/newsletter/brand-config.js` | そのまま使用（ブランド検証コア） |
| `astro-site/src/lib/newsletter/content-hash.js` | そのまま使用 |
| `astro-site/src/lib/newsletter/delivery-key.js` | そのまま使用（[10章](#10-deliverykey-設計) の根拠） |
| `astro-site/src/lib/newsletter/render-daily-main-race.js` | 拡張（`daily-main-race-jra` / `daily-grade-race-jra` も追加していく） |
| `astro-site/netlify/functions/newsletter-preview.js` | 拡張（実 Airtable READ を `audienceMode` で切替可能に） |
| 旧 `ScheduledEmails` / `NewsletterJobs` / `NewsletterQueue` | 凍結（参照しない・書き込まない）。残った PENDING/EXECUTING は別タスクで手動 `Status=CANCELED` |
| 旧 `send-newsletter.js` 系7関数 | ガード維持。新システムが稼働確認できたら削除（最終段階） |
| `EmailBlacklist` + `sendgrid-webhook.js` | 継続使用 |

## 付録 B. 用語集

| 用語 | 意味 |
|---|---|
| **brand** | サービスブランドの識別子（`analytics-keiba` / `keiba-intelligence`）。fromEmail のドメイン許可と直結 |
| **serviceType** | brand と同義（将来分離余地） |
| **audienceType** | 顧客の属性（`free` / `standard` / `premium-*` / `expired` / `admin-test`） |
| **campaignType** | メルマガの種別（`daily-*` / `step-*` / `promo` 等） |
| **deliveryKey** | 受信者単位の二重送信防止 idempotency key（sha256） |
| **contentHash** | subject + bodyHtml の sha256 |
| **dry-run** | SendGrid を呼ばず、対象抽出・本文生成・key 計算のみ行うモード |
| **test** | `NEWSLETTER_TEST_RECIPIENTS` 宛のみ SendGrid 送信するモード |
| **production** | 実 audience へ SendGrid 送信するモード（要 `NEWSLETTER_AUTOMATION_ENABLED=true`） |

## 付録 C. 参照

- 設計レポート: 本書作成のための初版設計（チャット履歴に保存）
- 既存ガード実装: `astro-site/netlify/functions/{cron-email-scheduler,execute-scheduled-emails,send-newsletter,schedule-email,create-newsletter-queue,send-newsletter-worker-background,retry-failed-emails}.js`
- 既存 dry-run 基盤: `astro-site/netlify/functions/newsletter-preview.js`, `astro-site/src/lib/newsletter/*.js`
- 使い方: `astro-site/docs/NEWSLETTER_PREVIEW_USAGE.md`
- 旧 Queue 設計: `astro-site/AIRTABLE_NEWSLETTER_SETUP.md`（凍結扱い、参照のみ）
