# analytics-keiba

**AI-Powered Analytics Dashboard for 南関競馬 + 中央競馬**

- **本番URL**: https://analytics.keiba.link
- **旧名**: nankan-analytics.keiba.link（移行中）
- **コンセプト**: 南関競馬＋中央（JRA）統合予想プラットフォーム

## 構成

| ディレクトリ | 内容 |
|---|---|
| `astro-site/` | メインサイト（Astro SSR + Netlify） |
| `nankan-stripe-integration/` | 決済連携 |
| `.github/workflows/` | 予想・結果データの自動取込 |

## データフロー

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

## 技術スタック

- Astro 5 + Sass（SSR）
- Netlify Functions (Node.js 20)
- Airtable（顧客管理）
- SendGrid Marketing Campaigns（メルマガ）
- Gemini 2.5 Flash（AI解説）
- Stripe + 銀行振込（決済）

## 関連プロジェクト

- `keiba-intelligence` - 先行実装プロジェクト（実装パターンの参照元）
- `keiba-data-shared-admin` - データ入力管理ツール
- `nankan-analytics` - 旧プロジェクト（本プロジェクトの前身）

## 詳細ドキュメント

- [CLAUDE.md](./CLAUDE.md) - プロジェクト設定・ルール
- [docs/](./docs/) - 詳細ドキュメント
