# /free-prediction/jra/[date]/ 恒久ルール（再発防止）

最終更新: 2026-05-29

## 背景

`/free-prediction/jra/[date]/`（過去日アーカイブ SSG ページ）は keiba-intelligence (KI) から
fork した経緯があり、premium 側と同様に旧 KI 風の演出（Ensemble Neural Network /
Multi-Dimensional Performance Analysis / DEEP LEARNING PREDICTION SYSTEM /
Win Prob / Model Certainty / Expected Value / Feature Importance Analysis 等）が長く残っていた。

premium 側は 2026-05-24 に `astro-site/docs/PREMIUM_JRA_RULES.md` と
`check-no-ki-relics-premium-jra.mjs` で除去・保護されたが、**free 側 `[date]` は対象外で残存**していた。
PR-E (2026-05-28) で完全除去 + PR #40 で追加した過去走データ UI を analytics 風
`horse-card` 構造に再配置。本ドキュメントは、その方針を恒久ルールとして固定化する。

## 方針

- `/free-prediction/jra/[date]/` には旧 KI 風演出を**復活させない**。
- 過去走データアコーディオン（PR #40 で追加、`history-details` / `hh-*` 系）は維持。
- analytics 風 AIモデル選出馬カード（累積スコア / AI総合指数 / 基本情報 /
  評価ポイント / 特徴量重要度〈安定性・能力上位性・展開利の3項目〉/ 過去5走）は維持。
- 計算ロジック（`featureScores.js` / `generateAdvancedMetrics` /
  `shared-prediction-logic.js` / `loadHorseHistoriesJra.js`）には触れない。
- **keiba-intelligence は別サービスとして独立運用**（CLAUDE.md「KI 独立運用方針」参照）。
- 廃止する要素（旧 KI 風演出）は二度と復活させない（**別名での復活も禁止**）。
- **`AIRaceComment` / `AIBettingSection` コンポーネントは `[date].astro` で使用禁止**。
  これらは `Powered by Keiba Intelligence` クレジット / `Recommended Betting Strategy`
  見出し / 有料版風 CTA を含む KI 由来コンポーネントのため、free JRA 過去日ページに載せない。
- **`AIBettingSection.astro` コンポーネント本体は削除禁止**。`src/pages/prediction/[slug].astro`
  （南関 SSR 動的ページ・OOI / URAWA / FUNABASHI / KAWASAKI）で現役使用中のため、削除すると
  build / SSR が落ちる。free JRA / premium JRA から import するのも禁止（guard で検知）。
  コンポーネント本体の削除は南関 prediction 系の刷新方針が確定してから（PR-H-2、無期限保留）。
  なお `AIRaceComment.astro` 本体は被参照ゼロのため PR-H-1 (#44) で削除済み。

## 表示構造のページ別境界

| ページ | 構造 | 備考 |
|---|---|---|
| `/free-prediction/jra/`（無料 index） | **アコーディオン表示** (`jra-race-accordion-list`) | 無料版の正規構造 |
| `/free-prediction/jra/[date]/`（無料 過去日）| 現状 venue-selector + race-selector の**タブ構造**（KI fork 時の経緯）| 本来は無料版アコーディオン構造に揃えるのが理想。ただし大規模再構築のため **別 PR 扱い**。PR-E ではタブ構造自体は変更しない |
| `/premium-prediction/jra/`（有料）| **タブ表示** (venue-selector + race-selector) | 有料版の正規構造（`PREMIUM_JRA_RULES.md` 参照）|

→ 「有料版タブ構造を free 側にコピーして持ち込む」「KI 由来の演出を free 側に表示する」は禁止。
   `[date].astro` の既存タブ構造のアコーディオン化は別 PR で扱う。

## 廃止済み（再復活禁止）ブロック / 文字列 / クラス

| 区分 | 対象 | 理由 |
|---|---|---|
| 英語演出フレーズ | `DEEP LEARNING PREDICTION` (SYSTEM) | 旧 KI 風バッジ。削除済み・再復活禁止 |
| 英語演出フレーズ | `Ensemble Neural Network` (Analysis) | 旧 KI 風 ML 演出。削除済み・再復活禁止 |
| 英語演出フレーズ | `Multi-Dimensional Performance Analysis` / `多次元パフォーマンス分析` | 全頭分析テーブル見出し。削除済み・再復活禁止 |
| 英語演出フレーズ | `Feature Importance Analysis` | 旧 KI 風 6 軸演出。削除済み・再復活禁止 |
| 英語演出フレーズ | `Win Prob` / `Model Certainty` / `Expected Value` | 詳細分析テーブル英語指標。削除済み・再復活禁止 |
| 英語演出フレーズ | `XGBoost` / `LSTM` / `Cross-val` / `Validation Accuracy` / `Training Loss` / `Inference Time` / `CROSS-VAL` / `PRO MEMBER EXCLUSIVE` | 旧 KI 風 ML 演出。削除済み・再復活禁止 |
| 旧クラス | `.detailed-horse-card` (`top-horse-detailed` / `top-horse-simple` 含む) | 旧 KI 風カード構造。analytics 風 `horse-card` に置き換え済み |
| 旧クラス | `.dhc-header` / `.dhc-main-info` / `.dhc-info-card` / `.dhc-title-line` / `.dhc-number` / `.dhc-name` / `.dhc-role` / `.dhc-age` / `.dhc-weight` / `.dhc-jockey` / `.dhc-trainer` / `.dhc-jockey-trainer` / `.dhc-quick-metrics` / `.dhc-features` | 旧 KI 風カード子要素 (dhc-*)。削除済み・再復活禁止 |
| 旧クラス | `.qm-item` / `.qm-label` / `.qm-value` | 旧 KI 風 quick-metrics 表。削除済み・再復活禁止 |
| 旧クラス | `.feature-title` / `.feature-grid` / `.feature-item` / `.feature-label` / `.feature-icon` / `.feature-bar-container` / `.feature-bar` / `.feature-bar-center` / `.feature-value` | 旧 KI 風 Feature Importance バー (feature-*)。削除済み・再復活禁止 |
| 旧クラス | `.rank-badge-large` | 旧 KI 風順位バッジ。削除済み・再復活禁止 |
| 旧クラス | `.recent-races-title` / `.recent-races-grid` / `.recent-race-item` / `.recent-race-label` / `.recent-race-details` | 旧 KI 風近走 grid 構造。analytics 風カードに置き換え済み |
| 旧クラス | `.rr-venue` / `.rr-result` / `.rr-distance` / `.rr-condition` (`top3` 含む) | 旧 KI 風近走フィールドクラス (rr-*)。削除済み・再復活禁止 |
| **KI 由来コンポーネント** | `AIRaceComment` / `AIBettingSection` | `Powered by Keiba Intelligence` クレジット / `Recommended Betting Strategy` / 有料版風 CTA を含む。`[date].astro` での import / 使用禁止 |
| **KI 由来テキスト** | `Powered by Keiba Intelligence` | `AIRaceComment` 内の KI クレジット。削除済み・再復活禁止 |
| **KI 由来テキスト** | `Recommended Betting Strategy` | `AIBettingSection` 内の旧 KI 風買い目見出し。削除済み・再復活禁止 |
| **KI 由来テキスト** | `AI予想解説` / `AI買い目` / `AI振り返り` | KI 由来コンポーネントのラベル。free [date] では非表示・再復活禁止 |
| **KI 由来クラス** | `ai-comment-*` / `ai-betting-*` | `AIRaceComment` / `AIBettingSection` 由来クラス。削除済み・再復活禁止 |

## 維持する要素（廃止禁止）

| 要素 | 説明 |
|---|---|
| archive-banner | 「過去のアーカイブです」表示 |
| page-title / page-subtitle | 日付 + 会場名のヘッダー |
| venue-selector | 複数会場の場合の会場タブ（現状維持、別 PR でアコーディオン化検討予定） |
| race-selector / race-name-header | レース選択・レース名表示（同上） |
| **analytics 風 AIモデル選出馬カード** (`horse-card horse-card-{main/sub/tana}` + `horse-header` + `horse-identity` + `horse-mark-*` + `horse-number` + `horse-name` + `role-badge` + `horse-stats-row` + `stat-block` + `basic-info` + `eval-points` + `feature-importance` + `importance-*` + `recent-races recent-races-compact`) | PR-E で再構築。`free-prediction/jra.astro` の正規構造に準拠 |
| 累積スコア / AI総合指数 / 基本情報 / 評価ポイント / 特徴量重要度（安定性・能力上位性・展開利の 3 項目バー）/ 過去5走 | analytics 正規表示要素。維持 |
| **過去走データアコーディオン** (`history-details` / `history-summary` / `history-content` / `history-section*` / `history-profile-*` / `history-record-*` / `history-cond-*` / `history-list` / `history-row` / `hh-*`) | PR #40 で追加した表示専用 UI。集計関数は `buildHistoryAccordionContext` / `fmtHistoryCondStat` |
| archive-nav | 「最新の中央競馬予想を見る」「過去予想一覧に戻る」リンク |

## 触ってはいけない領域

- `keiba-intelligence` 側（**絶対に触らない**）
- `astro-site/src/data/predictions/**` （JSON データ）
- `astro-site/src/data/horseHistories/**` （JSON データ）
- `astro-site/scripts/importPrediction*.js` （取込ロジック）
- `astro-site/src/utils/featureScores.js` （特徴量計算）
- `astro-site/src/lib/loadHorseHistoriesJra.js` （horseHistories loader）
- `astro-site/src/lib/shared-prediction-logic.js` （予想ロジック）

## 検証スクリプト（再混入検知）

| script | 目的 | 失敗条件 |
|---|---|---|
| `npm run check:ki-relics:free-jra-date` | `[date].astro` への旧 KI 風混入検知 | 禁止文字列・クラスが 1 件でも見つかれば fail |
| `npm run check:ki-relics:free-jra` | `free-prediction/jra.astro`（無料 index）への旧 KI 風混入検知（PR-F1 で追加）| 同上 |
| `npm run check:safety` | 上記を含む全 safety check | いずれか失敗で fail |

### PR-F1 で対象拡張（2026-05-29）

`check:ki-relics:free-jra` の検査対象: `free-prediction/jra.astro`（無料 index）。  
PR-F1 で dead CSS 一掃 + guard 追加。

#### PR-F1 時点で検知する対象

- 検出する禁止クラス例: `.detailed-horse-card` / `.dhc-*` / `.qm-label` / `.qm-value` / `.feature-grid` / `.feature-bar` / `.feature-icon` / `.feature-title` / `.feature-value` / `.feature-item` / `.feature-label` / `.feature-bar-container` / `.feature-bar-center` / `.rank-badge-large` / 旧 `.recent-races-grid` / `.recent-race-item` / `.recent-race-details` / `.rr-*` / `.ai-comment-*` / `.ai-betting-*`
- 検出する禁止文字列例: `Powered by Keiba Intelligence` / `Recommended Betting Strategy` / `AI予想解説` / `AI買い目` / `AI振り返り` / `AIRaceComment` / `AIBettingSection` / `Feature Importance Analysis` / `Multi-Dimensional Performance Analysis` / `DEEP LEARNING PREDICTION` / `Win Prob` / `Model Certainty` / `Expected Value` ほか

#### PR-F1 時点で **意図的に検知対象外**（PR-F2 判断保留・恒久的な許可ではない）

- 文字列: `XGBoost` / `LSTM` / `Ensemble Neural Network`
- 関連クラス: `.tech-background` / `.tech-section-title` / `.tech-block` / `.tech-block-title` / `.tech-list` / `.tech-heading` 等

理由: 上記は `free-prediction/jra.astro` L1102-1144 の「AI予想の技術的背景」セクションで
現在も画面表示されており、無料南関側 (`free-prediction/nankan.astro`) にも同様セクションがある可能性が高い。
削除可否・南関側との同時対応の要否は **PR-F2 で判断**するため、PR-F1 では guard 検知対象外とした。

**PR-F2 で削除方針が確定したら、本セクションの「検知対象外」記述から該当項目を移し、
`check-no-ki-relics-free-jra.mjs` の BANNED リストにも追加する。**

なお `premium-prediction/jra.astro` 用の `check-no-ki-relics-premium-jra.mjs` では
`XGBoost` / `LSTM` / `Ensemble Neural Network` は **既に禁止対象**（`PREMIUM_JRA_RULES.md` 参照）。
PR-F2 はあくまで無料 JRA 側のスコープ判断であり、premium 側の既存禁止規定には影響しない。

これらは `.github/workflows/safety-check.yml` 経由で **PR / push to main で
自動実行**される（既存 `safety-check.yml` が `npm run check:safety` を呼ぶため）。

## 作業フロー（必須）

`/free-prediction/jra/[date]/` を修正する場合:

1. **作業前**: `cat astro-site/docs/FREE_JRA_RULES.md` で本ルールを再読
2. **作業中**: 旧 KI 風演出 (DEEP LEARNING PREDICTION / Feature Importance Analysis 等) を再追加しない
3. **作業後**: `npm run check:safety` を必ず実行
4. **push 前**: `npm run verify:safety` (build + safety) を推奨

### revert / コピペ時の注意

過去の commit に旧 KI 風ブロックが残っているコミットがある。`git revert` や
`git checkout <旧 commit> -- <path>` で復活させた場合も検知できるように
`check:safety` を CI で必須化している。**「一時的に無効化」は禁止**。

## 関連 commit (削除履歴)

| commit | 内容 |
|---|---|
| (PR-E) | 旧 KI 風 detailed-horse-card / dhc-* / qm-* / feature-* / 旧近走 grid を全削除。analytics 風 horse-card に再配置し、過去走データアコーディオン (PR #40) を維持 |

## 関連 PR

- PR #37: horseHistories loader 拡張 (`pickHistoryForDetails` / `historyForDetails` 注入)
- PR #38: premium JRA に過去走データ UI 追加
- PR #39: free JRA index に過去走データ UI 追加
- PR #40: free JRA `[date]` に loader 呼び出し + 過去走データ UI 追加
- PR-E: free JRA `[date]` から旧 KI 風表示を完全除去 + 過去走データ UI 再配置 + guard 追加（本ドキュメント追加）
- PR #43 (PR-F1): free JRA index `jra.astro` の dead CSS 一掃 + 専用 guard `check-no-ki-relics-free-jra.mjs` を追加
- PR #44 (PR-H-1): 未使用化された `AIRaceComment.astro` を削除（被参照ゼロのため）

## ルール改訂時の運用

- 本ドキュメント (`FREE_JRA_RULES.md`) と `CLAUDE.md` を同時に更新
- `scripts/check-no-ki-relics-free-jra-date.mjs` の BANNED リストも同時に更新
- 単独で「禁止文字列だけ追加」「ドキュメントだけ更新」は不整合の元になるため避ける

## 関連ドキュメント

- [`astro-site/docs/PREMIUM_JRA_RULES.md`](./PREMIUM_JRA_RULES.md): premium 側の同等ルール（先行整備済み）
- [`docs/jra-horse-histories-operation.md`](../../docs/jra-horse-histories-operation.md): horseHistories 仕様
- [`docs/cross-project-safety-rules.md`](../../docs/cross-project-safety-rules.md): クロスプロジェクト安全運用ルール
