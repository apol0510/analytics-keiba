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
normComputer = clamp(sourceComputerIndex || computerIndex, 0, 100)
```

**ソース優先順位（2026-05-16〜）**:
1. `sourceComputerIndex` （racebook 由来の元コンピ指数、JRA は computer JSON 由来 / 南関は racebook 由来）が 10 以上なら採用。
2. なければ `computerIndex` が 10 以上なら採用（南関 admin 系・JRA admin 系の 0–9 スケールは 0 扱い）。
3. どちらも無ければ 0。

`normalizePrediction.js` が `rawScore`（→ `displayScore` = `pt`）を `sourceComputerIndex` から
昇格させているため、`adjustPrediction.js` も同じソースを参照することで「役割順 ≠ pt 順」の
矛盾（例: 単穴の pt が本命より高い）を防ぐ。

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

## pt（displayScore）算出 ★keiba-intelligence との差別化の核心★ (2026-05-20〜)

> **背景（重要）**: かつて `analyticsScore` は「診断用」に計算されるだけで、pt も役割も
> `computerIndex` 降順のみで決まっていた。一方 keiba-intelligence も印が無い素材では
> rawScore(=computerIndex) 降順に潰れるため、**両サイトの pt・役割・買い目が完全一致**する
> 同一化バグが長期間続いた。これを断つため、AK の **pt 自体に racebook 由来シグナルを織り込む**。

`adjustPrediction.js`（南関・JRA 共通）で、出走資格のある馬（`rawScore > 0`）の pt を次式で算出する。

```
pt (displayScore)
  = rawScore + 70                                   // 主軸: computer-manager 由来の computerIndex
  + (featureScore − 50) × FEATURE_NUDGE_WEIGHT      // 補助: race-data-importer 由来の過去走
  + markScore × MARK_NUDGE_WEIGHT                    // 補助: race-data-importer 由来の印

FEATURE_NUDGE_WEIGHT = 0.6   // 過去走で概ね ±30 点
MARK_NUDGE_WEIGHT    = 0.4   // 印が濃いほど最大 +40 点
```

- **computer 主軸 + racebook 補助**：computerIndex を土台に、過去走・印で前後させる。
- **後方互換**：過去走が無い馬は `featureScore=50` → 加点 0、印が無い馬は `markScore=0` → 加点 0。
  よって補助シグナルが無い馬は `pt = rawScore + 70`（従来値）に一致する。
- keiba-intelligence は `pt = computerIndex + 70`（補助加点なし）。**この差で pt・役割・買い目が分岐する。**
- 役割は下記 strict-pt-desc なので、pt にシグナルを織り込めば役割も自動的に差別化される
  （pt と役割の逆転は起きない）。
- 検証: `npm run check:differentiation`（過去走の強い馬が ci の高い馬を pt で逆転することを保証）。

## 役割決定 (2026-05-16 strict-pt-desc に刷新)

### 基本ルール

1. 各馬の `displayScore` (= pt、上記「pt 算出」式) を降順でソート
2. 上位から `本命 → 対抗 → 単穴 → 連下最上位 → 連下(最大3頭) → 補欠` を割り当てる
3. タイブレーク: `sourceComputerIndex` (なければ `computerIndex`) 降順 → 馬番昇順

### 不変条件 (`npm run verify:jra:roles` で検証)

各レースで以下を満たすこと:

1. 本命 pt ≥ 対抗 pt
2. 対抗 pt ≥ 単穴 pt
3. 単穴 pt ≥ 連下最上位 pt
4. 連下最上位 pt ≥ max(連下 pt)
5. max(連下 pt) ≥ max(補欠/抑え pt)
6. 本命・対抗・単穴・連下最上位 はそれぞれ 1 頭

`scripts/verify-jra-role-score-consistency.mjs` が JRA 全 prediction JSON を走査し、
不整合があれば exit 1。`import:prediction:jra` 後に必ず実行する運用。

### 旧仕様 (削除済み・参考)

2026-05-16 まで「analyticsScore (ci×0.5 + feature×0.3 + mark×0.2) 降順で役割決定 +
差別化ルール (close-call-prefer-computer / computer-top-mismatch)」を採用していた。
しかし `pt = rawScore + 70` (主に sourceComputerIndex 由来) と analyticsScore は
異なる式から導出されるため、role 順と pt 順が逆転する事例が頻発した
(2026-05-16 検証で JRA 36R 中 31R で逆転)。

strict-pt-desc に切替えた現在も `analyticsScore` / `markScore` / `featureScore` は
診断用に各馬に計算・保存しているが、役割決定には使用しない。
keiba-intelligence との差別化は「pt のソース (sourceComputerIndex 優先) を ci-top
ベースにする」ことで結果的に担保される (印1◎ 固定の KI と必然的に異なる)。

### 連下・補欠

- 連下は 3 頭まで (5 位〜7 位)、残り (8 位以降) は補欠
- 連下最上位は 4 位固定 (単穴の次)
- `rawScore = 0` の馬は activeHorses から除外し「無」のまま (役割不付与)
- 補欠の中で `shared-prediction-logic.js` の `isOsaeCandidate` (racebook 系 ci ≥ 45)
  が true なら抑え候補、false なら不要馬 (表示・買い目で同じ判定)

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

## 独自指数 OWN_INDEX_V1（2026-11-28 の開催から・MK 2026-11-26）

MK「能力差が小さいときは独自の評価で ◎○ を入れ替える・指数を独自算出に・精度は維持・大掛かりな仕様変更は不要」。
取込（`scripts/importPrediction.js` / `importPredictionJra.js`）が `normalizeAndAdjust` の後に `scripts/lib/ownIndexApply.mjs` `applyOwnIndex` を当てる。

- 独自指数 = 指数（computer JSON の computerIndex・45 以上）＋ 4 項目（`src/utils/ownIndex.js`）。各項目でレース内上位 3 分の 1 が +1・下位 3 分の 1 が −1（全頭同じ値の項目は使わない）
  | 項目 | 値 | 記録なし |
  |---|---|---|
  | 先行力 | 近 3 走の 1 コーナーの平均（前ほど高い） | 6 番手 |
  | 前走着順 | 1 着 100・2 着 85・3 着 70・5 着まで 55・8 着まで 35・他 15 | 40 |
  | 騎手 | 開催日より前の確定結果での勝率 (勝ち + 1) / (騎乗 + 10)（予想ファイルの騎手 × 着順を馬番で照合・市場ごと） | 0 騎乗 |
  | 上がり | 近 3 走の上がり 3F の最速 | 40.5 秒 |
- 役割 = 独自指数の高い順 → 指数 → 馬番。指数の差が小さい 2 頭は独自評価で ◎○ が入れ替わる（主に指数差 1〜2）。pt（累積スコア）= 表示値 + 70
- 表示値（AI総合指数）= round(1.15 × 独自指数 − 20)（[DISPLAY_INDEX_RULES.md](./DISPLAY_INDEX_RULES.md)）
- 変えないもの: 買い目の作り方（メイン 5 点・通常の本命軸 / 対抗軸・G-CI・抑え）。相手を選ぶ同じ役割内の順は指数の高い順（`partnerPt`・JSON に出さない）
- 🛑 新聞の印（marks）・本紙順位は使わない（中央の予想 JSON にも 11-28 以降は marks を書かない）。騎手成績は開催日より前の結果だけ
- 入力を読めない日は fail-closed で従来の pt（下の「pt 算出」）のまま（ログ `[OWN_INDEX]`）
- 検証（keiba-data-shared の予想と結果・南関 2,399R・中央 2,699R・2026-02〜11-26）: 指数順と比べて本命の単勝・複勝率、馬単の的中率・回収率は同等
  （南関 40.5% / 70.6% / 62.7% / 70.0% 対 40.3% / 70.3% / 62.5% / 70.1%・中央 31.3% / 63.8% / 52.5% / 70.9% 対 31.3% / 63.9% / 52.3% / 71.3%・回収率差の 95% 区間は 0 を含む）。
  中央は従来の AK（新聞の印で加点）より本命の単勝率 28.6% → 31.2%・複勝率 60.1% → 63.0%。通常レースの馬単は ◎○ が入れ替わっても買い目が同じ
- 同じ評価順を HIBI・NANKAN PICKS も使う（AK 基準・MK 2026-11-19）。KI は別の独自指数 OWN_INDEX_KI_V1（下の共通化ルール）

## 🛡️ keiba-intelligence との共通化ルール（同一化バグ再発防止）

AK と KI は同じ keiba-data-shared（race-data-importer の racebook ＋ computer-manager の指数）を
入力に使う。**素材は共通でよいが、最終アウトプットは共通化してはいけない。**

### 共通化してよい範囲（データ層）
- データ取込・正規化（馬名・日付・場コード・出走表・過去走の整形）
- `featureScores.js` の特徴量「計算関数」そのもの（calcSpeedIndex 等）※どう使うかは各サイト独自

### 共通化禁止範囲（最終ロジック層）★これらが一致したら同一化バグ★
- **totalScore / pt**（AK は上記「pt 算出」で feature/mark を織り込む。KI は computerIndex ベース）
- **役割（本命 / 対抗 / 単穴 / 連下 / 抑え）**
- **印**
- **買い目（betTickets）**

### サイト別の主軸（意図的に違える）
| サイト | pt / 役割の主軸 | 補助 |
|---|---|---|
| **analytics-keiba** | **独自指数 OWN_INDEX_V1**（指数 ＋ 先行力・前走着順・騎手・上がり・2026-11-28〜） | — |
| keiba-intelligence | 独自指数 OWN_INDEX_KI_V1（指数 ＋ 先行力・近 5 走・騎手・上がり・コース実績・2026-11-28〜） | — |

2026-11-28 より前の開催は従来どおり（AK = computerIndex ＋ 過去走・印の加点、KI = 印・racebook ＋ computerIndex）。
両者の一致（検証期間）: 本命 98〜99%・◎○▲ 89%・買い目 92〜94%（完全一致ではない）。

### 不一致の運用基準
- 12R 全てが一致する必要は無い。computerIndex の差が大きい（明確な抜けた1頭がいる）レースは
  本命が一致してよい。**全レースの本命/対抗/単穴と買い目が KI と完全一致したら異常**。
- 自動検証: `npm run check:differentiation`（CI の safety-check で強制）。
  これが落ちたら「pt が computerIndex 単独に潰れている＝KI と同一化」のサインなので、
  係数 0 化や analyticsScore の格下げ等の回帰を疑うこと。

## 今後の閾値・重み変更時の運用

1. `astro-site/src/utils/adjustPrediction.js` のコードを修正する
2. **本 MD の該当節を必ず同時更新する**
3. `importPrediction.js --date YYYY-MM-DD` で過去日を再生成してスナップショット比較
4. keiba-intelligence 側との重複が極端に増えていないか（目安: 12R 中 5R 以上の重複なら再調整）
5. `npm run check:differentiation` が通ること（pt が computerIndex 単独に戻っていないか）

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
