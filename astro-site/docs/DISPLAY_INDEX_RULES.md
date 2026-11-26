# 指数表示ルール（著作権・表示安全対策）

> CLAUDE.md から集約（2026-08-13）。**ルールの正本はこのファイル**。
> CI で強制している内容は [SAFETY_CHECKS.md](./SAFETY_CHECKS.md) も参照。


analytics-keiba では、外部由来の元指数（racebook 系 `computerIndex` / `sourceComputerIndex`）と、その加工値（raw − 1 など）を
**画面に表示してはならない**（MK 2026-11-26「指数を独自算出に」）。ユーザーに見せる指数は **独自指数（AI総合指数）だけ**。

| 用途 | 値 | 関数 |
|---|---|---|
| 内部計算（役割の基礎点 / isOsaeCandidate / isIneligibleHorse / 買い目の相手の順 / G-CI） | raw `computerIndex` | （関数ラップ不要） |
| 画面表示（AI総合指数・指数） | `horse.ownIndex`（独自指数 OWN_INDEX_V1 の表示値） | `getHorseAiIndex(horse)` |

### 独自指数（OWN_INDEX_V1・正本 [PREDICTION_LOGIC.md](./PREDICTION_LOGIC.md)「独自指数」）
- 独自指数 = 指数 ＋ 先行力・前走着順・騎手・上がりの 4 項目（各項目でレース内上位 3 分の 1 が +1・下位 3 分の 1 が −1）
- 表示値 `ownIndex` = round(1.15 × 独自指数 − 20)（独自の目盛り・27〜98・順位は独自指数と同じ）。取込（`scripts/lib/ownIndexApply.mjs`）が開催日 2026-11-28 以降の予想に書く
- `ownIndex` の無い予想（それより前の開催）は指数を表示しない（`getHorseAiIndex` が null）

### 必須ルール
- 個別ページで `{horse.computerIndex}` / `{horse.sourceComputerIndex}` を JSX に埋めるのは **禁止**。指数は必ず `getHorseAiIndex(horse)` 経由。
- `getDisplayComputerIndex(raw)` / `formatDisplayComputerIndex(raw)` は旧仕様（raw − 1）。新しい表示箇所に使わない。

### 🎯 AI総合指数の正規取得ルート（2026-05-24 集約 / 2026-11-26 独自指数へ）

**京都4R 案件**（無料 JRA 単穴の AI総合指数が `161` になった事故）の根本対応として、
AI 総合指数として画面に出す数値は **`getHorseAiIndex(horse)` 1 関数に集約**する。

**`getHorseAiIndex` の挙動:** 参照源は `horse.ownIndex` だけ。数値でなければ `null`（= 表示しない）。

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

