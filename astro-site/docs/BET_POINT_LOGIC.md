# BET POINT LOGIC（購入点数ロジック）

> archiveResults における購入点数と回収率の算出仕様。
> コード: `astro-site/scripts/importResults.js` / `importResultsJra.js`
> マージ優先順位: `astro-site/src/lib/archiveMonthlyView.js`

## 概要

archiveResults における購入点数は固定値ではなく、**回収率に応じた可変方式**を採用する。

過去は「固定 8 点/レース、回収率 300% 超のときだけ 12 点に昇格」という 2 段階方式だったが、
- 高回収日が過小評価される（12 点上限到達するまで 8 点として扱われる）
- 低回収日が過大評価される（常に 8 点相当で投資したとみなされる）

という偏りがあった。現行は **仮回収率に応じて 8 / 10 / 12 点の 3 段階**に分ける。

## 判定ロジック

### Step 1: 仮回収率の計算

**8 点固定**で仮投資額と仮回収率を計算する。

```
仮投資額   = レース数 × 8 × 100円
仮回収率   = totalPayout / 仮投資額 × 100
```

### Step 2: 点数決定

| 仮回収率 | 1 レースあたり点数 |
|---|---|
| `>= 200%` | **12 点** |
| `>= 100%` | **10 点** |
| `< 100%`  | **8 点** |

### Step 3: 最終計算

```
totalBetPoints   = レース数 × 点数
totalInvestment  = totalBetPoints × 100円
recoveryRate     = totalPayout / totalInvestment × 100
```

## race 単位のフィールド

1 日の中の**全レースに同一の** `betPoints` を付与する。

```js
race.betPoints = betPointsPerRace
race.betType   = race.betType || '馬単'
```

archive 月別ページ（`/archive/YYYY/MM/`）は race 単位の `race.betPoints` を集計して
`totalBetPoints` を再計算する。そのため race 側にもフィールドを埋めておかないと
表示から「合計購入点数」が欠落する。

## データソース優先順位

archive 表示は以下の順でデータを選ぶ（`buildMergedMonthData` at `src/lib/archiveMonthlyView.js`）。

1. **南関 singular** (`src/data/archiveResults.json`) — `importResults.js` が自動生成
2. **南関 monthly snapshot** (`src/data/archiveResults_YYYY-MM.json`) — 過去の手動キュレート版
3. **中央 singular** (`src/data/archiveResultsJra.json`) — `importResultsJra.js` が自動生成（dayKey `"DDj"` で保持）

### 例外ルール

同じ日が singular と monthly の両方に存在する場合、**原則 singular を優先**する（新ロジック適用のため）。

ただし次の条件を満たす場合は **monthly を優先**する:

```
singular.races のうち r.betPoints > 0 となる race が 1 つも無い
```

これは「古い singular エントリ（当ロジック適用前のデータ）」を検出するための判定。
該当する日は race 単位の betPoints が欠落しているため、singular をそのまま使うと
UI 側の集計（`dayData.races.reduce(... race.betPoints ...)`）が 0 になり
「合計購入点数」「回収率」が表示から消えてしまう。それを防ぐための fallback。

古い singular エントリは `importResults.js --date YYYY-MM-DD` で再生成すれば
新ロジックに乗せられる。

## 注意事項

- **monthly** は過去の手動補正データ（旧 nankan-analytics からコピー）
- **singular** は自動生成データ
- 新規日（未来）は必ずこのロジックを通る
- **閾値や点数を変更する場合は、コード（`importResults.js` / `importResultsJra.js`）だけでなく本 MD も必ず更新する**

## 目的

- 回収率と購入点数の整合性を取る
- 不自然な回収率表示（0% や極端な値）を防ぐ
- 旧サイト（nankan-analytics.keiba.link）との表示差を減らす
- 将来の仕様変更時にロジックが暗黙のうちに壊れるのを防ぐ

## 関連ファイル

| パス | 役割 |
|---|---|
| `astro-site/scripts/importResults.js` | 南関の結果取込。本ロジックで `betPointsPerRace` を算出 |
| `astro-site/scripts/importResultsJra.js` | 中央（JRA）の結果取込。同ロジック |
| `astro-site/src/lib/archiveMonthlyView.js` | `buildMergedMonthData`: singular / monthly / JRA をマージし、優先順位と例外ルールを適用 |
| `astro-site/src/pages/archive/YYYY/MM.astro` | 月別アーカイブ表示。`dayData.races.betPoints` を集計して「合計購入点数」「回収率」を描画 |
| `astro-site/src/data/archiveResults.json` | 南関 singular の保存先 |
| `astro-site/src/data/archiveResults_YYYY-MM.json` | 月別 snapshot（手動キュレート版） |
| `astro-site/src/data/archiveResultsJra.json` | 中央 singular の保存先 |
