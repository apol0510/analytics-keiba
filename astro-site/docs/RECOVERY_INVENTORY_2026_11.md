# 回収率関連の記載 棚卸し（2026-11-06）

新しい回収率の算定方式へ移る準備として、AK の回収率関連の記載を全件確認した。
方式の状態は `BET_POINT_LOGIC.md`「回収率の算定方式の状態」が正本。購入回収率の新方式の名称と数値はここに書かない。
旧 4 段階方式の復元値は `BET_POINT_LOGIC.md`「旧 4 段階方式の復元」。

## 調べた範囲

| 対象 | 方法 | 結果 |
|---|---|---|
| 本番の公開画面 | sitemap の全 URL と主要ページ、計 353 URL を取得（全部 200）。本文・meta・JSON-LD を検索 | AK の回収率の数値は 0 件。`recoveryRate` も HTML に 0 件 |
| ログイン後のページ | ソースで確認（Light・Premium は本番で未ログインのため見ていない） | 表示はすべて `publicRate` を通る |
| ソース・テスト・正本 | `origin/main` `dd27dafa` を検索。`回収率` は 136 ファイル 498 行 | 下の表 |
| Airtable ScheduledEmails | 5,239 行の本文を検索（PENDING 3 件を含む） | 0 件 |
| SendGrid Single Send | 42 件の本文を検索 | 2 件（下の表）。Automations は API が 403 で未確認 |
| 未マージ PR | #867・#869・#871・#872・#873 | 下の表。KAO の handoff に #871・#872 は無い |

画像の中の文字は検索していない。

## 分類

| 分類 | 対象ファイル | 記載内容 | 対応 | 公開影響 |
|---|---|---|---|---|
| 公開中 | `public/seo/*` 32 ページ | `+87,400円`・累計収支・収支ログ（120R × 1,000 円で回収率 173% に相当） | **置換済み**: 検証レース数・毎日の結果公開と実績ページへの導線へ。収支ログは複勝・ワイドの記録で archive と照合できないので戻さない | 収支の訴求が消え、情報量と導線は残る |
| 公開中 | `src/pages/free-prediction/archive.astro` | 「戦略別の回収率を比較」 | **撤去済み** | 1 行消える |
| 公開中 | `/archive/*`・`/results-showcase/*`・トップ（`AI_POINTS_NOTE`・合計購入点数） | 購入点数（本線＋抑えの全組）と合計配当 | **現状維持**（2026-11-06 MK 決定） | 非採用の回収率を読者が計算できる（中央 10/31: ¥33,410 ÷ 788 点 = 42.4%） |
| 公開中 | `public/seo/keiba-kaishuuritsu-ageru`・`keiba-shoshinsha-kachikata`・`keiba-fukushou-kotsu-kachikata` | 「回収率100%超え」「回収率150%を目指す」 | **置換済み**: 「回収率を上げる」「回収率アップ」へ。検索語の「回収率」は残す | title と meta の数値が消える |
| 公開中 | `src/pages/beginner/lesson-03.astro` | 的中率 76.2% | 残す（別用途の統計。回収率ではない。中央の 76.2% とは別の値） | なし |
| 公開中 | `public/seo/*`（`回収率80%以下`・`回収率70〜85%`） | 読者の現状の例え | 残す（別用途の統計） | なし |
| 公開中 | `src/pages/blog/**`・`course.astro`・`BettingSelectionQA.astro`・`keiba-ai-yosou-*` | 「回収率重視の予想」など数値のない語 | 残す（別用途の統計） | なし |
| 公開中 | `NankanHorseStatsPanel.astro` | 馬の条件別回収率 | 残す（別用途の統計） | なし |
| 現行仕様 | `docs/spec.md` | 代表値 回収率 73%、revert で戻す手順、10/6 の式 | **修正済み**: 公式は未確定と明記 | なし |
| 現行仕様 | `astro-site/docs/BET_POINT_LOGIC.md` | 式の矛盾、73%、「本番未反映」の古い記載、4 段階方式 | **修正済み**: 状態の節を追加し、検証値を末尾へ分離 | なし |
| 現行仕様 | `recoveryVisibility.js` | 「再表示するときは true にする」 | **修正済み**: true で非採用の値が出ると明記 | なし |
| 現行仕様 | `aiBetPoints.js` | 回収率の式の説明と `AI_RECOVERY_DISCLOSURE` | **修正済み**: コメントのみ。計算は変えていない | なし |
| 現行仕様 | `fixedMarketingStats.test.mjs` | 73% 前提の説明 | **修正済み**: 再混入を止めるテストを追加 | なし |
| 現行仕様 | `src/lib/newsletter/step-sequences.js` | 「回収率をアーカイブで公開」 | **修正済み**（この系統は 2026-09-14 に停止済み） | 送信なし |
| 現行仕様 | `src/pages/{archive*,results-showcase/*,index,light-*,premium-*}`・`Cumulative*` | `publicRate` 付きの回収率表示 | 残す（非公開。新方式で再利用） | なし |
| 現行仕様 | `importResults*.js`・`archive*.json` の `returnRate`・`recoveryRate` | 1 レース 5 点固定の内部値 | 残す（元データ） | なし |
| 現行仕様 | `src/pages/light-predictions.astro` `weeklyResults.recoveryRate: 209` | 画面で使っていない値 | 残す（表示なし） | なし |
| 別用途の統計 | `premiumPlusShowcase.js`・`admin/premium-plus-images.astro` | Premium Plus の回収率。公開カードは 2026-09-08 から非掲載 | 残す | なし |
| 別用途の統計 | `admin/results-manager*.astro` | 三連複の入力画面の回収率 | 残す | 管理画面のみ |
| 過去の検証記録 | `BET_POINT_LOGIC.md` 末尾 | 少点数 74.8% など、71.8% / 66.5%、68.2% / 70.8% | 履歴へ分離 | なし |
| 過去の検証記録 | `docs/decisions.md`・`docs/progress.md` の過去の節 | 126%・156% など | 残す（履歴） | なし |
| 過去の検証記録 | `src/pages/beginner/lesson-01,02,04,05,06,07` | 193.9% など | 残す（本番は `/beginner/` へ転送中） | なし |
| 過去の検証記録 | SendGrid Single Send 2 件（2026-02-26） | 「平均回収率」。送信済み 1 件と下書き 1 件 | 残す（下書きは再利用しない） | 下書きは未配信 |
| 未マージ | #871（Draft） | 現金回収率 66.8% / 76.2% と AI算定指標を公開 | **merge しない** | 本番に影響なし |
| 未マージ | #872 | 10/6 の式を AI算定指標として保持 | **merge しない** | 本番に影響なし |
| 未マージ | #873（未 merge で close） | AI選定回収率 71.8% / 66.5%・`ak-select-v1` | **再開しない** | 本番に影響なし |
| 未マージ | #867（conflict） | 回収率は理論値、の注記 | 非公開中は不要。新方式の決定後に判断 | 本番に影響なし |
| 未マージ | #869 | 期待値フィルターの検証（表示の変更なし） | 新方式の検討材料。公式化しない | 本番に影響なし |

## 再混入の防止

`npm run test:marketing-stats`（`check:safety` に組込）が、公開面の方式名・非採用の数値・`87,400` 等と、
`RECOVERY_RATE_PUBLIC=true` への切替、公開面からの `legacySimulation.js` の import を検知して失敗する。
