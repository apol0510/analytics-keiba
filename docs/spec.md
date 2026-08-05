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

> **重要**: `docs/spec.md` / `docs/progress.md` / `docs/decisions.md` の 3 文書は PR #143 で新設された、
> それぞれ仕様 / 進捗 / 設計判断のリポジトリ正本である。
> `CLAUDE.md`（運用ルールの正本）と `astro-site/docs/*.md`（各ドメイン詳細仕様の正本）は
> それ以前から存在する既存の正本であり、本 3 文書はこれらを置き換えない。

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

## マーケティング配信の運用（admin / 2026-08-02 完成）

管理画面 `/admin/premium-plus-eligibility` の「顧客マーケティング」タブだけで、
**対象選択 → 確認 → キュー登録 → 状況確認 → 取消**まで完結する。
送信経路は `marketing-campaign-dispatch` の **1 系統のみ**。

### 操作の流れ

| # | 操作 | 画面 | 副作用 |
|---|---|---|---|
| 1 | 顧客を選択（segment / checkbox）| 顧客マーケティング | なし |
| 2 | キャンペーンを選び **dry-run** | 施策パネル | **なし**（対象・除外・除外理由・planFingerprint を確認）|
| 3 | 最終確認 → **送信キューへ登録** | 確認モーダル | `ScheduledEmails`(PENDING) + `CampaignDeliveries`(queued)。**メールは出ない** |
| 4 | **送信状況・取消** で状態を確認 | 送信状況モーダル | なし |
| 5 | 必要なら **PENDING を取消** | 同上 | `ScheduledEmails`→CANCELLED / **queued の配信行だけ** →cancelled |
| 6 | dispatcher を実行（人が叩く）| API | **実メール送信**（gate が両方 true のときだけ）|

### 画面の操作順（Step 1〜6 / 2026-08-02）

管理画面は**押せる順にしか進めない**。判定は単一源 `src/lib/marketing/marketingConsoleFlow.js`。

| Step | 内容 | 次へ進む条件 |
|---|---|---|
| 1 | 対象顧客を絞り込む（常時 4 条件 + 詳細条件は折りたたみ・適用中件数とクリアつき）| 取得済み顧客がいる |
| 2 | 顧客を選択（**表示中を全選択**が主操作／全顧客選択は控えめ／送信不可は選択不可＋理由）| 1 名以上 |
| 3 | キャンペーンを選ぶ（**通常配信と運用テスト専用を分離**・カードに version / 対象条件 / 実績 / 再送可否）| 選択済み |
| 4 | 送信対象を確認（dry-run）| 送信対象 ≥ 1 |
| 5 | キュー登録 → 送信直前の確認 → 最終送信 | 各段の確認が最新であること |
| 6 | 送信状況・取消・結果確認 | — |

- **dry-run の結果は、選択・条件・キャンペーンのどれかが変われば失効**する（指紋で判定）。
  失効したらキュー登録は押せず、再確認が必須。
- 追従バーに「選択人数 / キャンペーン / 確認状態 / gate / 次の操作」を常時表示する。
- 最終送信は**二段階確認**（内容ダイアログ ＋ 送信予定人数の入力）。
  確認内容には campaign/version・対象人数・除外人数・gate・取消できる段階・
  送信後は取消不可・二重送信防止・**実メールが届くこと**・一般顧客かテスト受信者かを必ず含める。
- 送信後は直前確認を破棄する（もう一度確認しない限り再送ボタンは開かない）。
- 通知は内容別（成功 / 注意 / エラー）で、エラー時は「何が起きたか」と「次に何をするか」を出す。

### 管理画面の配色ルール（2026-08-02）

暗い画面の中で「次に押すもの」「危ないもの」を一目で分けるため、**色の意味を固定**する。
色は CSS 変数（`--action-*` / `--surface-*` / `--focus-ring`）にまとめ、直書きを増やさない。
**色だけに頼らず、アイコン・文言・枠でも区別する。**

| 色 | 意味 | 例 |
|---|---|---|
| 青 | 通常の取得・詳細・戻る | 対象候補を表示 / この条件で取得 |
| 緑 | 安全に完了できる確定操作・成功 | 付与内容を確認 / 送信対象を確認 |
| 黄 | 現在の段階・次の主要操作・確認待ち | 表示中を全選択 / 現在 Step |
| オレンジ | 実行前の強い注意・失効・危険設定 | 現有効会員を含める / dry-run 失効 |
| 赤 | **本番データが変わる操作**・不可逆・エラー | 無料特典を付与する / 今すぐ送信 |
| 紫 | 上位プラン・特典設定 | Premium 特典 / Step 3 |
| 灰 | 未到達・無効・参照のみ | 前の Step を完了してください |

- 主要ボタン（`btn-lg`）は高さ 50px・16px・太字・アイコンつき。補助は `btn-md`
- 危険操作は赤系 + ⚠️ + `aria-disabled`、二段階確認は維持
- Step ナビは丸番号（30px）+ アイコン + 補足の 72px カード。現在＝黄 / 完了＝緑 / 未到達＝灰
- 追従バーは上辺に黄ライン、次の操作 1 つだけを 52px で段階別の色に
- 通知は 成功（緑）/ 情報（青）/ 注意（黄）/ 強い注意（オレンジ）/ エラー（赤）の 5 種
- `focus-visible` は 3px の枠、無効ボタンは `cursor: not-allowed` と理由表示
- **モバイルで横スクロールさせない**（Step ナビは折り返す）

### カムバック特典タブの操作順（Step 1〜5 / 2026-08-02）

判定の単一源は `src/lib/entitlements/comebackConsoleFlow.js`。**前の段階が終わるまで次へ進めない。**

| Step | 内容 | 次へ進む条件 |
|---|---|---|
| 1 | 対象者を探す（**カムバックの言葉**で区分を選ぶ）| 「対象候補を表示」で取得 |
| 2 | 対象者を選ぶ（現有効会員・状態不明は**選択不可**・理由表示）| 1 名以上 |
| 3 | 付与する特典を決める（平文で要約）| Light / Premium のどちらかを選ぶ |
| 4 | 変更内容を確認する（付与内容を確認）| 付与人数 ≥ 1 かつ**現有効会員 0 名** |
| 5 | 特典を付与する | 人数入力つき二段階確認 |

- 契約状態の選択肢は **カムバック候補すべて / 期限切れ / 退会済み / 休眠・長期未ログイン /
  無料会員・契約なし / 状態不明**、区切り線の下に**現在有効な会員（通常は選択しない・警告色）**。
  「カムバック候補すべて」に**現有効会員は含まない**
- **条件・選択・特典のいずれかが変われば確認結果は失効**する
- 実行は dry-run と**同じ operationId**（冪等）。画面には
  「プラン・課金状態・入金状態・Premium Plus 販売資格・メール設定は変更しません」と
  「実行すると閲覧権限が変わる／メールは送信されない」を必ず出す
- 追従バーに 候補・選択・特典・確認状態と**次の操作 1 つ**を表示

### 無料付与の絞り込み（「いま」と「これまで」/ 2026-08-03）

判定の単一源は `src/lib/entitlements/freeGrantStatus.js`（純粋・I/O なし）。
**画面・API・集計がすべて同じ関数を通る**（表示と検索結果を食い違わせない）。

| 絞り込み | 区分 |
|---|---|
| **現在の無料付与** | 現在は無料付与なし / Light 無料期間中 / Light 永久無料 / Premium 無料期間中 / Premium 永久無料 / Light・Premium 両方が有効 / 要確認（データ不整合） |
| **無料付与履歴** | 付与の記録なし / Light の付与歴あり / Premium の付与歴あり / 両方の付与歴あり / 無料期間が終了済み / 取消・失効の記録あり / 要確認（記録が矛盾）/ 履歴不明（記録が不完全） |

- 同じ項目内は **OR**、異なる項目間は **AND**、未選択（空配列）は**条件なし**
- API は配列で受け、**許可値以外は 400**。旧 `promo`（現在の特典）は後方互換で受け付ける
- **`付与の記録なし` は「一度も付与していない」ではない**（台帳に記録が無いだけ）。
  Customers はティアごとに最新 1 回分しか持たないため、付与回数・過去の履歴は証明できない
- 不整合は**自動修復せず**「要確認」と理由を表示し、選択・付与は fail closed のまま
- 「特典」という語は、フィルター・チップ・条件要約・追従バー・一覧・顧客カルテから外した

### 「今すぐ送信」に到達できる唯一の順序（2026-08-02）

判定の単一源は `src/lib/marketing/marketingSendNow.js`。**すべて満たすまでボタンは押せない。**

| # | 条件 | 満たさない場合 |
|---|---|---|
| 1 | dry-run 実施済み・**失効していない** | `no_dry_run` / `dry_run_stale` |
| 2 | キュー登録済み | `not_enqueued` |
| 3 | dispatcher `dryRun:true` が成功し、**送信待ちジョブが 1 件に特定できる** | `no_preflight` / `job_not_unique` |
| 4 | 送信対象 ≥ 1 通 | `no_recipients` |
| 5 | 実配信 gate が有効 | `gate_closed` |
| 6 | 実行中でない・未送信 | `busy` / `already_sent` |

**送信の直前にもう一度 `dryRun:true` を取り**、確認したときと
**同じ jobId・同じ内容（willSend / willSkip / total）**であることを検証する。
違えば `job_mismatch` / `state_changed` で中止する（409 相当）。

- 実送信は **確認したジョブ 1 件だけ**を対象にする（dispatcher の `jobId` 指定）
- 通常配信は**実送信予定人数の入力一致**を必須にする（テスト専用は 1 通なので省略可）
- 二重クリックは `busy` フラグで 1 回だけ実行。応答待ち中は全送信操作を無効化
- 送信後は直前確認を破棄し、**同じ画面から二度押せない**

### 送信結果の表示

sent（＝provider 受理）/ skipped / failed / ジョブ状態（SENT / PARTIAL / FAILED）/
除外理由 / 完了時刻 /「送信済みのため取消不可」を画面内に出す。
**部分成功は巻き戻さず、再送ボタンを自動表示しない。**

### 送信ゲート（2 段・独立）

| env | 役割 | 閉じているときの挙動 |
|---|---|---|
| `MARKETING_CAMPAIGN_ENABLED` | **キュー登録**の解禁 | 送信ボタンが無効化され、理由を画面に表示。API は 503 |
| `MARKETING_CAMPAIGN_DISPATCH_ENABLED` | **実送信**の解禁 | キューは作れるが 1 通も出ない。dispatcher は 503 |

- **`NEWSLETTER_AUTOMATION_ENABLED` は無関係**（マーケ配信のために ON にしない）
- **ゲートが両方 true でも、人が dispatcher を実行しない限り送られない**
  （定期実行に登録していない。guard テストで固定）

### 二重送信・誤送信を防ぐ構造

| 防壁 | 内容 |
|---|---|
| `DeliveryKey` | campaignId × version × email × from の sha256。**同一版は 1 行**。再登録は `already_delivered` で除外 |
| `planFingerprint` | dry-run で確定した母集団と違えば send が 409。**確認した対象以外へ送れない** |
| 送信直前の再検証 | provider suppression / blacklist / 配信停止 / 退会 / 頻度キャップを 1 通ごとに再判定 |
| custom_args 3 点 | 揃わなければ**送らない**（Phase 1c）。台帳と噛み合わない配信を作らない |
| 経路の単一化 | 共有 executor は `canSharedExecutorSend` が **env 非依存で常時 skip** |
| PENDING 限定 | dispatcher は PENDING のジョブしか処理しない。SENT は再送対象にならない |

### 取消の原則

- **PENDING のジョブだけ**取り消せる。**SENT / FAILED は取消不可**（送った事実は消さない）
- 取り消すのは `ScheduledEmails.Status` と **`queued` の配信行だけ**。`sent` の行には触れない
- `operationId` 必須。同じ取消を 2 回実行しても 2 重に書かない（冪等）
- 書き込み列は allow-list（`Status` / `CompletedAt` / `Notes` / `SkippedAt` / `ErrorMessage`）に限定
- 画面は **二段階確認**（内容確認ダイアログ ＋ `CANCEL` の文字入力）

### 画面に出す情報

- キャンペーン名 / version、対象人数、除外人数と理由、送信予定時刻
- ゲート状態（両方）と、閉じている場合の**理由**
- ジョブごとの 送信待ち / 送信済 / 失敗 / スキップ / 取消 の件数と**失敗理由の分類**
- 取消可否と、不可の場合の理由
- 顧客カルテ ⑥-2: 台帳由来の反応（`resolved` のみ本人の反応として集計）＋
  **未確定（unresolved / conflict）の全体件数**（顧客には紐付けない参考値）

### Function に action を追加するときの必須手順（2026-08-02 の 500 を受けて）

ソース文字列を検査する guard は「何が書かれているか」しか見ない。**import 漏れ・引数不一致は
実行して初めて落ちる**（実際に `jobs` が本番 500 になった）。新しい action を足すときは
**ハンドラを起動する煙試験を必ず 1 本足す**こと（`adminMarketingHandler.smoke.test.mjs`）。

- `fetch` を差し替えてネットワークなしで `handler()` を呼ぶ
- 200 が返ること、応答に**アドレスを載せないこと**、
  書き込み系は**検証段階で PATCH を 1 回も出さないこと**を固定する

⚠️ **「送信済み」は配信基盤が受理した状態**で、実配信（`delivered`）とは別。
実配信は `EmailEvents` の台帳で確認する。

### 関連ファイル

| 目的 | ファイル |
|---|---|
| 対象・除外・DeliveryKey の単一源 | `src/lib/marketing/campaignSend.js` |
| ゲート判定・送信直前再検証の単一源 | `src/lib/marketing/marketingDispatchGate.js` |
| **ジョブ状況・取消の単一源** | `src/lib/marketing/marketingJobs.js` |
| custom_args（刻印）の単一源 | `src/lib/marketing/campaignCustomArgs.js` |
| admin API | `netlify/functions/admin-marketing.js` |
| 送信経路（唯一） | `netlify/functions/marketing-campaign-dispatch.js` |
| 画面 | `src/pages/admin/premium-plus-eligibility.astro` |

## AK 専用 CRM の責務（2026-08-04 / 大規模化の土台）

`/admin/premium-plus-eligibility/` は **AK 専用の「顧客販売・マーケティング管理」**。
将来の大規模配信に耐えるため、責務を 5 つに分けて扱う。

### 母集団は 3 つある（混同しない）

| # | 母集団 | 件数 | 状態 |
|---|---|---|---|
| 1 | **AK に登録済みの顧客** | 1,464 件（うち無料 1,374）| 本番 Airtable にある |
| 2 | **外部保有の無料ユーザーリスト** | **約 13,000 件** | AK の外。**未取り込み** |
| 3 | 取り込み後の統合顧客母集団 | 1 + 2 | 取り込み完了後に成立する |

**約 13,000 件は AK 本番の件数ではない。** 別途保有している analytics-keiba の
無料ユーザー名簿で、**将来 AK へ安全に取り込み**、この画面からキャンペーン対象として
管理・配信する。したがって大規模配信の設計（セグメント・snapshot・分割配信）は
「取り込み後の統合母集団」を前提に作る。

| 領域 | 何を扱うか | 触ってよいもの |
|---|---|---|
| 顧客 | 契約状態・プラン・区分・送信可否 | 読むだけ |
| カムバック特典 | 無料付与（promotional grant）| 特典フィールドのみ |
| キャンペーン | 文面・version・contentHash | カタログ定義 |
| 配送 | snapshot / 親ジョブ / 子バッチ / 再送 | ScheduledEmails・CampaignDeliveries |
| 成果 | delivered / open / click / ログイン / 購入 | 読むだけ |

既存 URL と Premium Plus 販売資格管理は維持する。

### 大規模セグメント（単一源: `src/lib/crm/audienceSegments.js`）

**取り込み後は 14,000 件超になる。ブラウザへ全件描画しない。** 画面へ返すのは
母数 / 送信候補 / 除外数 / 除外理由別件数 / 対象条件 / 最終計算日時 / 条件ハッシュ /
**匿名化した検証用サンプル（属性のみ・20 件まで）** だけ。

数え方の約束（崩れたらテストが落ちる）:

1. 母数は**一意メールアドレス**（レコード数ではない）
2. 同じアドレスの 2 件目以降は母数にも除外にも入れない（別枠で報告）
3. **母数 = 送信候補 + 除外合計** が常に成立する
4. 判定材料が欠ければ**送らない側へ倒す**（配信基盤の停止リストを読めなければ全員除外）
5. 除外は理由別に必ず数える

対象条件の正本は**サーバー側**。クライアントが送る recordId 一覧を正本にしない。

### Audience Snapshot（単一源: `src/lib/crm/audienceSnapshot.js`）

送信前に対象を固定する。**減るのは許す、増えるのは許さない。**

- 改ざん検知（整合性ハッシュ）／期限切れ・使用済み・別キャンペーンでの再利用を拒否
- 個人情報を持たない（件数と条件だけ）
- 送信直前に配信停止・有料化・バウンスを再判定し、**snapshot の件数を超えて送らない**
- キュー登録したら使い切り（同一 snapshot × campaign version の二重登録を禁止）

### 分割配信・段階配信（単一源: `src/lib/crm/batchPlan.js`）

親ジョブ + 子バッチ（既定 500 / 上限 1,000）。受信者単位の二重送信防止は従来どおり DeliveryKey。

- 同時に 2 バッチを走らせない／送信済みバッチは二度と実行しない（再開時の二重送信防止）
- 一時停止は**現バッチ完了後**／未送信は取消可／**送信済みは取消不可**
- 段階: 管理者テスト → 500 → 24〜48h 観測 → 1,000 → 2,000 単位 → 残り
- 異常停止の閾値は**設定値**（コードに直書きしない）。production での変更は別承認

### 計測状態モデル（単一源: `src/lib/crm/deliveryMeasurement.js`）

**「0 件」と「計測していない」を必ず区別する。**
2026-08-04 の 28 名配信では、実際は 9 名開封していたのに AK 台帳は 0 だった。

- `enabled` / `disabled` / `unknown` の 3 状態。tracking と Webhook の**両方**そろって `enabled`
- 無効・不明のときは数値を返さない（`null` ＋「—（計測していません）」）
- **1 件ずつの内訳（顧客カルテ）でも同じ規則を使う**。`measuredCount()` が単一源で、
  画面で `?? 0` と書くことを禁じる（2026-08-04: カルテだけ「開封 0 回」と断定していた）
- delivered / bounce / 配信停止 / 迷惑報告は **開封計測の状態に関係なく数値**（Webhook が届けている確定値）
- unique 人数と event 件数を分ける／provider 受理・delivered・opened を分ける
- provider 側だけで確認した値は**参考値**と明示
- 台帳と provider の件数差は異常停止の判断材料にする

#### EmailEvents を正本にするために必要な設定変更（**未実施 / 手順は確定済み**）

手順書の単一源は **`astro-site/docs/DELIVERY_MEASUREMENT.md`**（変更前の記録・順序・rollback を含む）。
確認コマンドは `npm run check:measurement`（GET のみ）。

| 変更 | 種別 | 現在（2026-08-04 実測） | 必要な値 |
|---|---|---|---|
| Event Webhook の `open` | 外部サービス設定 | false | true |
| Event Webhook の `click` | 外部サービス設定 | false | true |
| マーケ配信のクリック計測 | production env | 未設定 | `MARKETING_CLICK_TRACKING_ENABLED=true` |
| **アカウント全体の click tracking** | — | 無効 | **無効のまま。触らない** |

**アカウント全体の click tracking は有効化しない。** 有効にすると、per-message で opt-out して
いない送信経路すべての本文リンクが書き換わる。実測でその中に `send-magic-link`（**15 分・
単回使用のログイントークン**）が含まれ、リンク検査ボットの先読みだけでトークンが消費されて
**本人がログインできなくなる**。代わりにマーケ配信の 1 通ごとの `tracking_settings` で有効化する
（per-message はアカウント設定より優先）。ログインメールには明示的な opt-out を入れてある。

検証条件: 設定変更後にカナリア 1 通を送る → `EmailEvents` に `open` が `resolved` で入る →
顧客カルテ ⑥-2 が「—（計測していません）」から数値へ変わる。
期待する行の形は `src/lib/webhooks/emailEventOpenClick.fixture.test.mjs` が正本。

> ⚠️ `netlify dev:exec` が返す secret 系 env は**マスクされる**（`****…==`）。
> 取得した値をローカルで検証しないこと（署名鍵を「壊れている」と誤判定した前例がある）。

### 外部リストの取り込み（下見: 実装済み / 本番 write: 未配線）

**外部 13,000 件は「ユーザーが別途保有する AK 無料ユーザーのリスト」**であって、
**AK 本番 `Customers`（1,464 件）とは別物**。まだ AK へ取り込んでいない。
取り込みは戻しにくいので、**書き込む前にすべて分かる**状態を先に作る。
実 CSV の受領・本番取り込み・顧客レコード作成は**別承認**まで行わない。

| 層 | 単一源 | 状態 |
|---|---|---|
| CSV を読む（文字コード・引用符・改行・列名） | `src/lib/crm/csvParse.js` | 実装済み |
| 誰を入れる / 入れないの判定 | `src/lib/crm/customerImport.js` | 実装済み |
| 下見の固定（改ざん・期限・差し替えの拒否） | `src/lib/crm/importPreview.js` | 実装済み |
| 実行モデル（親ジョブ / 子バッチ / 冪等 / 戻し方）の下敷き | `src/lib/crm/importJobPlan.js` | 設計・定数（一部を job 側で再利用） |
| **親ジョブの状態機械（PLANNED〜CANCELLED / cursor / 突合）** | `src/lib/crm/importJobModel.js` | 実装済み |
| **作成対象の判定（決定的な並び・除外集合）** | `src/lib/crm/importEligibility.js` | 実装済み |
| **子バッチ 1 つの実行** | `src/lib/crm/importJobRunner.js` | 実装済み |
| **ジョブの保存（Netlify Blobs・正本ではない）** | `src/lib/crm/importJobStore.js` | 実装済み |
| 下見 API（read-only） | `netlify/functions/admin-customer-import.js` | 実装済み（`action:'previewCsv'`） |
| 単発実行 API（1 回 100 件） | `netlify/functions/admin-customer-import-run.js` | 実装済み・本番 3 バッチ 210 件で実績 |
| **ジョブ API（開始 1 回・子バッチ分割）** | `netlify/functions/admin-customer-import-job.js` | 実装済み・**本番未実行** |
| 画面 | `/admin/premium-plus-eligibility/` の「外部顧客リストの取り込み（下見）」 | 実装済み・単発の本番取込ボタンは **disabled のまま** |
| **画面（大量取り込み）** | 同ページの「外部顧客リストの取り込みジョブ（大量）」 | 実装済み・**書き込みゲートが閉じていれば開始不可** |

#### 読み取りの受け入れ仕様（`csvParse.js`）

- 文字コード: **UTF-8 / UTF-8 BOM 付き / Shift_JIS（CP932）**。
  MIME も拡張子も信用せず**中身だけ**で判定する。UTF-16 は受け付けない（推測で読まない）。
  復号に失敗したら**止める**（文字化けのまま取り込まない）
- 改行: CRLF / LF / CR のいずれでも同じ結果
- 引用符: RFC 4180（引用符内のカンマ・改行・`""`）
- 空行は行数に数えない / 列の順番は不同でよい / 前後空白・**全角空白**・ゼロ幅文字を落とす
- 上限: **8MB / 60,000 行 / 64 列**（13,000 行を十分に収める）
- 列数が見出しより多い行は**捨てずに `unsupported_row` として要確認**へ回す
- 知らない列は**取り込まない**。名前だけを件数と一緒に報告する

#### 列（実 CSV 受領後に確定する）

必須は **`email` のみ**。任意は `name` / `registered_at` / `source` / `note`。
列名のゆらぎ（日本語ヘッダ・大文字小文字・空白・全角）は `customerImport.js` の
**別名表 `COLUMN_ALIASES` で吸収**する。**実 CSV の列を推測で固定しない** —
旧会員区分などの列が来たら、別名表と `KNOWN_COLUMNS` を増やして対応する。

#### 分類（母数 = 全分類の合計）

| 正式名 | 意味 |
|---|---|
| `CREATE_CANDIDATE` | AK に無い → 新規追加の候補 |
| `UPDATE_CANDIDATE` | AK にある → 更新の候補（既存の値は壊さない） |
| `EXCLUDED` | 取り込まない |
| `REVIEW_REQUIRED` | 人が決める |

理由コード（固定・綴りを変えない）:
`missing_email`（`no_email`）/ `invalid_email` / `duplicate_in_file` / `duplicate_in_ak` /
`paid_member` / `unsubscribed` / `hard_bounce` / `soft_bounce` / `spam_reported` /
`provider_suppressed` / `suspended` / `test_account` / `ambiguous_match` /
`role_address` / `unsupported_row` / `encoding_broken`

**AK 側に同一アドレスの複数レコードがある場合は自動統合しない。** `REVIEW_REQUIRED` へ隔離する。
配信基盤の停止リストを確認できないときは**全員を要確認へ倒す**（fail closed）。

#### 下見の固定（`importPreview.js`）

下見 1 回につき `importPreviewId` / `fileHash` / `normalizedHeaderHash`（**列順に依存しない**）/
`rowCount` / `classificationCounts` / `reasonCounts` / `parserVersion` / `ruleVersion` /
`createdAt` / `expiresAt`（既定 30 分）/ `summaryHash` を作る。実行時に照合し、
**ファイル差し替え・列構成の変更・件数の書き換え・規則やパーサーの更新・期限切れ**は
すべて拒否する（fail closed）。**この記録にアドレス・氏名・行の中身は入らない。**

> 本番の preview 保存先（Airtable / Blobs）は**まだ決めない**。実 CSV 受領後に決める。

#### 実 CSV 3 ファイルにもとづく確定規則（2026-08-05）

実ファイルの read-only 集計で決めた。**推測で列を固定していない**。

| ファイル | 文字コード | 行数 | 読む列 | 取り込まない列 |
|---|---|---|---|---|
| 1 | UTF-8 (BOM) | 6,160 | `error_count` / `status` / `name` / `email` | 電話番号 |
| 2 | UTF-8 (BOM) | 9,621 | `email` | — |
| 3 | **Shift_JIS** | 15,688 | `email` / `name` | 電話番号 |

- **`状態` 列は実データでは「配信中」1 種のみ**（6,160 件 / 空欄 0）。
  既知ラベル表（`importStatusRules.js`）を単一源にし、**知らないラベルは REVIEW_REQUIRED**（fail closed）。
  送ってはいけないラベル（配信停止 / 退会 / 解除 / 受信拒否 / 無効 / エラー / バウンス 等）は EXCLUDED。
- **`エラーカウント数` は列として取り込まない**が、**≥1 は REVIEW_REQUIRED**（実測 78 件）。
  閾値は `ERROR_COUNT_REVIEW_THRESHOLD`。0 にすると失敗歴を無視する（運用判断）。
- **`電話番号` は読みもしない**（AK に取り込まない方針）。
- **統合の正本は「3 ファイル統合後の正規化一意メール」**（ファイル日時では優先順位を決めない）。
  実測: file2 は file3 に完全包含 / file1 のうち file3 に無いのは 109 件。
- **氏名は空欄を埋めるときだけ**使う。既存 AK 顧客の氏名は上書きしない。
  複数ファイルで**氏名が食い違うものは自動決定せず REVIEW_REQUIRED**（実測 1 件）。

#### 初回取り込みポリシー（`importWritePlan.js`）

**初回は CREATE_CANDIDATE の新規作成だけ。** UPDATE_CANDIDATE（実測 1,158 件）は 1 件も更新しない。

新規レコードに書く列（**Airtable の実スキーマにもとづく**）:

| 列 | 値 | 根拠 |
|---|---|---|
| `Email` | 正規化済みアドレス | 全 1,466 件が保有 |
| `プラン` | `Free` | singleSelect の選択肢。全件が保有（Free 1,370） |
| `ポイント` | `0` | 全件が保有 |
| `Source` | `customer-import:<batchId>` | singleLineText。**rollback の隔離キー** |
| `氏名` | 一意に決まったときだけ | 決められなければ書かない |
| `CreatedBy` / `ImportBatchId` / `ImportedAt` | **列が実在するときだけ** | 現在 Customers に**存在しない** |

**書かない**（`CREATE_FORBIDDEN_FIELDS` で構造的に禁止）: `Status` / `PlanType` / `有効期限` /
`PaidAt` / `PaymentConfirmed` / `Light*Grant*` / `Premium*Grant*` / `LifetimeSanrenpuku` /
`UnsubscribedAnalyticsKeiba` / `Phone` / **`登録日`（createdTime＝計算フィールドなので書けない）**。

> free 会員は `Status` 空が通常（1,466 件中 1,421 件が空）。**active を入れない。**

#### 本番取り込みの実行モデル（`importJobPlan.js`・**未配線**）

親ジョブ + 子バッチ（既定 200 / 100〜500）。**作成と更新は別バッチ**（戻し方が違う）。

- 行ごとの冪等キー `sha256(import:batchId:email)` で**同じ行を二度書かない**（アドレスは復元不能）
- 同時に 2 バッチを走らせない / 送信済みバッチは二度と実行しない
- **失敗したバッチだけ**再試行する（成功行を巻き込まない）
- 一時停止は現バッチ完了後 / 未実行だけ取消可 / **書き込み済みは取消不可**
- 計画（下見の 作成候補 + 更新候補）を**超えて書けない**。毎回検算する
- 取り込んだ行に `CreatedBy=customer-import` / `ImportBatchId` / `ImportedAt` を刻む
- 監査ログはハッシュのみ（アドレス・氏名を入れない）
- 戻すのは**削除ではなく印を外す**方向。**取り込みと配信を同じ操作にしない**

#### 大量取り込みの親ジョブ（`importJobModel.js` / `admin-customer-import-job.js`）

残り 14,284 件を 1 回 100 件の単発 run で処理すると**約 143 回**になる。人が 143 回ゲートを
開け閉めするのは現実的でないので、**管理者は 1 回だけ開始し、内部で 100 件以下の子バッチへ
分割**する。単純に `FIRST_RUN_MAX_ROWS` を引き上げて単一の同期 Function で大量処理する案は
採らない（26 秒上限を超えると「作成済みだけ残って結果が返らない」最悪の状態になるため）。

**1 呼び出し = 子バッチ 1 つ。** 100 件は実測 9〜13 秒で 26 秒上限に収まり、
進捗が常に確定した状態で保存される。画面が完了まで**逐次**呼び直す（並行に走らせない）。

| 状態 | 意味 |
|---|---|
| `PLANNED` | 開始済み。**まだ 1 件も書いていない** |
| `RUNNING` | 子バッチを処理中 |
| `PARTIAL` | 失敗が混ざって終わった / 例外で中断した。**続きから再開できる** |
| `COMPLETED` | 対象を書き終えた。**再実行できない** |
| `FAILED` | 続行不能で終了。**再実行できない** |
| `CANCELLED` | 取り消した。**作成済みは消さない**・再実行できない |

##### ⚠️ 正本は Airtable であって、ジョブ記録ではない

Netlify Blobs は同一キー競合が **last-write-wins** で、`onlyIfNew` / `onlyIfMatch` も
best-effort でしかない（premium-plus canary #13 で実 lost-update を確認・
`docs/PREMIUM_PLUS_STORAGE_DESIGN.md`）。Airtable 側に CAS は無く、ImportJobs テーブルの
新設は **schema 変更**にあたるため採らない。そこで**安全性をジョブ記録の一貫性に依存させない**:

1. **二重作成を防ぐのは Customers 側のアドレス実在判定**（子バッチ直前に取り直す）。
   すでに作った行は Customers に居るので、同じ子バッチをもう一度流しても
   `skippedExisting` になるだけで**増えない**
2. **進捗の正本も Customers**（`Source = customer-import:<batchId>` の件数）。
   ジョブ記録が壊れても Airtable から再構成できる。`status` は毎回この実測と突合する
3. `cursor` は**やり直しを速くするためだけ**の目印。巻き戻っても結果は変わらない
4. 排他リース（既定 90 秒）は **best-effort の多重防御**。これ単独では同時実行を防げない

> **残る競合**: 2 つの実行が**同時に**同じアドレスを「まだ無い」と読んだ場合は二重作成が
> 起こりうる（TOCTOU）。これは実績のある単発 run 経路と**同じ露出**であり、
> 運用は「同時に 2 つ動かさない」（画面は逐次実行 + リースで拒否）で閉じる。
> **strong な排他は現在の基盤では提供できない**ことを明示しておく。

##### ジョブの二重ゲート（`canStartImportJob` / `canStepImportJob`）

1. `CUSTOMER_IMPORT_WRITE_ENABLED=true`（**開始と続行の両方**に掛かる）
2. 開始時の確認文字列 `IMPORT-JOB <batchId> <対象総数>` — 総数に紐づくので使い回せない

加えて fail closed で断るもの: 停止リストが取れない / 開始時と違う CSV（指紋不一致）/
リース保持中 / 完了・取消・失敗のジョブ / 計画総数に到達済み / 同じ batchId のジョブが既にある。

##### 子バッチの分割

| 項目 | 値 |
|---|---|
| 子バッチの上限 | **100 件**（`JOB_CHILD_MAX_ROWS = FIRST_RUN_MAX_ROWS`。`Math.min` で緩められない） |
| Airtable への書き込み | **10 件ずつ**（`CREATE_CHUNK_SIZE`。executor をそのまま再利用） |
| 14,284 件のとき | 子バッチ **143 個**（最後の 1 個は 84 件） |

#### 実行の二重ゲート（`importWritePlan.canRunFirstImport`）

**両方そろわなければ 1 件も書かない**（fail closed）:

1. `CUSTOMER_IMPORT_WRITE_ENABLED=true`（production は**未設定のまま**）
2. 実行時の確認文字列 `IMPORT <batchId> <件数>` — **バッチと件数に紐づくので使い回せない**

加えて **初回は 1 回 100 件まで**（`FIRST_RUN_MAX_ROWS`）。101 件以上の指定は `over_limit` で拒否。

#### 書き込みの手順（`importWriteExecutor.js`・I/O 注入でテスト可能）

- 書き込み**直前**に Customers を取り直し、下見のあとに増えたアドレスを弾く
- 行ごとの冪等キー `sha256(import-create:batchId:email)` で同じ行を二度作らない
- **まとめ書き（bulk create）**: Airtable の上限どおり **1 リクエスト 10 件**。
  1 件ずつだと 1 件約 273ms（実測）で 100 件が約 35 秒となり、同期 Function の上限を超えて
  **「作成済みだけ残って結果が返らない」**状態になるため。10 件ずつなら 100 件でも 10 リクエスト
- **チャンクが失敗したら 1 件ずつ書き直して原因を切り分ける**（1 件の不備で 10 件を曖昧にしない）
- **429 / 5xx だけ**再試行（指数バックオフ・最大 3 回）。**検証エラー（4xx）は再試行しない**
- **許可外の列が 1 つでもあれば 1 件も書かない**（適格判定は書き込みより前に全件通す）
- 1 件失敗しても他行を続行し、成功 / 除外 / 失敗を**行ごとに記録して突合**する
- 許可列以外が 1 つでも混ざったら**そのバッチを止める**
- 監査ログは rowKey のハッシュのみ（アドレス・氏名を残さない）

#### rollback（初回は削除しない）

対象は `Source = "customer-import:<batchId>"` の行だけ。**既定は隔離**（削除しない＝履歴を消さない）。

**A. 隔離（既定・推奨）**

1. Airtable で `Source = "customer-import:<batchId>"` を絞り込み、件数が実行件数と一致するか確認
2. `プラン` は `Free` のまま据え置く（**課金・特典フィールドは元々空**なので触らない）
3. 配信対象から外す（キャンペーンのセグメント条件で `Source` のこの値を除外する）
4. 記録として残す。**レコードは消さない**

**B. 削除（別の高リスク操作・別承認）**

作成直後で、次を**すべて証明できた場合にのみ**実施する:

- そのバッチのアドレスへ**メールを 1 通も送っていない**
  （`CampaignDeliveries` / `ScheduledEmails` / `EmailEvents` に該当バッチ由来の行が無い）
- **会員として利用されていない**（`最終ログイン` が空・`認証トークン` が未発行）
- **外部から参照されていない**（`StepEnrollments` などのリンクが空）

手順: 上記 3 点を read-only で確認 → 件数を記録 → `Source` 一致の行だけを削除 →
削除後の件数が「実行前の Customers 件数」に戻ることを突合。

⚠️ **削除はコードから行わない。** 実行 Function に DELETE の綴りを持たせない（guard で固定）。
Airtable 画面での手作業に限る。**現時点で rollback は未実施。**

書き込みゲート **`CUSTOMER_IMPORT_WRITE_ENABLED`（既定 OFF）**。
`admin-customer-import.js`（下見）には**書き込み経路が存在しない**（`action:'run'` は 501）。
実行は別 Function `admin-customer-import-run.js`（`plan` / `run`）に分離する。

#### 出さない情報（PII 非露出）

API 応答・画面・ログ・エラーのいずれにも
**メールアドレス / 氏名 / recordId / 行の中身**を出さない。返すのは
件数・理由コード・ハッシュ・列名だけ。13,000 行を DOM へ描画しない。

#### 承認境界

実 CSV の受領・実 CSV 内容の読み取り・本番 preview 保存・Airtable write・
Customers の作成/更新・import 実行・production env 変更・production deploy・
PR merge は**すべて別承認**。

（以下は #229 時点の設計メモ。上の表と重複する部分は上を正とする）

#### 受け付ける形

| 列 | 必須 | 用途 |
|---|---|---|
| `email` | **必須** | 突合の鍵 |
| `name` / `registered_at` / `source` / `note` | 任意 | 補助情報 |

- 列名のゆらぎ（日本語ヘッダ・大文字・空白）は吸収する
- **知らない列は取り込まない**（勝手に顧客レコードへ書かない）
- 文字コード: UTF-8 BOM を除去。復号失敗（U+FFFD）・CP932 取り違えを検出して**止める**
  （復号そのものは取り込み層の仕事。判定モジュールは痕跡を見つけるだけ）

#### メールアドレスの正規化

前後の空白・引用符・`mailto:` を落とし、NFKC で全角を半角へ、ゼロ幅文字を除去し、小文字化。
**`+alias` とドットは正規化しない**（別アドレスとして扱う人がいるため、同一視すると本人の意図と食い違う）。

#### 下見で必ず出す 4 区分

| 区分 | 意味 |
|---|---|
| **新規追加** | AK に無い → 追加の候補 |
| **既存更新** | AK にある → 更新の候補（既存の値は壊さない）|
| **除外** | 取り込まない（配信停止・バウンス・迷惑報告・停止リスト・現役有料・ファイル内重複・不正）|
| **要確認** | 人が決める（AK 側の重複・共用アドレス・文字化け・停止リスト未確認）|

**総行数 = 新規 + 更新 + 除外 + 要確認** が常に成り立つ（崩れたらテストが落ちる）。

#### 安全側

- **送ってはいけない相手は取り込まない**（取り込んでから除外するより安全）
- **現役の有料会員を無料リストとして取り込まない**（プランを壊す事故のもと）
- 配信基盤の停止リストを確認できなければ**要確認へ倒す**（fail closed）
- 下見の戻り値に**アドレス・氏名を含めない**。ログにも出さない。Git にも実データを置かない
- 冪等キーは `sha256(import:batchId:email)`。**batchId を塩に使い、アドレスを復元できない**

#### 実行の境界

`canRunImport` が次を**すべて**満たさなければ実行できない:
書き込み有効化 / 明示承認 / 下見の指紋一致（TOCTOU 防止）/ 書き込み件数の入力一致。

#### 取り消し

取り込んだ行には `ImportBatchId` が入る。取り消しは**そのバッチで新規作成した行だけ**を対象にし、
**削除ではなく印を外す方向**で戻す（履歴を消さない）。既存顧客の更新は更新前の値を同じバッチ記録に残す。
**取り込みと配信を同じ操作にしない**（取り込んだ直後に自動送信しない）。

### 成果追跡（単一源: `src/lib/crm/campaignOutcome.js`）

因果を断定せず **direct / correlated / unknown** の 3 段階で示す。
click 計測が無効な現状では direct は観測できないため、その事実も一緒に返す。

## カムバック施策の対象条件（正本 / 2026-08-03）

「カムバック」は **戻ってきてほしい人** への施策であり、いま払って使っている会員に配るものではない。

| 区分 | 意味 | カムバック対象 |
|---|---|---|
| `expired` 期限切れ | 元有料会員で有効期限が過ぎている | **対象** |
| `withdrawn` 退会済み | **旧 Stripe の課金停止のための状態**。メール拒否の意思表示ではない | **対象** |
| `dormant` 休眠 | 契約が無い / 長期未ログイン。生まれ変わった AK を再利用してもらいたい相手 | **対象** |
| `active_member` 現在有効な有料会員 | いま課金が続いている | **原則 対象外**（明示許可 + 人数入力一致が必要）|
| `unknown` 状態不明 | 判定できない（推測しない）| 対象外 |

### 明記しておく前提

1. **「退会済み」は送信禁止ではない。** 退会は課金契約の状態であって受信拒否ではない
   （退会受付メールでも「メルマガは引き続き配信されます」と案内している）。
   メールを止める意思表示は `UnsubscribedAnalyticsKeiba` と provider suppression が担う。
   **この 2 つは絶対に緩めない。**
2. **無料会員に「期限切れ」という概念は無い。** `有効期限` に過去日が入っていても
   無料である限り「期限切れ」と表示しない。無料・契約なしは **休眠かどうか** で見る。
3. **付与できる相手と、メールを送ってよい相手は一致しない。**

   | | 無料付与 | 案内メール |
   |---|---|---|
   | 既に同じ特典を持っている | 付与しない（弱い付与で権利を縮めない）| **送れる** |
   | 配信停止 / blacklist / バウンス | 付与できる場合がある | **送らない** |
   | 退会済み | 付与できる | **送れる** |

   したがって **付与成功者への案内メール**（引き継ぎ導線）と
   **付与できなかった人への一般カムバック案内**（通常の顧客選択）は **別の操作**として扱う。

判定の単一源は `src/lib/entitlements/comebackAudience.js`。画面・Function に再実装しない。
上記の前提は `src/lib/entitlements/comebackAudience.test.mjs` で固定してある。

### 退会・課金停止の元会員への無料付与（2026-08-04 / 施策の宣言で決まる）

上の表は「退会済み＝付与できる」と定めているが、**実装は 3 か所で退会者を締め出していた**。
その結果、元の対象者 65 名のうち期限切れ 28 名だけが Light 30 日無料を受け取り、
**退会済みの元有料会員 37 名は 1 人も対象にできなかった**。

| 場所 | 何をしていたか |
|---|---|
| `comeback/comebackGrantPlan.checkGrantable` | 退会を `withdrawal_blocked` で弾く（付与できない）|
| `auth/memberResolution` | 退会を無料特典より**先**に評価する（付与しても効かない）|
| `entitlements/resolveEntitlements` | 退会で `canLogin=false` → 特典が常に無効 |

#### 施策は**特典カタログの宣言**で決まる（コード修正なしで増やせる）

判定の単一源は **`src/lib/entitlements/comebackPolicy.js`**。施策名を 1 つも知らず、
`promotionOfferCatalog.js` の `offer.comeback` を読んで正規化するだけ。
**新しい施策を足す = 該当 offer に `comeback: {...}` を書く。それだけ**（PR・deploy は不要）。

| 項目 | 意味 |
|---|---|
| `audienceSegments` | 対象区分（`expired` / `withdrawn` / `dormant`）|
| `allowWithdrawn` | 退会・課金停止の元会員を対象にしてよいか |
| `grantTier` / `durationDays` | 何を何日開放するか（**期間限定のみ**・上限 365 日）|
| `campaignId` / `campaignVersion` | 付与後に送る案内メール（対応表はここから自動生成）|
| `requiresSuccessfulGrant` | 付与に成功した人だけをメールへ引き継ぐ |
| `restoresPaidContract` | **false 以外は受け付けない**（課金契約の復帰は入金確認フローだけ）|
| `preserveWithdrawalRequested` | **true 以外は受け付けない**（退会の記録は書き換えない）|
| `allowedEntitlements` / `forbiddenEntitlements` | 開いてよい / 絶対に開かない権利 |

現行の宣言（`light-30d-free`）: segments=expired+withdrawn / allowWithdrawn=true /
light 30 日 / `comeback-light-30d-granted:v2` / restoresPaidContract=false /
preserveWithdrawalRequested=true / allowed=[light] / forbidden=[premium, sanrenpuku, purchase]。

#### 権限側も同じ宣言から決まる

`honorsGrantDespiteWithdrawal()` が「宣言された施策のどれかと形が一致するか」だけで判定する
（ティア・期間内・宣言日数以内・`*GrantOp` あり・取消/不整合でない・`ForceLogout` でない）。
`resolveEntitlements` は `allowedEntitlements` に載った権利だけを開く。
付与側だけ直すと「付与できたのに使えない」が再発するため、**両方を 1 ファイルに置く**。

#### 緩めないもの（fail closed のまま）

`ForceLogout` / アカウント停止 / テストアカウント / メール不正 /
`UnsubscribedAnalyticsKeiba` / provider suppression / blacklist（hard・soft とも）。
**`ForceLogout` は課金の状態ではなく安全上の措置**なので、退会と同列に扱わず宣言でも緩められない。
理由コードも `withdrawal_blocked` と `force_logout_blocked` で**分ける**
（同じ表示にまとめると「施策で許可すれば通るのか」が読めない）。

#### 同一メールアドレスの重複レコードは付与しない

`auth/customerLookup.classifyCustomerMatches` は同じアドレスが 2 件以上あると
**CONFLICT として fail closed でログインを拒否する**。付与しても本人は使えないので、
`checkGrantable` が `duplicate_email` で弾く（レコード統合が先）。

#### Step 2「選べるか」と Step 3「付与できるか」を分ける

管理画面は **Step 1〜2 対象者を探す・選ぶ → Step 3 特典を決める** の順なので、
Step 2 の時点では特典が決まっていない。ここで `checkGrantable` をそのまま使うと
「まだ選んでいない特典」を基準に判定してしまい、**退会・課金停止の候補が全員
「対象外」→ 選択 0 名 → Step 3 へ進めない**という行き止まりになる（本番で発生）。

| 関数 | いつ使うか | 何で決まるか |
|---|---|---|
| `checkSelectable(fields, {duplicateEmail})` | **Step 2**（候補として選べるか）| **絶対除外だけ**：メール未登録・不正 / 同一アドレスの重複 / 停止・テスト / `ForceLogout` |
| `checkGrantable(fields, {allowWithdrawn, duplicateEmail})` | **Step 3 以降**（この特典へ付与できるか）| 上記 ＋ 退会の可否（施策の宣言次第）|

`checkGrantable` は内部で `checkSelectable` を呼ぶので、**判定は 1 本のまま**。

- **`WithdrawalRequested` だけを理由に Step 2 で選択不可にしない**
- 特典 未選択のうちは `grantEvaluated=false` で「Step 3 で特典を選ぶと判定します」と表示し、
  勝手な基準で「付与不可」と出さない
- **既定で特典を選ばない**（旧実装は Light 永久無料が既定で、それが暗黙の判定基準になっていた）。
  追従バーも Step 3 未選択なら「特典: 未選択」
- Step 3 で特典を決めた時点で選択済みを再判定し、対象外を**件数と理由付きで**外す
  （`cbPruneSelectionForOffer`）。黙って減らさない
- Step 4 dry-run と実行直前も同じ `checkGrantable` を通る

本番実測（read-only）: 退会・課金停止 37 名 → **Step 2 選択可能 36 / 選択不可 1（重複アドレスのみ）**、
**Step 3 で Light 30 日無料を選ぶと 36 名が付与可能のまま維持**、
退会者非対応の Light 永久無料を選ぶと 0 名（36 名が理由付きで対象外）。

固定テスト: `src/lib/entitlements/comebackPolicy.test.mjs` /
`src/lib/comeback/comebackWithdrawnGrant.test.mjs` /
`src/lib/comeback/adminComebackUi.guard.test.mjs`

## 無料付与 → 案内メールの引き継ぎ（2026-08-03 / 自動化は 2026-08-04）

### 付与が成功したら**自動で**引き継ぐ（2026-08-04）

付与のあとマーケティングタブへ移っても対象が 0 名で、運用者が
「操作 ID から引き継ぎ直す」を開いて内部 ID を探して入力する必要があった。
内部 ID を人が扱う理由は無いので、**通常フローから手入力を無くす**。

| きっかけ | 何が起きるか |
|---|---|
| 付与が 1 名以上成功 | 応答の引き継ぎ票をそのまま採用 → **マーケティングタブへ自動遷移** → 対象・キャンペーンを自動セット |
| 同じタブの再読み込み | `sessionStorage` から復元（既存） |
| 別タブ・ブラウザを閉じた・付与だけ先に実施 | **「🎁 直近の付与成功者を引き継ぐ」1 クリック**（`handoffLatest`。入力なし） |
| 2 つ以上前の操作を指定したい | 「うまくいかないとき: 操作 ID を指定して引き継ぎ直す」（最終手段）|

- 画面に出るのは **人数と期限だけ**。`operationId` は表示しない（`describeHandoff`）
- `operationId` は URL にも `localStorage` にも載せない。`sessionStorage` に票として持つだけ
- 票に入るのは **人数と offerId** のみ。アドレス・氏名・recordId は 1 つも入らない
- 対象の正本は**毎回サーバーが `operationId` から再導出**する。票を書き換えても対象は増えない
- 期限は**付与時刻（`*GrantedAt`）から**測る（保存値を信用しない）。既定 24 時間
- キュー登録したら票は**使い切り**（`markHandoffQueued`）＝二重登録・二重送信を防ぐ
- 案内キャンペーンは**施策の宣言**（`offer.comeback.campaignId` / `campaignVersion`）から自動選択

`handoffLatest` は**入力を受け取らない** read-only API。実データから
「`*GrantedAt` が最も新しい 1 操作」だけを選び（`pickLatestGrantOperation`）、
TTL 切れ・取消済み・付与時刻不明は候補にしない。過去の操作は掘り起こさない。



無料付与の成功者を、**再検索・再選択せずに**案内メールの文面編集 → dry-run →
キュー登録 → 実送信確認へ渡す導線。付与とメールは**内部処理として分離したまま**にする。

### 付与とメールは融合させない

- 無料付与の**成功前にメールを送らない**
- 付与に**失敗した顧客をメール対象へ含めない**
- **一部成功なら、成功した分だけ**を引き継ぐ
- **メール送信の失敗を理由に、成功済みの無料付与を巻き戻さない**
- 付与とメール送信を**同一トランザクションのように扱わない**

`admin-comeback-grants` は従来どおり **メールを 1 通も送らない**
（SendGrid / ScheduledEmails / CampaignDeliveries に触れない。guard テストで固定）。

### 引き継ぐのは「操作 ID」だけ

採用方式: **`operationId` を鍵にし、対象は毎回サーバーが Customers から再導出する。**

無料付与が成功すると Customers の `LightGrantOp` / `PremiumGrantOp` にその操作の
`operationId` が書かれる。つまり **付与成功そのものが既に台帳**であり、成功者リストを
別に保存する必要がない。

| | 内容 |
|---|---|
| 引き継ぐ値 | `operationId` と件数だけ（**PII なし・recordId なし**）|
| 対象の確定 | dry-run / キュー登録のたびに Customers を読み直し、`operationId` 一致行から導出 |
| 保管場所 | ブラウザの `sessionStorage`（識別子と件数のみ）。**URL には載せない** |
| 有効期限 | **2 時間**（`HANDOFF_TTL_MS`）。**付与時刻 `*GrantedAt` を基準**にサーバーが測る |
| 使い切り | キュー登録したら再利用不可。同じ相手へ再送するには明示的な引き継ぎ直しが必要 |

採らなかった案:

| 案 | 却下理由 |
|---|---|
| sessionStorage に recordId 配列を持つ | クライアントが任意の相手を注入できる。期限も持てない |
| 新しい handoff token 台帳（Airtable / Blobs）| 保管場所とスキーマが増える。付与成功が既に台帳なので不要 |

### 安全性

- **recordId 改ざんに耐える**: 引き継ぎモードではクライアントの `recordIds` を**一切読まない**
- **失敗者が構造的に混ざらない**: 付与できなかった行には grant フィールドが書かれていない
- **取り消し済みは対象外**: revoke 後の行は導出から外れる
- **期限切れ・付与時刻不明は fail closed**（410 / 409 で停止。副作用なし）
- **既存の除外判定を 1 ミリも緩めない**: provider suppression / EmailBlacklist / 配信停止 /
  既送信（`DeliveryKey` 冪等）/ キャンペーン固有条件は従来と**同じ経路**。
  provider suppression を確認できなければ **1 通も送らない**

### 画面の挙動

| 状況 | 挙動 |
|---|---|
| 付与成功後 | 成功人数・付与できなかった人数・**PII なしの理由集計**を出し「成功者へ案内メールを作成」を表示 |
| 付与 0 名 | ボタンを押せない（`aria-disabled`）|
| 同じタブの再読み込み | 引き継ぎは維持される |
| 別タブ / 別ウィンドウ | `sessionStorage` は共有されないので引き継ぎ無し |
| 期限切れ・使用済み | 理由を 1 度知らせて破棄。サーバー側でも同じ判定をするので通っても弾かれる |
| キュー登録後 | 使い切り。同じ相手へ再送するには付与結果から引き継ぎ直す |

「送信予定文面の例」（旧「案内文面プレビュー」）は閲覧専用で終わらせず、
**例であることを明示**したうえでメール作成工程へ接続する。実際に送る件名・本文は
メール作成工程（`campaignContentDraft.js`）で編集し、そこで確定した文面だけが送信される。

### 送信工程は既存機構をそのまま使う（再実装しない）

キュー登録したジョブの `Notes` に `handoff:<operationId>` を残し、
どの付与操作から来た配信かを後から辿れるようにする。

| 目的 | ファイル |
|---|---|
| 引き継ぎの単一源 | `src/lib/comeback/comebackEmailHandoff.js` |
| 引き継ぎ票の発行 | `netlify/functions/admin-comeback-grants.js`（`apply` 応答の `handoff`）|
| 対象の再導出 | `netlify/functions/admin-marketing.js`（`grantOperationId`）|
| テスト | `comebackEmailHandoff.test.mjs` / `comebackHandoffHandler.smoke.test.mjs` / `comebackHandoffContract.guard.test.mjs` |

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
- 入金確認メール v2 は **2026-07-21 に v2-full で本番稼働（D1 cutover 完了）**。worker（dispatcher */5）+ reconciler（*/15）稼働・A1 ON・A2 OFF・送信元 support@keiba.link。**Event Webhook（delivered/bounce 反映）は別 Phase・未実施**。詳細正本: `astro-site/docs/PAYMENT_EMAIL_V2.md` §D1 cutover 完了記録。
- `docs/dark-horse-picks-stability-plan.md` の Phase 3 以降の実装着手状況は **未確定**（同文書は「実装未着手」のまま）。
- 滞留ブランチが多数残存しており、どれが生存 / 破棄対象かの棚卸し記録は **証拠未確認**（正確な本数も 未確認）。
- `verify-project.sh` は **旧プロジェクト由来の期待値（旧パス・旧 remote）** を検証しており、本リポジトリでは常に失敗する。意図的な残置か放置かは **証拠未確認**。
- 追跡下の lockfile が 3 つあり、うち `astro-site/astro-site/package-lock.json` は入れ子の重複。3 つとも npm 形式のため形式矛盾は無いが、入れ子が意図的かは **証拠未確認**（`CLAUDE.md` §Package manager）。
