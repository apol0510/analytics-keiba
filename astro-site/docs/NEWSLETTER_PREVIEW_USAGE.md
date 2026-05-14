# Newsletter Preview API（dry-run・最小構成）

完全自動化メルマガ配信システムの第一段階。  
**副作用ゼロ** の dry-run プレビュー API。

## 何をするか

- 入力された brand / campaignType / campaignDate / targetRace から、
  - 件名（subject）
  - 本文 HTML（bodyHtml）
  - contentHash（sha256）
  - deliveryKey サンプル（モック受信者2名分）
  - fromEmail / fromName（brand-config から取得）
  - brand と fromEmail の組合せ検証結果
- を JSON で返すだけ。

## 何をしないか（重要）

- ❌ SendGrid を呼ばない
- ❌ Airtable を読まない
- ❌ Airtable を書き込まない
- ❌ ファイルを書き込まない
- ❌ 既存テーブル（ScheduledEmails / NewsletterJobs / NewsletterQueue / Campaigns / CampaignDeliveries）に一切触らない
- ❌ 受信者は **モック固定**（`preview-user-1@example.com`, `preview-user-2@example.com`）

レスポンスには `sideEffects: "none"` を明記している。

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
