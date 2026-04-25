# ログイン認証（マジックリンク方式）

> analytics-keiba のログイン仕様。
> Airtable Customers（nankan-analytics 既存DB）を引き継ぎ、認証フローは
> keiba-intelligence 流の **マジックリンク**（メール送信→リンククリック→セッション）。

## 設計方針

| 軸 | 採用 |
|---|---|
| 顧客DB | **nankan-analytics の Airtable Base を共有**（Customers テーブル流用） |
| 認証フロー | **マジックリンク**（メールアドレスだけで即ログインできる旧方式は廃止） |
| 認証情報の保存 | **localStorage**（AccessControl.astro の既存仕様と互換） |
| トークン保管 | nankan-analytics Airtable に **AuthTokens テーブル**を新設 |
| 別 Base 参照 | **しない**（keiba-intelligence の Airtable Base は使わない） |

## 構成要素

| パス | 役割 |
|---|---|
| `src/pages/login.astro` | メールアドレス入力フォーム → `send-magic-link` |
| `src/pages/auth/verify.astro` | URL の `?token=...` を `verify-magic-link` で検証 |
| `netlify/functions/send-magic-link.js` | Customers 確認 → AuthTokens 作成 → SendGrid でリンク送信 |
| `netlify/functions/verify-magic-link.js` | AuthTokens 検証（未使用 / 期限内）→ Customers 取得 → セッション JSON 返却 |
| `src/components/AccessControl.astro` | `localStorage['user-plan']` を読んでアクセス可否判定（既存挙動を維持） |

## ログインフロー

```
[ユーザー]
   ↓ メール入力
/login
   ↓ POST /.netlify/functions/send-magic-link  { email }
[Airtable] Customers 検索（存在しなくても 200 を返す＝enumeration 防止）
[Airtable] AuthTokens に {Token, Email, ExpiresAt(15分後), Used:false} 作成
[SendGrid] メール送信（リンク = /auth/verify?token=...）

[ユーザー] メールのリンククリック
/auth/verify?token=...
   ↓ GET /.netlify/functions/verify-magic-link?token=...
[Airtable] AuthTokens でトークン検証（未使用 / 期限内）
[Airtable] AuthTokens.Used = true（再使用防止）
[Airtable] Customers から PlanType / VenueAccess / 有効期限などを取得
   ↓ レスポンス { redirectTo, userPlan }
[クライアント] localStorage['user-plan'] = userPlan
[クライアント] redirectTo へ遷移（/premium-prediction/nankan/ など）
```

## Airtable スキーマ

### Customers（既存・nankan-analytics 流用）

代表的に参照されるカラム（無くても動作するが、有るとプラン判定が正しく動く）:

| カラム | 用途 |
|---|---|
| `Email` | 必須。Magic link 検索キー |
| `Name` または `お名前` | メール本文の宛名 |
| `Status` | `inactive` の場合のみ拒否（`active` / 未設定 / 他値は通す） |
| `PlanType` | `pro` / `pro-plus` / `premium` / `premium-plus` / `standard` / `light` / `free-registered` 等 |
| `VenueAccess` | `jra` / `nankan` / `all`（プラン別 redirect に使用） |
| `ExpirationDate` または `有効期限` | 有効期限（任意） |
| `LifetimeSanrenpuku` | 三連複 Lifetime 権利（任意） |
| `AccessEnabled` | 認証完了時に true に更新される |

### AuthTokens（新規追加）

**nankan-analytics Airtable Base に Airtable UI から手動で作成する。**

| カラム | 型 | 用途 |
|---|---|---|
| `Token` | Single line text | UUID v4。検索キー |
| `Email` | Email | 紐付くユーザー |
| `CreatedAt` | Date (ISO) | 発行時刻 |
| `ExpiresAt` | Date (ISO) | 有効期限（15分後） |
| `Used` | Checkbox | 使用済みフラグ |
| `Ip_Address` | Single line text | 発行リクエスト元 IP |
| `User_Agent` | Long text | 発行リクエストの User-Agent |

## 環境変数（Netlify ダッシュボードで設定）

| 変数名 | 値 | 必須 |
|---|---|---|
| `AIRTABLE_API_KEY` | nankan-analytics と同じ Personal Access Token | ✅ |
| `AIRTABLE_BASE_ID` | nankan-analytics と同じ Base ID（例: `apptmQUPAlgZMmBC9`） | ✅ |
| `SENDGRID_API_KEY` | SendGrid 送信用 API Key | ✅ |
| `SENDGRID_FROM_EMAIL` | 送信元メール（例: `noreply@analytics.keiba.link`） | 推奨 |
| `MAGIC_LINK_BASE_URL` | マジックリンクのベース（既定 `https://analytics.keiba.link`） | 任意 |

設定方法:
```
Netlify dashboard → Sites → analytics-keiba → Site settings → Environment variables
```

## セキュリティの担保

- トークンは UUID v4 + 15分 TTL + 1回限り（`Used` で再使用拒否）
- 存在しないメールでも 200 を返してメールアドレス列挙を防止
- CORS は `analytics.keiba.link` / `analytics-keiba.netlify.app` / localhost のみ許可
- `Status === 'inactive'` のアカウントは明示的に拒否
- `localStorage` に保存するセッションには expiry を含める（7日）

## トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| `500 Airtable env not configured` | Netlify env に `AIRTABLE_API_KEY` / `AIRTABLE_BASE_ID` を設定 |
| `500 SendGrid env not configured` | `SENDGRID_API_KEY` 未設定 |
| `Token not found` | リンクが古い／コピペミス。`/login` から再送 |
| `Token expired` | 15分超過。`/login` から再送 |
| `Token already used` | リンクは1回限り。`/login` から再送 |
| メール届かない | SendGrid の Sender Authentication / DNS 確認 |
| Customers 検索でヒットしない | nankan-analytics 側の Customers にメール登録があるか確認 |

## 関連ドキュメント

- `astro-site/docs/PREDICTION_LOGIC.md` — 予想ロジック
- `astro-site/docs/BET_POINT_LOGIC.md` — 購入点数ロジック
