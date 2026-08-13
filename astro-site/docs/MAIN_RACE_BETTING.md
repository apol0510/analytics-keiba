# 買い目生成ロジック（メインレース5点 / 通常レース2段 / 抑え判定）

> CLAUDE.md から集約（2026-08-13）。**ルールの正本はこのファイル**。
> 閾値・仕様を変更する場合は **コードとこの MD を必ず両方更新**すること。


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

