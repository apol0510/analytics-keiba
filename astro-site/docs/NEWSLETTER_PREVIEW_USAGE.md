# Newsletter Preview API（dry-run）

完全自動化メルマガ配信システムの第一段階。  
**dry-run のみ** のプレビュー API。送信は絶対に行わない。

## audienceMode

`audienceMode` リクエストパラメータで挙動を切り替える（既定: `'mock'`）。

| audienceMode | Airtable READ | レスポンス内容 | sideEffects |
|---|---|---|---|
| `mock`（既定） | ❌ 読まない | モック受信者2名固定 | `none` |
| `real-count-only` | ✅ READ-ONLY | 実 Customers の **件数のみ**（PII なし） | `airtable-read-only` |

## 何をするか

- 入力された brand / campaignType / campaignDate / targetRace から、
  - 件名（subject）
  - 本文 HTML（bodyHtml）
  - contentHash（sha256）
  - deliveryKey サンプル（モック受信者2名分、`real-count-only` でもモックのまま）
  - fromEmail / fromName（brand-config から取得）
  - brand と fromEmail の組合せ検証結果
- を JSON で返す。
- `audienceMode='real-count-only'` の場合は加えて、対応 Base の Customers を Airtable GET で読み、
  AudienceType=指定値に該当する件数を返す。

## 何をしないか（重要）

- ❌ SendGrid を呼ばない
- ❌ Airtable WRITE（PATCH/POST/PUT/DELETE）
- ❌ ファイルを書き込まない
- ❌ 既存テーブル（ScheduledEmails / NewsletterJobs / NewsletterQueue / Campaigns / CampaignDeliveries）に一切触らない
- ❌ レスポンスに email / name / AirtableRecordId などの **PII を含めない**（`real-count-only` でも件数のみ）
- ❌ `audienceMode='mock'` では Airtable も読まない

レスポンスには `sideEffects` を `none`（mock）または `airtable-read-only`（real-count-only）として明記する。

## エンドポイント

```
POST /.netlify/functions/newsletter-preview
```

## サポートする campaignType（最小構成）

- `daily-main-race-nankan` のみ

`daily-main-race-jra` / `daily-grade-race-jra` / `step-*` / `promo` / `winback` などは、次のステップ以降で順次追加する。

## サポートする brand

- `analytics-keiba` → fromEmail デフォルト `analytics@keiba.link`（許可ドメイン: `keiba.link`）
- `keiba-intelligence` → fromEmail デフォルト `newsletter@em8410.keiba-intelligence.jp`（許可ドメイン: `keiba-intelligence.jp`, `em8410.keiba-intelligence.jp`）

brand と fromEmail の許可ドメインが一致しない場合、dry-run でも 400 エラーで弾く（誤組合せ事故防止）。

## curl 実行例

### 1. 正常系（analytics-keiba × 川崎11R）

```bash
curl -X POST http://localhost:8888/.netlify/functions/newsletter-preview \
  -H "Content-Type: application/json" \
  -d '{
    "brand": "analytics-keiba",
    "serviceType": "analytics-keiba",
    "campaignType": "daily-main-race-nankan",
    "campaignDate": "2026-05-14",
    "audienceType": "free",
    "targetRace": {
      "raceId": "nankan:2026-05-14:KAW:R11",
      "venue": "川崎",
      "raceNumber": 11,
      "raceName": "メインレース",
      "postTime": "20:10"
    }
  }'
```

### 2. ブランド誤組合せ（必ず弾かれる）

```bash
curl -X POST http://localhost:8888/.netlify/functions/newsletter-preview \
  -H "Content-Type: application/json" \
  -d '{
    "brand": "analytics-keiba",
    "serviceType": "analytics-keiba",
    "campaignType": "daily-main-race-nankan",
    "campaignDate": "2026-05-14",
    "audienceType": "free",
    "fromEmail": "newsletter@em8410.keiba-intelligence.jp",
    "targetRace": { "venue": "川崎", "raceNumber": 11, "raceName": "メイン", "postTime": "20:10" }
  }'
```

→ 400 Bad Request `brand-from validation failed`

### 3. real-count-only（Airtable READ-ONLY で実件数のみ取得）

`AIRTABLE_API_KEY` と `AIRTABLE_BASE_ID_ANALYTICS_KEIBA`（または `AIRTABLE_BASE_ID_KEIBA_INTELLIGENCE`）が
Netlify 環境変数に設定されている必要がある（READ-ONLY スコープの PAT 推奨）。

```bash
curl -X POST http://localhost:8888/.netlify/functions/newsletter-preview \
  -H "Content-Type: application/json" \
  -d '{
    "brand": "analytics-keiba",
    "serviceType": "analytics-keiba",
    "campaignType": "daily-main-race-nankan",
    "campaignDate": "2026-05-14",
    "audienceType": "free",
    "audienceMode": "real-count-only",
    "targetRace": { "raceId": "nankan:2026-05-14:KAW:R11", "venue": "川崎", "raceNumber": 11, "raceName": "メイン", "postTime": "20:10" }
  }'
```

レスポンスの `audience` ブロック（**件数のみ**、PII 一切なし）:

```json
{
  "audience": {
    "source": "airtable-read-only",
    "audienceMode": "real-count-only",
    "brand": "analytics-keiba",
    "base": "analytics-keiba",
    "audienceTypeFilter": "free",
    "today": "2026-05-16",
    "totalCustomers": 1123,
    "matchedCount": 1045,
    "withdrawnExcluded": 37,
    "audienceTypeBreakdown": {
      "free": 1045,
      "premium": 8,
      "expired": 67,
      "unpaid": 2,
      "(null/unknown)": 8
    },
    "matchedStatusBreakdown": { "active": 1043, "pending": 2 },
    "pii": "none-exposed",
    "note": "Emails / names / record ids are not exposed. This is a dry-run count only.",
    "queriedAt": "2026-05-16T12:34:56.789Z"
  }
}
```

`sideEffects` は `"airtable-read-only"` になる（`mock` モードの `"none"` と区別）。

`audienceType` に `"*"` を指定すると AudienceType フィルタを外して全 AudienceType（withdrawn 除く）の合算件数を返す。

## 期待レスポンス例（正常系）

```json
{
  "success": true,
  "mode": "dry-run",
  "sideEffects": "none",
  "campaign": {
    "brand": "analytics-keiba",
    "serviceType": "analytics-keiba",
    "campaignType": "daily-main-race-nankan",
    "campaignDate": "2026-05-14",
    "audienceType": "free",
    "fromEmail": "analytics@keiba.link",
    "fromName": "KEIBA Analytics",
    "targetRace": {
      "raceId": "nankan:2026-05-14:KAW:R11",
      "venue": "川崎",
      "raceNumber": 11,
      "raceName": "メインレース",
      "postTime": "20:10"
    },
    "subject": "【KEIBA Analytics】5/14(木) 川崎11R メインレース の予想を公開",
    "contentHash": "<sha256 hex>",
    "contentPreview": "<!doctype html>...",
    "contentLength": 1234
  },
  "audience": {
    "source": "mock",
    "sampleRecipients": [
      "preview-user-1@example.com",
      "preview-user-2@example.com"
    ],
    "mockRecipientCount": 2,
    "note": "Airtable READ は未実装。次のステップで実会員リストを参照する"
  },
  "deliveryKey": {
    "template": "sha256(brand|serviceType|campaignType|campaignDate|audienceType|recipientEmail(lowercase)|contentHash|fromEmail(lowercase)|extraKey)",
    "extraKey": "race:nankan:2026-05-14:KAW:R11",
    "samples": [
      { "recipientEmail": "preview-user-1@example.com", "deliveryKey": "<sha256 hex>" },
      { "recipientEmail": "preview-user-2@example.com", "deliveryKey": "<sha256 hex>" }
    ]
  },
  "validation": {
    "brandFromEmailValid": true,
    "sendgridSenderAuthRequired": true,
    "sendgridSenderAuthChecked": false,
    "warnings": [
      "analytics@keiba.link が SendGrid Sender Authentication / Domain Authentication 済みかは手動確認が必要"
    ]
  },
  "timestamp": "..."
}
```

## エラー例

| 状況 | ステータス | 原因 |
|---|---|---|
| 必須フィールド不足 | 400 | `missing required fields` + どれが足りないか |
| `campaignDate` が `YYYY-MM-DD` 形式でない | 400 | `campaignDate must be YYYY-MM-DD` |
| サポート外 `campaignType` | 400 | `unsupported campaignType (minimal preview supports only daily-main-race-nankan)` |
| 未知 `brand` | 400 | `unknown brand: ...` |
| brand と fromEmail のドメイン不整合 | 400 | `brand-from validation failed` |
| サポート外 `audienceMode` | 400 | `unsupported audienceMode` |
| `audienceMode=real-count-only` 時に Airtable env 不足 | 503 | `audienceMode=real-count-only requires Airtable env vars` + `missingEnv` |
| `audienceMode=real-count-only` で Airtable READ 失敗 | 502 | `airtable fetch failed (READ-ONLY)` + 構造化診断フィールド（下記） |
| audience カウント中の例外（不正 record shape 等） | 500 | `audience count failed` |
| ハンドラ未捕捉例外（最終防衛線） | 500 | `unexpected handler error` |

### 502 レスポンスの構造化診断フィールド

Airtable READ が non-2xx を返した場合、必ず JSON で以下を返す（Cloudflare/Netlify edge の generic 502 プレーンテキストを抑止）:

```json
{
  "error": "airtable fetch failed (READ-ONLY)",
  "brand": "keiba-intelligence",
  "baseSource": "keiba-intelligence",
  "envName": "AIRTABLE_BASE_ID_KEIBA_INTELLIGENCE",
  "table": "Customers",
  "airtableStatus": 403,
  "airtableErrorType": "NOT_AUTHORIZED",
  "page": 1,
  "hint": "401/403 means PAT scope or base access issue. ..."
}
```

| airtableStatus | 典型 airtableErrorType | 対処 |
|---|---|---|
| 401 | `AUTHENTICATION_REQUIRED` | PAT が無効 / 失効。Netlify env の `AIRTABLE_API_KEY` を再発行 |
| 403 | `NOT_AUTHORIZED` | PAT に対象 Base のアクセス権がない、または `data.records:read` scope なし |
| 404 | `NOT_FOUND` / `TABLE_NOT_FOUND` | Base ID が間違っている、または KI Base に `Customers` テーブルがない |
| 429 | `RATE_LIMIT_REACHED` | Airtable 5rps 制限。数秒待って再試行 |
| 0 | `NETWORK_ERROR` | 関数 egress / Airtable 障害 |
| 5xx | `UNKNOWN` / etc. | Airtable 上流障害。https://status.airtable.com を確認 |

レスポンスに **絶対に含めない**もの: `AIRTABLE_API_KEY` の値 / Base ID の値 / `Authorization` ヘッダ / Airtable 生レスポンス全文 / record id / email / name。

## 次のステップ（このAPIには含めない）

1. **Airtable READ 追加**: `Customers` テーブルから brand / audienceType 別に受信者抽出（書き込みなし）
2. **EmailBlacklist / 配信停止 / 期限切れ除外** の集計
3. **test モード追加**: `NEWSLETTER_TEST_RECIPIENTS` 宛のみ SendGrid 送信
4. **`Campaigns` / `CampaignDeliveries` テーブルへの書き込み**: dry-run 結果保存・admin 承認フロー
5. **production モード**: `NEWSLETTER_AUTOMATION_ENABLED=true` + `Status=approved` のみ pick する worker

このAPIに**実送信機能・実顧客リスト参照を直接足してはいけない**。
追加は順を追って、それぞれ別の関数として実装する。

## 関連ファイル

- `astro-site/src/lib/newsletter/brand-config.js`
- `astro-site/src/lib/newsletter/content-hash.js`
- `astro-site/src/lib/newsletter/delivery-key.js`
- `astro-site/src/lib/newsletter/render-daily-main-race.js`
- `astro-site/netlify/functions/newsletter-preview.js`
