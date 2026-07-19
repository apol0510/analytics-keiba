# Project Specification

本書は `analytics-keiba` リポジトリの **仕様の正本（canonical）** である。

**正本の役割分担（重要）**

| 文書 | 役割 | 正本の範囲 |
|---|---|---|
| `docs/spec.md`（本書） | 仕様の正本 | リポジトリ全体の責務境界・アーキテクチャ・完成条件・禁止事項 |
| `CLAUDE.md` | 運用ルールの正本 | AI 作業ルール・恒久ルール・安全条件。本書と重複する箇所は **CLAUDE.md の記述が優先** |
| `astro-site/docs/*.md` | 各ドメイン詳細仕様の正本 | 予想ロジック / 認証 / 決済メール / Premium Plus / safety checks 等の詳細 |
| `docs/*.md`（既存） | 個別方針・履歴 | UI 横断ポリシー、会員階層、決済手段、保守履歴、穴馬抽出タスク計画 |
| `docs/progress.md` | 進捗の正本 | 現在地・残作業 |
| `docs/decisions.md` | 設計判断の正本 | 採用済み判断とその根拠 |

本書は既存文書を **置き換えない**。詳細は各ドメイン文書を参照し、本書は境界と全体像のみを定義する。

> **重要（2026-07-20 時点）**: `docs/spec.md` / `docs/progress.md` / `docs/decisions.md` の 3 文書は
> **branch `docs/autonomous-project-workflow`（PR #143）上にのみ存在し、`main` には未マージ**である。
> したがって現時点でリポジトリ恒久の正本ではなく、**PR がマージされて初めて正本として機能する**。
> マージ前にこれらを「リポジトリの正本」として他文書から参照しないこと。
> `CLAUDE.md` と `astro-site/docs/*.md` は main 上に存在する既存の正本である。

---

## 1. Purpose

南関競馬（NANKAN）と中央競馬（JRA）を統合した **AI 予想コンテンツの Web 配信＋会員課金プラットフォーム**。

- 本番 URL: `https://analytics.keiba.link/`（`CLAUDE.md` §本番 URL ルール）
- 旧ドメインからの移行途上（`README.md` は「移行中」表記のまま。301 切替の完了状況は 未確認）

このリポジトリは **予想データの「消費側・表示側・課金側」** である。予想データの生成・入力そのものは行わない（§3 参照）。

## 2. Responsibilities

証拠に基づき、本リポジトリが担う責務は以下。

1. **予想データの取込（consumer）**
   - `keiba-data-shared-admin` からの `repository_dispatch`（`prediction-updated` / `prediction-jra-updated` / `nankan-results-updated` / `jra-results-updated`）を受け、GitHub Actions で取込む。
   - 取込スクリプト: `astro-site/scripts/importPrediction{,Jra}.js` / `importResults{,Jra}.js` / `importResultsJraSanrenpuku.js` / `importHorseHistoriesJra.js` / `importRecentHorseHistoriesNankan.js` / `importEntriesNankan.js` / `importFeatureScores.js` / `importComputer.js`
   - 出力先: `astro-site/src/data/archive{,Jra}.json` / `archiveResults{,Jra}.json` 等（リポジトリへ自動 commit / push）
2. **予想の加工・役割決定・買い目生成**
   - `analyticsScore = computerIndex×0.5 + featureScore×0.3 + markScore×0.2` によるデータ主導の本命/対抗/単穴決定（詳細正本: `astro-site/docs/PREDICTION_LOGIC.md`）
   - メインレース買い目は **一方向馬単「本命→相手5頭」= 最大5点**（`astro-site/src/utils/mainRaceBetting.js`）
   - 抑え/不要馬判定の単一源: `astro-site/src/utils/osaeClassification.js`
   - 特徴量算出: `astro-site/src/utils/featureScores.js`
3. **Web 配信（Astro 5 SSR / Netlify）**
   - 4 領域（JRA free / JRA premium / NANKAN free / NANKAN premium）＋ light 系を含む計 6 経路（`docs/ui-cross-plan-regression-policy.md`）
   - アーカイブ / 実績ショーケース / 穴馬抽出 / Premium Plus 等の周辺ページ
4. **会員認証・アクセス制御**
   - マジックリンク方式ログイン（`/login` → SendGrid → `/auth/verify`）。詳細正本: `astro-site/docs/AUTH_LOGIN.md` / `AUTH_SESSION_DESIGN.md`
   - `AccessControl.astro` によるプラン別出し分け
5. **課金・入金確認フロー**
   - 現行の主導線は **銀行振込**（`docs/PAYMENT_SYSTEM.md`）。判定の単一源は `astro-site/src/lib/payments/bankPaymentFlow.js`
   - 入金確認メール v2（状態機械 + worker + reconciler）を設計・実装中。詳細正本: `astro-site/docs/PAYMENT_EMAIL_V2.md`
6. **恒久ルールの CI 強制（safety check）**
   - `.github/workflows/safety-check.yml` と `npm run check:safety`。詳細正本: `astro-site/docs/SAFETY_CHECKS.md`

## 3. Non-responsibilities

以下は **本リポジトリの責務ではない**。混同して実装を持ち込んではならない。

- **予想データの入力・管理 UI**: `keiba-data-shared-admin`（`/admin/computer-manager` = 予想本体、`/admin/race-data-importer` = 補完情報）が担う。
- **共有データストアの管理**: `keiba-data-shared`（`{cat}/predictions/computer/...` / `{cat}/racebook/...` の格納先）。本リポジトリは読み取り consumer。
- **`keiba-intelligence` の実装・修正**: 2026-05-23 以降 **別サービスとして独立運用**。本リポジトリのロジック修正を自動横展開しない（`CLAUDE.md` §keiba-intelligence との関係）。
- **予想ロジックの ML モデル学習・推論基盤**: 本リポジトリの予想は取込済みコンピ指数＋特徴量スコアの決定論的合成であり、モデル学習は行わない。
- **dispatch の発火判断**: ペア揃いガードは入力側（admin）の `netlify/lib/pair-guard.mjs` が担う。本リポジトリ側は取込側の追加防御のみ。
- **メルマガ配信基盤そのもの**: SendGrid Marketing Campaigns が担う（本リポジトリは連携のみ）。

## 4. Current Architecture

```
keiba-data-shared-admin（入力 UI）
  │ [ペア揃いガード] racebook + computer 両方が揃ったときのみ発火
  ↓ repository_dispatch
.github/workflows/import-*.yml（本リポジトリ）
  │ [中身 date 検証ガード] ファイル名日付ではなく中身 date が一致するもののみ採用
  ↓
astro-site/scripts/import*.js
  ↓
astro-site/src/data/archive{,Jra}.json ほか（自動 commit / push）
  ↓
Netlify 自動ビルド → https://analytics.keiba.link/
```

### ディレクトリ構成

| パス | 内容 |
|---|---|
| `astro-site/` | メインサイト（Astro 5 SSR + Netlify adapter）。ビルド base |
| `astro-site/src/pages/` | ページ（free/light/premium × JRA/NANKAN、archive、premium-plus 等） |
| `astro-site/src/lib/` | 純粋ロジック層（auth / payments / entitlements / darkHorse / sanrenpuku / pricing / premiumPlus 等） |
| `astro-site/src/utils/` | 予想ロジック（featureScores / osaeClassification / mainRaceBetting / adjustPrediction） |
| `astro-site/src/data/` | 取込済み予想・結果 JSON |
| `astro-site/netlify/functions/` | Netlify Functions（認証・決済・admin・canary 等） |
| `astro-site/scripts/` | 取込スクリプト・検証スクリプト（`check-*` / `verify-*`） |
| `nankan-stripe-integration/` | 決済連携（Stripe / Supabase）。仕様は `nankan-stripe-integration/docs/stripe-spec.md` |
| `.github/workflows/` | 取込・検証・安全チェックの自動化 |

### ビルド・デプロイ

- `netlify.toml`: base `astro-site` / publish `dist` / command `npm run build` / `NODE_VERSION=22`
- `npm run build` = `validate:archive` → `astro build` → `scripts/prune-ssr-function-data.mjs`（SSR Function 250MB 上限対策）
- `netlify.toml` に旧 URL → 新 URL の 301 リダイレクト群（予想ページ再編・アーカイブ階層統一）

### GitHub Actions（`.github/workflows/`）

`import-on-dispatch.yml` / `import-results-on-dispatch.yml` / `import-computer-on-dispatch.yml` / `import-entries-nankan-on-dispatch.yml` / `import-feature-scores-on-dispatch.yml` / `import-horse-histories-on-dispatch.yml` / `import-horse-stats-nankan-on-dispatch.yml` / `import-recent-horse-histories-nankan-on-dispatch.yml` / `import-prediction-daily.yml` / `import-results-jra{,-daily}.yml` / `import-results-nankan-daily.yml` / `archive-sync.yml` / `auto-sync-check.yml` / `verify-archive-sync.yml` / `check-publish-drift.yml` / `safety-check.yml`（`disabled/` 配下に無効化済みのものあり）

Concurrency Group: 南関 `archive-nankan-update` / JRA `archive-jra-update`。

## 5. External Dependencies

| 依存 | 用途 | 備考 |
|---|---|---|
| Netlify（Pro） | ホスティング / Functions / Blobs | Premium Plus 実績画像は Netlify Blobs 上（git に置かない） |
| Airtable（Pro） | 顧客管理（Customers） | Automation 2 本が入金確認フローに関与。Base の共有範囲は 未確認 |
| SendGrid | マジックリンク送信 / 確認メール / Marketing Campaigns | v2 では Event Webhook 併用設計 |
| Google Gemini 2.5 Flash | AI 解説生成 | `@google/generative-ai` |
| Stripe | 決済連携（`nankan-stripe-integration/`） | 現行 pricing 導線は銀行振込のみ案内 |
| Upstash Redis | 入金確認メール v2 の fencing token / lease | `astro-site/docs/PAYMENT_EMAIL_V2.md` の確定方針 |
| GitHub Actions / repository_dispatch | データ取込トリガ | 送出元は `keiba-data-shared-admin` |
| `keiba-data-shared` | 予想・結果 JSON の共有ストア | 読み取り側 |

### 環境変数（**名称のみ**。値は一切記載しない）

`AIRTABLE_API_KEY` / `AIRTABLE_BASE_ID` / `SENDGRID_API_KEY` / `SENDGRID_FROM_EMAIL` / `GEMINI_API_KEY` / `GITHUB_TOKEN` / `GITHUB_REPO_OWNER` / `GITHUB_REPO_NAME` / `GITHUB_BRANCH` / `SENDGRID_CUSTOM_FIELD_ANALYTICS` / `PAYMENT_CONFIRM_SECRET`（production context 設定済み）/ `ALERT_EMAIL`

- `.env.example` は **リポジトリに存在しない**（証拠未確認：環境変数の網羅一覧は `CLAUDE.md` §Netlify環境変数 と各 Function の参照が唯一の根拠）。
- secret / token の **値** をコード・ログ・commit・本書に記載することは禁止。

## 6. Contracts and Compatibility

### 入力契約（keiba-data-shared → 本リポジトリ）

- パス規約: `{cat}/predictions/computer/YYYY/MM/YYYY-MM-DD-{CODE}.json`（予想本体）、`{cat}/racebook/YYYY/MM/YYYY-MM-DD-{CODE}.json`（補完情報）
- **両方揃って初めて完全な予想ページが描画できる**（ペア揃いガードの前提）
- 取込側は **中身 `date` が指定日と一致するもののみ採用**。±1日マージロジック自体は維持する（2026-05-15 案件の救済機能）

### 保存フォーマット契約（後方互換）

| 禁止（旧） | 必須（新） |
|---|---|
| `raceResults` | `races` |
| `honmeiHit` | `isHit` |
| `umatanHit` | `hitLines` |
| `sanrenpukuHit` | （廃止） |

検証: `npm run validate:archive`

### 買い目表記の互換規約

- `→` = 一方向馬単（メインレース新仕様、2026-07-09〜）。裏目は不的中
- `↔` / `⇔` / `-` = 双方向（過去 archive 救済・通常レース用）
- **過去 archive は再判定しない**。旧 `↔` エントリは旧仕様のまま据え置く

### 表示契約

- 表示指数は必ず **raw − 1**。`getDisplayComputerIndex` / `formatDisplayComputerIndex` 経由必須（`astro-site/src/lib/shared-prediction-logic.js`）
- 全レースプレビューで **表示分類合計 == 出走頭数**（不要馬セクションを消さない）

### URL 契約

`netlify.toml` の 301 リダイレクト群は既存被リンク・メルマガ既発信リンクの互換維持。新 URL を巻き込まないよう `from` は exact 一致 or 明示 splat のみ。

## 7. Security and Production Boundaries

- **secret / token / 認証値の実値**をコード・ドキュメント・ログ・commit に記載しない（`CLAUDE.md` §PAYMENT_CONFIRM_SECRET に明記）
- `confirm-bank-payment` は公開 URL。認可は「Airtable の `PaymentConfirmed=true` 再読込検証」＋「`x-confirm-secret` ヘッダ認証」の二重。**fail closed**
- Premium Plus admin write は production 判定で hard block（commit `3b8c908`）
- カナリア検証は **専用 Airtable Base / Table / PAT に完全分離**し production Customers に触れない（commit `924a9d0` / `e1e730c`）
- Netlify サブドメイン（`*.netlify.app`）は Deploy Preview 専用。本番案内に使わない
- **高リスク操作の一覧と停止境界は `CLAUDE.md` §High-risk approval boundary が単一源**。本書では重複記載しない。

## 8. Completion Criteria

作業単位の完成条件は以下をすべて満たすこと。

1. **4 領域横断確認**: JRA free / JRA premium / NANKAN free / NANKAN premium。UI 修正は light を含む **6 経路**（`docs/ui-cross-plan-regression-policy.md`）
2. 一領域のみを対象とする場合、対象範囲 / 対象外範囲 / 対象外にした理由 / 影響可能性を明記していること（明記なしの片側 push は禁止）
3. `npm run check:safety` が pass すること（予想表示・馬分類を変更した場合は必須）
4. push 前は `npm run verify:safety`（build + safety）を推奨
5. 数値を変更した場合は修正前後の比較を表形式で提示すること
6. commit 前に `git diff` を確認していること
7. 仕様変更を伴う場合、コードと対応 MD の **両方**を更新していること（`PREDICTION_LOGIC.md` / `BET_POINT_LOGIC.md` 等）
8. 本番反映前に確認方法（正規の本番 URL）を提示していること

## 9. Validation

`astro-site/` で実行する。

| コマンド | 内容 |
|---|---|
| `npm run build` | validate:archive → astro build → SSR data prune |
| `npm run typecheck` | `astro check` |
| `npm run lint` | `eslint . --ext .js,.jsx,.ts,.tsx,.astro` |
| `npm run validate:archive` / `validate:prediction` | JSON スキーマ検証 |
| `npm run check:safety` | 恒久ルール＋主要ユニットテストの直列実行 |
| `npm run verify:safety` | `build` → `check:safety` |
| `npm run check:no-raw-index` / `check:display-index` | 指数表示 raw−1 の強制 |
| `npm run check:horse-sections` | 全頭分類（合計 == 出走頭数） |
| `npm run check:ki-relics:*` | 旧 keiba-intelligence 風ブロック再混入の検知 |
| `npm run check:jra-nankan-parity` | JRA 有料版が NANKAN 有料版の構造に揃っているか |
| `npm run test:auth-session` / `test:bank-payment` / `test:entitlements` / `test:premium-plus` / `test:dark-horse` / `test:sanrenpuku-cta` / `test:pricing-tiers` / `test:nankan` / `test:contact-autofill` | 各ドメインのユニット/ガードテスト |

CI: `.github/workflows/safety-check.yml`（PR / push to main / workflow_dispatch）。**一時的に検証を無効化することは禁止**。

既知の問題: `check:prediction-integrity` は「検査対象 0 件で失敗」する既存問題があり、`safety-check.yml` へは未組込（`CLAUDE.md` PR-K 記載）。

## 10. Prohibited Changes

- 旧フォーマット（`raceResults` / `honmeiHit` / `umatanHit` / `sanrenpukuHit`）の復活
- 指数の raw 直接表示（JSX への `{horse.computerIndex}` / `{horse.sourceComputerIndex}` 直出力）
- 不要馬セクションの削除・全頭分類の破壊
- ±1日マージロジックの削除 / 中身 date 検証ガードの無効化（**両方で 1 セット**、片方だけ無効化しない）
- safety check の一時無効化・スキップ
- `keiba-intelligence` へのロジック自動横展開、および 2026-05-22 以前の同期義務の復活
- Premium Plus 実績画像のハードコード方式（`public/upsell-images/upsell-YYYYMMDD.png` + sed）復活
- Premium Plus の実績数値の手書き（`computeStats()` の戻り値以外を出さない）
- Premium Plus CTA を Premium / Light / 無料ページへ設置すること
- `analytics.keiba.jp` の使用、Netlify サブドメインの本番案内、本番 URL の推測生成
- secret / token の実値をコード・ドキュメント・ログへ記載
- `paypal-webhook.js` / `send-payment-confirmation.js` を `PaymentEmailSent: true` の同時書込みなしに復活させること（確認メール 2 通の既知リスク）
- Airtable Automation「入金確認メール自動送信」の監視 Fields を空欄に戻すこと
- `CLAUDE.md` §保留・禁止事項（PR-H-2 / PR-G2 等）で凍結された変更の再開

## 11. Known Unknowns

- **`.env.example` が存在しない**。環境変数の完全な一覧・必須/任意の区別は証拠未確認。
- `nankan-stripe-integration/` の現在の稼働状況（本番で使われているか、休止中か）は **証拠未確認**。`docs/PAYMENT_SYSTEM.md` は銀行振込をメインと記述し、`CLAUDE.md` は「現在 pricing は銀行振込のみを案内」としているが、Stripe 経路の停止/生存の明示的記録は未確認。
- 旧ドメインから `analytics.keiba.link` への 301 切替が完了しているかは **未確定**（`README.md` は「移行中」表記のまま）。
- `CLAUDE.md` §移行タスク（初期セットアップ）7 項目のうち、どこまで完了しているかの最新状態は **証拠未確認**（`NEXT_SESSION.md` は文書内の「最終更新」表記が 2026-04-14）。
- 入金確認メール v2 のどの段階（worker / reconciler / Event Webhook / 段階有効化）が本番有効かは **未確定**。カナリア分離までのコミットは main にあるが、cutover 実行の記録は未確認。
- `docs/dark-horse-picks-stability-plan.md` の Phase 3 以降の実装着手状況は **未確定**（同文書は「実装未着手」のまま）。
- 滞留ブランチが多数残存しており、どれが生存 / 破棄対象かの棚卸し記録は **証拠未確認**（正確な本数も 未確認）。
- `verify-project.sh` は **旧プロジェクト由来の期待値（旧パス・旧 remote）** を検証しており、本リポジトリでは常に失敗する。意図的な残置か放置かは **証拠未確認**。
- 追跡下の lockfile が 3 つあり、うち `astro-site/astro-site/package-lock.json` は入れ子の重複。3 つとも npm 形式のため形式矛盾は無いが、入れ子が意図的かは **証拠未確認**（`CLAUDE.md` §Package manager）。
