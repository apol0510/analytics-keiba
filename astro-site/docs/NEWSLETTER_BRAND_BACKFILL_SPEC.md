# Newsletter Brand 遡及付与 CSV 出力スクリプト 仕様書

**作成日**: 2026-05-15  
**フェーズ**: 設計のみ（実装はまだしない）  
**安全性**: **READ ONLY**（Airtable / SendGrid に WRITE しない、ファイル書き込みは CSV/JSON 出力のみ）  
**前提**: [NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md](./NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md) のフィールド追加作業が両 Base で完了済（2026-05-15）

---

## 1. 目的

両 Base の既存 Customers に対し、新規追加した `Brand` / `ServiceType` / `AudienceType` フィールドの**推奨値**を機械的に算出し、必要に応じて `Status` の見直し候補も含めて **CSV に出力**する。

- Airtable には**書き込まない**
- 出力 CSV は人間レビュー後に手動インポート（または個別目視更新）する
- 自動上書きや一括 PATCH は禁止

事故防止のため、機械が判定できない部分は `NeedsManualReview=true` フラグを付けて人間に判定を委ねる。

---

## 2. 対象 Base

| Base | レコード数 | 名前 | プラン | Status 既存値 | 退会判定 | 期限 | 拡張フィールド |
|---|---|---|---|---|---|---|---|
| `analytics-keiba` | 1,121 | `Name` → `名前` | `PlanType` → `plan_type` → `Plan` → `プラン` | active / pending / cancelled / suspended / expired / unpaid / refunded / withdrawn / test | `WithdrawalRequested=true` OR `Status='withdrawn'` | `有効期限` → `ExpiryDate` | Brand 等9個追加済 |
| `keiba-intelligence` | 32 | `Name` → `名前` | `PlanType` → `plan_type` → `Plan` → `プラン` | pending / active / cancelled / suspended / expired / unpaid / refunded / withdrawn / test | `Status='withdrawn'` のみ | `有効期限` → `ExpirationDate` | Brand 等9個追加済 |

両 Base とも本作業は**両方を対象**にし、結果 CSV は Base 別に分離する。

---

## 3. 出力方針

### 3.1 操作の階層

```
本スクリプト                    ←  ✅ READ-ONLY、ローカルファイル書き込み（CSV/JSON）のみ
   ↓ ※自動 WRITE しない
人間レビュー                    ←  ✅ CSV を Excel/Numbers などで開いて目視
   ↓ ※差分が妥当か確認
人間が Airtable に手動インポート ←  ✅ Airtable UI で CSV インポート機能、または個別レコードを目視更新
```

### 3.2 何を読むか

- **Airtable Customers**（両 Base、READ-ONLY、ページネーション対応）
- **SendGrid Marketing Campaigns Contacts**（カスタムフィールド `registered_analytics` / `registered_intelligence` を確認したい場合のみ、READ-ONLY）
  - 当面 v1 では SendGrid 参照は**任意**（Airtable Customers の所属 Base で十分に Brand 判定できる）
  - SendGrid 参照を入れる場合は `--with-sendgrid` フラグなどで明示オプトイン

### 3.3 何を書くか / 書かないか

| 対象 | 書き込み |
|---|---|
| Airtable Customers | ❌ 書かない |
| Airtable 他テーブル | ❌ 書かない |
| SendGrid | ❌ 書かない |
| ローカル CSV / JSON ファイル | ✅ 書く（出力先は [§9](#9-想定出力ファイル)） |

### 3.4 環境変数（READ-ONLY 専用）

スクリプト実装時に使用予定の env:

```bash
# 必須
AIRTABLE_API_KEY=...           # READ-ONLY スコープのトークン推奨（Personal Access Token の data.records:read のみ）
AIRTABLE_BASE_ID_ANALYTICS_KEIBA=...
AIRTABLE_BASE_ID_KEIBA_INTELLIGENCE=...

# 任意（SendGrid 参照する場合のみ）
SENDGRID_API_KEY=...           # Marketing Read 権限のみ推奨
SENDGRID_CUSTOM_FIELD_ANALYTICS=...     # 既存環境変数を流用可
SENDGRID_CUSTOM_FIELD_INTELLIGENCE=...  # 既存環境変数を流用可

# Dry-run スイッチ
BACKFILL_DRY_RUN=true          # デフォルト true。false にしても WRITE は走らない設計だが、明示的に true を強制
```

⚠️ **Airtable Token は data.records:read 権限のみのものを発行**して使用すること。書き込み権限のあるトークンを使ってはいけない（事故防止）。

---

## 4. analytics-keiba Base のマッピング案

### 4.1 固定値

| 出力フィールド | 値 |
|---|---|
| `BaseName` | `analytics-keiba` |
| `SuggestedBrand` | `analytics-keiba`（全レコード一律） |
| `SuggestedServiceType` | `analytics-keiba`（全レコード一律） |

### 4.2 取得フィールド（フォールバック）

| 出力フィールド | 取得ロジック |
|---|---|
| `Email` | `Email`（lowercase, trim） |
| `NameResolved` | `Name` → `名前` の先勝ち |
| `CurrentPlanRaw` | `PlanType` → `plan_type` → `Plan` → `プラン` の先勝ち（原文保存） |
| `PlanResolved` | `CurrentPlanRaw` を [§6](#6-audiencetype-変換ロジック共通) のロジックで正規化したラベル |
| `ExpiryDateResolved` | `有効期限` → `ExpiryDate` の先勝ち（ISO 日付） |
| `WithdrawalRequested` | `WithdrawalRequested` の値（true / false / null） |
| `CurrentStatus` | `Status` 既存値（active / pending / cancelled / suspended など） |
| `CurrentBrand` | `Brand` 既存値（通常空、追加直後なので） |
| `CurrentServiceType` | `ServiceType` 既存値 |
| `CurrentAudienceType` | `AudienceType` 既存値 |

### 4.3 退会判定（analytics-keiba 専用）

`WithdrawalRequested=true` OR `Status='withdrawn'` のいずれかが真なら退会扱い。  
このとき `SuggestedStatus='withdrawn'` を**候補として**出力し、`NeedsManualReview=true` を立てる（既存 Status を勝手に上書きしないため）。

---

## 5. keiba-intelligence Base のマッピング案

### 5.1 固定値

| 出力フィールド | 値 |
|---|---|
| `BaseName` | `keiba-intelligence` |
| `SuggestedBrand` | `keiba-intelligence`（全レコード一律） |
| `SuggestedServiceType` | `keiba-intelligence`（全レコード一律） |

### 5.2 取得フィールド（フォールバック）

| 出力フィールド | 取得ロジック |
|---|---|
| `Email` | `Email`（lowercase, trim） |
| `NameResolved` | `Name` → `名前` の先勝ち |
| `CurrentPlanRaw` | `PlanType` → `plan_type` → `Plan` → `プラン` の先勝ち |
| `PlanResolved` | 同上 |
| `ExpiryDateResolved` | `有効期限` → `ExpirationDate` の先勝ち（**ExpiryDate ではないことに注意**） |
| `WithdrawalRequested` | このフィールドは keiba-intelligence Base に**存在しない** → 常に `null` |
| `CurrentStatus` | `Status` 既存値 |
| `CurrentBrand` | `Brand` 既存値 |
| `CurrentServiceType` | `ServiceType` 既存値 |
| `CurrentAudienceType` | `AudienceType` 既存値 |

### 5.3 退会判定（keiba-intelligence 専用）

`Status='withdrawn'` のみで判定（`WithdrawalRequested` フィールドが存在しないため）。  
このとき `SuggestedStatus='withdrawn'` を**候補として**出力、`NeedsManualReview=true`。

---

## 6. AudienceType 変換ロジック（共通）

`CurrentPlanRaw` の値（フォールバック取得した原文）を以下のルールで `SuggestedAudienceType` に正規化する。

### 6.1 ルール（先勝ち）

| 条件（小文字化 + trim 後） | `SuggestedAudienceType` |
|---|---|
| `''` / `null` / `undefined` | `free`（プラン未設定は無料扱い） |
| `free` / `フリー` / `無料` / `無料会員` | `free` |
| `light` / `ライト` | `light` |
| `standard` / `スタンダード` | `standard` |
| 文字列に `premium combo` / `Premium Combo` / `premium-combo` を含む | `premium-combo` |
| 文字列に `premium` を含む（Combo 以外）<br>例: `Premium`, `Premium Lifetime`, `Premium Annual`, `Premium Predictions`, `Premium Sanrenpuku`, `Premium Plus` | `premium` |
| 文字列に `test` / `テスト` を含む | `admin-test` |
| 上記いずれにも一致しない | `null`（= SuggestedAudienceType 空）+ `Warning="unknown plan: <CurrentPlanRaw>"` + `NeedsManualReview=true` |

### 6.2 期限切れ補正

上記で算出した `SuggestedAudienceType` が `premium` / `premium-combo` / `standard` / `light` のいずれかで、かつ `ExpiryDateResolved < today (JST)` の場合:

- `SuggestedAudienceType` を **`expired`** に上書き
- `Warning="plan-expired: original=<元のSuggestedAudienceType>, expiry=<ExpiryDateResolved>"` 追加

### 6.3 未入金補正

`CurrentStatus='pending'` の場合:

- `SuggestedAudienceType` を **`unpaid`** に上書き
- `Warning="status-pending: original=<元のSuggestedAudienceType>"` 追加

### 6.4 退会補正

退会判定が真の場合:

- `SuggestedAudienceType` は元の判定を残す（退会自体は `SuggestedStatus='withdrawn'` で表現）
- `SuggestedStatus='withdrawn'` を出力
- `NeedsManualReview=true`

### 6.5 ルール優先順（早い者勝ち、上書き順）

1. 元プランから `SuggestedAudienceType` を算出（[§6.1](#61-ルール先勝ち)）
2. 期限切れ補正（[§6.2](#62-期限切れ補正)）
3. 未入金補正（[§6.3](#63-未入金補正)）
4. 退会補正（[§6.4](#64-退会補正)）

→ 退会 > 未入金 > 期限切れ > 平常 の優先で `SuggestedAudienceType` / `SuggestedStatus` が決まる。

---

## 7. Status 変換ロジック

### 7.1 基本方針: **既存 Status は原則そのまま保持**

| 既存 `CurrentStatus` | `SuggestedStatus` | 備考 |
|---|---|---|
| `active` | `active` | そのまま |
| `pending` | `pending` | そのまま（unpaid 候補だが、自動変更しない） |
| `cancelled` | `cancelled` | そのまま |
| `suspended` | `suspended` | そのまま |
| `expired` | `expired` | そのまま（keiba-intelligence のみ既存値） |
| `unpaid` / `refunded` / `withdrawn` / `test` | 同じ値 | 新規追加した選択肢が偶然既に入っている場合はそのまま |
| `null` / 空 | `null` | 空のまま |

### 7.2 退会候補

`WithdrawalRequested=true`（analytics-keiba のみ）または `Status='withdrawn'` の場合:

- `SuggestedStatus='withdrawn'`
- `NeedsManualReview=true`（既存 Status が `withdrawn` 以外なら、人間に変更可否を確認させる）

### 7.3 未入金候補

`CurrentStatus='pending'` の場合は **`SuggestedStatus` は `pending` のまま**（自動で `unpaid` にしない）。  
代わりに `Reason="status-pending may be 'unpaid' (manual review)"` を `Reason` 列に出力。

### 7.4 期限切れ候補

`ExpiryDateResolved < today (JST)` かつ `CurrentStatus` が `active` の場合:

- `SuggestedStatus` は `active` のまま
- `Reason="active-but-expired: expiry=<ExpiryDateResolved>"` を出力
- `NeedsManualReview=true`

⚠️ Status の自動上書き候補は出さない（人間判断を必須にする）。

---

## 8. CSV 出力カラム

両 Base 共通の CSV スキーマ。Base 別にファイルを分けて出力する。

### 8.1 カラム定義

| # | カラム名 | 内容 | 例 |
|---|---|---|---|
| 1 | `BaseName` | `analytics-keiba` / `keiba-intelligence` | `analytics-keiba` |
| 2 | `AirtableRecordId` | Airtable レコード ID | `recXXXXXXXXXX` |
| 3 | `Email` | 正規化後 Email（lowercase, trim） | `user@example.com` |
| 4 | `NameResolved` | 名前フォールバック結果 | `山田太郎` |
| 5 | `CurrentBrand` | 既存 Brand 値（通常空） | `` |
| 6 | `SuggestedBrand` | 提案 Brand 値 | `analytics-keiba` |
| 7 | `CurrentServiceType` | 既存 ServiceType 値 | `` |
| 8 | `SuggestedServiceType` | 提案 ServiceType 値 | `analytics-keiba` |
| 9 | `CurrentAudienceType` | 既存 AudienceType 値 | `` |
| 10 | `SuggestedAudienceType` | 提案 AudienceType 値 | `premium` |
| 11 | `CurrentStatus` | 既存 Status 値 | `active` |
| 12 | `SuggestedStatus` | 提案 Status 値（**通常 CurrentStatus と同じ**） | `active` |
| 13 | `CurrentPlanRaw` | プランフィールド原文 | `Premium Lifetime` |
| 14 | `PlanResolved` | プラン正規化ラベル | `premium` |
| 15 | `ExpiryDateResolved` | 期限フォールバック結果（ISO） | `2026-12-31` |
| 16 | `WithdrawalRequested` | analytics-keiba は true/false、keiba-intelligence は null | `false` |
| 17 | `Reason` | 提案理由（複数可、`;` 区切り） | `plan-mapped:premium;active-but-expired` |
| 18 | `Warning` | 警告（複数可、`;` 区切り） | `unknown plan: ` |
| 19 | `NeedsManualReview` | true/false | `true` |

### 8.2 NeedsManualReview=true の条件（OR）

- `SuggestedAudienceType` が空 / unknown
- `Warning` が空でない（何らかの警告あり）
- 退会判定が真（既存 Status と SuggestedStatus が食い違う可能性）
- `Email` が空 or 形式不正
- 同一 Base 内で `Email` 重複（dup detection）

### 8.3 CSV エンコーディング

- 文字コード: UTF-8 (BOM つき推奨、Excel での文字化け回避)
- 改行: LF
- 引用: RFC 4180 準拠（フィールド内に `,` / `"` / `\n` を含む場合のみ `"` で囲む）

---

## 9. 想定出力ファイル

すべてローカルディレクトリ `tmp/newsletter-backfill/`（gitignore 推奨）の下に出力:

| ファイル | 内容 |
|---|---|
| `tmp/newsletter-backfill/analytics-keiba-customers-brand-backfill.csv` | analytics-keiba Base の全 1,121 件 |
| `tmp/newsletter-backfill/keiba-intelligence-customers-brand-backfill.csv` | keiba-intelligence Base の全 32 件 |
| `tmp/newsletter-backfill/newsletter-backfill-summary.json` | 全体サマリ・統計（後述） |

### 9.1 サマリ JSON フォーマット

```json
{
  "runAt": "2026-05-15T12:00:00.000Z",
  "dryRun": true,
  "bases": {
    "analytics-keiba": {
      "totalRecords": 1121,
      "csvFile": "tmp/newsletter-backfill/analytics-keiba-customers-brand-backfill.csv",
      "stats": {
        "needsManualReview": 0,
        "emailMissing": 0,
        "emailDuplicates": 0,
        "audienceTypeBreakdown": {
          "free": 0,
          "light": 0,
          "standard": 0,
          "premium": 0,
          "premium-combo": 0,
          "expired": 0,
          "unpaid": 0,
          "admin-test": 0,
          "(null/unknown)": 0
        },
        "withdrawalCandidates": 0,
        "expiredCandidates": 0,
        "pendingCandidates": 0,
        "unknownPlanRaw": []
      }
    },
    "keiba-intelligence": {
      "totalRecords": 32,
      "csvFile": "tmp/newsletter-backfill/keiba-intelligence-customers-brand-backfill.csv",
      "stats": {
        "needsManualReview": 0,
        "emailMissing": 0,
        "emailDuplicates": 0,
        "audienceTypeBreakdown": {
          "free": 0,
          "light": 0,
          "standard": 0,
          "premium": 0,
          "premium-combo": 0,
          "expired": 0,
          "unpaid": 0,
          "admin-test": 0,
          "(null/unknown)": 0
        },
        "withdrawalCandidates": 0,
        "expiredCandidates": 0,
        "pendingCandidates": 0,
        "unknownPlanRaw": []
      }
    }
  },
  "totalProcessed": 1153,
  "totalNeedsManualReview": 0,
  "warnings": []
}
```

### 9.2 .gitignore 追加候補

```
tmp/newsletter-backfill/
```

理由: CSV には実顧客の Email / 名前が含まれるため、リポジトリにコミットしてはいけない。

---

## 10. 安全ルール

### 10.1 絶対禁止

- ❌ Airtable WRITE（POST / PATCH / DELETE）
- ❌ SendGrid WRITE（contacts upsert / send 等）
- ❌ Airtable 既存レコードの変更
- ❌ Airtable 新規レコードの作成
- ❌ Status の自動変更
- ❌ Brand の自動付与（Airtable へ）
- ❌ CSV を Airtable に自動インポート

### 10.2 必須

- ✅ Airtable / SendGrid トークンは **READ-ONLY スコープ**で発行
- ✅ `BACKFILL_DRY_RUN=true` をデフォルト、コード内で WRITE 呼び出しを物理的に書かない
- ✅ レート制限対応（Airtable 5rps / SendGrid Marketing API レート）
- ✅ ページネーション完全対応
- ✅ `NeedsManualReview=true` のレコードは **手動確認必須**
- ✅ CSV 出力先は `tmp/newsletter-backfill/`（gitignore 対象）
- ✅ Email を含むファイルを Slack / メール等に**そのまま貼らない**（ファイル添付運用に統一）

### 10.3 失敗時の挙動

- Airtable API エラー → リトライ最大3回、それでも失敗ならスクリプト停止（部分 CSV は出さない、または `.partial.csv` 拡張子）
- SendGrid API エラー（オプション使用時のみ）→ スキップして CSV の `Reason` に `sendgrid-fetch-failed` を記録
- 期待外の Plan 値 → `Warning="unknown plan: <raw>"` を出して継続（停止しない）
- Email 不正 → 行は出力するが `NeedsManualReview=true`

---

## 11. スクリプト構成案（実装時）

実装はまだしない前提だが、ファイル配置の予定:

```
astro-site/scripts/newsletter/
├── backfill-customers.mjs              # メインエントリ
├── lib/
│   ├── airtable-read.mjs               # READ-ONLY Airtable クライアント
│   ├── sendgrid-read.mjs               # READ-ONLY SendGrid クライアント（任意）
│   ├── plan-normalizer.mjs             # AudienceType 変換ロジック (§6)
│   ├── status-resolver.mjs             # Status 提案ロジック (§7)
│   ├── csv-writer.mjs                  # CSV 出力
│   └── summary-writer.mjs              # JSON サマリ出力
└── README.md                            # 使い方
```

CLI 例:

```bash
# 両 Base
node astro-site/scripts/newsletter/backfill-customers.mjs

# Base 別
node astro-site/scripts/newsletter/backfill-customers.mjs --base=analytics-keiba
node astro-site/scripts/newsletter/backfill-customers.mjs --base=keiba-intelligence

# SendGrid 参照を有効化（オプション）
node astro-site/scripts/newsletter/backfill-customers.mjs --with-sendgrid

# 限定件数で動作確認（最初の数件のみ処理）
node astro-site/scripts/newsletter/backfill-customers.mjs --limit=10
```

---

## 12. 次の実装ステップ（このスクリプト導入の流れ）

1. **本仕様書のレビュー・承認**（今ここ）
2. **READ ONLY スクリプト実装**（`scripts/newsletter/backfill-customers.mjs` ほか）
   - Airtable READ + plan 正規化 + CSV 出力
   - 単体テスト（plan-normalizer / status-resolver の純粋関数）
3. **ローカルで小規模確認**（`--limit=5` で挙動を見る）
4. **両 Base の本番データを CSV 出力**（READ ONLY）
5. **マコさんが CSV を人間レビュー**:
   - `NeedsManualReview=true` のレコードを手動確認
   - `unknown plan` の Plan 値を AudienceType ルールに追記する判断
   - 退会候補を承認するか拒否するか判定
6. **必要なら Airtable に手動インポート / 個別更新**（マコさん作業）
7. **その後 `newsletter-preview` に `audienceMode=real-count-only` を追加**して、実 Customers の件数だけ dry-run で表示できるようにする

→ Status / Brand / AudienceType の遡及は**人間判断を経た上で手動反映**する設計。スクリプトは**提案を CSV で出すだけ**。

---

## 13. 禁止事項（再掲）

- ❌ Airtable WRITE
- ❌ SendGrid WRITE
- ❌ Airtable レコードの自動更新
- ❌ 既存 Status の変更
- ❌ Brand の自動付与（CSV のみ）
- ❌ `NEWSLETTER_AUTOMATION_ENABLED=true` の設定
- ❌ 既存 7 関数のガード解除
- ❌ nankan-analytics 側の変更
- ❌ `reset --hard` / force push

---

## 14. 参照

- [NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md](./NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md) — 全体設計
- [NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md](./NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md) — 既存フィールド実測
- [NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md](./NEWSLETTER_AIRTABLE_SETUP_CHECKLIST.md) — フィールド追加手順（実施済）
- [NEWSLETTER_PREVIEW_USAGE.md](./NEWSLETTER_PREVIEW_USAGE.md) — preview API の使い方
