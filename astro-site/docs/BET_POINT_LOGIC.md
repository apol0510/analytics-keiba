# BET POINT LOGIC（購入点数ロジック）

> archiveResults における購入点数と回収率の算出仕様。
> 実装: `astro-site/scripts/importResults.js` / `importResultsJra.js`

## 適用範囲

**南関と中央（JRA）の両方に同一ロジックを適用する**。両者で閾値・点数・計算式は同じ。

| 区分 | 取込スクリプト | 保存先ファイル |
|---|---|---|
| 南関（大井 / 川崎 / 船橋 / 浦和） | `scripts/importResults.js` | `src/data/archiveResults.json` |
| 中央（JRA） | `scripts/importResultsJra.js` | `src/data/archiveResultsJra.json` |

JRA は 1 日に複数会場（中山・阪神・福島 等）が並走するため、`races[]` には全会場のレースが
混在した状態で保存される。点数判定は**全会場まとめて 1 日単位**で行う（venue 別の投資分割はしない）。

## 概要

archiveResults における購入点数は固定値ではなく、**払戻と実レース数に応じた 4 段階可変方式**を採用する。

各段階の閾値は「その点数で投資した場合に回収率がちょうど 100% となる金額」であり、
**回収率 100% 以上を維持できる最大の点数を選択する**。下限は 6 点（マイナス受容）。

## 判定ロジック

```js
function getBetPoints(totalPayout, races) {
  if (races <= 0) return 6;
  if (totalPayout >= races * 12 * 100) return 12;
  if (totalPayout >= races * 10 * 100) return 10;
  if (totalPayout >= races *  8 * 100) return 8;
  if (totalPayout >= races *  6 * 100) return 6;
  return 6; // 下限（安全側）
}
```

| 段階 | 閾値（払戻） | 1レース点数 | この段階での回収率 |
|---|---|---|---|
| ④ | `≥ races × 12 × 100円` | **12点** | 100% 以上 |
| ③ | `≥ races × 10 × 100円` | **10点** | 100% 以上 |
| ② | `≥ races ×  8 × 100円` | **8点**  | 100% 以上 |
| ① | `≥ races ×  6 × 100円` | **6点**  | 100% 以上 |
| ⓪ | それ以下 | **6点**（下限） | 100% 未満（マイナス受容） |

## 計算式

```js
const totalPayout       = (的中レースの払戻合計);
const races             = totalRaces;          // 実レース数（南関=12, JRA 3会場=36）
const betPointsPerRace  = getBetPoints(totalPayout, races);
const totalBetPoints    = races * betPointsPerRace;
const totalInvestment   = totalBetPoints * 100; // 1点 = 100円
const recoveryRate      = Math.round((totalPayout / totalInvestment) * 1000) / 10;
```

## 出力フィールド

| フィールド | 例 | 説明 |
|---|---|---|
| `betPointsPerRace` | `12` | 1レースあたりの買い目点数 |
| `totalBetPoints`   | `144` | 合計買い目点数（races × betPointsPerRace） |
| `totalInvestment`  | `14400` | 合計投資額（円）|
| `totalPayout`      | `25260` | 合計払戻（円・実額）|
| `recoveryRate`     | `175.4` | 回収率（%・小数1桁）|

## 計算例

### 南関（12R）

| ケース | 払戻 | 点数 | 投資 | 回収率 |
|---|---|---|---|---|
| 低配当日 | ¥5,000  | 6点  | ¥7,200  | 69.4%  |
| 境界（6点） | ¥7,200  | 6点  | ¥7,200  | 100.0% |
| 境界（8点） | ¥9,600  | 8点  | ¥9,600  | 100.0% |
| 中配当 | ¥12,000 | 10点 | ¥12,000 | 100.0% |
| 高配当 | ¥25,260 | 12点 | ¥14,400 | 175.4% |

### JRA 3会場（36R）

| ケース | 払戻 | 点数 | 投資 | 回収率 |
|---|---|---|---|---|
| 低配当日 | ¥15,000 | 6点  | ¥21,600 | 69.4% |
| 境界（6点） | ¥21,600 | 6点  | ¥21,600 | 100.0% |
| 境界（8点） | ¥28,800 | 8点  | ¥28,800 | 100.0% |
| 高配当 | ¥53,720 | 12点 | ¥43,200 | 124.4% |

## 設計原則

- **実レース数ベース**: `races` は実データから取得。固定 12R 前提は禁止
- **6〜12点に収める**: 12 点を超えない（ユーザー離脱防止）
- **払戻を加工しない**: キャップなど一切なし、実払戻をそのまま使用
- **南関と JRA で同一ロジック**: カテゴリ別ロジック禁止
- **日単位で再計算**: 取込のたびに当日分を再評価
