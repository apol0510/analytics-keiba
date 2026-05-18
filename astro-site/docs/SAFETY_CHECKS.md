# Safety Checks — 表示指数 raw-1 と全頭分類の恒久ルール

analytics-keiba には CI で強制している 2 つの恒久ルールがある。
変更前後で **必ず** 該当チェックがローカルで通ることを確認すること。

## ルール 1: 表示用コンピ指数は必ず raw − 1

外部由来の元指数（`horse.computerIndex` / `horse.sourceComputerIndex`）を
画面にそのまま表示すると著作権・表示安全上 NG。analytics-keiba ではユーザー
表示は必ず `raw − 1` する。

### NG 例

```astro
{/* ❌ raw を直接 JSX に埋めている */}
<span class="info-val">{horse.computerIndex}</span>
<span class="meta-key">指数</span>{horse.computerIndex}
<span>{horse.sourceComputerIndex}</span>
```

### OK 例

```astro
{/* ✅ 共通関数経由 */}
import { getDisplayComputerIndex } from '../lib/shared-prediction-logic.js';
<span class="info-val">{getDisplayComputerIndex(horse.computerIndex)}</span>
{horse.computerIndex != null && getDisplayComputerIndex(horse.computerIndex) != null && (
    <span class="meta-key">指数</span>{getDisplayComputerIndex(horse.computerIndex)}
)}
```

### 内部計算は raw のままで OK

`pt` / `analyticsScore` / 役割分類 / `isOsaeCandidate` / `isIneligibleHorse` /
買い目生成 / 特徴量重要度 は raw `computerIndex` を使ってよい。
**変えるのはユーザーに見える指数表示だけ**。

## ルール 2: 全レースプレビューで全頭が分類される

各レースの展開時、すべての馬は次のどれかに必ず属する：

- 本命 / 対抗 / 単穴 / 連下（連下最上位）/ 抑え（押さえ）/ 不要馬

表示合計 = 出走頭数。「不要馬セクション」を抜くことで頭数が合わなくなるのは NG。

## ローカル確認コマンド

```bash
cd astro-site
npm run check:no-raw-index       # JSX 直接出力ガード
npm run check:display-index      # 全 predictions で raw-1 確認
npm run check:horse-sections     # 全レースで全頭分類確認
npm run check:safety             # 上記 3 つを直列実行
npm run verify:safety            # build → check:safety
```

引数で対象を絞れる：

```bash
node scripts/check-display-computer-index.mjs 2026-05-19 ooi 10
node scripts/check-free-prediction-horse-sections.mjs 2026-05-19 ooi
```

## CI で守っている内容

`.github/workflows/safety-check.yml` が PR / push to main / workflow_dispatch で起動：

1. `npm run check:no-raw-index` — 静的ガード（grep 系）
2. `npm run build` — Astro build（既存 `validate:archive` 込み）
3. `npm run check:display-index` — 全 predictions/*.json で raw vs display 突合
4. `npm run check:horse-sections` — 全レースで分類合計 = 出走頭数 を検証

### CI が失敗する条件

- 表示指数が raw と同じ／raw − 1 になっていない
- JSX に `{horse.computerIndex}` / `{horse.sourceComputerIndex}` を直接出力
- 表示分類合計 != 出走頭数（不要馬・抑え・連下の分類漏れ）
- 検証対象スコープなのに対象ファイル 0 件（CI で「素通り」を防ぐ）
- 対象ファイルがあるのに馬数 0 件（スキーマ破損）

## 修正時の正しい関数

`astro-site/src/lib/shared-prediction-logic.js`：

- `getDisplayComputerIndex(rawIndex)` → 数値なら `Math.max(0, raw - 1)`、null/不能なら null
- `formatDisplayComputerIndex(rawIndex)` → 文字列化、null なら `'-'`

## 一時的に検証を無効化することは禁止

CI を通すためにルールを緩めてはいけない。
検証ログ（日付・会場・R・馬番・馬名・raw・表示・判定）を読んで根本修正すること。
