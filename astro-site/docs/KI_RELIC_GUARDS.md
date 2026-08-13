# 旧 KI 風ブロック 再混入防止（guard 3 段防御）

> CLAUDE.md から集約（2026-08-13）。**ルールの正本はこのファイル**。
> ページ別の禁止リストは [PREMIUM_JRA_RULES.md](./PREMIUM_JRA_RULES.md) /
> [FREE_JRA_RULES.md](./FREE_JRA_RULES.md)。


`/premium-prediction/jra/` は keiba-intelligence (KI) からの fork 経緯で、
旧 KI 風の演出（Ensemble Neural Network / XGBoost×LSTM / Multi-Dimensional
Performance Analysis / WIN PROB / MODEL CERTAINTY 等）が長く残っていた。
2026-05-24 にこれらを段階的に削除し、**`/premium-prediction/nankan/` の
有料ページ構造に完全に寄せる**方針が集約された。

**今後の作業・revert・コピペ・テンプレート同期で旧 KI 風ブロックが復活しないよう
3 段の防御を入れる**:

### 1. ドキュメント化
詳細な禁止リスト・必須セクション・許可される維持要素・作業フローは
ページ別に集約。**修正前に必ず読む**。
- premium: `astro-site/docs/PREMIUM_JRA_RULES.md`
- free `[date]`（過去日アーカイブ）: `astro-site/docs/FREE_JRA_RULES.md`

### 2. grep 検査（再混入検知）

JRA 系ページごとに **対象スコープ・検知範囲が異なる**ため、ページ別に分けて記述する。
（共通: いずれも `check:safety` に組み込み済み・CI で強制実行）

#### 2-A. `premium-prediction/jra.astro`（有料）

`npm run check:ki-relics:jra` で検知。  
詳細禁止リストは [`PREMIUM_JRA_RULES.md`](./PREMIUM_JRA_RULES.md) を参照。  
代表的な禁止対象:
- 文字列: `AI Recommended Betting Strategy`, `Multi-Dimensional Performance Analysis`,
  `Ensemble Neural Network`, `XGBoost`, `LSTM`, `Cross-val`, `Win Prob`,
  `Model Certainty`, `Expected Value`, `Feature Importance Analysis`,
  `DEEP LEARNING PREDICTION`, `PRO MEMBER EXCLUSIVE`, `Inference Time`
- クラス: `.ai-model-card`, `.detailed-horse-card`, `.dhc-quick-metrics`,
  `.qm-label`, `.qm-value`, `.feature-grid`, `.feature-bar`, `.recent-races-grid`,
  `.recent-race-item`, `.rr-venue`, `formula-row`, `axis-mark`, `opponents-list`,
  `stat-stars-block`, `star-rating`

#### 2-B. `free-prediction/jra/[date].astro`（無料 過去日）

`npm run check:ki-relics:free-jra-date` で検知。  
詳細禁止リストは [`FREE_JRA_RULES.md`](./FREE_JRA_RULES.md) を参照。  
**A. 共通禁止対象**（PREMIUM と整合）に加えて、以下を**追加で検知**:
- 文字列: `Powered by Keiba Intelligence`, `Recommended Betting Strategy`,
  `AI予想解説`, `AI買い目`, `AI振り返り`, `AIRaceComment`, `AIBettingSection`
- クラス: `.ai-comment-*` (header / badge / label / sub / masked-* など),
  `.ai-betting-*` (header / badge / label / sub / toggle / masked-* など)

理由: KI 由来コンポーネント（Powered by Keiba Intelligence クレジット /
Recommended Betting Strategy 見出し / 有料版風 CTA）を含むため、
free JRA 過去日ページには載せない。
無料版の正規構造（`free-prediction/jra.astro` の `jra-race-accordion-list`）にはこれらは含まれない。

#### 2-C. `free-prediction/jra.astro`（無料 index、PR-F1 で追加）

`npm run check:ki-relics:free-jra` で検知。  
**B (free [date]) と同じ禁止対象**（共通禁止 + KI 由来コンポーネント）を検知。

ただし PR-F1 時点では以下を **意図的に検知対象外**としている（**恒久的な許可ではない・PR-F2 判断保留**）:
- 文字列: `XGBoost`, `LSTM`, `Ensemble Neural Network`
- 関連クラス: `.tech-background`, `.tech-section-title`, `.tech-block`,
  `.tech-block-title`, `.tech-list`, `.tech-heading` 等

理由: 上記は L1102-1144 の「AI予想の技術的背景」セクションで現在も画面表示されており、
無料南関側 (`free-prediction/nankan.astro`) にも同様セクションがある可能性が高く、
削除可否・南関側との同時対応の要否は **PR-F2 で判断**するため、
PR-F1 では guard 検知対象外とした。

**PR-F2 で削除方針が確定したら、本セクションの「検知対象外」記述から該当項目を移し、
guard の BANNED リストにも追加する。**

#### CI workflow ステップマトリクス（2026-05-29 / PR-J 集約）

`.github/workflows/safety-check.yml` の `jobs.safety.steps` で **3 つの ki-relics guard すべてが PR / push to main で個別 step として CI 実行される**。

| step 名 | npm script | 検査対象 |
|---|---|---|
| Verify premium JRA 旧 KI 風混入なし | `check:ki-relics:jra` | `premium-prediction/jra.astro` |
| Verify free JRA [date] 旧 KI 風混入なし | `check:ki-relics:free-jra-date` | `free-prediction/jra/[date].astro` |
| Verify free JRA index 旧 KI 風混入なし | `check:ki-relics:free-jra` | `free-prediction/jra.astro` |

paths フィルターにも対応する guard スクリプト 3 ファイルが追加済み (PR-J / #46)。guard スクリプト単独修正の PR でも workflow が起動し、該当 step が CI 上で実際に実行される。

**新規 guard を追加する場合の手順**:
1. `astro-site/scripts/check-no-ki-relics-XXX.mjs` を作成
2. `astro-site/package.json` の `check:safety` に組み込み
3. `.github/workflows/safety-check.yml` の `pull_request.paths` / `push.paths` に追加
4. **`jobs.safety.steps` にも個別 step として追加**（paths だけでは CI 実行されない）

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

### 🔒 旧 KI 風除去 / guard 強化 系列の保留・禁止事項（2026-05-29 集約）

旧 KI 風除去・guard 強化系列は **PR #41〜#46 / #45 で一段落**。以後の関連タスクは下表の保留・除外区分に従う。

#### 触ってはいけないコンポーネント

- `astro-site/src/components/AIBettingSection.astro` は **削除禁止**。`src/pages/prediction/[slug].astro`（南関 SSR 動的ページ・OOI / URAWA / FUNABASHI / KAWASAKI）で現役使用中のため、削除すると build / SSR が落ちる。premium-prediction/jra.astro / 無料 JRA から再 import するのも禁止（guard で検知）。

#### 保留 / 凍結 / 除外

| 候補 | 状態 | 理由 |
|---|---|---|
| **PR-F2** | 保留（着手可能・要判断）| `free-prediction/jra.astro` の tech-background (XGBoost / LSTM / Ensemble Neural Network) 削除可否 + `free-prediction/nankan.astro` 側との同時対応の要否判断が必要 |
| **PR-H-2** | **無期限保留** | AIBettingSection.astro 削除は南関 prediction 系の刷新方針確定まで凍結 |
| **PR-G2** | **候補から除外** | 上部 UI / 会場切替 / 余白 / 角丸デザイン統一は本番目視で問題なし。崩れが出た場合のみ別途対応 |
| **PR-K** | 低優先度 | `check:jra-nankan-parity` / `check:prediction-integrity` の `safety-check.yml` 組み込み。`check:prediction-integrity` は既存問題（検査対象 0 件で失敗）があるため、まず原因調査が先 |

