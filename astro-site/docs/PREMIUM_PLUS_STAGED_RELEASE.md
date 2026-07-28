# Premium Plus 段階公開（PHASE 1〜4）

`/premium-plus-v2/`（商品ページ）への導線を、**Premium Sanrenpuku を購入した会員に対して
時間差で開いていく**方式。三連複を買った直後に ¥68,000 の購入 CTA を見せない。

> 対象範囲: Premium Plus 導線のみ（三連複会員向け）。JRA / NANKAN の無料版・有料版の
> 予想表示ロジックには一切触れていない（4 領域横断ルールの対象外）。

## 判定の単一源

`astro-site/src/lib/premiumPlus/premiumPlusRelease.js`（純粋関数・I/O なし）。
**ページ・コンポーネントに日数条件や時刻条件を書かないこと。**

phase を決める入力は次の 4 つだけ:

1. Premium Sanrenpuku 権限（正本 = `ak_session` の plan / `auth/pageAccess.js` の `verifyPlanAccess`）
2. Premium Sanrenpuku の購入確定日時
3. 現在日時（JST）
4. 受付時刻（PHASE 4 到達後のみ）

**実績（的中 / 不的中）は入力にしない。** 「当たった日は売る / 外した日は売らない」に見える
連動を構造的に禁止するため、モジュールが `premiumPlusResults.json` を import していないことを
guard テストで固定している。

## 段階

| PHASE | いつ | 何が出るか |
|---|---|---|
| **1 LOCKED** | 購入当日〜（0〜2 日目） | 何も出さない。商品ページは **404**（存在秘匿） |
| **2 TEASER** | 3 日目〜 | 三連複会員ページに短い予告のみ。**金額なし・購入ボタンなし・商品ページへのリンクなし** |
| **3 PREVIEW** | 6 日目〜 | 商品ページ閲覧可（説明 / 実績 / 過去結果 / 本日の1鞍 UI）。購入 CTA は「受付準備中」へ置換 |
| **4 SALE** | 10 日目〜 | ¥98,000 → ¥68,000・銀行振込 CTA を通常表示。加えて本日の受付ステータスを表示 |

日数は `PP_PHASE_START_DAY`（TEASER / PREVIEW / SALE）で定数化。購入当日を 0 日目として
**JST 暦日**で数える（UTC 基準だと JST 深夜 0〜9 時に 1 日ズレる）。

fail closed: 権限なし / 購入確定日時が不明・不正・未来 → すべて PHASE 1。

## 本日の受付ステータス（PHASE 4 到達後のみ）

| 状態 | 表示 | 購入操作 |
|---|---|---|
| OPEN | 「本日のPremium Plus受付」「現在受付中」「受付状況は時間帯・申込状況により変動します。」 | 可 |
| CLOSING | 「本日のPremium Plus受付」「受付終了が近づいています」 | 可 |
| CLOSED | 「本日分の受付は終了しました」「次回受付時に、このページからお申し込みいただけます。」 | **不可** |

- CLOSED でも **商品説明・実績は閲覧可**。ページを 404 にはしない。
- CLOSED の購入不可は二重防御: ボタンの `disabled` ＋ `openBankModal()` の早期 return
  （`<html data-pp-purchase>` をサーバーが出力し、クライアント JS が読む）。
- 判定は JST。時刻が不正なら CLOSED（売らない側へ倒す）。

### ⚠️ 受付締切時刻は「未決定」

AK 内に Premium Plus の正式な締切時刻仕様は**存在しない**（docs / コードを grep して確認）。
推測で本番確定させないため、暫定値を定数として置いている:

```js
PP_INTAKE_WINDOW = {
  chuo:   { closingFromMin: 13:00, closedFromMin: 15:00 },  // 土日 = 中央（昼開催）
  nankan: { closingFromMin: 18:00, closedFromMin: 20:00 },  // 平日 = 南関（夜開催）
}
```

サーキットは曜日から導出（平日 = 南関 / 土日 = 中央）。ページ側の既存ロジックと同一基準。

**運用で締切を確定したら、`PP_INTAKE_WINDOW` と本 doc を同時に更新すること。**

## ⛔ 購入確定日時の正本が存在しない（未解決・要判断）

**現状 PHASE は上がらない。全会員が PHASE 1（= 商品ページ 404）になる。**

Airtable Customers に **三連複購入の日時フィールドが無い**:

- 入金確認時の `buildConfirmationFields()`（`src/lib/payments/bankPaymentFlow.js`）は
  三連複分岐で `LifetimeSanrenpuku: true` と `Requested*` クリアだけを書き、**`PaidAt` を書かない**。
- `PaidAt` は Light / Premium の**会員ランク購入時のみ**書かれる。
- したがって「三連複をいつ買ったか」は既存データから導出できない。

### `PaidAt` で代用してはいけない

既存 Premium 会員が後から三連複を買った場合、`PaidAt` は馬単購入日（数か月前）なので
**購入直後に PHASE 4 へ飛ぶ**。本機能の目的と正反対になる。
そのため `SANRENPUKU_PAID_AT_FIELDS` に `PaidAt` を含めていない（テストで固定）。

### 解禁の選択肢（いずれも実行には承認が必要）

| # | 方法 | 必要な操作 | リスク |
|---|---|---|---|
| A | Airtable に `SanrenpukuPaidAt` を作成し、`buildConfirmationFields()` の三連複分岐で書く | **production Airtable schema 変更** ＋ 決済確定パスのコード変更 | 高（未作成フィールドへ PATCH すると Airtable が 422 を返し三連複昇格が全落ちする。**フィールド作成が先**） |
| B | env `PREMIUM_PLUS_FUNNEL_ANCHOR` に全体アンカー日（ISO / `YYYY-MM-DD`）を設定 | **production env 変更** ＋ 再デプロイ | 中（会員別ではなく全員一律。暫定運用向け） |

コード側は **A / B どちらにも既に対応済み**（A が優先・無ければ B・どちらも無ければ PHASE 1）。
`SanrenpukuPaidAt` は日本語別名 `三連複購入日時` も読む。

> 本タスクでは A / B とも**実行していない**（production schema 変更・env 変更は高リスク境界）。

## 取得層（唯一の I/O）

`astro-site/src/lib/premiumPlus/purchaseAnchorLookup.js`

- `ak_session` の `sub`（Airtable recordId）で Customers を **GET するだけ**（書き込みなし）
- タイムアウト 2.5 秒 / recordId 単位で 10 分キャッシュ
- 鍵なし・通信失敗・404・JSON 破損 → 例外を投げず `null`（= PHASE 1）
- 秘密鍵・レコード内容はログに出さない

## 予告（PHASE 2）の配信経路

三連複会員ページ（`premium-sanrenpuku.astro` / `premium-sanrenpuku-jra.astro`）は
`prerender = true` の**静的 HTML** なので、予告文を直接書くと非会員がソースを見るだけで
Premium Plus の存在を知れてしまう。

そのため:

- ページには**空のスロットだけ**を置く（`PremiumPlusStageTeaser.astro`）
- 文言は SSR エンドポイント **`/api/premium-plus-stage.json`** から取得する
  - `verifyPlanAccess` NG → **404**
  - PHASE 1 → **404**（まだ何も知らせない）
  - PHASE 2 → 予告文言のみ（商品ページ URL は返さない = 強制誘導しない）
  - PHASE 3 以降 → 予告文言 ＋ 商品ページ URL
  - 価格・口座情報は**どの phase でも返さない**

## 関連ファイル

| 目的 | ファイル |
|---|---|
| 判定の単一源（純粋） | `src/lib/premiumPlus/premiumPlusRelease.js` |
| 購入確定日時の取得（I/O） | `src/lib/premiumPlus/purchaseAnchorLookup.js` |
| 予告配信エンドポイント | `src/pages/api/premium-plus-stage.json.js` |
| 予告スロット | `src/components/PremiumPlusStageTeaser.astro` |
| 商品ページ（正式） | `src/pages/premium-plus-v2.astro` |
| 商品ページ（旧経路・迂回防止で同じゲート） | `src/pages/premium-plus.astro` |
| 予告の設置先 | `src/pages/premium-sanrenpuku.astro` / `premium-sanrenpuku-jra.astro` |
| テスト | `src/lib/premiumPlus/premiumPlusRelease.test.mjs` / `purchaseAnchorLookup.test.mjs` / `stagedReleaseGuard.test.mjs` |

テストは `npm run test:premium-plus-media`（`check:safety` に組込済み）で実行される。

## 変更してはいけないこと

- phase 判定に**実績データを入力しない**（販売タイミングと的中を連動させない）
- PHASE 3 未満で商品ページを 200 で返さない（404 で存在秘匿。401/403 は使わない）
- 購入ボタンから `disabled={!ppRelease.purchaseEnabled}` を外さない
- 三連複会員ページの静的 HTML に価格・商品リンクを書かない
- 商品ページの本文コピー・`PRICE` / `LIST_PRICE` を段階公開の実装ついでに書き換えない
  （guard テストが検知する）
- `premium-plus.astro` の vref カード描画を変えたら `PP_TEMPLATE_VERSION` を bump する
  （Netlify functions cache 対策。本タスクで `staged-release-phase-gate-20260728-1` へ更新済み）

## 現在地（2026-07-28）

- [x] 判定の単一源（phase / 受付ステータス / JST / 文言）＋ テスト
- [x] 購入確定日時の取得層（read-only・fail closed）＋ テスト
- [x] 商品ページ 2 本の phase ゲート（PHASE 3 未満 404 / CTA 置換 / CLOSED 操作不可）
- [x] PHASE 2 予告の SSR 配信経路 ＋ 三連複会員ページへの設置
- [x] guard テスト（実績非連動 / 迂回防止 / 本文非改変 / 存在秘匿）
- [ ] **購入確定日時の正本を用意する**（上記 A または B。承認待ち・未実行）
- [ ] 受付締切時刻の確定（`PP_INTAKE_WINDOW` 暫定値のまま）
- [ ] 本番での phase 遷移の実地確認（正本が入るまで実施不可）
