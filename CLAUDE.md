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

## 🌐 本番 URL ルール（運用厳守 / 2026-05-29 集約）

| 項目 | 値 |
|---|---|
| **本番 URL** | `https://analytics.keiba.link/` |
| **使用禁止 URL** | `https://analytics.keiba.jp/`（誤記・存在しない）|
| **Netlify サブドメイン** | `https://*.netlify.app/` は **Deploy Preview 専用**。本番案内に使わない |

### 禁止事項

- `analytics.keiba.jp` を本番 URL として使わない / 案内しない
- Netlify サブドメイン (`analytics-keiba.netlify.app` / `deploy-preview-NN--analytics-keiba.netlify.app`) を本番案内・目視確認 URL として使わない
- 本番確認 URL を **推測で生成しない**
- ドメインを記憶や雰囲気で補完しない
- 不明な場合は **ユーザー確認を取る**

### 該当する操作

PR description の本番リンク / ユーザーへの本番反映確認案内 / 目視確認の指示 / 外部ドキュメント生成時の URL すべて。

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

## 🧭 修正対象範囲ルール（4領域横断確認 / 2026-05-24 集約）

表示・ロジック・データ反映・UI修正・文言修正・不具合修正を行う場合は、
**原則として以下の 4 領域すべてを対象確認範囲に含める**こと。
一部だけを修正して「完了」扱いにしてはいけない。

| # | 領域 | 主な該当ページ |
|---|---|---|
| 1 | 中央競馬（JRA）**無料版** | `src/pages/free-prediction/jra.astro` |
| 2 | 中央競馬（JRA）**有料版** | `src/pages/premium-prediction/jra.astro` |
| 3 | 南関競馬（NANKAN）**無料版** | `src/pages/free-prediction/nankan.astro` |
| 4 | 南関競馬（NANKAN）**有料版** | `src/pages/premium-prediction/nankan.astro` |

### 必ず 4 領域を横断確認すべき修正

以下のいずれかに該当する場合は、4 領域すべてを必ず差分確認・整合性確認すること:

- 指数表示
- 総合評価表示
- 買い目表示
- 不要馬表示
- 過去走表示
- 特徴量・評価ポイント表示
- レース一覧／詳細ページ表示
- アーカイブ結果表示
- データ取込・変換ロジック（importPrediction*.js / importResults*.js / featureScores.js / osaeClassification.js など）
- 表示文言・演出 UI

### 特定領域のみが対象の場合（例外運用）

修正内容が明確に特定領域のみを対象としている場合は、**作業前または報告時に以下を必ず明記**すること:

- **今回の対象範囲**（例: JRA 有料版のみ）
- **対象外とした範囲**（例: JRA 無料版 / NANKAN 両版）
- **対象外にした理由**（例: nankan には該当 HTML/CSS が無い・該当ロジックを使っていない 等）
- **中央／南関、無料／有料のどこに影響する可能性があるか**

明記なしで一領域だけ修正して push することは禁止。

### 目的

- 片側だけ直って、もう片側が旧仕様のまま残る事故を防ぐ
- 無料版だけ直って、有料版が壊れる事故を防ぐ
- 中央と南関で**意図しない仕様差**が生じる事故を防ぐ

過去事例（2026-05-24）: JRA 有料版の `総合評価★` を廃止して `AI総合指数` に移行
した際、無料版 JRA に同じ `総合評価★` ブロックが残り続け、ユーザー指摘で初めて
発覚した。同種の事故再発防止のためこのルールを集約。

### 関連する単一源・パリティ検証

- `src/utils/osaeClassification.js` — 抑え/不要馬判定の単一源
- `src/lib/shared-prediction-logic.js` — 指数表示用関数 (`getDisplayComputerIndex` / `formatDisplayComputerIndex`)
- `npm run check:jra-nankan-parity` — JRA 有料版が NANKAN 有料版の構造に揃っているか検証
- `npm run check:safety` — 上記を含む全 safety check

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

## 🎯 メインレース5点ロジック（一方向馬単 / 2026-07-09〜）

メインレースの買い目は **全プラン共通で最大5点** に統一する。
**一方向馬単「本命→相手5頭」**（`→` 表記・裏目は取らない）で保存・表示・的中判定する。
上位プランへの導線は「買い目数の増加」ではなく「**閲覧できるレース数の増加**」で作る方針。
ユーザーは点数の多い買い目を嫌うため、上位プランでもメインレースは5点を超えない。

> **2026-07-09 変更**: 旧仕様は双方向馬単「本命↔相手5頭」= 10点（表裏両取り）だった。
> 「点数が多い」「裏目まで買うのは不自然」との判断で **一方向 `→` 5点** に統一。
> - 生成: `mainRaceBetting.js` が `本命→相手...`（`→`）で保存。`countMainRaceBetPoints` = 相手数（最大5）
> - 的中判定: `checkUmatanHit`（`importResults*.js`）は `→` を **一方向（軸→相手のみ）** と解釈。
>   `↔` / `⇔` / `-` は従来どおり双方向（過去 archive 救済・通常レース用）
> - **裏目（相手1着・本命2着）は不的中**（例 買い目 `1→2` / 結果 `2-1` = 不的中）
> - **過去 archive は再判定しない**（旧 `↔` エントリは双方向のまま据置）
> - **通常レース（メイン以外）は現状維持**（双方向 `↔` 2段構成のまま）

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

### 5点買い目生成ロジック

メインレースのみ：

1. **本命を軸**にする（**対抗軸の2行目は生成しない**）
2. 相手は本命を除く **役割優先で上位5頭**
   - 役割優先順: 対抗 → 単穴 → 連下最上位 → 連下
   - 同役割内は `pt`（displayScore/rawScore）降順
3. 1行コンパクト形式で保存: `"{本命}→{c1}.{c2}.{c3}.{c4}.{c5}"`（一方向馬単）
4. **5頭未満なら拾えた分のみ**（パディング・補欠埋めはしない）
5. **抑え（補欠/抑え かつ racebook 系コンピ指数 ≥ 45）を `(抑え...)` で情報付与**する
   （2026-05-21〜）。通常レースと同じ単一源 `selectOsaeNumbers`（`osaeClassification.js`）で
   選出し、軸・選出済み相手を除外して馬番昇順。**本線5点には含めない情報表示**。
   これで「表示の抑え（isOsaeCandidate）」と「買い目の抑え」が構造的に一致する。

例：本命3、上位5頭=5,7,8,10,12、抑え=9,14 → `bettingLines: ["3→5.7.8.10.12(抑え9.14)"]` の1行
（抑え0件なら `"3→5.7.8.10.12"`）

### 的中判定との整合性

`scripts/importResults*.js` の `checkUmatanHit` は区切り記号で方向を切り替える:
- `→` = **一方向**（軸→相手のみ的中・裏目は不的中） ← メインレース新仕様
- `↔` / `⇔` / `-` = 双方向（軸→相手・相手→軸の両方向） ← 過去 archive・通常レース用

上記1行 `"3→5.7.8.10.12"` で：

- 本命→相手（3→5, 3→7, ..., 3→12）= 5点で **合計5点**
- 裏目（5→3, 7→3, ...）は **買わない＝不的中**

**表示・的中判定・archive保存で同じ `bettingLines` 文字列を使用**。別ロジックの混入なし。

### archiveResults.json 保存形式（メインレース）

```json
{
  "raceNumber": 11,
  "venue": "大井",
  "bettingLines": ["3→5.7.8.10.12"],
  "isHit": true,
  "hitLines": ["3→5.7.8.10.12"],
  "umatan": { "combination": "3-5", "payout": 1200 },
  "betType": "馬単",
  "betPoints": 5
}
```

メインレースのみ per-race `betPoints` を実本数（相手数、最大5）で記録。
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

> **メインレースは1段（本命軸・一方向 `→` 5点）**。通常レースの2段構成は持ち込まない。
> ただし 2026-05-21〜 メインレースも `(抑え...)` を情報付与する（本線5点には不算入）。
> 2段構成ロジックを `generateNormalRaceUmatanLines()` に閉じ込め、dispatcher
> `generateRaceUmatanLines(horses, isMainRaceFlag)` で呼び分ける。

### 表記文字

- **メインレースは `→`（一方向馬単・5点）**（2026-07-09〜）
- **通常レースは `↔`（双方向馬単・両軸2段）**
- `checkUmatanHit`（`scripts/importResults*.js`）は区切りで方向を切替:
  `→` = 一方向（軸→相手のみ）/ `↔` `⇔` `-` = 双方向（軸→相手・相手→軸）

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

## 💎 有料実績ショーケース（無料→有料導線 / 2026-07-09 集約）

無料ユーザーに「有料版で実際に配信したメインレース買い目と結果」を毎日公開し、
有料への導線にするページ。`/results-showcase/{jra,nankan}`（commit `b112c3c` main 反映済み）。

### 設計原則（触る前に必読）

- **新データを作らない**。既存の結果アーカイブ配列 `src/data/archiveResults.json`（南関）/
  `archiveResultsJra.json`（JRA）の **最新日 = index 0** だけを読む。`importResults*.js` の
  自動取込＋Netlify 自動ビルドにそのまま乗り、毎日「上書き」表示・自動反映される
  （**アーカイブ本体とは別ページ・データ二重管理なし**）。「毎日上書きの別JSON生成」案は
  単一源が割れるため**採用しない**。
- 単一源 **`src/lib/resultsShowcase.js`**（純粋・Node/SSR安全）。`buildLatestShowcase(arr)` が
  `arr[0]` を会場別グルーピングし、メインは `getMainRaceNumber(会場別レース数)`
  （`mainRaceBetting.js` 再利用）で判定。複数会場同日開催（JRA 3会場×12R 等）に対応。
  抑え除去は premium ページと同一正規表現の `stripOsae`。

### 公開範囲（確定仕様）

- **メインレースのみ買い目公開**: 本命→相手5頭=**5点**（`1→2.3.6.8.9(抑え4.5)` を抑え除去し
  `本命→相手` で表示）。的中時は `umatan.combination` + `payout` を表示。
  抑えは**伏せて**有料の付加価値を一段残す。
  - **裏目的中の表示畳み込み（旧 `↔` archive 専用の後方互換）**: 2026-07-09〜 メインは
    一方向馬単 `→` に統一され、**裏目（相手1着・本命2着）は不的中**となったため、新データでは
    この畳み込みは発火しない。ただし旧仕様（双方向 `↔` 10点）で保存済みの過去 archive エントリは
    再判定しない方針のため、`↔` の裏目的中（例 買い目 `1↔2.3.6.8.9` / 結果 `2-1`）が残る。
    その**旧データの裏目的中のときだけ**、勝った1組に畳んで `本命 ⇄ 勝った相手`（例 `1 ⇄ 2`）を
    `⇄` で表示する（相手5頭は出さない）。判定は `resultsShowcase.js` の `buildMainRace`：
    `umatan.combination` の2着が本命なら `displayArrow='⇄'` / `displayPartners=[1着相手]`。
    順目的中（本命が1着）・不的中は `本命 → 相手5頭`（`→`）。
- **メイン以外は全レース ✅/✗ のみ**（買い目・払戻は非表示）。的中/不的中を正直に全部出す。
- ⚠️ 既存アーカイブ（`archive/{jra,nankan}` 月別）は**意図的に買い目非公開**だが、本ページは
  **意図的にメイン5点を公開**する差別化ページ。混同して buy 目を消さないこと。

### 関連ファイル

| 目的 | ファイル |
|---|---|
| 単一源ロジック | `src/lib/resultsShowcase.js` |
| 独立ページ（prerender=false） | `src/pages/results-showcase/{jra,nankan}.astro` |
| 無料ページ埋込バナー | `src/components/ResultsShowcaseBanner.astro`（category prop） |
| 埋込先 | `src/pages/free-prediction/{jra,nankan}.astro`（dark-horse-link-section 直前） |
| nav | `src/layouts/BaseLayout.astro`。ナビ集約後、昨日の買い目は top-level ではなく「🏆 実績」ドロップダウン内の「💎 昨日の買い目」グループ（JRA/NANKAN）に格納。的中実績（アーカイブ）と同じ実績メニューにまとめて混同回避 |

### 運用の注意

- JRA は平日開催が無く、南関（平日開催）と**最新日がズレる**のは正常（例: 南関7/8 / JRA7/5）。
- ローカルで最新日が出ないときは、まず `origin/main` を fetch。結果取込コミットが先行しているだけ
  （本番は Actions→Netlify で常に最新日を反映）。

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

### 🎯 AI総合指数の正規取得ルート（2026-05-24 集約 / 4 領域共通）

**京都4R 案件**（無料 JRA 単穴の AI総合指数が `161` になった事故）の根本対応として、
AI 総合指数として画面に出す数値は **`getHorseAiIndex(horse)` 1 関数に集約**する。

| 用途 | 関数 |
|---|---|
| **AI総合指数（4 領域共通の表示用）** | `getHorseAiIndex(horse)` |
| raw - 1 変換のみ | `getDisplayComputerIndex(raw)` |

**`getHorseAiIndex` の挙動:**
- 参照源: `horse.sourceComputerIndex ?? horse.computerIndex` の**この 2 つだけ**
- 範囲ガード: raw が 10〜99 の範囲外なら `null` を返す（=表示しない）
- 範囲内なら `getDisplayComputerIndex(raw)` を返す（= raw - 1）

**絶対に AI 総合指数として表示してはいけないフォールバック値**:
- `horse.pt` / `horse.totalScore` / `horse.displayScore` / `horse.rawScore`
  → これらは累積スコア / rawScore など別スケールの値。混在させると京都4R 案件のような
     `100` 超の異常値表示が発生する。
- `horse.confidence` / `horse.score` / `horse.rating` / `horse.evaluation`
  → AI 総合指数とは別概念。

**4 領域すべてで `getHorseAiIndex(horse)` を使う:**
- `src/pages/free-prediction/jra.astro`
- `src/pages/free-prediction/nankan.astro`
- `src/pages/premium-prediction/jra.astro`
- `src/pages/premium-prediction/nankan.astro`
- `src/components/HorseMainCard.astro` / `RaceHorseSection.astro`（共有部品）

ローカルに `getDisplayIndex` のような独自フォールバック関数を再実装することは禁止。

### 🛡️ 馬データ整合性ガード（取込側 sanitize）

`keiba-data-shared` 側（admin）の OCR / HTML パース失敗で
`name === ''` / `sexAge === ')'` 等の壊れた馬データが流れ込んでも、
予想カード（本命/対抗/単穴/連下系/補欠）に登場させない。

`src/utils/normalizePrediction.js` の `sanitizeHorseName` / `sanitizeAge` /
馬名空時の `role='無' + rawScore=0` 強制ガードで対応する。

**禁止事項**:
- 表示側で「`)` を replace で消す」「空文字を別文字で埋める」等の隠蔽対応は禁止。
- データが壊れている場合は**取込側 (sanitize)** で修正する。
- 過去 JSON は遡及修正しない方針（新規取込から順次正常化）。

### 検証
- `npm run check:display-index` — raw - 1 一致検証
- `npm run check:prediction-integrity` — 馬名空 / 性齢ゴミ / AI総合指数 100超 を直近ファイルで検出
- `npm run check:safety` に両方とも組込済み

### 検証
`node astro-site/scripts/check-display-computer-index.mjs [YYYY-MM-DD] [venueSlug]` で
全レース・全馬を `raw - 1 == display` で検証する（不一致 1件でも非ゼロ exit）。

### 関連ファイル
| 目的 | ファイル |
|---|---|
| 共通関数 | `astro-site/src/lib/shared-prediction-logic.js` (`getDisplayComputerIndex` / `formatDisplayComputerIndex` / **`getHorseAiIndex`**) |
| 取込 sanitize | `astro-site/src/utils/normalizePrediction.js` (`sanitizeHorseName` / `sanitizeAge` / 馬名空時の role='無' + rawScore=0 ガード) |
| 整合性検証 | `astro-site/scripts/check-prediction-data-integrity.mjs` |
| 表示適用 | `src/pages/free-prediction/nankan.astro`, `premium-prediction/nankan.astro`, `free-prediction/jra.astro`, `premium-prediction/jra.astro`, `src/components/HorseMainCard.astro`, `src/components/RaceHorseSection.astro` |
| 検証スクリプト | `astro-site/scripts/check-display-computer-index.mjs` |

## 🔑 ログイン（マジックリンク方式）

`/login` でメール入力 → SendGrid 経由でリンク送信 → `/auth/verify?token=...` で検証 →
localStorage `user-plan` に保存して AccessControl が読む構成。
Airtable Base は **nankan-analytics と共有**（顧客は引き継ぎ）。
詳細・環境変数・Airtable スキーマ追加手順は `astro-site/docs/AUTH_LOGIN.md` を参照。

## 🏦 銀行振込 入金確認フロー（2026-07-10 再設計 / 本番反映済み）

**入金確認は `PaymentConfirmed` にチェックを入れる 1 アクションだけ。有効期限は手入力しない。**

### フロー

| 段階 | 何が起きるか |
|---|---|
| **申込フォーム送信** | `bank-transfer-application.js` が `氏名` / `PaymentMethod` / `RequestedPlan` / `RequestedPlanType` / `RequestedAmount` / `PaymentConfirmed=false` のみ書く |
| **入金確認（MK）** | Airtable で `PaymentConfirmed` にチェック |
| **昇格（自動）** | Automation → `confirm-bank-payment.js` が `プラン` / `PlanType` / `Status='active'` / `有効期限`（**入金確認日 JST + 1年**）/ `PaidAt` / `PaymentEmailSent=true` を 1 回の PATCH で確定し、確認メールを送信 |

- **申込時に有料権限を付与しない**。`プラン` / `PlanType` / `有効期限` / `Status='active'` は書かない
- **既存 active Light 会員はフォーム送信だけでは昇格しない**（Light active のまま維持）
- 新規 / 非 active のみ `Status='pending'`（`auth-user.js` の pending ガードで Free 扱い）
- 退会フラグのリセットは**承認時**（未入金の申込で退会申請が消えないように）

### 判定の単一源

`astro-site/src/lib/payments/bankPaymentFlow.js`（純粋関数・Airtable 非依存）

- `buildApplicationFields()` — 申込時に書くフィールド
- `buildConfirmationFields()` — 承認時に書くフィールド。`RequestedPlan` が空なら `null`（fail closed）
- `addOneYearJst()` / `addMonthsJst()` — **JST の暦日**で計算。`toISOString()` の UTC 基準は使わない
  （JST 深夜 0〜9 時に 1 日ズレる）。閏日 2/29 + 1年 は 3/1 ではなく 2/28 に丸める

検証: `npm run test:bank-payment`（`check:safety` に組込済み）

**禁止事項**: Function 内で `プラン` / `有効期限` / `Status='active'` を直書きしない。
必ず `bankPaymentFlow.js` 経由。guard テストが直書きを検知する。

### 認可・冪等性・二重メール防止

- **認可**: `confirm-bank-payment.js` は公開 URL。Airtable の `PaymentConfirmed=true` を
  **再読込して検証**し、false なら 403。チェックできるのは Airtable にアクセスできる MK だけ
- **冪等性**: 承認時に `Requested*` をクリア。再チェックしても `RequestedPlan` が空 → 昇格しない
  （有効期限が再延長されない）
- **二重メール防止**: confirm が `PaymentEmailSent=true` を立てるため、
  `send-payment-confirmation-auto.js` の再送ガードでスキップされる。メールは常に 1 通

### Airtable Automation（2 本。触る前に必読）

| Automation | Trigger | 監視 Fields | 条件 | Action |
|---|---|---|---|---|
| 入金確認 → 有料プラン昇格 | When record updated | `PaymentConfirmed` | PaymentConfirmed is checked | `confirm-bank-payment` |
| 入金確認メール自動送信 | When record updated | **`Status` のみ** | Status is active AND PaymentEmailSent is unchecked | `send-payment-confirmation-auto` |

後者は元 `When a record matches conditions`（フィールド監視なし）で**レコード更新全般で発火**していた。
2026-07-10 に `Status` のみ監視へ変更し、役割を「MK が手動で pending→active にしたときの確認メール」に縮小。

**監視 Fields を空欄に戻さないこと。** 空欄 = 全フィールド監視となり、`RequestedAmount` の更新等でも
入金確認メールが誤送信される。

### ⚠️ 再送手順（変更あり）

**`PaymentEmailSent` を空に戻すだけでは再送されない。**
Automation は `Status` の変化でしか発火しないため、再送するには
**`Status` を pending → active に切り替える**必要がある。
これは `send-payment-confirmation-auto.js` が返す `howToResend` メッセージと同じ手順。

### ⚠️ 未使用経路の二重送信リスク（未修正）

`paypal-webhook.js` と `send-payment-confirmation.js` は
**自前で SendGrid を叩き `Status='active'` を書くが `PaymentEmailSent=true` を立てない**。
そのため Automation「入金確認メール自動送信」が発火し、**確認メールが 2 通届く**。

現在 pricing は銀行振込のみを案内しており両経路とも未使用のため実害は無い。
**復活させる場合は、両ファイルで `PaymentEmailSent: true` を同時に書く修正が必須。**

### 🔐 PAYMENT_CONFIRM_SECRET（設定・本番検証済み / 2026-07-11）

`confirm-bank-payment` は公開 URL のため、`PaymentConfirmed=true` 再読込認可に加えて
`x-confirm-secret` ヘッダ認証を本番で有効化済み。**認証機能の有効化に追加のコード変更は不要**
（gating は `if (process.env.PAYMENT_CONFIRM_SECRET)` として既にデプロイ済み。env 投入だけで有効化される）。

- **Netlify**: `PAYMENT_CONFIRM_SECRET` を **production context に設定済み**。
- **Airtable Automation**「入金確認 → 有料プラン昇格」の Run script は
  `confirm-bank-payment` 呼び出し時に **`x-confirm-secret` ヘッダを送信する**
  （`Content-Type: application/json` は残したまま1行追加）。
- **順序厳守**: Automation ヘッダ追加 → その後 env 設定。逆順にすると env 有効化後に
  ヘッダ無し Automation が全て 403 となり昇格が止まる。env 未設定の間はヘッダを送っても
  Function 側が無視する（`if(CONFIRM_SECRET)` が false）ため無害。
- **本番検証済み**:
  - secret **なし** / **不一致** → `403 Forbidden`（認可段で停止・レコード非破壊）を確認済み。
  - **正しい secret** による Premium 昇格（Automation 経由で `プラン=Premium` /
    `PlanType=Annual` / `Status=active` / 有効期限 JST+1年 / `PaymentEmailSent=true` /
    `Requested*` クリア / 確認メール1通）を確認済み。
- **rollback**: `netlify env:unset PAYMENT_CONFIRM_SECRET --context production` →
  正規 production build（Build Hook で origin/main を1回ビルド）で、コード変更なしに
  従来の `PaymentConfirmed` 再読込認可のみへ即復帰する。
- **secret 値そのものは CLAUDE.md / ログ / commit に絶対に記載しない。**

### 残件

- Airtable Customers に `Amount` / `ProductName` フィールドは無い。振込金額は
  `RequestedAmount`（承認時にクリア）と管理者宛メールにしか残らない

### 関連ファイル

| 目的 | ファイル |
|---|---|
| 判定の単一源 | `astro-site/src/lib/payments/bankPaymentFlow.js` |
| 申込 | `astro-site/netlify/functions/bank-transfer-application.js` |
| 昇格 | `astro-site/netlify/functions/confirm-bank-payment.js` |
| 確認メール（手動 active 化用） | `astro-site/netlify/functions/send-payment-confirmation-auto.js` |
| テスト | `astro-site/src/lib/payments/bankPaymentFlow.test.mjs` / `bankPaymentFunctions.guard.test.mjs` |

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
npm run test:pricing-tiers     # /pricing/ のプラン別出し分け（Light 乗り換え価格の露出防止）
npm run test:bank-payment      # 銀行振込 申込/入金確認フロー（入金前に昇格しない）
npm run check:safety           # 上記を含む全 safety check を直列実行
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
ページ別に集約。**修正前に必ず読む**。
- premium: `astro-site/docs/PREMIUM_JRA_RULES.md`
- free `[date]`（過去日アーカイブ）: `astro-site/docs/FREE_JRA_RULES.md`

### 2. grep 検査（再混入検知）

JRA 系ページごとに **対象スコープ・検知範囲が異なる**ため、ページ別に分けて記述する。
（共通: いずれも `check:safety` に組み込み済み・CI で強制実行）

#### 2-A. `premium-prediction/jra.astro`（有料）

`npm run check:ki-relics:jra` で検知。  
詳細禁止リストは [`astro-site/docs/PREMIUM_JRA_RULES.md`](./astro-site/docs/PREMIUM_JRA_RULES.md) を参照。  
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
詳細禁止リストは [`astro-site/docs/FREE_JRA_RULES.md`](./astro-site/docs/FREE_JRA_RULES.md) を参照。  
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

## 完了報告の簡潔化

各フェーズの完了報告は、原則として以下だけを簡潔に記載すること。

- 判定
- 実施内容
- 変更ファイル
- テスト結果
- Git状態
- 異常・未確定事項
- 次工程案

成功したコマンドの全文、重複する説明、既知仕様の再掲は省略すること。
エラー、想定外差分、安全条件違反がある場合のみ、必要なログを提示すること。

各リポジトリ固有の安全条件、伝播確認、本番確認、取得回数、rollback条件など、既存の必須報告項目は省略しないこと。
