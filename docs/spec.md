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
