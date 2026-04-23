# PREDICTION LOGIC（予想ロジック）

> analytics-keiba の予想スコアリングと役割（本命・対抗・単穴・連下）決定ルールの仕様。
> コード: `astro-site/src/utils/adjustPrediction.js` / `normalizePrediction.js` / `featureScores.js`
> 呼び出し元: `astro-site/scripts/importPrediction.js`（南関） / `importPredictionJra.js`（中央）

## 適用範囲

**南関・中央（JRA）共通**。両カテゴリで同一の `adjustPrediction.js` を通る。

## 設計思想

| サイト | 思想 | 主たる評価軸 |
|---|---|---|
| keiba-intelligence | 人間寄り・印ベース | 印1◎ を固定軸にした伝統的評価 |
| **analytics-keiba** | **データ主導AI・期待値重視** | **コンピ指数 + 特徴量（past race）を主軸** |

同じ keiba-data-shared を入力として使うため、**意図的にロジックを違えて出力を分ける**。同一結果になる日があっても正常。差別化は「ルールで確定」しており、ランダムは一切使わない。

## スコア式

各馬について 3 つの成分を 0–100 に正規化し、重み付き和を取る。

```
analyticsScore
  = computerIndex × 0.5
  + featureScore  × 0.3
  + markScore     × 0.2
```

### computerIndex（50%）

日刊コンピ指数。nankan/jra とも 40〜99 の範囲が実運用値。欠損時は 0。

```
normComputer = clamp(computerIndex, 0, 100)
```

### featureScore（30%）

`featureScores.js` の関数を組み合わせた数値（0–100）。

```
featureScore
  = calcSpeedIndex(_pastRaces)        × 0.4
  + (calcFormTrend(_pastRaces) + 50)  × 0.4   // -50..+50 → 0..100
  + calcStaminaRating(_pastRaces)     × 0.2
```

過去走データ（`_pastRaces`）が無い馬は **featureScore = 50（中立）** とする。

### markScore（20%）

印1〜印4 の重み付き合計を 0–100 に正規化。keiba-intelligence が使う式と同じ配点だが analytics では全体の 20% の比重しかない。

```
raw =
  (印1点 × 4) +
  (印2点 × 3) +
  (印3点 × 2) +
  (印4点 × 1)

印点数: ◎=4 / ○=3 / ▲=2 / △=1 / -=0

markScore = clamp(raw / 30 × 100, 0, 100)   // 理論最大30を100に正規化
```

## 役割決定

### 基本ルール

1. `analyticsScore` 降順でソート
2. 上位から `本命 → 対抗 → 単穴 → 連下最上位 → 連下…` を割り当て
3. **keiba-intelligence とは異なり「印1◎ 固定」は行わない**（ここが最大の差別化点）

### 差別化ルール（意図的に keiba-intelligence と結果を違える）

以下の条件を満たす場合、**本命を analyticsScore 最上位 → computerIndex 最上位** に差し替える:

- **(a) 上位2頭の `analyticsScore` 差 < 3%** が close-call → `close-call-prefer-computer`
- **(b) `analyticsScore` 最上位 ≠ `computerIndex` 最上位** → `computer-top-mismatch`

### 荒れ防止ガード

差別化ルールを適用するのは次の条件を満たす場合のみ:

- **`computerIndex` 最上位馬が `analyticsScore` 上位 3 位以内に入っている**

これにより「コンピ 1 位だが feature も mark も極端に低い馬」を本命に押し上げる暴発を防ぐ。ガード不発時は通常通り analyticsScore 最上位を本命として採用する。

### 連下・補欠

- 連下は 3 頭まで、残りは補欠（`analyticsScore` 降順）
- `連下最上位` は 1 頭固定（単穴の次の順位）
- analyticsScore が 0 かつ rawScore が 0 の馬は「無」扱い

## 買い目との関係

- **買い目生成は本ロジックとは独立**（`shared-prediction-logic.js` の `generateStandardizedBets` 等が担当）
- 3 戦略（safe / balance / aggressive）＋ 三連複は維持する
- keiba-intelligence は単一馬単中心 → analytics-keiba は 3 戦略 ＋ 三連複で差別化

## 差別化の実観測例（2026-04-23 浦和）

同一 keiba-data-shared 入力に対して 12 レース中 **5 レース**で本命が異なる:

| R | keiba-intelligence 相当 | analytics-keiba | 差別化要因 |
|---|---|---|---|
| R1 | #9 ビナナムディン | #5 アルディバ | computer+feature で逆転 |
| R3 | #5 ヤサカソレイユ | #11 ヴァンクールシチー | `computer-top-mismatch` |
| R4 | #7 パロサント | #4 スマイルスライヴ | computer 主導 |
| R5 | #2 オーシンラッシュ | #1 マイリトルロマンス | スコア主導 |
| R9 | #10 レイナバローズ | #1 ノースラノビア | `computer-top-mismatch` |

残り 7 レースは両ロジックが同一馬を選出（データ的に明確な第一候補）。

## デバッグ情報

`adjustPrediction` は race オブジェクトに次のフィールドを付与する（表示には使わない）:

- `horse.markScore` / `horse.featureScore` / `horse.analyticsScore`
- `horse.customScore`（旧 UI 互換のため markScore と同値）
- `race._analyticsRule`: `'close-call-prefer-computer'` / `'computer-top-mismatch'` / `null`

## 今後の閾値・重み変更時の運用

1. `astro-site/src/utils/adjustPrediction.js` のコードを修正する
2. **本 MD の該当節を必ず同時更新する**
3. `importPrediction.js --date YYYY-MM-DD` で過去日を再生成してスナップショット比較
4. keiba-intelligence 側との重複が極端に増えていないか（目安: 12R 中 5R 以上の重複なら再調整）

## 関連ファイル

| パス | 役割 |
|---|---|
| `astro-site/src/utils/adjustPrediction.js` | 本ロジックの本体。analyticsScore 計算と役割決定 |
| `astro-site/src/utils/normalizePrediction.js` | 正規化。`computerIndex` / `_pastRaces` / `marks` を伝搬させる |
| `astro-site/src/utils/featureScores.js` | Speed / Form / Stamina 等の特徴量計算 |
| `astro-site/scripts/importPrediction.js` | 南関取込。`normalizeAndAdjust()` を呼ぶ |
| `astro-site/scripts/importPredictionJra.js` | 中央取込。同上 |
| `astro-site/src/lib/shared-prediction-logic.js` | 買い目・戦略生成（本ロジックの下流） |
| `astro-site/docs/BET_POINT_LOGIC.md` | 的中判定後の購入点数・回収率ロジック（別仕様） |
