# /premium-prediction/jra/ 恒久ルール（再発防止）

最終更新: 2026-05-24

## 背景

`/premium-prediction/jra/` は keiba-intelligence (KI) から fork した経緯があり、
旧 KI 風の演出（Ensemble Neural Network / XGBoost×LSTM / Multi-Dimensional
Performance Analysis / WIN PROB / MODEL CERTAINTY 等）が長く残っていた。

これらを段階的に削除し、`/premium-prediction/nankan/` と同一の有料ページ構造に
寄せる方針が 2026-05-24 に集約された。本ドキュメントは、その方針を恒久ルールとして
固定化し、今後の作業・revert・コピペ・テンプレート同期で旧 KI 風ブロックが
復活しないようにするためのもの。

## 方針

- `/premium-prediction/jra/` は `/premium-prediction/nankan/` の有料ページ構造に**完全に寄せる**。
- nankan を「正解テンプレート」として扱い、jra で乖離した場合は jra 側を修正する。
- **keiba-intelligence は別サービスとして独立運用**。AK と KI のロジック・表示を
  自動的に同期しない（独立運用方針は CLAUDE.md「KI 独立運用方針」参照）。
- 維持する要素（買い目、的中実績、回収率、過去走、累積スコア、特徴量重要度、
  AI総合指数）は廃止しない。
- 廃止する要素（旧 KI 風演出）は二度と復活させない（**別名での復活も禁止**）。

## 廃止済み（再復活禁止）ブロック / 文字列 / クラス

| 区分 | 対象 | 理由 |
|---|---|---|
| 英語演出フレーズ | `AI Recommended Betting Strategy` | 旧 KI 風買い目見出し。「AI推奨買い目」を使う |
| 英語演出フレーズ | `Multi-Dimensional Performance Analysis` / `多次元パフォーマンス分析` | 全頭分析テーブル。二重表示原因 |
| 英語演出フレーズ | `Ensemble Neural Network` | ML 演出 |
| 英語演出フレーズ | `XGBoost`, `LSTM` | ML 演出 |
| 英語演出フレーズ | `Cross-val`, `Cross-validation` | ML 演出 |
| 英語演出フレーズ | `Validation Accuracy` | ML 演出 |
| 英語演出フレーズ | `Training Loss` | ML 演出 |
| 英語演出フレーズ | `Feature Importance Analysis` (英語 6 軸見出し) | 旧 KI 風 6 軸演出 |
| 英語演出フレーズ | `DEEP LEARNING PREDICTION` | 旧 KI 風バッジ |
| 英語演出フレーズ | `PRO MEMBER EXCLUSIVE` | 旧 KI 風バッジ |
| 英語演出フレーズ | `Inference Time` | ML 演出 |
| 英語演出フレーズ | `CROSS-VAL` (見出し版) | 旧 KI 風指標 |
| 詳細分析テーブル | `Win Prob`, `Model Certainty`, `Expected Value` | 全頭分析テーブル英語指標。本命・対抗・単穴と二重表示 |
| 詳細分析テーブル | `Risk /` (qm-label 内) | 全頭分析テーブル Risk 指標 |
| 旧クラス | `.ai-model-card` | KI 風モデル説明カード |
| 旧クラス | `.detailed-horse-card` | KI 風詳細カード |
| 旧クラス | `.dhc-quick-metrics`, `.qm-label`, `.qm-value` | KI 風 metrics 表 |
| 旧クラス | `.dhc-header`, `.dhc-main-info`, `.dhc-info-card`, `.dhc-title-line`, `.dhc-jockey-trainer` | KI 風カード |
| 旧買い目クラス | `formula-row`, `axis-mark`, `opponents-list`, `opponent-paren` | KI 風買い目フォーマット。nankan 統一 `bet-item` を使う |
| 著作権配慮 | `stat-stars-block`, `star-rating` (★★★★ + (85) 表示) | JRA premium は累積スコアのみ表示。星評価は廃止 |

## 必須セクション（nankan と同一の構造）

`premium-prediction/jra.astro` に**常に存在しなければならない**要素:

| セクション | キー | 出現位置 |
|---|---|---|
| AI分析完了バッジ | `.ai-badge`, `ai-status` | header-section 内 |
| リッチタイトル | `.race-title` | header-section 内 |
| 穴馬抽出ツールバナー | `.dark-horse-link-section`, `/dark-horse-picks/` | ヘッダー直下 |
| プレミアム会員限定コンテンツ バッジ | `.premium-status` | 穴馬バナー直下 |
| 本日の傾向分析（会場ごと） | `.daily-analysis-section` | venue-content 内 |
| AI推奨買い目（統一カード） | `.recommendation-section`, `.unified-bet-card` | レースごと |
| 買い目リスト | `.bet-list`, `.bet-item` | unified-bet-card 内 |
| 連下候補ミニカード | `.minor-group-renka`, `.minor-horse-card-renka` | AI選出馬分析内 |
| 抑え候補ミニカード | `.minor-group-osae`, `.minor-horse-card-osae` | AI選出馬分析内 |
| 不要馬・見送り馬 | `.ineligible-section` | AI選出馬分析内 |
| 抑え判定 (単一源) | `isOsaeCandidate` import | フロントマター |
| 不要馬判定 (単一源) | `isIneligibleHorse` import | フロントマター |

## 維持する要素（廃止禁止）

- 累積スコア (pt)
- AI総合指数 (raw computerIndex - 1 の表示)
- 特徴量重要度 (安定性 / 能力上位性 / 展開利)
- 基本情報 (騎手 / 調教師 / 斤量 / 性齢 / 父)
- 評価ポイント (eval-tag)
- 過去走 (recent-races)
- 買い目 (馬単 10 点ロジック / 通常レース本命軸+対抗軸)
- 的中実績 / 回収率（archiveResults 由来）
- 連下候補・抑え候補・不要馬の分類

## 触ってはいけない領域

- `keiba-intelligence` 側（**絶対に触らない**）
- `astro-site/src/data/predictions/**` （JSON データ）
- `astro-site/scripts/importPrediction*.js` （取込ロジック）
- `astro-site/src/utils/featureScores.js` （特徴量計算）
- `astro-site/src/utils/osaeClassification.js` （抑え判定の単一源）
- `astro-site/src/lib/shared-prediction-logic.js` のうち、再エクスポート以外

## 検証スクリプト（再混入検知）

| script | 目的 | 失敗条件 |
|---|---|---|
| `npm run check:ki-relics:jra` | 旧 KI 風ブロックの混入検知 | 禁止文字列・クラスが 1 件でも見つかれば fail |
| `npm run check:jra-nankan-parity` | nankan 構造パリティ検証 | jra から必須セクションが 1 つでも欠ければ fail |
| `npm run check:safety` | 上記を含む全 safety check | いずれか失敗で fail |

これらは `.github/workflows/safety-check.yml` 経由で **PR / push to main で
自動実行**される（既存 `safety-check.yml` が `npm run check:safety` を呼ぶため）。

## 作業フロー（必須）

`/premium-prediction/jra/` を修正する場合:

1. **作業前**: `cat astro-site/docs/PREMIUM_JRA_RULES.md` で本ルールを再読
2. **作業中**: nankan.astro と diff を取り、構造の乖離を最小化
3. **作業後**: `npm run check:safety` を必ず実行
4. **push 前**: `npm run verify:safety` (build + safety) を推奨

### revert / コピペ時の注意

過去の commit に旧 KI 風ブロックが残っているコミットがある。`git revert` や
`git checkout <旧 commit> -- <path>` で復活させた場合も検知できるように
`check:safety` を CI で必須化している。**「一時的に無効化」は禁止**。

## 関連 commit (削除履歴)

| commit | 内容 |
|---|---|
| `a01b0a2` | DEEP LEARNING バッジ / Ensemble Neural Network / XGBoost+LSTM / CROSS-VAL / Feature Importance 6 軸演出を削除 |
| `f6a0dcc` | AI Recommended Betting Strategy 見出し / 星評価 / 「指数」→「AI総合指数」/ Multi-Dimensional Performance Analysis を削除し、連下/抑え/不要馬セクションを nankan から移植 |
| `84e0412` | ヘッダーを nankan 風にリッチ化 (AI分析完了バッジ / ai-metrics 4枚 / 穴馬バナー / プレミアムバッジ / 本日の傾向分析) |
| `42f9600` | AI推奨買い目を nankan 統一 unified-bet-card 形式に書き換え |
| `1655f13` | 買い目非表示バグ修正 + renkaList から不要馬補欠を除外 (isOsaeCandidate 単一源) |
| `c16bc13` | 連下/抑え/不要馬ミニカードの CSS を nankan から移植 |

## ルール改訂時の運用

- 本ドキュメント (`PREMIUM_JRA_RULES.md`) と `CLAUDE.md` を同時に更新
- `scripts/check-no-ki-relics-premium-jra.mjs` の BANNED リストも同時に更新
- `scripts/check-jra-nankan-structure-parity.mjs` の REQUIRED リストも同時に更新
- 単独で「禁止文字列だけ追加」「ドキュメントだけ更新」は不整合の元になるため避ける
