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

## 🎯 メインレース10点ロジック

メインレースの買い目は **全プラン共通で最大10点** に統一する（2026-05-08〜）。
上位プランへの導線は「買い目数の増加」ではなく「**閲覧できるレース数の増加**」で作る方針。
ユーザーは10点超の買い目を嫌うため、上位プランでもメインレースは10点を超えない。

### メインレース判定（会場別レース数で判定）

`src/utils/mainRaceBetting.js` の `getMainRaceNumber(totalRaces)`：

| 開催レース数 | メインレース番号 |
|---|---|
| 12R | **R11** |
| 10R | **R9** |
| 8R | **R7** |
| その他 | 最終レース（フォールバック） |

`src/lib/race-config.js` の `RACE_TIERS` / `getMainRaceNumber()` と同一の判定基準。
複数会場同日開催（南関 大井+船橋、JRA 3場×12R など）は **会場別にレース数を数えてから判定**。
`importResults*.js` / `importPrediction*.js` 内で `racesByVenue` Map を構築し、各 race の venue 別レース数で判定する。

### 10点買い目生成ロジック

メインレースのみ：

1. **本命を軸**にする（**対抗軸の2行目は生成しない**）
2. 相手は本命を除く **役割優先で上位5頭**
   - 役割優先順: 対抗 → 単穴 → 連下最上位 → 連下
   - 同役割内は `pt`（displayScore/rawScore）降順
3. 1行コンパクト形式で保存: `"{本命}↔{c1}.{c2}.{c3}.{c4}.{c5}"`（双方向馬単）
4. **5頭未満なら拾えた分のみ**（パディング・補欠埋めはしない）
5. **抑え（補欠/抑え かつ racebook 系コンピ指数 ≥ 45）を `(抑え...)` で情報付与**する
   （2026-05-20〜）。通常レースと同じ単一源 `selectOsaeNumbers`（`osaeClassification.js`）で
   選出し、軸・選出済み相手を除外して馬番昇順。**本線10点には含めない情報表示**。
   これにより「表示の抑え（isOsaeCandidate）」と「買い目の抑え」が構造的に一致する。

例：本命3、上位5頭=5,7,8,10,12、抑え=9,14 → `bettingLines: ["3↔5.7.8.10.12(抑え9.14)"]` の1行
（抑え0件なら `"3↔5.7.8.10.12"`）

### 的中判定との整合性

`scripts/importResults*.js` の `checkUmatanHit` は `↔` / `→` / `-` のいずれも解釈し、軸→相手・相手→軸の双方向で判定する。上記1行で：

- 本命→相手（3→5, 3→7, ..., 3→12）= 5点
- 相手→本命（5→3, 7→3, ..., 12→3）= 5点
- **合計10点が自然に成立**

**表示・的中判定・archive保存で同じ `bettingLines` 文字列を使用**。別ロジックの混入なし。

### archiveResults.json 保存形式（メインレース）

```json
{
  "raceNumber": 11,
  "venue": "大井",
  "bettingLines": ["3↔5.7.8.10.12"],
  "isHit": true,
  "hitLines": ["3↔5.7.8.10.12"],
  "umatan": { "combination": "3-5", "payout": 1200 },
  "betType": "馬単",
  "betPoints": 10
}
```

メインレースのみ per-race `betPoints` を実本数（top5×2、最大10）で記録。
通常レースは従来通り `betPointsPerRace`（payout 由来ヒューリスティック）を per-race にも埋め込む。

### 通常レース（メイン以外）

メインレースと同じく **本命を軸にした双方向 1行**で生成し、抑えを情報として括弧付与する：

- 1行 双方向: `"{本命}↔{相手1}.{相手2}.{相手3}.{相手4}.{相手5}(抑え{...})"`
- 相手は本命を除く **役割優先で上位5頭**（対抗 → 単穴 → 連下最上位 → 連下、同役割内は pt 降順）
- `(抑え...)` は **抑え候補（role が `補欠`/`押さえ`/`抑え` かつ racebook 系コンピ指数 ≥ 45）**の馬（本命・選出済み相手を除く）を **馬番昇順**で全件。判定は単一源 `osaeClassification.js` の `selectOsaeNumbers`
- 双方向馬単として **5頭 × 2 = 10点**（抑えは点数に含めない情報表示）
- `betPoints` は payout 由来ヒューリスティック（`betPointsPerRace`）

例：`"7↔11.2.13.9.6(抑え1.3.4.10)"` → 10点

### 表記文字

- メインレース・通常レースともに `↔` を使用（双方向馬単の正規表記）
- `checkUmatanHit`（`scripts/importResults*.js`）は `↔` / `→` / `-` を全て解釈し、軸→相手・相手→軸の双方向で判定する

### 🧩 抑え/不要馬 判定の単一源（2026-05-20 集約）

抑え・不要馬の判定は **`astro-site/src/utils/osaeClassification.js` に一本化**する。
過去、判定が表示・買い目・三連複に分散し基準がズレ、「抑えのはずが不要馬」「直すと別が壊れる」
が再発していたため、依存ゼロの純粋モジュールに集約した。

| 判定 | 仕様 |
|---|---|
| `getOsaeCi(h)` | racebook 系コンピ指数（JRA: sourceComputerIndex 優先 / 南関: computerIndex、10未満は0） |
| `isOsaeCandidate(h)` | role が `押さえ`/`抑え`/`補欠` かつ `getOsaeCi(h) ≥ 45` |
| `isIneligibleHorse(h)` | HANDLED_ROLES 外/`無` または 抑え系だが候補でない |
| `selectOsaeNumbers(h, exclude)` | `(抑え...)` 用の馬番（軸・相手除外、馬番昇順） |

**禁止事項**:
- `mainRaceBetting.js` / `sanrenpukuBetting.js` / 各 astro ページに**ローカル抑え判定を再実装しない**。
  必ず `osaeClassification.js`（または再エクスポートする `shared-prediction-logic.js`）を import する。
- `shared-prediction-logic.js` は `osaeClassification.js` を再エクスポートする薄いラッパー
  （Astro/ブラウザ依存の `integrated-data-manager.js` を Node 実行へ巻き込まないため判定本体は置かない）。

### 関連ファイル

| 目的 | ファイル |
|---|---|
| ロジック本体 | `astro-site/src/utils/mainRaceBetting.js` |
| **抑え/不要馬 判定（単一源）** | `astro-site/src/utils/osaeClassification.js` |
| 既存メイン判定（プラン tier） | `astro-site/src/lib/race-config.js` |
| 予想取込（買い目生成） | `astro-site/scripts/importPrediction.js`, `importPredictionJra.js` |
| 結果取込（メインのみ betPoints 上書き） | `astro-site/scripts/importResults.js`, `importResultsJra.js` |
| 表示（プラン分岐 / クライアント側 isMainRace） | `astro-site/src/pages/premium-prediction/jra.astro` |

### 過去archive

新ロジックは **新規取込分から適用**。過去の archiveResults エントリは旧フォーマットのまま残る（再生成は別タスク）。

### keiba-intelligence との整合

姉妹repo `keiba-intelligence` にも同じ `src/utils/mainRaceBetting.js` を配置済み。
**両 repo で同じ判定式・同じ買い目生成ロジック**を使うため、メインレース判定や10点ロジックを変更する場合は **両 repo を同時に更新する**。

## 🧠 予想ロジック（スコア・役割決定）

本命・対抗・単穴の選定は `analyticsScore = computerIndex×0.5 + featureScore×0.3 + markScore×0.2` の
データ主導方式。keiba-intelligence（印ベース）と意図的に差別化している。
詳細仕様は `astro-site/docs/PREDICTION_LOGIC.md` を参照。
重み・閾値・差別化ルールを変更する場合は **コードと MD を必ず両方更新**すること。

## 🔢 指数表示ルール（著作権・表示安全対策）

analytics-keiba では、外部由来の元指数（racebook 系 `computerIndex` / `sourceComputerIndex`）を
画面にそのまま表示してはならない。**ユーザー表示用の指数は必ず「元指数 − 1」** とする。

| 用途 | 値 | 関数 |
|---|---|---|
| 内部計算（pt / analyticsScore / 役割分類 / isOsaeCandidate / isIneligibleHorse / 買い目生成 / 特徴量重要度） | raw `computerIndex` をそのまま使用 | （関数ラップ不要） |
| 画面表示（HTML / カード / 全レースプレビュー / 無料予想 / プレミアム予想 / 不要馬・抑え候補・連下） | raw − 1 | `getDisplayComputerIndex(raw)` / `formatDisplayComputerIndex(raw)` |

### 必須ルール
- 個別ページで `{horse.computerIndex}` を直接 JSX に埋めるのは **禁止**。必ず共通関数経由。
- 共通関数は `astro-site/src/lib/shared-prediction-logic.js` の
  `getDisplayComputerIndex(raw)` / `formatDisplayComputerIndex(raw)` を使用。
- JRA 側で `sourceComputerIndex` を選定してから表示する場合も、最終出力は同関数で `-1` する。
- 新しい指数表示箇所を追加する場合も、必ず共通関数を使うこと。

### 検証
`node astro-site/scripts/check-display-computer-index.mjs [YYYY-MM-DD] [venueSlug]` で
全レース・全馬を `raw - 1 == display` で検証する（不一致 1件でも非ゼロ exit）。

### 関連ファイル
| 目的 | ファイル |
|---|---|
| 共通関数 | `astro-site/src/lib/shared-prediction-logic.js` (`getDisplayComputerIndex` / `formatDisplayComputerIndex`) |
| 表示適用 | `src/pages/free-prediction/nankan.astro`, `premium-prediction/nankan.astro`, `free-prediction/jra.astro`, `premium-prediction/jra.astro`, `src/components/HorseMainCard.astro`, `src/components/RaceHorseSection.astro` |
| 検証スクリプト | `astro-site/scripts/check-display-computer-index.mjs` |

## 🔑 ログイン（マジックリンク方式）

`/login` でメール入力 → SendGrid 経由でリンク送信 → `/auth/verify?token=...` で検証 →
localStorage `user-plan` に保存して AccessControl が読む構成。
Airtable Base は **nankan-analytics と共有**（顧客は引き継ぎ）。
詳細・環境変数・Airtable スキーマ追加手順は `astro-site/docs/AUTH_LOGIN.md` を参照。

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

# 恒久ルール検証（指数表示 raw-1 / 全頭分類）
npm run check:no-raw-index     # JSX に {horse.computerIndex} を直接出力していないか
npm run check:display-index    # 全 predictions で 表示指数 == raw-1
npm run check:horse-sections   # 全レースで 合計 == 出走頭数（不要馬セクション維持）
npm run check:safety           # 上記 3 つを直列実行
npm run verify:safety          # build → check:safety（push 前推奨）
```

## 🛡️ CI Safety Check（恒久ルール強制）

以下 2 つの恒久ルールは **CI で強制**する。CI を通さずに予想表示や馬分類を変更してはいけない。
一時的に検証を無効化することは **禁止**。

### CI で強制しているルール
1. **指数表示は必ず raw − 1**
   - `horse.computerIndex` / `horse.sourceComputerIndex` を JSX に直接埋めるのは禁止
   - 必ず `getDisplayComputerIndex` / `formatDisplayComputerIndex` 経由
2. **全レースプレビューで全頭が分類される**
   - 本命 / 対抗 / 単穴 / 連下 / 抑え / 不要馬 のいずれかに必ず分類
   - 表示合計 = 出走頭数
   - 不要馬セクションが消えないこと

### CI が失敗する条件
- 表示指数が raw と同じ
- `getDisplayComputerIndex` で `-1` されていない
- JSX に `{horse.computerIndex}` / `{horse.sourceComputerIndex}` を直接出力
- 表示分類合計 != 出走頭数（不要馬・抑え・連下の分類漏れ）
- 検証対象スコープなのに対象ファイル 0 件（「素通り」防止）
- 対象ファイルがあるのに馬数 0 件（スキーマ破損）

### Workflow / Scripts
| ファイル | 役割 |
|---|---|
| `.github/workflows/safety-check.yml` | PR / push to main / dispatch で実行 |
| `astro-site/scripts/check-display-computer-index.mjs` | raw vs display 一致検証 |
| `astro-site/scripts/check-no-raw-computer-index-display.mjs` | JSX 直接出力の grep ガード |
| `astro-site/scripts/check-free-prediction-horse-sections.mjs` | 全頭分類検証 |
| `astro-site/package.json` の `check:*` / `verify:safety` | 実行エントリ |

### 運用ルール
- 予想ページ・カード・全レースプレビューを変更したら **必ず** `npm run check:safety` を実行
- push 前は `npm run verify:safety`（build + safety）を推奨
- CI を通さずに指数表示や馬分類を変更してはいけない
- 一時的に検証を無効化することは禁止

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
