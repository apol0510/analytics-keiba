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
  │ [ペア揃いガード] racebook + computer の両方が揃ったときだけ発火
  ↓ repository_dispatch (prediction-updated / results-updated)
.github/workflows/import-on-dispatch.yml
.github/workflows/import-results-on-dispatch.yml
  ↓
astro-site/scripts/importPrediction{,Jra}.js
  │ [中身 date 検証ガード] ±1日マージで拾ったファイルも中身 date が
  │ 指定日と一致するもののみ採用
astro-site/scripts/importResults{,Jra}.js
  ↓
astro-site/src/data/archive{,Jra}.json
  ↓ 自動commit/push
Netlify自動ビルド→本番反映
```

### 📊 入力データの構成（前提）

予想ページに表示されるデータは、admin 側の **2 つの入力経路** から成る：

| admin 経路 | 役割 | 取込元パス（keiba-data-shared） |
|---|---|---|
| `/admin/computer-manager` | **予想本体**（コンピ指数 + 印 + 役割振り分け） | `{cat}/predictions/computer/YYYY/MM/YYYY-MM-DD-{CODE}.json` |
| `/admin/race-data-importer` | **補完情報**（騎手・調教師・斤量・性齢・近走など、表示に必須の値） | `{cat}/racebook/YYYY/MM/YYYY-MM-DD-{CODE}.json` |

- **予想の本体は computer-manager**。コンピ指数と印・役割振り分けはこちらから来る
- **race-data-importer は補完**。予想ロジック自体には使わないが、騎手・調教師・斤量・
  性齢・近走など**ページ表示やfeatureScores計算に必須**の値を埋める
- 両方揃って初めて完全な予想ページが描画できる → だから dispatch も「両方揃いガード」

### 🛡️ 二段防御: ペア揃いガード + 中身 date 検証（2026-05-23 集約）

`prediction-updated` dispatch の取込で **前日データが当日 prediction に混入する**
事故（2026-05-24 案件: 36レース中24レースが23日と完全同一）を恒久的に防ぐため、
入力側と取込側に**二段の防御**を入れる。

#### Step 1: 入力側ガード（`keiba-data-shared-admin/netlify/lib/pair-guard.mjs`）
- `racebook` JSON と `computer` JSON の両方が `keiba-data-shared` に揃ったときだけ
  `prediction-updated` dispatch を発火
- race-data-importer / computer-manager のどちらが先でも、**後勝ちで1回**発火
- 詳細は admin 側 CLAUDE.md「🧠 keiba-intelligence連携」参照

#### Step 2: 取込側ガード（`astro-site/scripts/importPredictionJra.js`）
- `fetchRacebookData` 内で **rbData.date が指定日と一致するもののみ採用**
- ±1日マージロジック自体は維持（「ファイル名は前日付だが中身は当日」運用の救済）
- admin ガードをすり抜けた場合の追加防御

#### 触ってはいけないこと
- ±1日マージロジックを削除しない（2026-05-15 案件の救済機能）
- 中身 date 検証ガードを無効化しない（24日案件の追加防御）
- 入力側ガードと取込側ガードは**両方で1セット**。片方だけ無効化しない

#### 検知時のログ
- 入力側: `⏸️ [PairGuard] dispatch保留: ...` （Netlify Functions ログ）
- 取込側: `⏭️ [RACEBOOK-GUARD] ... スキップ（中身 date=... ≠ 指定日 ...）`
  （GitHub Actions ログ）

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
   （2026-05-21〜）。通常レースと同じ単一源 `selectOsaeNumbers`（`osaeClassification.js`）で
   選出し、軸・選出済み相手を除外して馬番昇順。**本線10点（top5×2）には含めない情報表示**。
   これで「表示の抑え（isOsaeCandidate）」と「買い目の抑え」が構造的に一致する。

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

メインレースと違い、**本命軸 + 対抗軸の 2 段構成**で生成する（2026-05-20〜）。
各行末尾に抑えを情報として括弧付与する：

- **1段目（本命軸）**: `"{本命}↔{相手...}(抑え{...})"`
  - 相手は本命を除く **役割優先で上位5頭**（対抗 → 単穴 → 連下最上位 → 連下、同役割内は pt 降順）
- **2段目（対抗軸）**: `"{対抗}↔{相手...}(抑え{...})"`
  - 相手は対抗を除く **役割優先で上位5頭**（**本命** → 単穴 → 連下最上位 → 連下、同役割内は pt 降順）
  - ※ 2段目は **本命を相手に入れる**（対抗は軸なので相手から除外）
- 相手は選出後 **馬番昇順**で表示
- `(抑え...)` は **抑え候補（role が `補欠`/`押さえ`/`抑え` かつ racebook 系コンピ指数 ≥ 45）**を **馬番昇順**で。
  本命・対抗・両軸の選出済み相手は除外。**抑えが 0 件なら `(抑え...)` を出さない**。
  判定は単一源 `osaeClassification.js` の `selectOsaeNumbers`（メインレース・三連複・表示と同一基準）
- 対抗が存在しない場合は **本命軸の 1 行のみ**
- `betPoints` は payout 由来ヒューリスティック（`betPointsPerRace`）

例（本命9 / 対抗12 / 単穴1,2 / 連下3,6 / 抑え5,8,11）:
```
9↔1.2.3.6.12(抑え5.8.11)
12↔1.2.3.6.9(抑え5.8.11)
```

> **メインレースは1段（本命軸双方向）**。通常レースの2段構成は持ち込まない。
> ただし 2026-05-21〜 メインレースも `(抑え...)` を情報付与する（本線10点には不算入）。
> 2段構成ロジックを `generateNormalRaceUmatanLines()` に閉じ込め、dispatcher
> `generateRaceUmatanLines(horses, isMainRaceFlag)` で呼び分ける。

### 表記文字

- メインレース・通常レースともに `↔` を使用（双方向馬単の正規表記）
- `checkUmatanHit`（`scripts/importResults*.js`）は `↔` / `→` / `-` を全て解釈し、軸→相手・相手→軸の双方向で判定する

### 🧩 抑え/不要馬 判定の単一源（2026-05-21 集約）

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

### keiba-intelligence との関係（独立運用、2026-05-23〜）

`analytics-keiba` と `keiba-intelligence` は **別サービスとして独立運用** する。
両方とも今後も稼働を続け、それぞれ独自の顧客に対して予想を提供する。

#### 運用方針

- `keiba-intelligence` は `analytics-keiba` とは **別サービスとして独立運用** する
- admin (`keiba-data-shared-admin`) からの dispatch / データ供給は **当面維持** する（両 repo にデータが届く状態を続ける）
- `/admin/computer-manager` は **予想本体**（コンピ指数 + 印 + 役割振り分け）
- `/admin/race-data-importer` は **補完情報**（騎手・調教師・斤量・性齢・近走などの値）
- `analytics-keiba` 側のロジック修正を `keiba-intelligence` へ **自動的に横展開しない**
- `keiba-intelligence` 側は **必要な場合のみ個別に修正** する
- 顧客表示に影響する汚染・誤表示が残る場合は、`keiba-intelligence` 側の運用方針に沿って **別途最小修正する**

#### 過去の経緯

2026-05-22 以前は両 repo で同じ判定式・同じ買い目生成ロジックを使う前提で、
メインレース判定や10点ロジックの変更は両 repo 同時に行うルールだった。
2026-05-23 にこの同期義務を取りやめ、両 repo は独立進化することとした。
過去の経緯を理由に同期作業を再開してはいけない。

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

## 🛡️ JRA premium 恒久ルール（KI 風ブロック再混入防止 / 2026-05-24 集約）

`/premium-prediction/jra/` は keiba-intelligence (KI) からの fork 経緯で、
旧 KI 風の演出（Ensemble Neural Network / XGBoost×LSTM / Multi-Dimensional
Performance Analysis / WIN PROB / MODEL CERTAINTY 等）が長く残っていた。
2026-05-24 にこれらを段階的に削除し、**`/premium-prediction/nankan/` の
有料ページ構造に完全に寄せる**方針が集約された。

**今後の作業・revert・コピペ・テンプレート同期で旧 KI 風ブロックが復活しないよう
3 段の防御を入れる**:

### 1. ドキュメント化
詳細な禁止リスト・必須セクション・許可される維持要素・作業フローは
`astro-site/docs/PREMIUM_JRA_RULES.md` に集約。**修正前に必ず読む**。

### 2. grep 検査（再混入検知）
`npm run check:ki-relics:jra` で `premium-prediction/jra.astro` から
旧 KI 風文字列・クラスを検出。
- 禁止文字列の例: `AI Recommended Betting Strategy`, `Multi-Dimensional
  Performance Analysis`, `Ensemble Neural Network`, `XGBoost`, `LSTM`,
  `Cross-val`, `Win Prob`, `Model Certainty`, `Expected Value`,
  `Feature Importance Analysis`, `DEEP LEARNING PREDICTION`,
  `PRO MEMBER EXCLUSIVE`, `Inference Time`
- 禁止クラスの例: `.ai-model-card`, `.detailed-horse-card`,
  `.dhc-quick-metrics`, `.qm-label`, `.qm-value`, `formula-row`,
  `axis-mark`, `opponents-list`, `stat-stars-block`, `star-rating`

### 3. 構造パリティ検証（PR/作業時の差分確認の強制）
`npm run check:jra-nankan-parity` で nankan.astro に存在する必須セクションが
jra.astro にも存在するかを検証。
- 必須: `.ai-badge`, `.race-title`, `.dark-horse-link-section`,
  `.premium-status`, `.daily-analysis-section`, `.recommendation-section`,
  `.unified-bet-card`, `.bet-list`, `.bet-item`, `.minor-group-renka`,
  `.minor-group-osae`, `.ineligible-section`, `isOsaeCandidate` import,
  `isIneligibleHorse` import

### CI で強制
上記 2 つは `check:safety` に組み込み済みで、PR / push to main で
自動実行される（`.github/workflows/safety-check.yml`）。
**「一時的に無効化」は禁止**。

### 触ってはいけない領域
- `keiba-intelligence` 側（**絶対に触らない**）
- JSON データ / `importPrediction*.js` / `featureScores.js` /
  `osaeClassification.js` / `shared-prediction-logic.js`（再エクスポート以外）

### 復活させようとする操作の例（すべて検知できる状態）
- `git revert <KI 風削除コミット>` → grep ガードで検知
- `git checkout <旧コミット> -- premium-prediction/jra.astro` → grep ガード + パリティで検知
- 別名で復活（`detailed-horse-card` → `detail-horse-card` 等）→ 禁止リストを更新して対応
- nankan に無いセクション追加 → パリティチェックでは検知できないので、上記の grep
  ガードに該当クラス/文字列を追加すること

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
