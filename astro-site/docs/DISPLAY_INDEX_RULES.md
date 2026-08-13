# 指数表示ルール（著作権・表示安全対策）

> CLAUDE.md から集約（2026-08-13）。**ルールの正本はこのファイル**。
> CI で強制している内容は [SAFETY_CHECKS.md](./SAFETY_CHECKS.md) も参照。


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

