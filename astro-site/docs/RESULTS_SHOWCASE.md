# 有料実績ショーケース（無料→有料導線）

> CLAUDE.md から集約（2026-08-13）。**ルールの正本はこのファイル**。


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
| トップ上部プレビュー（ビュー選択のみ・買い目を持たない） | `src/lib/resultsShowcasePreview.js` / `src/lib/resultsShowcasePreview.test.mjs`（`npm run test:results-showcase`・`check:safety` 組込） |
| トップ上部プレビュー（表示） | `src/components/HomeResultsShowcasePreview.astro` |
| 埋込先（トップ） | `src/pages/index.astro`（Hero Key Visual 直下 / Hero Section の前） |
| nav | `src/layouts/BaseLayout.astro`。ナビ集約後、昨日の買い目は top-level ではなく「🏆 実績」ドロップダウン内の「💎 昨日の買い目」グループ（JRA/NANKAN）に格納。的中実績（アーカイブ）と同じ実績メニューにまとめて混同回避 |

### トップページ上部プレビュー（2026-08-18 追加 / 同日 2 度の改訂）

Hero Key Visual の直下・Hero Section の前に、`/results-showcase/{jra,nankan}` へ誘導する
コンパクトプレビューを置く（PC 2 カラム / スマホ 1 カラム）。

**構成は ① 当日の全体実績（的中数/総レース数・回収率）→ ② 全会場・全レースの ✅/✗ → ③ 導線 で固定。**

#### トップでは買い目・払戻を出さない（確定仕様）

初版は代表メインの配信買い目をトップに出していたが、

1. 代表メインが目立ちすぎ、**メイン不的中の日に当日全体の実績まで悪く見えた**
2. 主役を「その日の全レース実績」に置きたい

という理由で、**トップからメイン買い目・払戻の表示を削除**した。

- トップの主役は **的中数 / 総レース数・回収率・全レースの ✅/✗** の 3 点
- **全レースを同列で表示する**。メインレースを金枠等で強調しない
- `resultsShowcasePreview.js` は**買い目・払戻を戻り値に含めない**
  （`mainRace` / `honmei` / `displayPartners` / `payout` / `combination` を返さない）。
  マークアップ側だけで隠すのではなく**データとして持たない**ことで漏れを防ぐ。テストで固定
- **メインレースの実際の配信買い目は `/results-showcase/{jra,nankan}` 側だけで公開する。
  そちらの表示（メイン 5 点・抑え非公開・旧 `↔` 裏目的中の `⇄` 畳み込み）は変更しない**

#### そのほかの原則

- **集計を持たない**。`resultsShowcasePreview.js` は単一源 `buildLatestShowcase()` の戻り値から
  **選ぶだけ**のアダプタ。新しい結果 JSON・独自集計・固定の宣伝数値は作らない
  （全レース一覧も `venueGroups[].races[]` をそのまま渡すだけで、的中数を数え直さない）
- **全レース一覧は正本どおり ✅/✗ のみ**。渡す race は `raceNumber` / `isHit` / `isMain` の
  3 キーだけ（`isMain` は単一源の値を通すだけで**表示上の強調には使わない**）
- **JRA の複数会場開催は全会場ぶん**出す（例: 中京・新潟・札幌 × 12R = 36 レース）
- 不的中も同じ視認性で出す（実績なので `✗` を薄くして隠さない）
- 回収率が無い日は項目ごと非表示（0% を捏造しない）。表示できるレースが 1 つも無いカテゴリは
  **カードごと非表示**、両方無ければセクションを描画しない
- 縦の長さは実測で管理する（2026-08-18 時点: PC 1280px で約 451px / スマホ 390px で約 729px。
  12R の一覧は PC 1 行・スマホ 2 行）
- 表示順・買い目非表示・メイン非強調は `resultsShowcasePreview.test.mjs` の guard
  （マークアップを直接検査）で固定する

### 運用の注意

- JRA は平日開催が無く、南関（平日開催）と**最新日がズレる**のは正常（例: 南関7/8 / JRA7/5）。
- ローカルで最新日が出ないときは、まず `origin/main` を fetch。結果取込コミットが先行しているだけ
  （本番は Actions→Netlify で常に最新日を反映）。

