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

### 5xx 系エラーは HTTP 200 + structured_error で返す（2026-05-17 改訂）

Cloudflare 前段が origin の 5xx を generic 502 (text/plain `error code: 502`) に
書き換える事象を回避するため、**既知のサーバ側エラー (旧 500/502/503) は
HTTP 200 + `body.success: false` + `structured_error: true` で返却**するように
した。4xx クライアントエラーは Cloudflare が透過するためそのまま 4xx を返す（仕様維持）。

| 旧 HTTP | errorClass | 発生条件 |
|---|---|---|
| 503 | `missing-env` | `audienceMode=real-count-only` で `AIRTABLE_API_KEY` / `AIRTABLE_BASE_ID_<BRAND>` 不足 |
| 502 | `airtable-customers-fetch` | Customers テーブル READ-ONLY 取得失敗 (401/403/404/5xx/network) |
| 500 | `audience-count` | countAudience 内部例外（不正 record shape 等） |
| 500 | `unexpected-handler-error` | 最終防衛線（上記以外の未捕捉例外） |

EmailBlacklist 取得失敗は元々全体エラーにせず `blacklistStatus` で表現する設計
なので、structured_error には変換しない（success 応答内の `audience.blacklistStatus` で
`missing` / `permission-error` / `network-error` / `read-error` を見る）。

#### structured_error レスポンス body 例

```json
{
  "success": false,
  "structured_error": true,
  "httpStatusSource": 502,
  "errorClass": "airtable-customers-fetch",
  "error": "airtable fetch failed (READ-ONLY)",
  "mode": "real-count-only",
  "brand": "analytics-keiba",
  "baseSource": "analytics-keiba",
  "envName": "AIRTABLE_BASE_ID_ANALYTICS_KEIBA",
  "table": "Customers",
  "airtableStatus": 403,
  "airtableErrorType": "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND",
  "page": 1,
  "hint": "401/403 means PAT scope or base access issue. ...",
  "pii": "none-exposed",
  "queriedAt": "2026-05-17T..."
}
```

admin UI 側は `body.success === false && body.structured_error === true` を
検出して既存 `renderJsonError()` に流す（`errorClass` を黄バナーで強調表示）。

### 旧 502 レスポンスの構造化診断フィールド（4xx エラーには残存、参考）

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

## 本番到達点（2026-05-17 時点）

ここまでで実装・本番デプロイ済の機能:

- ✅ `mode='dry-run'` 固定で副作用ゼロのプレビュー（subject / bodyHtml / contentHash / deliveryKey）
- ✅ brand × fromEmail 整合チェック（誤組合せ事故防止）
- ✅ deliveryKey 構造化（brand|serviceType|campaignType|campaignDate|audienceType|recipientEmail|contentHash|fromEmail|extraKey）
- ✅ `audienceMode='mock'` 既定で Airtable も読まない
- ✅ `audienceMode='real-count-only'` で **Airtable READ-ONLY** から実 Customers 件数のみ返却（PII 露出ゼロ）
- ✅ 退会候補 (`SuggestedStatus=withdrawn`) を matched から除外
- ✅ Airtable READ 失敗時の構造化 502 JSON（airtableStatus / airtableErrorType / page / table / hint）
- ✅ ハンドラ未捕捉例外の最終防衛線（500 JSON、generic 502 plaintext を抑止）
- ✅ admin 画面「対象者数確認 (READ-ONLY)」ボタン (commit `f81540b`)
- ✅ customer-field-resolver の `??` 連鎖を `firstNonEmpty()` に置換、`Plan=""` で
  停止していた Light/Premium 取りこぼしを修正 (commit `4e21fa4`)
- ✅ 旧 admin「配信統計」カードに誤解防止 amber バナー (commit `bdb3528`)
- ✅ netlify.toml の `force = true` 重複を削除し netlify CLI 動作を回復 (commit `0877e86`)
- ✅ 排他 3 段階除外 (withdrawn → unsubscribe → blacklist) + AK のみ EmailBlacklist
  READ-ONLY 取得 + admin UI に `blacklistStatus` / `unsubscribeExcluded` /
  `blacklistExcluded` 表示 (commit `c786f22`)

**Cloudflare 5xx 書き換え事象（運用知見）**:
`analytics.keiba.link`（Cloudflare 前段）は origin の 5xx を Cloudflare 汎用エラーページ
（`content-type: text/plain`, `body: error code: 502`）に書き換える。`x-nf-request-id` 等の
Netlify ヘッダも消える。**デバッグ時は `https://analytics-keiba.netlify.app` の直 URL で叩く** と
Function が返した構造化 JSON 診断がそのまま見える（運用 SOP として記録）。

## 本番確認実績（PII なし）

### 2026-05-17 全件 READ-ONLY 検証（初回・resolver バグ未修正版）

| Base | totalCustomers | filter | matchedCount | withdrawnExcluded | sideEffects | pii |
|---|---|---|---|---|---|---|
| analytics-keiba | 1123 | free | 1033 | 37 | airtable-read-only | none-exposed |
| analytics-keiba | 1123 | expired | 30 | 37 | airtable-read-only | none-exposed |
| keiba-intelligence | 32 | free | 21 | 0 | airtable-read-only | none-exposed |

### 2026-05-17 Light 取りこぼし修正後 (commit `4e21fa4`) 再検証

`customer-field-resolver.mjs` の `??` 連鎖を `firstNonEmpty()` に置換し、
AK の `Plan=""` で停止していた問題を解消した直後の本番値:

| Base | totalCustomers | filter | matchedCount | withdrawnExcluded | sideEffects | pii |
|---|---|---|---|---|---|---|
| analytics-keiba | 1123 | **light** | **3** ← 旧 0 から改善 | 37 | airtable-read-only | none-exposed |
| analytics-keiba | 1123 | free | 1033 | 37 | airtable-read-only | none-exposed |
| analytics-keiba | 1123 | expired | 30 | 37 | airtable-read-only | none-exposed |
| keiba-intelligence | 32 | light | 3 ← regression なし | 0 | airtable-read-only | none-exposed |

AK の audienceTypeBreakdown 変化（同時に Premium 取りこぼしも回復）:

| AudienceType | 修正前 | 修正後 | 差分 |
|---|---|---|---|
| free | 1033 | 1033 | ±0 |
| premium | 8 | **13** | +5 (Plan="" 取りこぼし回復) |
| expired | 67 | 67 | ±0 |
| admin-test | 5 | 5 | ±0 |
| unpaid | 2 | 2 | ±0 |
| (null/unknown) | 8 | **0** | -8 (全件正しく分類) |
| **light** | (なし) | **3** | +3 (新規分類) |
| 合計 | 1123 | 1123 | ✓ |

- Airtable WRITE: なし
- SendGrid 呼び出し: なし
- email / name / record id 漏洩: regex 検査で 0 件
- 既存 admin 「配信統計」(legacy customerStats) との数値ズレが大きいため、
  旧カードに **誤解防止 amber バナー** を追加して送信判断は本 API を使うよう誘導 (commit `bdb3528`)

### 2026-05-17 配信停止 / EmailBlacklist 除外実装後 (commit `c786f22`) 検証

`audience-counter` に排他 3 段階除外 (withdrawn → unsubscribe → blacklist) を組み込み、
`newsletter-preview` で AK のみ EmailBlacklist テーブルを READ-ONLY 取得する実装の本番結果:

| Base | filter | matched | withdrawn | unsub | blacklist | blacklistStatus | sideEffects | pii |
|---|---|---|---|---|---|---|---|---|
| analytics-keiba | free | **1032** ← 前 1033 から -1 | 37 | 0 | **3** | **enabled** | airtable-read-only | none-exposed |
| analytics-keiba | light | 3 維持 | 37 | 0 | 3 | enabled | airtable-read-only | none-exposed |
| keiba-intelligence | free | 21 維持 | 0 | 0 | 0 | **not-applicable** | airtable-read-only | none-exposed |
| keiba-intelligence | light | 3 維持 | 0 | 0 | 0 | not-applicable | airtable-read-only | none-exposed |

数値の解説:
- **AK の `blacklistExcluded=3`** は AK EmailBlacklist の HARD_BOUNCE / COMPLAINT 件数（AudienceType に依存しない Set）
- AK × free で matched が 1033 → 1032 と -1 なのは、blacklist 3 件のうち **1 件のみが Free 会員**だったため。残り 2 件は元々 free 以外で AudienceType フィルタ段階で既に弾かれていた範囲
- **AK の `unsubscribeExcluded=0`** は現時点で `UnsubscribedAnalyticsKeiba=true` の会員ゼロ（既存 `unsubscribe.js` が旧フィールド `メール配信` に書こうとしてサイレント失敗中なので新フィールドは未利用と整合）
- **KI の `blacklistStatus=not-applicable`** は KI Base に EmailBlacklist テーブル未存在のため READ を skip した結果（`BRAND_HAS_BLACKLIST_TABLE['keiba-intelligence'] = false`）
- KI × light = 3 維持により Light resolver 修正の regression なしを再確認

不変条件 (`matched + 全 excluded + filter 不一致 = totalCustomers`) 検算:
- AK × free: 1032 + 37 + 0 + 3 + (1123 - 1072 = 51 filter 不一致) = 1123 ✓
- KI × free: 21 + 0 + 0 + 0 + 11 (filter 不一致) = 32 ✓

PII 検証:
- regex で実 email 漏洩: 0 件 (4 パターン全て)
- Airtable record id (`rec[14 chars]`) 漏洩: 0 件
- Airtable WRITE / SendGrid 呼び出しなし

### 既知の Airtable 認証エラー型（hint テーブル参照）

`audienceMode=real-count-only` で本番返却が確認された Airtable error type:
- `AUTHENTICATION_REQUIRED` (401): PAT 失効
- `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` (403): PAT に対象 Base のアクセス権がない or Base ID 誤り

## 除外ロジック仕様（2026-05-17 改訂）

`audienceMode='real-count-only'` で matched から除外する条件と優先順を以下に固定（排他カウント、最初に該当した理由だけ加算）:

| 優先順 | 理由 | 判定 | カウンタ |
|---|---|---|---|
| 1 | `withdrawn` | `SuggestedStatus === 'withdrawn'` (status-resolver の判定結果) | `withdrawnExcluded` |
| 2 | `unsubscribe` | brand 別 Customers Checkbox = `true` <br>・analytics-keiba → `UnsubscribedAnalyticsKeiba` <br>・keiba-intelligence → `UnsubscribedKeibaIntelligence` | `unsubscribeExcluded` |
| 3 | `blacklist` | EmailBlacklist テーブルの `Status` ∈ `{HARD_BOUNCE, COMPLAINT}` の email (大文字化後で比較) | `blacklistExcluded` |
| 4 | `audienceType` フィルタ | リクエストの `audienceType` と一致しない | どこにもカウントしない |
| 5 | 全通過 | matched | `matchedCount` |

不変条件: `matchedCount + withdrawnExcluded + unsubscribeExcluded + blacklistExcluded + (filter 不一致) = totalCustomers`

### EmailBlacklist の base 別扱い

| brand | EmailBlacklist テーブル | blacklistStatus |
|---|---|---|
| `analytics-keiba` | ✅ 存在（domain-protection.js が運用中） | `enabled` (取得成功時) |
| `keiba-intelligence` | ❌ 未追加（2026-05-17 時点） | `not-applicable` (READ せず skip) |

将来 KI に EmailBlacklist を追加する場合は `netlify/functions/newsletter-preview.js` の `BRAND_HAS_BLACKLIST_TABLE` を `true` に変更するだけ。

### EmailBlacklist 取得失敗時の blacklistStatus 値

| 状況 | airtableStatus / errorType | blacklistStatus | 動作 |
|---|---|---|---|
| 取得成功 | – | `enabled` | matchedCount から除外実行 |
| brand が対象外 | – | `not-applicable` | スキップ |
| テーブル未存在 | 404 / NOT_FOUND / TABLE_NOT_FOUND / MODEL_NOT_FOUND | `missing` | 空 Set で継続 |
| PAT 権限不足 | 403 / NOT_AUTHORIZED / INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND | `permission-error` | 空 Set で継続 |
| 通信失敗 | 0 / NETWORK_ERROR | `network-error` | 空 Set で継続 |
| その他 (5xx 等) | – | `read-error` | 空 Set で継続 |

**いずれの失敗時も Customers 集計は継続**（全体エラーにしない）。admin UI 側で `blacklistStatus !== 'enabled' && !== 'not-applicable'` のときは赤バナー警告を出して運用者に通知。

### 追加レスポンスフィールド

```json
"audience": {
  ...,
  "matchedCount": 1028,           // 3 種類除外後
  "withdrawnExcluded": 37,
  "unsubscribeExcluded": 3,       // 新規 2026-05-17
  "blacklistExcluded": 5,         // 新規 2026-05-17
  "blacklistStatus": "enabled",   // 新規 2026-05-17
  "exclusionPolicy": {            // 新規 2026-05-17 (運用透明性のための説明文)
    "withdrawn": "SuggestedStatus=withdrawn を除外",
    "unsubscribe": "brand 別 UnsubscribedAnalyticsKeiba / UnsubscribedKeibaIntelligence = true を除外",
    "blacklist": "EmailBlacklist Status が HARD_BOUNCE / COMPLAINT の email を除外",
    "blacklistCriteria": ["HARD_BOUNCE", "COMPLAINT"],
    "order": ["withdrawn", "unsubscribe", "blacklist", "audienceTypeFilter"]
  }
}
```

### PII 取り扱い

- EmailBlacklist の email は **内部 `Set<string>` のみで保持**、レスポンスや log に出さない
- normalized email (trim + lowercase) で `resolveEmail()` と一致させて Set lookup
- `pii: "none-exposed"` を引き続き返す

## 次の実装候補

### A. admin 画面「対象者数確認」ボタン（設計案・実装未着手）

既存の `src/pages/admin-newsletter-simple.astro` には `customerStats`（ページ初期化時に Airtable から
全 Customers を取得して集計するレガシー実装）を参照する「現在の配信対象者数」ボタンがあるが、これは:
- analytics-keiba Base のみで keiba-intelligence をカバーしない
- 退会候補・期限切れ判定が現在の plan-normalizer ロジックと乖離している可能性
- 旧プラン名（standard / premium / premium-sanrenpuku / premium-combo）ベースで AudienceType と一致しない

→ **newsletter-preview API (`audienceMode=real-count-only`) を呼び出す形に置き換える**のが望ましい。

#### UI 設計（提案）

```
┌─────────────────────────────────────────────┐
│ 📊 対象者数確認 (Real-Count Only)            │
├─────────────────────────────────────────────┤
│ ブランド: ( ) analytics-keiba               │
│            ( ) keiba-intelligence           │
│ 配信対象: [ free ▼ ]                         │
│           free / light / standard / premium │
│           premium-combo / unpaid / expired  │
│           admin-test / * (全件合算)          │
│ [ 確認する (READ-ONLY) ]                    │
├─────────────────────────────────────────────┤
│ 結果（個人情報は表示しません）:              │
│  対象件数: 1,033 名                          │
│  退会除外: 37 名                             │
│  AudienceType 内訳:                          │
│    free        1,045                         │
│    premium         8                         │
│    expired        67                         │
│    unpaid          2                         │
│    (null/unknown)  8                         │
│  matched ステータス内訳:                     │
│    active 1,031 / pending 2                  │
│  queriedAt: 2026-05-17T...                   │
│  sideEffects: airtable-read-only             │
└─────────────────────────────────────────────┘
```

#### 動作仕様（提案）

1. **送信先**: `POST /.netlify/functions/newsletter-preview`
   - `audienceMode: 'real-count-only'`
   - `targetRace` はダミーで OK（preview API の必須項目を満たすためだけ、admin は内部固定値）
   - `campaignType` は当面 `daily-main-race-nankan`（admin はその他を呼ぶ必要なし）
2. **追加で投げる必要があるもの**: brand / serviceType / audienceType / campaignDate (=今日)
3. **クリック時の安全装置**:
   - 配信ボタン (`production`) とは UI 上で**明確に分離**（色・配置）
   - `audienceMode=real-count-only` 固定（select / hidden、ユーザーが他値に変えられない）
   - ボタン disabled → 確認中 → 結果表示 → 「もう一度」で disabled 解除
4. **エラーハンドリング**:
   - 4xx / 5xx 時は JSON 診断フィールド (`airtableStatus`, `airtableErrorType`, `hint`) を表示
   - Cloudflare 5xx 書き換え対策として、admin の fetch は **`window.location.host` を使わず固定の直 Netlify URL** または同一オリジン経由を選べる切替を入れる
5. **既存「現在の配信対象者数」ボタンの扱い**:
   - 当面は両方並置（新ボタンは「新方式 (READ-ONLY API)」、旧ボタンは「ローカル集計 (legacy)」）
   - 数値が一致することを目視確認できたら旧ボタン削除（別タスク）

#### 実装スコープ（admin 側）

| 変更 | 内容 |
|---|---|
| `src/pages/admin-newsletter-simple.astro` | フォーム UI 追加（brand select / audienceType select / submit ボタン）+ fetch 関数 + 結果表示テーブル |
| 新規 fetch helper | preview API レスポンス整形（成功 / 4xx / 5xx の 3 分岐表示） |

ファイル数: 1（既存ファイル編集のみ）。新規 netlify function は不要（既存 `newsletter-preview.js` を呼ぶだけ）。

#### 禁止事項の継承

- ❌ admin から SendGrid を呼ばない（API 経由でも）
- ❌ admin から Airtable WRITE しない
- ❌ admin で `NEWSLETTER_AUTOMATION_ENABLED=true` を立てない
- ❌ admin で `audienceMode=production` 等の未実装値を許可しない
- ✅ 表示するのは件数 / 内訳 / hint のみ、email / name / record id は表示も保持もしない

### B. その他の次ステップ候補（将来）

1. **EmailBlacklist / 配信停止フラグ除外** の matched 計算への組み込み
2. **test モード**: `NEWSLETTER_TEST_RECIPIENTS` 宛のみ SendGrid 送信（admin から手動で安全テスト送信）
3. **`Campaigns` / `CampaignDeliveries` テーブル**: dry-run 結果保存・admin 承認フロー
4. **production モード**: `NEWSLETTER_AUTOMATION_ENABLED=true` + `Status=approved` のみ pick する worker
5. **502→200+structured_error 化**: Cloudflare 5xx 書き換え回避（HTTP 200 で body に `success: false` を含める案）

このAPIに**実送信機能を直接足してはいけない**。
追加は順を追って、それぞれ別の関数として実装する。

## 関連ファイル

- `astro-site/src/lib/newsletter/brand-config.js`
- `astro-site/src/lib/newsletter/content-hash.js`
- `astro-site/src/lib/newsletter/delivery-key.js`
- `astro-site/src/lib/newsletter/render-daily-main-race.js`
- `astro-site/src/lib/newsletter/audience-counter.js`
- `astro-site/netlify/functions/newsletter-preview.js`
- `astro-site/scripts/newsletter/lib/plan-normalizer.mjs` (preview API も再利用)
- `astro-site/scripts/newsletter/lib/status-resolver.mjs` (preview API も再利用)
- `astro-site/scripts/newsletter/lib/customer-field-resolver.mjs` (preview API も再利用)
- `astro-site/scripts/newsletter/backfill-customers.mjs` (オフライン CSV 出力、preview と同一ロジック)
