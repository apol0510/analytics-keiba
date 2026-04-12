# Airtableメルマガ配信システム テーブル設計書

## 📋 概要

Queue方式メルマガ配信システムのAirtableテーブル設計書です。
PayPal Webhook Phase 7の冪等性設計を応用した、16,000件以上の大量配信に対応したシステムです。

**専門家推奨修正版（2026-01-12）:**
- ✅ 10件バッチ更新でAirtable 5rps制限対策
- ✅ performUpsertで重複Queue投入防止
- ✅ LeaseId二重起動ガード実装
- ✅ Background Functions対応

---

## 🗂️ テーブル1: NewsletterJobs

**役割:** メルマガ配信ジョブの管理テーブル（メタデータ）

### フィールド一覧

| フィールド名 | 型 | 必須 | 説明 |
|------------|-----|------|------|
| JobId | Single line text | ✅ | ジョブID（例: JOB-2026-01-12-001）★重複不可★ |
| Subject | Single line text | ✅ | メール件名 |
| Content | Long text | ✅ | メール本文（HTML可） |
| TemplateId | Single line text | ❌ | テンプレートID（将来拡張用） |
| TargetPlan | Single select | ✅ | 配信対象プラン |
| Status | Single select | ✅ | ジョブステータス |
| TotalRecipients | Number | ✅ | 総配信数（Queue生成時に確定） |
| SentSuccess | Number | ✅ | 送信成功数（デフォルト: 0） |
| SentFailed | Number | ✅ | 送信失敗数（デフォルト: 0） |
| CreatedAt | Date | ✅ | ジョブ作成日時（ISO 8601形式） |
| QueuedAt | Date | ❌ | Queue生成完了日時 |
| CompletedAt | Date | ❌ | 配信完了日時 |

### TargetPlan選択肢
- `ALL` - 全顧客（退会者除く）
- `Standard` - Standard会員のみ
- `Premium` - Premium会員のみ
- `Premium Sanrenpuku` - Premium Sanrenpuku会員のみ
- `Premium Combo` - Premium Combo会員のみ

### Status選択肢
- `draft` - 下書き（Queue生成前）
- `queued` - Queue生成完了（送信待ち）
- `sending` - 送信中
- `completed` - 配信完了
- `paused` - 一時停止
- `failed` - 失敗

### Status遷移フロー
```
draft → queued → sending → completed
              ↓          ↓
            paused    failed
```

---

## 🗂️ テーブル2: NewsletterQueue

**役割:** メール送信キュー（受信者単位の配信管理）

### フィールド一覧

| フィールド名 | 型 | 必須 | 説明 |
|------------|-----|------|------|
| Key | Single line text | ✅ | 🔧 専門家推奨: `JobId:lowercase(email)` 形式★重複不可★ |
| JobId | Link to another record | ✅ | NewsletterJobsへのリンク |
| Email | Email | ✅ | 配信先メールアドレス |
| Status | Single select | ✅ | 配信ステータス |
| SentAt | Date | ❌ | 送信完了日時（ISO 8601形式） |
| LastError | Long text | ❌ | エラーメッセージ（最大500文字） |
| RetryCount | Number | ✅ | 再送回数（デフォルト: 0） |
| ClaimedAt | Date | ❌ | 🔧 専門家推奨: ワーカーが取り込んだ日時（LeaseId用） |
| ClaimedBy | Single line text | ❌ | 🔧 専門家推奨: ワーカーLeaseId（二重起動ガード） |

### Status選択肢
- `pending` - 送信待ち
- `sending` - 送信中（Deprecated: 使用しない）
- `success` - 送信成功
- `failed` - 送信失敗

### Status遷移フロー
```
pending → success
   ↓
 failed → pending（retry-failed-emails.jsで再送設定）
```

### 🔧 専門家推奨: Keyフィールドの重要性

**❌ 従来の問題:**
- Formula型Keyフィールド（`{JobId} & ":" & LOWER({Email})`）は重複を防げない
- POSTで複数回実行すると同じ顧客に重複Queue投入される

**✅ 修正後（本実装）:**
- **Single line text型**のKeyフィールド
- コード側で `jobId:lowercase(email)` を手動生成
- **performUpsert API** 使用（`fieldsToMergeOn: ["Key"]`）
- 同じKeyのレコードが既にある場合は更新、なければ新規作成
- → 重複Queue投入が構造的に不可能

### 🔧 専門家推奨: ClaimedAt/ClaimedByの役割

**問題:** 複数のワーカーが同時実行された場合、同じ`pending`レコードを取得してしまう

**解決策（見かけ上のロック）:**
1. ワーカーは `Status=pending AND (ClaimedAt=BLANK OR ClaimedAt<15分前)` のみ取得
2. 取得後、**即座に** ClaimedAt=現在時刻、ClaimedBy=LeaseId で更新
3. 他のワーカーは「15分以内にClaimされたレコード」をスキップ
4. 送信完了後、ClaimedAtをnullに戻す

**メリット:**
- Airtableに「原子的ロック」機能はないが、見かけ上のロックで二重起動を防ぐ
- タイムアウトしたワーカーのレコードも15分後に自動解放

---

## 🚀 セットアップ手順

### 1. NewsletterJobsテーブル作成

1. Airtableで新規テーブル「NewsletterJobs」作成
2. 以下のフィールドを追加:
   - JobId (Single line text)
   - Subject (Single line text)
   - Content (Long text)
   - TemplateId (Single line text)
   - TargetPlan (Single select: ALL, Standard, Premium, Premium Sanrenpuku, Premium Combo)
   - Status (Single select: draft, queued, sending, completed, paused, failed)
   - TotalRecipients (Number, デフォルト: 0)
   - SentSuccess (Number, デフォルト: 0)
   - SentFailed (Number, デフォルト: 0)
   - CreatedAt (Date, ISO 8601)
   - QueuedAt (Date, ISO 8601)
   - CompletedAt (Date, ISO 8601)

### 2. NewsletterQueueテーブル作成

1. Airtableで新規テーブル「NewsletterQueue」作成
2. 以下のフィールドを追加:
   - **Key (Single line text)** ← ⚠️ Formula型ではない！
   - JobId (Link to another record → NewsletterJobs)
   - Email (Email)
   - Status (Single select: pending, sending, success, failed)
   - SentAt (Date, ISO 8601)
   - LastError (Long text)
   - RetryCount (Number, デフォルト: 0)
   - **ClaimedAt (Date, ISO 8601)** ← 🔧 専門家推奨（二重起動ガード）
   - **ClaimedBy (Single line text)** ← 🔧 専門家推奨（LeaseId記録）

### 3. 重複不可設定（重要）

1. **JobIdフィールド**（NewsletterJobs）:
   - フィールド設定 → 「Duplicate records are not allowed」にチェック

2. **Keyフィールド**（NewsletterQueue）:
   - フィールド設定 → 「Duplicate records are not allowed」にチェック

### 4. デフォルト値設定

- TotalRecipients: 0
- SentSuccess: 0
- SentFailed: 0
- RetryCount: 0
- Status（NewsletterJobs）: draft
- Status（NewsletterQueue）: pending

---

## 📊 データ例

### NewsletterJobs例
```
JobId: JOB-2026-01-12-001
Subject: 【NANKANアナリティクス】1月の無料予想配信開始！
Content: <html>...</html>
TargetPlan: ALL
Status: completed
TotalRecipients: 15756
SentSuccess: 15650
SentFailed: 106
CreatedAt: 2026-01-12T10:00:00.000Z
QueuedAt: 2026-01-12T10:05:23.000Z
CompletedAt: 2026-01-12T10:38:41.000Z
```

### NewsletterQueue例
```
Key: JOB-2026-01-12-001:customer@example.com
JobId: recXXXXXXXXXXXXXX (Link to NewsletterJobs)
Email: customer@example.com
Status: success
SentAt: 2026-01-12T10:12:34.000Z
LastError: (空)
RetryCount: 0
ClaimedAt: (空・送信完了後はnull)
ClaimedBy: (空・送信完了後はnull)
```

### 送信中のレコード例（ClaimedAt/ClaimedBy使用）
```
Key: JOB-2026-01-12-001:pending@example.com
Status: pending
ClaimedAt: 2026-01-12T10:15:22.000Z
ClaimedBy: worker-1736665522-abc123x
RetryCount: 0
```

---

## 🔧 システム動作フロー

### 1. Queue生成（create-newsletter-queue.js）

```javascript
// Step 1: NewsletterJobs作成（Status=draft）
POST /NewsletterJobs
{ JobId, Subject, Content, TargetPlan, Status: 'draft', ... }

// Step 2: Customers取得（スナップショット）
GET /Customers?filterByFormula=...

// Step 3: NewsletterQueueにperformUpsert（10件ずつバッチ）
PATCH /NewsletterQueue
{
  performUpsert: { fieldsToMergeOn: ['Key'] },
  records: [
    { fields: { Key: 'JOB-xxx:email1@example.com', Email: '...', ... }},
    // ... 9件まで
  ]
}

// Step 4: Job.Status='queued'に更新
PATCH /NewsletterJobs/{jobId}
{ Status: 'queued', TotalRecipients: 15756, QueuedAt: '...' }
```

### 2. 送信ワーカー（send-newsletter-worker-background.js）

```javascript
while (残り時間あり) {
  // Step 1: pending AND (ClaimedAt=空 OR ClaimedAt<15分前) 取得（100件）
  GET /NewsletterQueue?filterByFormula=...

  // Step 2: 即座にClaimAt/ClaimedBy更新（10件ずつバッチ）
  PATCH /NewsletterQueue
  { records: [{ id: 'recXXX', fields: { ClaimedAt: 'now', ClaimedBy: 'worker-xxx' }}]}

  // Step 3: SendGrid送信（8通/秒・125ms/通）
  for (record of records) {
    await sendEmail(record.Email);
    results.push({ id: record.id, fields: { Status: 'success', ... }});
  }

  // Step 4: 結果を10件ずつバッチ更新（ClaimedAtをnullに戻す）
  PATCH /NewsletterQueue
  { records: [{ id: 'recXXX', fields: { Status: 'success', ClaimedAt: null, ClaimedBy: null }}]}

  // Step 5: Job集計更新
  PATCH /NewsletterJobs/{jobId}
  { SentSuccess: job.SentSuccess + successCount, SentFailed: job.SentFailed + failedCount }
}

// 完了判定: pendingが0件ならJob.Status='completed'
```

### 3. 失敗分再送（retry-failed-emails.js）

```javascript
// Step 1: failed取得
GET /NewsletterQueue?filterByFormula={Status}='failed'

// Step 2: failed → pending に更新（10件ずつバッチ）
PATCH /NewsletterQueue
{ records: [{ id: 'recXXX', fields: { Status: 'pending', LastError: '' }}]}
```

---

## ⚠️ 重要な注意点

### API制限対策

1. **Airtable API**: 5 requests/second per base
   - 対策: 10件バッチ更新 + 200ms待機
   - 16,000件 → 1,600リクエスト → 320秒（約5分）

2. **SendGrid**: 自主制限 8 emails/second
   - 対策: 125ms/通スロットリング
   - 16,000件 → 2,000秒（約33分）

### Background Functions制限

- **最大実行時間**: 15分
- **対策**: 13分でタイムアウト → 次回実行で続行可能
- **16,000件の配信時間**: 約2〜3回の実行で完了（合計33分）

### 二重起動防止

- **ClaimedAt/ClaimedBy**: 15分のリース期間
- **複数ワーカー実行可能**: 異なるレコードをClaimするため安全
- **タイムアウト対策**: 15分後に自動解放

### 冪等性保証

- **performUpsert**: Keyで重複防止（構造的）
- **ClaimedAt**: 二重送信防止（見かけ上のロック）
- **Status遷移**: pending → success/failed（一方通行）

---

## 📝 修正履歴

### 2026-01-12（専門家推奨修正版）
- ✅ Keyフィールドを Formula → Single line text に変更
- ✅ ClaimedAt/ClaimedByフィールド追加（二重起動ガード）
- ✅ performUpsert実装（重複Queue投入防止）
- ✅ 10件バッチ更新実装（Airtable 5rps対策）
- ✅ Background Functions対応

---

**最終更新日**: 2026-01-12
**バージョン**: v2.0（専門家推奨修正版）
**実装ファイル**:
- `netlify/functions/create-newsletter-queue.js`
- `netlify/functions/send-newsletter-worker-background.js`
- `netlify/functions/retry-failed-emails.js`
- `src/pages/admin/newsletter-status.astro`
