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

## 無料コンテンツの 2 層構造（2026-08-19 確定 / 実装未着手）

無料ユーザー向けのコンテンツは **目的の異なる 2 層**に分ける。1 ページに両方を担わせない。

| 層 | ページ | 目的 | 買い目 |
|---|---|---|---|
| **第 1 層: プレビュー** | `/free-prediction/{jra,nankan}`（既存） | **有料版の内容・価値を見せる**サンプル | 出さない（ダミーのモザイク表示のみ）|
| **第 2 層: 日常利用** | **新規ページ（URL・名称 未確定）** | 無料ユーザーが**毎日訪れて実際に使う** | **出さない**（無料専用の買い目も作らない）|

### 第 1 層 `/free-prediction/` = **有料版のプレビュー**（2026-08-20 位置づけ変更）

**2026-08-20 に MK が位置づけを変更した。** `/free-prediction/` は「無料予想」ではなく
**有料版のプレビュー**である。これに伴い次を確定した。

- **無料登録による全頭解放 CTA を撤廃**した（`locked-free` / 「無料登録で全頭を見る」）
- **解放ゲート自体も撤廃**し、**未登録でも出走全頭と ○▲△ が見える**
- 残る CTA は**有料 1 枚のみ**。2 枚並び前提のレイアウトをやめ、1 枚を主役に据えた
- **ページ上部にプレビューバナー**を置く（`header-section` 直後・会場タブより前）。
  CTA まで読まないと位置づけが分からない状態にしない。各レースの CTA 横の注記も残す
- **有料項目のマスクは従来どおり維持**（`pt` / AI総合指数 / 役割 / 買い目）

> ⚠️ CTA だけを消してゲートを残すと、**未登録は◎ 1 頭しか見えないのに解除手段が無い**
> 壊れた状態になる。**CTA とゲートは必ずセットで扱う**こと。

対象は `/free-prediction/{nankan,jra}` の 2 ページ。旧レイアウトの
`free-prediction-urawa` / `free-prediction-funabashi` / `free-prediction/jra/[date]` /
`JraVenuePanel.astro` は**今回の対象外**（現行導線から外れているため）。

検証: `npm run test:free-viewpoints`（`freePreviewCta.guard.test.mjs`）。

無料へ渡してよい範囲の単一源は `astro-site/src/lib/freePublicView.js` の
`buildFreePublicRows()`。この DTO には **pt / AI総合指数 / 役割 / 特徴量重要度 /
評価ポイント / 買い目を入れない**（静的 HTML に実値を焼き込まないため）。

| 無料へ出している（公開事実 + 上位 4 頭の印）| 有料限定（DTO に含めない）|
|---|---|
| 馬番 / 馬名 / 騎手 / 厩舎 / 斤量 / 枠 / 父 / 性齢 / 過去走 / 通算成績 | `pt`（累積スコア）|
| 印 ◎本命 / ○対抗 / ▲単穴 / △連下最上位（上位 4 頭のみ）| AI総合指数（`computerIndex` / `sourceComputerIndex` 由来）|
| レース詳細（距離 / 頭数 / 発走時刻）| 特徴量重要度・評価ポイント |
| | ▲単穴 / △連下 / 抑え / 不要馬 の役割 |
| | 買い目（`bettingLines`）|

**2026-08-20 以降は登録の有無にかかわらず ○▲△ と全出走馬が見える**（ゲート撤廃）。
**買い目は誰にも解放しない。**

### 第 2 層（新規・未実装）の確定条件

1. `/free-prediction/` とは**別の新規ページ**として作る（既存ページの改修ではない）。
   `/free-prediction/` は有料版プレビューとして維持し、第 2 層と**分離する**。
2. **買い目を表示・返却しない。** 無料専用の 5 点買い目を新設する案も**不採用**。
3. 対象は **全レース**。「買い目以外で無料でも実際に役立ち、毎日見に来る価値がある情報」を出す。
4. **独立した新しい未検証の予想モデルを勝手に作らない。**
   既存の `pt` / 指数 / 役割 / 特徴量を**複合的に使った派生指標・分類・説明文は禁止しない**
   （具体的な算式・表示項目は未確定）。
5. **`/free-prediction/` のプレビュー価値を毀損しない。**
6. **Light / Premium の有料価値を毀損しない。**
7. URL・名称・具体的な公開項目・計算式は **未確定**（調査 → 比較 → MK 決定）。
   **調査段階で新しい表示項目・計算式を確定仕様にしない。**

### 有料情報の扱い（**直接公開は禁止 / 非公開入力としての利用は検討可能**）

`pt`（累積スコア）/ AI総合指数 / 役割 / 特徴量 は **第 2 層でも公開しない**。
ただし **利用そのものを禁止するものではない**。

| | 可否 |
|---|---|
| これらの値を**そのまま画面・API へ出す** | **禁止** |
| 名称変更・数値の丸め・ランク化など、**元の有料情報を実質そのまま開示するだけ**の加工 | **禁止** |
| これらを**非公開の内部入力**として使い、無料ユーザーに役立つ**別の情報へ加工・変換**して出す | **検討可能**（採否は MK 決定）|

「別の情報」と言えるかの判定は、**元の値を推測・復元できないこと**を条件とする
（1 対 1 対応・単調変換・順位そのものの開示は「実質そのまま」に当たる）。
本節は**方針のみ**を定め、**具体的な表示項目・計算式は確定仕様にしない**。

### 却下済みの案（**再提案しない**）

| 案 | 判定 |
|---|---|
| **前日の答え合わせ（AI印 × 実着順）** | **却下**（2026-08-19 MK 決定）。第 2 層の候補から外す |
| 無料専用の 5 点買い目を新設 | 不採用 |
| `/free-prediction/` の解放範囲を広げて第 2 層を兼ねる | 不採用 |

### 第 2 層の無料会員特典（2026-08-20 確定）

**登録特典＝拡張版 `/race-viewpoints/`**（自動付与）。開くのは**公開事実だけ**で、
買い目 / `pt` / AI総合指数 / 役割 / 特徴量は**登録しても出さない**。

| 特典 | 単一源 |
|---|---|
| 出走間隔 / 馬体重の増減 / 条件変化の履歴 / 同条件馬の横比較 | `src/lib/freeViewpoints/memberExtras.js` |

**守ること**:

- **いま公開しているものを引っ込めてゲートにしない**（追加分だけをゲートにする）
- `/free-prediction/` と重複する情報を特典にしない（未登録から迂回できるため）
- ゲートは**クライアント側の soft gate**。公開事実にのみ使い、**有料情報には使わない**
- 「登録すれば買い目が見える」と読める文言を書かない

検証: `npm run test:free-viewpoints`（`memberExtras.test.mjs` / `memberGate.guard.test.mjs`）。

判断の根拠と不採用案は `docs/decisions.md` §2026-08-19（無料コンテンツを 2 層に分ける）が正本。
進捗・残作業は `docs/progress.md` の該当ブロックが正本。

### 第 2 層の実装（2026-08-19 / 仮 URL・仮名称のまま実装）

無料ユーザー向けに、**全レース一覧＋各レースの短い見どころ**を出す。
出すのは**出走馬の近走（前走の会場・距離・騎手）から数えたレース単位の傾向**だけで、
買い目・`pt`・AI総合指数・役割・特徴量は**出力にも入力にも使っていない**。

| | |
|---|---|
| URL | `/race-viewpoints/{jra,nankan}/`（**2026-08-20 に nav 掲載・`noindex` 解除**。nav / フッター / トップページでの呼び名は「**無料予想**」。URL 名称そのものは未確定で、変更する場合は 301 リダイレクトが要る）|
| 判定の単一源 | `astro-site/src/lib/freeViewpoints/raceViewpoints.js`（純粋・I/O なし）|
| しきい値の単一源 | `astro-site/src/lib/freeViewpoints/thresholds.js`（**凍結値**）|
| 文言の単一源 | `astro-site/src/lib/freeViewpoints/copy.js`（**仮文言**・有限集合）|
| データ源 | 南関 = `horseStats/nankan`（**馬番**結合）／ JRA = `horseHistories/jra`（**馬名**結合・`lib/jra/horseHistoryJoin.js`）|
| 検証 | `npm run test:free-viewpoints`（`check:safety` と CI 個別 step に組込済み）|

#### 2 つのレイヤーを混同しない

- **絶対タグ**: JRA / 南関それぞれの**カテゴリ全体の分布**が基準。意味が日替わりしない
- **当日相対**: **その会場のその日**の中での順位。意味はその日限り。3 つだけ出す

#### しきい値（凍結値 / 変更は測り直し＋テスト更新＋docs 更新が必須）

母集団は「通常タグ判定に進めるレース」＝**全頭照合できて過去走があるレース**。
南関 660 レース（2026-06〜08）／ JRA 753 レース（2026-05〜08・`(地)`/`(外)` 照合修正後）。

| 指標 | 南関 `[p20, p80]` | JRA `[p20, p80]` |
|---|---|---|
| 距離替わり | `[0.14, 0.57]` | `[0.19, 0.62]` |
| 初コース | `[0.00, 0.15]` | `[0.25, 0.79]` |
| 乗り替わり | `[0.25, 0.56]` | `[0.44, 0.79]` |
| 近走の比べやすさ | `[0.33, 0.78]` | `[0.00, 0.43]` |

- **`MIN_HORSES = 3`**（全次元共通）。1〜2 頭でタグが立つのは**南関の初コースだけ**で、
  3 頭を課すと該当 134→60 件・**−1 頭で判定が変わる率 57% → 3%**
- **`REQUIRED_COVERAGE = 1.0`**（JRA は全頭照合できたレースだけ通常判定）。
  実測で全頭照合が **98.6%** あり、しきい値を下げる動機が無い
- p85 / p90 は**安定性を改善しなかった**ためタグ数を確保できる p20/p80 を採る

#### レースの状態は 4 つ（混同しない）

| 状態 | 意味 |
|---|---|
| `tagged` | 通常判定できて突出があった |
| `neutral` | 通常判定できたが突出なし → **中立文（1 つの意味に固定）**。弱いシグナルを別文言にしない |
| `no-history` | **全頭照合済みで**近走が 1 頭も無い（新馬戦など）|
| `unmatched` | 近走を照合しきれていない（**準備中**。未出走とは別物）|

個別フィールド（今日の距離など）だけ欠けた場合は、**そのフィールドに依存するタグだけ**落とす（縮退）。

#### 2026-08-19 ユーザー目視で新たに確定した仕様

初回 Preview を MK が目視した結果、**修正前は NG**。以下を確定仕様とする。

1. **単調な青＋白の UI をやめ、意味別の多色 UI にする。**
   **タグ種別 / 当日相対 / 中立 / データなし・準備中**を視覚的に区別する
   （グリーン・レッド・パープル・イエロー等。**exact な色番号は未確定**）。
   **色だけに依存せず、文字とアイコンでも意味が分かること。** contrast / accessibility を確保する。
2. **`<details>` を開いた状態が一目で分かること。** 背景・border・summary アイコン等を
   開閉で変化させ、**開いていることが識別できる class / 状態**を持たせる。
3. **別ページへ誘導するだけの薄いページにしない。**
   各レース詳細の中に**そのレースの出走馬と無料公開可能な印**を直接出す。
   さらに各馬について、このページで使っている**公開事実由来の条件変化**
   （距離替わり / 初コース / 乗り替わり / 前走と近い条件）を**馬単位**で示し、
   「**なぜこのレースが◯◯多めなのか**」を出走馬レベルまで辿れるようにする。
4. **買い目はこのページに出さない。`pt` / AI総合指数 / 役割 / 特徴量も公開しない。**
   **有料専用情報の逆算につながる表示も追加しない。**（3 を満たすために緩めない）
5. **`/free-prediction/` への CTA の役割を変える。**
   「出走馬・印を見る →」ではなく、`/free-prediction/` が**有料版プレビュー**である性質を活かし、
   **買い目は有料版で確認できる**ことを伝える導線にする（最終コピーは未確定）。
6. **このページ単体で「今日の全レースを眺める価値がある」情報密度にする。**
   1 文の説明だけで終わらせない。

**無料公開してよい範囲は変えない。** 出せる印は
`src/lib/freePublicView.js` の `buildFreePublicRows()` が返す範囲＝
**上位 4 頭の印（◎本命 / ○対抗 / ▲単穴 / △連下最上位）と公開事実**のみ。
DTO に `pt` / AI総合指数 / 役割 / 特徴量 / 買い目は含まれない。

> ⚠️ **未決**: `/free-prediction/` は ○▲△ を**無料登録後**に開く導線を持つ。
> 本ページは認証を持たないため、同じ印を**未登録でも見せる**ことになる。
> 無料登録の動機に影響しうるため、**印の出し方（◎のみ / 上位4頭）は MK 判断事項**として残す。

#### 未確定（MK 目視確認が必要）

**ページ名称・最終コピー**は未確定（実装は仮文言）。
2026-08-20 に MK 判断で **nav 掲載（独立トップ項目「🔍 レースの見どころ」）と `noindex` 解除**を実施した。
URL を変える場合は **301 リダイレクトが必要**になる点に注意。

### `/results-showcase/` との関係（既存の例外を変えない）

`/results-showcase/{jra,nankan}` は **前日確定分**のメインレース 5 点を無料公開している
（詳細正本: `astro-site/docs/RESULTS_SHOWCASE.md`）。これは既存の意図的な例外であり、
本節はこれを変更しない。**当日分の買い目を無料へ出さない**という区別を維持する。

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

## メルマガ自動化の Redis 不変条件（2026-08-06）

| 不変条件 | どう守るか |
|---|---|
| `index:active` は **`status === 'ACTIVE'` と一致する** | `saveDefinition` が **CAS と索引を 1 回の Lua**（KEYS 2 本）で更新する。tick の先頭で `reconcileActiveIndex()` が古い不整合を収束させる（**外す方向だけ**） |
| 同じ `runId` を**二度開始しない** | `run-mark:<runId>` の `SET NX`（**TTL 無し**）。run 本体の TTL 切れに依存しない |
| run の保持期間 | `RUN_TTL_SEC = 120 日`。履歴表示（既定 30 日 / 最大 90 日）より長い |
| TTL の大小 | `lock 300 秒 < recipient claim 7 日 < run 120 日 < 墓標（無期限）` |
| PII | Redis に保存するアドレスは **`ak:prospect:` 配下だけ**。`run-mark` は `runId`（automationId + 暦日）のみ |

## 管理操作の完成条件（2026-08-07 恒久ルール）

管理画面から**本番の顧客体験を変える操作**（販売状態・送信・特典付与・昇格）は、
**文言と公開側の最終挙動が一致して初めて完成**とする。実装・テスト・CI が green でも、
**運用者が通常理解する意味と挙動がズレていれば未完成**。

### 検証は一連で行う（画面の状態だけを見ない）

```
管理操作 → 保存値 → 公開判定 → 商品ページの可否 → purchaseEnabled
```

**強い操作語**（「即時販売」「送信」「昇格」「販売可」）は、この全段を **E2E で確認**する。
保存値が正しいことや、管理一覧の表示が変わったことをもって完成としない。

### dry-run / preview の要件

本番書き込み前の確認画面は、**「この操作後に顧客から何が見えるか」を明示**できること。
保存されるフィールド値の羅列で終わらせない。

### 再発防止

この種のズレは**運用者の手動監査を前提にせず、自動テストと仕様で検知**する。
恒久的な回帰条件は `src/lib/premiumPlus/premiumPlusImmediateSale.test.mjs`:

管理画面で「今すぐ販売可」を確定 → `PremiumPlusReleaseOverride = 'phase4'` →
   公開判定 `phase = 4` → `showProductPage = true` → `purchaseEnabled = true` →
   **本人が `/premium-plus/` で購入できる**

`showPurchaseCta` は公開判定の値として確認してよいが、
**「三連複ページに強い CTA が即座に出ること」は完成条件にしない**。

## Premium Plus の「即時販売」（2026-08-07 明文化）

管理画面の**「今すぐ販売可」＝即時販売**は、**その会員だけ段階公開の待機日数を飛ばして
PHASE 4（販売中）にする**操作。単に `PremiumPlusEligibility = eligible` にするのとは違う。

| 操作 | 書く値 | 会員に起きること |
|---|---|---|
| 段階公開で販売可（staged） | `eligible` + override **解除** | 販売資格は付くが、**PHASE 1→4 の待機日数が経過するまで買えない** |
| **今すぐ販売可（immediate）** | `eligible` + **`PremiumPlusReleaseOverride = 'phase4'`** | **即座に** PHASE 4。`/premium-plus/` を開けて**購入できる**（`showProductPage` / `purchaseEnabled` が true） |
| 保留（review）/ 販売対象外（blocked） | 該当状態 + override **必ず解除** | 売らない。override を残すと再 eligible 化で即時販売が復活するため |

### 守るべき性質

- **route は本人本来のもの**を保つ（三連複会員は `sanrenpuku` のまま。Premium は `premium_admin`）
- **override は待機より優先**（`PremiumPlusEligibleAt` / `PaidAt` からの日数計算を飛ばす）
- **売ってはいけない状態は override でも売らない**（review / blocked / 契約無効）
- **受付時間帯は変えない**（16:30 以降は `purchaseEnabled=false`）
- **冪等**（同じ操作を繰り返しても結果が同じ。2 回目は override を PATCH に含めない）
- **他会員に波及しない**（判定は 1 レコードだけを見る）
- **同義の新規フィールドを増やさない**（既存 `PremiumPlusReleaseOverride` が正本）

### 三連複ページの販売導線は段階公開設計のまま（即時販売はこれを変えない）

`PremiumPlusCta.astro` は **2026-07-15 から `premium-sanrenpuku.astro` でコメントアウト**されている
（prerender + クライアント AccessControl のため、置くと商品名とリンクが未ログイン者の HTML に載る＝存在秘匿が破れる）。

PHASE 4 の会員に実際に見えるのは:

1. `/premium-plus/` が開ける（価格・申込ボタンあり）
2. 三連複ページの **`PremiumPlusStageTeaser`（予告枠リンク）**のみ（SSR API 経由で会員だけに描画）

即時販売が保証するのは **商品ページのアクセスと購入可否**であって、
**三連複ページに新しい強い CTA を出すことではない**（導線は既存設計を維持する）。
管理画面はこの実態を操作前に表示する（文言と実動作を食い違わせない）。

### 単一源

| 目的 | ファイル |
|---|---|
| 公開判定 | `src/lib/premiumPlus/premiumPlusRelease.js` |
| 管理操作 → 書く値 | `src/lib/premiumPlus/premiumPlusEligibility.js`（`buildAdminActionFields`） |
| 顧客に見えるものの再現 | `src/lib/premiumPlus/premiumPlusPreview.js`（`buildPreviewSnapshot`） |
| 規約の固定 | `src/lib/premiumPlus/premiumPlusImmediateSale.test.mjs` |

## Premium Plus の再募集は**会員ごと**（2026-08-22 確定）

優待クーポンの有効期限は「**再募集の開始日時 + 14 日**」。その **`reopenStartsAt` は
会員ごとに持つ**（サイト全体で 1 個ではない）。

| 項目 | 確定内容 |
|---|---|
| 単位 | **会員単位**。admin で対象顧客を選んで開始する |
| 操作 | `/admin/premium-plus-eligibility/` の**各顧客詳細**「再募集（この会員）」 |
| 値 | **押下時のサーバー時刻**が、その会員の `reopenStartsAt` |
| client 指定日時 | **信用しない**（要求 body の時刻は 1 つも読まない）|
| 期限 | その会員の `reopenStartsAt + 14 日` を既存の単一源から導出 |
| 二重押下・並行要求 | **上書きしない**（`HSETNX` の first-write-wins）|
| 未開始の会員 | **fail closed**（販売も予約も開かない・期限を出さない）|
| 他会員 | **影響しない** |
| 保存先 | Upstash Redis の HASH `ak:pp:reopen:v1:members`（field = recordId）。**本番 schema を増やさない** |

### 別軸であるもの（開始しても 1 バイトも変えない）

`PremiumPlusEligibility` / `PremiumPlusReleaseOverride` / PHASE / route /
`PremiumPlusSalePaused` / 販売 CTA / クーポン保有（3 列）/ プラン / 決済。

⚠️ **再募集の開始は「売れるようにする」操作ではない。** 開始済みでも
`salePaused` の会員は従来どおり購入できない（購入可否は既存判定のまま）。

### 参照の単一源

`loadReopenStart({ recordId })` → `withReopenStart()` の 2 段だけ。
顧客画面（受付休止 / クーポンページ / マイページ）・申込画面・申込受付・admin が
**同じ経路**で、**その会員の** recordId を渡して読む。
URL 直打ち・API 直呼び・古いタブでも、サーバーが recordId を検証してから
保存先を読み直すので判定は一致する。

### やってはいけないこと

- **サイト全体で 1 個の開始日時を復活させない**（旧 `ak:pp:reopen:v1:start` は廃止済み・本番未使用）
- admin に**一括開始ボタン・取消ボタンを置かない**（rollback は Upstash の `HDEL` のみ）
- 期限日数（14）を `premiumPlusReopenCoupon.js` 以外に書かない
- 「読めない」を「未開始」に丸めない（`unknown` として理由を出す）

単一源: `src/lib/premiumPlus/premiumPlusReopenStart.js`（判定・純粋）/
`premiumPlusReopenStartStore.js`（保存・Redis）。
詳細は `astro-site/docs/PREMIUM_PLUS_STAGED_RELEASE.md`、判断の記録は `docs/decisions.md` §2026-08-22。

## 見込み客プール（外部リスト・2026-08-06）

外部 CSV の 1 万数千件は **Airtable Customers へ入れない**。Redis の見込み客プールで扱い、
**1 回でも open / click した人だけ**を Customers へ昇格させる。
反応が無いまま 3 回送ったら**登録せず、以後の配信対象から永久に外す**。

### 状態機械（単一源 `src/lib/marketing/prospectPolicy.js`）

```
NEW ──送信──▶ SENDING ──反応──▶ ENGAGED ──登録──▶ PROMOTED
                │
                ├─ 3 回 無反応 ─────────────▶ EXHAUSTED（登録しない）
                └─ bounce / 苦情 / 配信停止 ─▶ SUPPRESSED（即時）
```

- 反応とみなすのは **open / click だけ**（`delivered` は反応ではない）
- 同一相手への最小間隔 **3 日**
- **除外は反応より優先**。苦情の後に開封しても戻さない

### ⚠️ 永続抑止台帳（TTL を付けない）

`ak:prospect:blocked:<sha256>` に **TTL なし**で `hash` / `kind` / `reason` / `at` / `sends` を残す。
**TTL で消すと CSV を入れ直したときに配信対象として復活する。**
台帳は**アドレスを持たない**。生アドレスを持つのは `ak:prospect:p:` の**配信中のレコードだけ**で、
抑止後は `purge()` で削除してよい（台帳が残るので復活しない）。取り込みは **hash で台帳と突合**する。

### 反応者は自動で登録される

`netlify/functions/cron-prospect-worker.js`（**10 分ごとの Scheduled Function**）が、
ENGAGED を Customers へ **CREATE 1 件**する。

| 仕組み | 目的 |
|---|---|
| `promo-lock:<hash>` の `SET NX` | 自動と手動（管理画面）の**二重登録を防ぐ** |
| **CREATE 成功時だけ** PROMOTED | 作られていないのに完了扱いにしない |
| 失敗時は **ENGAGED 維持 + claim 解放** | 次の tick で**再試行**する |
| 写しが使えなければ**登録しない** | 既存顧客との重複を判定できないため |

書く列は取り込みと**同じ allow-list**（`Email` / `プラン=Free` / `ポイント` / `Source`）。
課金・権利・配信停止の列は 1 つも書かない。`PATCH` / `DELETE` の経路を持たない。

### 顧客一覧の写し（同期 Function をタイムアウトさせない）

dry-run と ACTIVE 化が Customers を全件・逐次取ると、**約 4,000 件でタイムアウト域**、
15,800 件では確実に失敗する。走査は **Scheduled Function だけ**が行い、
同期側は Redis の写し（`ak:customer-snapshot:`）を読む。

- **公開 URL から走査を起動できない**（scheduled function への HTTP は Netlify が 403）
- 管理画面の「写しを更新」は **認証済み管理 API が Redis に依頼札を立てるだけ**。
  次の tick が拾う（管理 API は自分で走査しない）
- 写しが**無い / 古い（6 時間）/ 壊れている**ときは **fail-closed**

### 単一源

| 目的 | ファイル |
|---|---|
| 状態機械・判定 | `src/lib/marketing/prospectPolicy.js` |
| 保存（Redis / 台帳 / claim） | `src/lib/marketing/prospectStore.js` |
| 配信対象・昇格計画・イベント反映 | `src/lib/marketing/prospectPipeline.js` |
| 顧客一覧の写し | `src/lib/marketing/customerSnapshotCache.js` |
| 管理 API の中身 | `src/lib/marketing/prospectAdminApi.js` |
| 管理 API | `netlify/functions/admin-marketing-prospect.js` |
| 自動処理（昇格・写し更新） | `netlify/functions/cron-prospect-worker.js` |
| 配信計画（customer + prospect） | `src/lib/marketing/automationTickPlan.js` |
| 画面 | `src/pages/admin/premium-plus-eligibility.astro` |

### ゲート（いずれも production 未設定）

`MARKETING_PROSPECT_WRITE_ENABLED`（取込・手動昇格・除外・削除）/
`MARKETING_PROSPECT_AUTO_PROMOTE_ENABLED`（**自動登録**）/
`MARKETING_PROSPECT_EVENTS_ENABLED`（webhook からの反映）/
`MARKETING_AUTOMATION_ENQUEUE_ENABLED`（cron からの enqueue）

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
| **排他とグローバル行 claim（Redis）** | `src/lib/crm/importClaimStore.js` | 実装済み |
| **親ジョブの正本 + snapshot（Redis）** | `src/lib/crm/importJobAuthority.js` | 実装済み |
| **4 点突合と reconciler の解放条件** | `src/lib/crm/importJobReconcile.js` | 実装済み |
| 下見 API（read-only） | `netlify/functions/admin-customer-import.js` | 実装済み（`action:'previewCsv'`） |
| 単発実行 API（1 回 100 件） | `netlify/functions/admin-customer-import-run.js` | 実装済み・本番 3 バッチ 210 件で実績 |
| **ジョブ API（開始 1 回・子バッチ分割）** | `netlify/functions/admin-customer-import-job.js` | 実装済み・**start/step は kill-switch で 403**（BLOCKED） |
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

##### 正本と排他は Upstash Redis（Blobs 方式は破棄）

Netlify Blobs は同一キー競合が **last-write-wins** で、`onlyIfNew` / `onlyIfMatch` も
best-effort でしかない（premium-plus canary #13 で実 lost-update を確認・
`docs/PREMIUM_PLUS_STORAGE_DESIGN.md`）。**リースは排他にならない**。
また Airtable の `Source` 件数だけでは **snapshot / 失敗 / 未処理 / cancel 境界 /
operationId** を復元できず、ImportJobs テーブルの新設は **schema 変更**にあたる。

そこで **Upstash Redis**（AK の既存基盤・入金確認メール v2 で本番稼働中）を採る:

1. **グローバルロック** `customer-import:lock:global` を `SET NX EX` + `INCR` fencing token で取る。
   **AK 全体で write ジョブは同時に 1 つ**。job 単位ではないので**異なる `batchId` 同士の競合も拒否**する。
   **取れなければ Airtable を一切読まない・書かない**
2. **行 claim は正規化メールに対してグローバル**: `customer-import:email:<sha256(normalizedEmail)>`。
   **`batchId` で区切らない**（区切ると別 batchId が同じメールを同時 claim できてしまう）。
   作成の**前**に `EVAL`（Lua）で 100 件を 1 往復 atomic 取得する
3. **親 ImportJob の正本は Redis**。snapshot は chunk 分割（500 件ずつ）して固定し、
   `snapshotFingerprint` で開始後の差し替えを検知する
4. Customers の実在判定は **第二防御**。**同時実行排他の代替ではない**

###### 不変条件（順序を崩さない）

グローバルロック → 正本読み込み → snapshot 検証 → 子バッチ claim →
**行 claim（Lua）** → **書き込み直前にロック所有権と fencing token を再検証** →
所有権を失っていたら **create しない** → create 成功を確認した行だけ `CREATED` へ。

**claim は Airtable で作成済みと確認できるまで解放しない。** 回収は reconciler だけが、
次を**すべて**確認してから行う: Customers に同メールが無い / 同 `Source` の行が無い /
claim が期限切れ / 旧 fencing token が現在値より古い。

###### 保証すること・しないこと

- **保証**: Redis が正常なときの **at-most-once claim**（＝二重作成が起きない）
- **保証しない**: literal exactly-once。claim 後・create 前のクラッシュは
  「claim 済み・未作成」を残す。これは**重複ではなく取りこぼし**（安全側）で reconciler が回収する
- **Redis 異常時は新規 Airtable 書き込みを全面停止（fail-closed）**:
  到達不能 / Lua 結果不明 / lock 状態不明 / 正本が読めない / claim 不整合 / データ欠損の疑い

###### 突合は 4 点（不一致なら自動続行しない）

Redis job counters / Redis 行 claim 状態 / Airtable `Source` 件数 /
**Customers 全体の正規化メール重複数**。
説明できない不一致は `BLOCKED`、claim 済み・未作成が残るときは `PARTIAL` とし、**進めない**。

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

## 販売CTA の自動判定を管理画面で確認する（2026-08-07）

管理者が **「今なぜこの CTA が出ているのか」を管理画面だけで読み切れる**ようにする。
判定そのものは変更しない — しきい値・優先順位・fail closed 条件は従来どおり。

### 管理画面（`/admin/premium-plus-eligibility` の詳細パネル）に出すもの

| 項目 | 内容 |
|---|---|
| 三連複保有 | あり / なし |
| ROUTE | A（三連複購入者）/ B（Premium 30日）/ C（管理者指定）/ 対象外 |
| Premium加入からの経過 | 日数 / ROUTE A は **「ROUTE A（三連複保有）のため判定対象外」** / それ以外で `PaidAt` が無ければ **「加入日（PaidAt）が未記録」**（下記）|
| **自動判定CTA** | `UpsellTarget` を無視して auto で解決した結果（三連複 / Plus / なし）|
| **自動判定の理由** | 具体的な 1 文。ROUTE B なら「Premium加入から30日以上経過（42日）・三連複未購入のため Plus を自動表示」|
| 現在の設定 | Airtable `UpsellTarget`（自動 / 三連複 / Plus / なし）|
| 顧客に表示されるCTA | 最終結果（顧客側 resolver と同一）|
| 実表示の理由 | 具体的な 1 文 |

手動指定が自動判定と違う結果になっているときは、その旨を明示する。

### 「自動」の意味（管理画面に常設）

1. Plus の販売条件が成立している → **Plus のみ**表示
2. それ以外で三連複を購入できる → **三連複のみ**表示
3. どちらでもなく Plus の予告段階 → **Plus の予告のみ**表示
4. **2 商品を同時に表示することはない**

### `daysSincePremium = null` は 2 通りある（混同禁止）

`resolvePlusRoute` は **ROUTE A で最初に短絡し、`daysSincePremium` を常に `null`** で返す。
三連複保有者に「Premium 加入からの 30 日」は無関係だからで、**`PaidAt` が無いという意味ではない**。

| null の理由 | 表示 |
|---|---|
| ROUTE A（三連複保有）＝ 判定対象外 | 「ROUTE A（三連複保有）のため判定対象外」 |
| `PaidAt` が本当に無い（2026-07-10 の入金確認フロー刷新より前の会員）| 「加入日（PaidAt）が未記録」 |

`null` を一律「未記録」と表示すると、`PaidAt` を持つ三連複会員に**データ欠損だと誤読させる**
（2026-08-07 の表示不備。本番 ROUTE A 3 件のうち 2 件が該当していた）。

文言の正本は `describeDaysSincePremium(days, { route, hasPaidAt })`。
**管理画面側で `daysSincePremium == null` から文言を決め打ちしない**（guard テストで禁止）。

### 手動上書き

`自動 / 三連複 / Plus / なし` の 4 択（従来どおり・単一選択）。
**明示指定でも各商品の販売資格・契約状態・blocked 等の fail closed 条件は再評価する**
（保有済みへの三連複 CTA / blocked への Plus CTA は手動でも出ない）。

### 実装の分担（判定と説明を混ぜない）

- 判定の正本: `src/lib/upsell/upsellTarget.js` / `src/lib/premiumPlus/premiumPlusRelease.js`
- **説明の生成: `src/lib/upsell/upsellExplain.js`（純粋・read-only）**。
  しきい値も優先順位も持たず、既存 resolver の戻り値を日本語にするだけ
- 「自動ならどうなるか」は `resolveUpsellForCustomer({ ..., targetOverride: 'auto' })` で求める。
  **`targetOverride` は管理経路専用**。顧客向けページ / API では使わない（guard テストで固定）

固定テスト: `src/lib/upsell/upsellExplain.test.mjs` /
`src/lib/upsell/upsellIntegration.guard.test.mjs`

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

## Light 無料体験 → Premium の道のり（2 フェーズ / 合計 24 接点 / 2026-08-15）

### 何を約束しているか

**1 人あたり最大 24 通**の接点を作り、反応（開封・クリック・購入・配信停止・バウンス）で
継続 / 停止を決める。人が 145 回手操作しなくても運用できること。

### なぜ 2 キャンペーンに分かれているか

無料体験は **30 日で終わる**。最短 3 日間隔 + 無反応での間隔延長では、
体験中に届くのは **6 通前後**（統合テストで実測）。
7 通目以降を体験中フェーズに置くと、期限切れの相手へ「無料期間中です」と書いた
メールを送ることになり、**事実と食い違う**。

| フェーズ | campaignId | 通数 | 通し番号 | 対象条件 |
|---|---|---|---|---|
| 体験中 | `light-trial-to-premium-sequence` | 6 | 1〜6 | `requiresActiveGrant: {tier:'light', termedOnly:true}` + 取り込みコホート |
| 体験終了後 | `light-trial-post-expiry-sequence` | 18 | 7〜24 | `requiresExpiredGrant: {tier:'light'}` + 取り込みコホート |

通し番号（touch）の変換は **`src/lib/marketing/journeyModel.js` が単一源**
（`journeyId = light-trial-to-premium-v1` / `maxTouches = 24`）。

### フェーズ移行（handoff）

**記録を作らない。** 毎 tick、そのときの事実から導出する:

1. 体験中フェーズは期限切れを `grant_expired` として止める（**脱落ではない**）
2. 終了後フェーズは `requiresExpiredGrant` で「痕跡があり期限切れ」の人を対象にする
3. 購入・配信停止・バウンス・苦情・suppression・対象外は既存の単一源が止める
4. 期日が来たら通常の安全経路（sequence 判定 → dry-run → 指紋 / contentHash /
   shellVersion 固定 → queue → 送信直前 dry-run → `expectedWillSend` 付き Background）

導出なので**二重に作られようがない**（統合テストで固定）。

### 止める条件と、止めない条件

**即停止**: 購入 / 配信停止 / ハードバウンス / 苦情 / provider suppression / 対象外
（`grant_revoked` / `grant_lifetime` / コホート外）。

**止めない**: 単なる無反応。間隔は伸ばすが（無反応 3 連続で 2 倍）、24 通までは進む。
短期の出しすぎ防止（最短 3 日 / 7 日 2 通）と、送信直前の横断頻度ガードは維持する。

### 文面の約束

- 終了後の文面に「無料体験中」「まだ無料で利用できます」等、**事実と異なる表現を置かない**
  （カタログ検証で禁止語を検査）
- 終了後は `{{grantExpiry}}`（体験の終了日）を差し込まない
- 24 通すべて `action=preview` で**送らずに確認できる**

### version ルール（連続配信）

DeliveryKey = `campaignId × version × step × 受信者`。version を上げると
**1 通目から全員へ配り直し**になるため、単発キャンペーンと同じ扱いにしない。

| | 扱い |
|---|---|
| 末尾への追加 | version 据え置きで**許可**（既存 Step の鍵を変えない） |
| 未送信 Step の修正 | version 据え置きで**許可**（`LOCKED` に記録） |
| **送信済み Step の変更** | **禁止**（`campaignCatalog.test.mjs` が逐語で凍結） |

送信済み: `light-trial-to-premium-sequence` の **Step1**（2026-08-15 / 10 名）。

### 展開の完成条件（**正本: `astro-site/src/lib/marketing/rolloutTarget.js`**）

| 項目 | 値 |
|---|---|
| 対象 | 取り込みコホート **約 15,000 名** |
| 目標 | 正常時は**同日中に自動で配り切る**（`sameDay: true`） |
| 1 日上限 | **dailyLimit=15000** |
| 論理バッチ | **batchSize=500** |
| 付与 1 回 | **200**（`GRANT_OPERATION_MAX`）。500 名は **200 + 200 + 100** に分割 |
| 1 バッチ | 付与 3 + queue 1 + 送信起動 1 = **5 tick**（cron 2 分 → 30 バッチで約 5 時間） |

- 各論理 500 名は **付与 → Step1 queue → dispatch → `PENDING=0` / `outstandingStep1=0` 確認**
  を経てから次のバッチへ進む
- **人間は 500 名ごと・日ごとの再開操作をしない**（開始は `alwaysArmed: true` の 1 回だけ）
- 正常なら候補 0 まで自動継続し **`completed`** へ入る。
  `completed` 後は cron が動いても**新規付与 0**（既に配った人の Step2〜24 は続く）
- **異常時だけ auto-stop** し、人が原因を解消して開始し直すまで再開しない
- 二重付与・二重 queue・二重送信は既存の **`operationId` / `DeliveryKey` / 関所 / CAS** で防ぐ
- 大規模の touch 集計は **paged scan**（`action=touchMeasurementPage` /
  `npm run scan:touch-measurement`）が正規経路。**単一 Function の全件走査へ戻さない**

⚠️ **「500 名/日」は仕様ではない。** 2026-08-17 に 500 名で止めたのはカナリアと障害修正のため。
   運用を一時的に絞るときは `rolloutStart` の引数（state）で絞る。**目標そのものは下げない。**
   目標値を変えるには `rolloutTarget.js` と本節を**同時に**直す必要がある
   （`rolloutTargetContract.test.mjs` が突き合わせているので、片方だけでは CI が落ちる）。

### 管理画面（`action=rollout`）

体験中 / 体験終了・フォロー中 / 購入 / 停止 / 24 通完了 / 現在の通し番号 / 次回予定 /
閉じている env と、そのせいで止まっていることを返す。
人数の主計は**終了後フェーズの集計**から作る（両フェーズは同じ母集団なので、
単純に足すと 1 人を 2 回数える）。まとめ方は `journeyTotals.js` が単一源。

---

## グループ配信の単位（2026-08-17 / 同日複数バッチ）

約 15,000 件を安全に配るため、**同じ日に複数バッチ**を回せる。

| 概念 | 意味 |
|---|---|
| `batchSize` | **1 回に配る人数**（例 500）。**必須**（既定値で代用しない） |
| `dailyLimit` | **1 日に配れる合計人数**（回数ではない。例 15000）。**必須** |
| `ABSOLUTE_MAX_PER_DAY` | 絶対上限 **20000**（状態が壊れても超えない。15,000 件を 1 日で配り切れる） |
| `lastRunDay` | **今日の集計がどの日のものか**（「1 日 1 回」の禁止札ではない） |
| `batchSeq` | 今日のバッチ通し番号。`operationId` の枝番になる |

**「1 日 1 回」は廃止した。** 代わりに次が二重付与・二重送信を防ぐ:

1. **関所**（`previousOutstanding > 0` なら次を始めない）＝ バッチの直列化
2. 1 日の合計上限
3. **バッチごとに一意な `operationId`**（`light-trial-YYYY-MM-DD` / `-b2` …。
   1 バッチ目は従来の形なので既存データと互換。同じ値の再実行は冪等）
4. DeliveryKey（campaign × version × step × 受信者）
5. kill switch（全アクションに優先）

**バッチ間の健全性チェック**（`batchHealth.js`）: 2 バッチ目以降は前バッチの
failed / duplicate / bounce / complaint / unsubscribe / outstanding / suppression を確認し、
**数えられない値があれば進まない**。異常なら `stage: 'paused'` へ落として自分で止まる。

---

## 配信イベントの計測（2026-08-16 / 1 通ごと）

### 保存先

| 場所 | 役割 |
|---|---|
| **Netlify Blobs**（`ak-email-events`） | **正本**。生ログを append-only（`MARKETING_EVENT_SINK=blob`） |
| **Redis**（`ak:delivery-events:<DeliveryKey>`） | 1 通ごとの索引（delivered / first open / last open / open 回数）。再構築できる写し |
| **Redis**（engagement signal） | 受信者ごとの反応集計（どの通かは持たない） |
| Airtable `EmailEvents` | **書かない**（行数が Airtable の 37% を占めたため移設済み） |

### 判断は DeliveryKey 完全一致

「この人がこの touch を開いたか」は **DeliveryKey**（campaign × version × step × 受信者の
sha256）でしか結ばない。受信者ごとの「最新 open 時刻」から推測すると、
古いメールを後から開いたときに別 touch へ誤帰属する。

### 未計測は「無反応」ではない

| 状態 | 扱い |
|---|---|
| delivered あり + open あり | 反応あり |
| delivered あり + open なし | **観測できた**無反応（減速の材料になる） |
| delivered を確認できない / 索引が読めない | **未計測**（無反応として数えない・減速も停止もしない） |

`click` は provider 側で OFF（アカウント全体の click tracking はマジックリンクを壊すため）。
**false と捏造せず unknown のまま**にする。

### 読み取りの上限

- 展開の運用状態は 6 つ（`src/lib/marketing/rolloutOperationalState.js` が単一源）:
  `running` / `waiting_previous` / `daily_limit_reached`（**翌日自動継続**）/ `completed` /
  `paused` / `auto_stopped`（**人が直すまで再開しない**）
- 管理画面 `action=touchMeasurement` … Blob 全件走査 **なし**、Redis は最大 500 鍵の bounded read。
  **配信台帳も全件走査しない**（1 ページ = cursor 方式。全体は `action=touchMeasurementPage` を辿る
  `npm run scan:touch-measurement`。数え切れないときは数字を返さない）
- `action=eventBackfillDryRun` … Blob は**日付で絞って**読む。**書き込みは別承認**

---

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
- 無料公開DTO `buildFreePublicRows()`（`freePublicView.js`）へ `pt` / AI総合指数 / 役割 / 特徴量重要度 / 評価ポイント / 買い目を追加すること（＝**直接公開**の禁止。これらを**非公開の内部入力**として派生情報の生成に使うことまでは禁止しない）
- 新設する無料ページで `pt` / AI総合指数 / 役割 / 特徴量を**そのまま公開**すること、および名称変更・数値の丸め・ランク化など**元の有料情報を実質そのまま開示するだけ**の加工で出すこと
- 新設する無料ページ（当日・全レース）で買い目を表示・返却すること、および無料専用の買い目を新規に作ること（`/results-showcase/` の**前日確定分**は既存の意図的例外として維持）
- **第 2 層を兼ねさせる目的で** `/free-prediction/` の公開範囲を広げること（第 2 層は**別の新規ページ**で作る。`docs/decisions.md` §2026-08-19）。※ 通常の UI 改善・不具合修正、および 2026-08-20 の**有料版プレビューへの位置づけ変更**はここに含まない
- `/free-prediction/` に無料登録による全頭解放 CTA / ゲートを復活させること（2026-08-20 撤廃済み。CTA だけ・ゲートだけの復活も不可）

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

### 配信履歴の置き場所（2026-08-09〜 段階移行）

Airtable Team は 1 Base 50,000 レコードで、配信 1 回（14,279 名）で 34,000〜41,000 件増える。
**Airtable に置くのは「人が画面で直接扱う正本」だけ**とし、配信履歴は既存インフラへ出す。

| データ | 置き場所 | 理由 |
|---|---|---|
| Customers / EmailBlacklist / PromotionalOffers 等 | **Airtable** | 人が扱う正本。件数も小さい |
| `DeliveryKey`（二重送信防止）| **Upstash Redis** の SET | 必要なのは集合だけ。O(1) 判定 |
| 配信イベントの生ログ | **Netlify Blobs**（NDJSON）| append-only。バッチ固有キーで新規作成のみ |
| イベントの集計 | Redis カウンタ | 表示用 |

段階は `MARKETING_DELIVERY_STORE` / `MARKETING_EVENT_SINK` の 2 env で表す。
**どちらも既定 OFF で従来動作。** 詳細と切替順序は `docs/AIRTABLE_CAPACITY.md`。

---

# メールマーケティング方針（2026-08-10 改定）

**大量送信を減らし、反応する見込みのある相手へ「受け取る側に得のあるメール」だけを送る。**
Customers レコードは削除しない。会員・決済とマーケティング配信可否は分ける。

## 1. エンゲージメント分類

単一源 `src/lib/marketing/engagementPolicy.js`。**閾値をコードへ散らさない。**

| 状態 | 条件 | 通常マーケ配信 |
|---|---|---|
| `ACTIVE` | open / click / 購入 / ログインのいずれか | 送る |
| `UNKNOWN` | 送信が閾値未満（判断材料不足）| 送る |
| `LOW_ENGAGEMENT` | 5 回以上送信して無反応 | **送る**（観察段階。まだ止めない）|
| `INACTIVE` | 10 回以上 delivered で無反応 | **除外** |
| `HARD_INACTIVE` | 20 回以上 delivered で無反応 | **除外** |

閾値は env で上書き可（`MARKETING_LOW_ENGAGEMENT_SENDS` /
`MARKETING_INACTIVE_DELIVERED` / `MARKETING_HARD_INACTIVE_DELIVERED`）。
壊れた値・大小関係が逆の設定は**既定へ倒す**。

### 譲らない前提

- **取引メールには適用しない**（決済確認 / 認証 / サポート / 期限通知 / step）。
  反応が無くても届けなければならない
- **unsubscribe とは別状態**。あちらは本人の意思表示
- **bounce / provider suppression は従来どおり最優先で除外**
- **open を絶対視しない。** Apple MPP・画像ブロックで落ちるし、プリフェッチで立つ。
  open は「反応あり」へ倒すためだけに使い、open が無いことで切るのは
  delivered が閾値に達してから
- **click / 購入 / ログインはより強いシグナル**として別枠（`hasMeaningfulAction`）
- **将来の購入・ログインで ACTIVE へ復帰できる**（状態を固定しない）
- Customers レコードは削除しない

### ⚠️ click は現状ゼロ

`MARKETING_CLICK_TRACKING_ENABLED` が未設定で、Event Webhook の `click` も false。
**click を有効なシグナルとして当てにしない。** 購入とログインで補う。

## 2. メール価値 guard（benefit）

単一源 `src/lib/marketing/campaignBenefit.js`。
**大量配信では「受信者の具体的メリット」を宣言していないと送れない**（fail closed）。

| benefitType | 例 |
|---|---|
| `free_access` | Light / Premium の期間限定無料 |
| `discount` | 割引・特別価格 |
| `content_unlock` | 通常有料の分析・指数・予想の開放 |
| `new_feature` | 明確な新機能 / 新サービス |
| `exclusive_perk` | 直接価値のある特典 |
| `operational_test` | 運用テスト専用 |

- **200 名以下の配信には適用しない**（個別対応・少数テストを止めない）
- 説明が「サイトを見てください」だけなら弾く（具体的な得が要る）
- 宣言も `bulkSendAllowed:false` も無いキャンペーンは作れない（テストで固定）

### 🚫 `dormant-reactivation` v2 は大量配信の対象外

2026-08-09 に 14,279 名へ送ったが、受信者の得は「実績が見られる」だけで、
配信停止申請と苦情を招いた。`bulkSendAllowed: false` で隔離済み。
**再利用には benefit の宣言し直しが要る。**

## 3. 実測（2026-08-10 / 全 15,970 名）

| 区分 | 人数 |
|---|---:|
| ACTIVE | **3,512** |
| LOW_ENGAGEMENT | 0 |
| INACTIVE | 0 |
| HARD_INACTIVE | 0 |
| UNKNOWN（材料不足）| 12,458 |

**現状 engagement guard は 1 人も止めない。** 送信回数の最大が 2〜4 回（59 名）で、
5 回以上に到達した人が **0 名**だから。分類は送信を重ねてから効いてくる。

したがって**いま送信数を減らす手段は「人を絞ること」ではなく「送らないこと」**。
benefit guard が主たる削減手段になる。

| 段階 | 対象 |
|---|---:|
| 全 Customers | 15,970 |
| − unsubscribe / provider suppression | 15,581 |
| − engagement guard | 15,581（変わらず）|

参考: 反応があった人だけに絞ると 3,508 名（削減率 78.0%）。ただし 1 通の open だけを
根拠に 78% を切るのは**根拠が薄い**（Apple MPP の影響を受ける）。閾値運用を優先する。
