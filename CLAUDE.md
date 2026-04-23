# CLAUDE.md - analytics-keiba 司令塔

## プロジェクト識別

```
プロジェクト名: analytics-keiba
作業ディレクトリ: /Users/user/Projects/analytics-keiba/astro-site
本番URL: https://analytics.keiba.link （移行後）
旧URL: https://nankan-analytics.keiba.link
コンセプト: 南関競馬 + 中央（JRA）競馬 統合AI予想プラットフォーム
前身: /Users/user/Projects/nankan-analytics
参照: /Users/user/Projects/keiba-intelligence (先行実装)
```

## 🚨 最重要：AI作業ルール 🚨

### 作業開始時に必ず明示

```
【今回の目的】
【変更対象ファイル】
【完了条件】
```

### AI作業の絶対禁止事項

1. **推測でコードを書かない** - Readツールで実ファイルを確認
2. **指示されていない変更を勝手に広げない**
3. **完了条件を満たさない完了宣言の禁止**
4. **数値修正は修正前後の比較を必ず出す**（表形式）
5. **commit前にgit diffを確認する**
6. **本番反映前に確認方法を示す**

## 📊 データフロー

```
keiba-data-shared-admin（入力）
  ↓ repository_dispatch (prediction-updated / results-updated)
.github/workflows/import-on-dispatch.yml
.github/workflows/import-results-on-dispatch.yml
  ↓
astro-site/scripts/importPrediction{,Jra}.js
astro-site/scripts/importResults{,Jra}.js
  ↓
astro-site/src/data/archive{,Jra}.json
  ↓ 自動commit/push
Netlify自動ビルド→本番反映
```

## 🛡️ 旧フォーマット禁止

| 禁止（旧） | 必須（新） |
|---|---|
| `raceResults` ❌ | `races` ✅ |
| `honmeiHit` ❌ | `isHit` ✅ |
| `umatanHit` ❌ | `hitLines` ✅ |
| `sanrenpukuHit` ❌ | - |

検証: `npm run validate:archive`

## 📊 購入点数ロジック

archiveResults の購入点数・回収率は仮回収率に応じた 3 段階方式。
詳細仕様は `astro-site/docs/BET_POINT_LOGIC.md` を参照。
閾値を変更する場合は **コードと MD を必ず両方更新**すること。

## 🧠 予想ロジック（スコア・役割決定）

本命・対抗・単穴の選定は `analyticsScore = computerIndex×0.5 + featureScore×0.3 + markScore×0.2` の
データ主導方式。keiba-intelligence（印ベース）と意図的に差別化している。
詳細仕様は `astro-site/docs/PREDICTION_LOGIC.md` を参照。
重み・閾値・差別化ルールを変更する場合は **コードと MD を必ず両方更新**すること。

## 🔧 開発コマンド

```bash
cd /Users/user/Projects/analytics-keiba/astro-site
npm run dev            # 開発サーバー
npm run build          # validate → build
npm run validate:archive
npm run import:prediction
npm run import:prediction:jra
npm run import:results
npm run import:results:jra
```

## 📝 技術スタック

- Astro 5 + Sass（SSR mode）
- Netlify Pro（Functions/Blobs）
- Airtable Pro（顧客管理）
- SendGrid Marketing Campaigns（メルマガ）
- Gemini 2.5 Flash（AI解説）
- Stripe + 銀行振込（決済）

## 🔄 GitHub Actions Workflows

`.github/workflows/` に配置：
- `import-on-dispatch.yml` - 予想データ取込（南関＋JRA統合）
- `import-results-on-dispatch.yml` - 結果データ取込
- `import-prediction-jra.yml` / `import-prediction-daily.yml`
- `import-results-jra.yml` / `import-results-jra-daily.yml` / `import-results-nankan-daily.yml`
- `auto-sync-check.yml` - archive整合性検証
- `verify-archive-sync.yml`

keiba-intelligenceで実証済みの構成を採用。Concurrency Groupは
- 南関: `archive-nankan-update`
- JRA: `archive-jra-update`
で統一。

## 🧠 特徴量システム

`src/utils/featureScores.js`に全ページ共通の算出ロジックあり：
- Speed Index / Stamina Rating / Form Trend
- Track Compatibility / Distance Fitness / Jockey Factor
- 期待値（predictedOdds がなければ控除率25%）

## 🔐 Netlify環境変数（必須）

```
AIRTABLE_API_KEY
AIRTABLE_BASE_ID
SENDGRID_API_KEY
SENDGRID_FROM_EMAIL
GEMINI_API_KEY
GITHUB_TOKEN
GITHUB_REPO_OWNER
GITHUB_REPO_NAME
GITHUB_BRANCH
SENDGRID_CUSTOM_FIELD_ANALYTICS  # 新規: analytics.keiba.link用カスタムフィールド
```

## ⚠️ 移行タスク（初期セットアップ）

1. GitHubリポジトリ作成: `apol0510/analytics-keiba`
2. Netlifyサイト作成・環境変数設定
3. DNS: `analytics.keiba.link` をNetlifyに向ける
4. SendGrid カスタムフィールド `registered_analytics` 追加
5. keiba-data-shared-admin から本リポジトリへのdispatch送信追加
6. nankan-analytics.keiba.link → analytics.keiba.link への301リダイレクト
7. 内部リンク・メタタグ・メルマガテンプレ更新

## 関連プロジェクト

| プロジェクト | 役割 |
|---|---|
| `keiba-intelligence` | 先行実装・実装パターン参照元 |
| `keiba-data-shared-admin` | データ入力管理ツール |
| `nankan-analytics` | 旧実装（段階的に引退予定） |
