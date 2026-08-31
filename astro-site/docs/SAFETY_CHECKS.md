# Safety Checks — CI で強制している恒久ルール

analytics-keiba には CI で強制している恒久ルールがある。
変更前後で **必ず** 該当チェックがローカルで通ることを確認すること。

> **このファイルが CI safety の正本。** CLAUDE.md には要点だけを置く。
> ルールを増やしたらここへ追記し、CLAUDE.md 側は箇条書き 1 行に留めること。

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

## ルール 3: 無料版のモザイクは「描画されて」初めてマスク

> 2026-08-13 に CLAUDE.md から移設（原文のまま）。2026-07-31 の本番不具合が根拠。

- `.stat-score` / `.stat-index` の gradient 文字（`background-clip: text` +
  `-webkit-text-fill-color: transparent`）の中では、子要素に `filter: blur()` を掛けても
  **親が同じ文字をクリップ描画するため鮮明な文字が残る**（2026-07-31 本番不具合）
- マスク時は親に `stat-value-masked` を付け、gradient 文字を無効化する
  （`.stat-value.stat-value-masked` の 2 クラスで上書き。同詳細度だと定義順依存になる）
- 検証: `npm run check:free-mask`（markup だけでなく打ち消し CSS の有無まで検査）

## ルール 4: 旧 KI 風ブロックを再混入させない

3 ページ分の grep guard と構造パリティで強制する。詳細は
[`KI_RELIC_GUARDS.md`](./KI_RELIC_GUARDS.md) / [`PREMIUM_JRA_RULES.md`](./PREMIUM_JRA_RULES.md) /
[`FREE_JRA_RULES.md`](./FREE_JRA_RULES.md)。

検証: `npm run check:ki-relics:jra` / `check:ki-relics:free-jra-date` / `check:ki-relics:free-jra`
/ `check:jra-nankan-parity`

## ルール 5: Customers を無フィルタで全件走査しない

Customers は 15,962 件。先頭 N 件だけ読んで黙って打ち切ると**人が静かに消える**。
用途別に `filterByFormula` で絞るか、絞れないなら fail closed にする。
**`MAX_PAGES` を上げるのは解決ではない。**

検証: `npm run check:no-unbounded-scan`

## ルール 6: 「当日」を表示するページはビルド時に日付を決めない

**根拠（2026-08-30 のお客様報告）**: `/dark-horse-picks/`（穴馬抽出）は
`prerender = true`（静的生成）のまま、当日 (`todayJst`) を**ビルド時刻**で決めていた。
ビルドは前日夕方の自動取込でしか走らないため `todayJst` が前日で固定され、
**当日は終日「前日のレース」しか表示されなかった**
（本番 8/30 12 時の HTML が `2026-08-29` のデータ。当日 8/30 分はリポジトリに揃っていた）。

- 当日判定を伴うページは **SSR (`prerender = false`)**。当日は
  `jstDateString(new Date())`（`src/lib/darkHorse/selectTodaysDarkHorses.js`）で
  **リクエストごと**に決める。ページ内で `9 * 60 * 60 * 1000` を再実装しない
- データは **当日分だけ** `loadComputerEntriesForDate(todayJst)` で fs から読む。
  `import.meta.glob(eager)` で全日付をバンドルへ焼き込まない
- **前日 / 最新日への fallback を足さない**。当日 0 件は「まだ公開されていません」が正しい
- CDN に寝かせない（`Cache-Control: public, max-age=0, must-revalidate`）
- SSR 化したサブツリーは `src/lib/ssr/runtimeDataRetention.js` の
  `RUNTIME_SUBTREES` へ入れる。**`BUILD_ONLY_SUBTREES` へ戻すと当日分が消える**
  （`computer/{jra,nankan}` は 2026-08-30 に build-only から移動）

検証: `npm run test:dark-horse`（SSR guard 込み）/ `npm run test:ssr-retention`
/ `npm run check:ssr-runtime-data`（**ビルド成果物**に当日分が残っているかを実際の loader で確認）

## ルール 7: メールアドレスを直書きしない（単一源 `email-config.js`）

**根拠**: 旧サイト（南関中心）時代のアドレスが 6 本の Function とページに直書きで散在し、
「問い合わせの返信が旧 Gmail に飛ぶ」「SendGrid で verify されていない旧ドメイン別名を
`from` に使い、送信が無音で失敗しうる」状態だった（2026-08-31 に全廃）。

- 問い合わせ・返信先 = `support@keiba.link`（`SUPPORT_EMAIL` / `ADMIN_EMAIL`）
- システム送信元 = `noreply@keiba.link`（`FROM_EMAIL`）
- 正本は `netlify/functions/config/email-config.js` **1 ファイルだけ**。
  Function / ページ / コンポーネントにアドレスを直書きしない
- **例外 2 経路を `FROM_EMAIL` へ寄せ替えない**:
  決済メールは `src/lib/payments/senderIdentity.js`（noreply への fallback 禁止・fail closed）、
  メルマガは `src/lib/newsletter/brand-config.js`（From は DeliveryKey の構成要素＝
  変えると既送分と鍵が変わり**二重送信**）

検証: `npm run test:email-identity`（正本: [`EMAIL_ADDRESSES.md`](./EMAIL_ADDRESSES.md)）

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
5. `npm run check:free-mask` — 無料版マスクの打ち消し CSS まで検査
6. `npm run check:ki-relics:*` — 旧 KI 風ブロックの再混入検知（3 ページ分の個別 step）
7. `npm run check:no-unbounded-scan` — Customers の無フィルタ全件走査＋黙って打ち切りの検知
8. `npm run test:dark-horse` — 穴馬抽出の当日選定（SSR 維持 / 過去日 fallback なし / JST 境界）
9. `npm run test:ssr-retention` — SSR 実行時データの保持ポリシー（computer を全削除へ戻さない）
10. `npm run check:ssr-runtime-data` — prune 後の成果物に当日データが実在するかを loader で確認
11. `npm run test:email-identity` — 旧メールアドレスの再混入検知＋ support / noreply の役割固定

実行エントリの正本は `astro-site/package.json` の `check:safety` / `verify:safety`。
**新しい guard を足すときは `check:safety` と `safety-check.yml` の `paths` と
`jobs.safety.steps` の 3 箇所すべてに追加する**（paths だけでは CI 実行されない）。

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
