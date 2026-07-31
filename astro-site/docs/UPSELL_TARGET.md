# 販売導線の制御（UpsellTarget）

Premium 会員に「Premium Sanrenpuku」と「Premium Plus」を**同時に見せて迷わせない**ための仕組み。
どの商品の CTA を見せるかを **会員ごとに管理画面から選べる**ようにする。

> **状態: 未本番（2026-07-31）**
> Airtable の `UpsellTarget` フィールドは**未作成**、書き込み env gate は**未設定**。
> 未設定 = `auto` として動くため、**フィールドが無い間の挙動は従来と完全に同じ**。

---

## 1. これは何を決めるフィールドか（混同しない）

| | 何を決めるか | 正本 |
|---|---|---|
| **UpsellTarget** | **どの商品の販売導線を見せるか** | `src/lib/upsell/upsellTarget.js` |
| entitlement | 何を閲覧できるか | `src/lib/entitlements/resolveEntitlements.js` |
| `PremiumPlusEligibility` | **Plus を売ってよいか**（資格） | `src/lib/premiumPlus/premiumPlusRelease.js` |
| `canPurchaseSanrenpuku` | 三連複を買えるか | `resolveEntitlements`（有料 Premium かつ未保有） |

> **`UpsellTarget` は販売導線の選択であり、会員権・決済・entitlement の正本ではない。**
> この値で権利を増やしたり、販売資格を上書きしたりしない。
> **各商品固有の権限条件は、指定があっても必ず再評価する。**

## 2. 値と意味

| 値 | 意味 |
|---|---|
| `auto` | システム自動判定（**既定**。未設定と同義） |
| `sanrenpuku` | 三連複の導線だけを見せる |
| `plus` | Premium Plus の導線だけを見せる |
| `none` | 販売導線を出さない（**会員機能は一切変更しない**） |

**1 会員に 2 商品を同時表示しない。** resolver は `channel` を 1 つだけ返し、
選ばれなかった側の表示フラグをすべて false に落とす。

### 未設定は `auto`

`UpsellTarget` が無い / 空 / 未知の値 → すべて `auto`。
**既存 1,400 件超への一括書き込み（migration）は不要**で、フィールド作成前でも安全に動く。

## 3. `auto` の挙動（既存の段階表示を壊さない）

`auto` の三連複導線は、従来どおり `src/lib/sanrenpuku/sanrenpukuCtaStage.js` の**段階表示**に従う。

- 1 日目: 何も出さない
- 2 日目: 予告（day2）
- 3 日目: 予告（day3）＋前日結果（結果セクションのあるページのみ）
- 4 日目以降: 三連複 CTA（`ak-srp-cta-dismissed` で非表示にできる）

**`auto` だからといって即時 CTA にはしない。** 基準時刻（`ak-umatan-first-seen`）と
dismiss は従来どおり localStorage で管理する。

### 競合したときの優先順位（`auto`）

1. **Plus の明示的な販売対象**（phase 4 = 販売中 / 「今すぐ販売可」）→ **Plus**
2. それ以外で三連複を売れる相手 → **三連複（既存の段階表示）**
3. 三連複を売れない相手（保有済み等）で Plus が予告 phase → **Plus 予告**
4. どちらでもない → **なし**

つまり **Plus が予告止まり（phase 2/3）のときは三連複を優先**する。
これにより「Plus 予告」と「三連複 CTA」が同時に出ることがない。

## 4. 明示指定の挙動

判定順は **`none` > `plus` > `sanrenpuku` > `auto`**。ただし各商品の権限条件は必ず再評価する。

### `sanrenpuku`

- Premium Plus の予告・商品ページ・CTA は**すべて出さない**
- 三連複は**既存の段階表示を維持**（管理者が指定しても即時 CTA にはしない）
- **三連複を保有済みなら CTA は出さない**（再購入 CTA を出さない）。
  このとき **Plus へ勝手にフォールバックしない**（`channel = none`）
- 管理画面では、保有済み会員に対して `三連複` の選択肢を**無効化**する

### `plus`

**「販売CTA = Premium Plus」を選ぶこと自体が、管理者による販売許可**です。
別途 `PremiumPlusEligibility=eligible` を設定させる**二重操作をなくす**ため、
`plus` の明示指定は次の 2 つを免除します。

| 免除するもの | 理由 |
|---|---|
| `PremiumPlusEligibility` が **review / 未設定** | 「plus を選んだ」= 管理者が売ると決めた、と解釈する |
| 段階公開の phase 進行（PHASE 1→4 待ち） | 同上。指定した時点で販売中として扱う |
| `PaidAt` から 30 日（ROUTE B の条件） | `PaidAt` は 2026-07-10 の入金確認フロー刷新以降しか書かれず旧会員は構造的に空。<br>明示指定時は **ROUTE C（`premium_admin`）**として販売対象になる |

**免除しないもの（必ず維持）**:

- **`PremiumPlusEligibility=blocked`**（明示指定でも override でも**常に表示不可**）
- **Free / Light**（対象ティアでない）
- **Premium 契約が無効**（期限切れの通常 Premium は勝手に売らない）
- 未ログイン fail closed / 受付時間（intake）・`purchaseEnabled` / 二重購入防止 /
  商品ページ 404（存在秘匿）/ 三連複の同時表示禁止

⚠️ **`UpsellTarget=plus` にしても Airtable の `PremiumPlusEligibility` は書き換えません。**
resolver 上で「管理者の販売許可」として扱うだけで、既存データはそのまま保持します
（`resolvePremiumPlusRelease` の戻り値 `adminSaleDirective` で区別でき、
`overrideApplied` は従来どおり `PremiumPlusReleaseOverride` フィールド由来のときだけ true）。

⚠️ **`auto` の意味は変えていません。** `auto` では従来どおり
`PremiumPlusEligibility` / `PremiumPlusReleaseOverride` / route による自動判定を使い、
review / 未設定なら Plus を出しません。免除は**明示指定のときだけ**です。

### `none`

三連複の予告・CTA、Plus の予告・商品ページ・CTA を**すべて**出さない。
**通常の会員機能（閲覧権・ログイン・マイページ）は一切変更しない。** 販売導線だけ止める。

## 5. 実装（判定は 1 か所）

| 目的 | ファイル |
|---|---|
| **判定の単一源（純粋）** | `src/lib/upsell/upsellTarget.js` |
| ブラウザ用の取得ヘルパ | `src/lib/upsell/upsellClient.js` |
| 配信 API（SSR・read-only） | `src/pages/api/upsell.json` |
| Plus 予告 API（channel を尊重） | `src/pages/api/premium-plus-stage.json` |
| 商品ページ | `src/pages/premium-plus-v2.astro` / `premium-plus.astro` |
| 三連複 CTA 設置ページ | `src/pages/premium-prediction/{jra,nankan}.astro` |
| 主要導線 | `src/pages/dashboard.astro` |
| 管理画面 | `src/pages/admin/premium-plus-eligibility.astro` + `netlify/functions/premium-plus-eligibility.js` |

### 管理プレビューも同じ判定を通る

`/admin/premium-plus-eligibility` の「表示プレビュー」（`action=preview`）は
`premiumPlusPreview.js` → **`resolveUpsellDisplay`** を経由する。
`UpsellTarget` から Plus 側フラグを導く処理は **`resolvePlusAdminFlags()` が唯一の導出元**で、
顧客経路（`resolveUpsellForCustomer`）とプレビューが同じ関数を共有する。

> 一覧の「実表示」・プレビュー・顧客側の 3 つが必ず一致する。
> ズレると「管理画面では出ないのに顧客には出る（逆も）」が起きるため、
> `upsellTarget.test.mjs` が 80 ケース以上で両者の結論一致を固定している。

プレビューの戻り値には `upsellTarget` / `upsellChannel` / `upsellDisplay` /
`upsellReason` / `adminSaleDirective` / `sanrenpukuAllowed` が含まれる。

### 顧客側の流れ

1. ページが `/api/upsell.json` を **1 回だけ**取得（`upsellClient.js` が memoize）
2. サーバーが `channel`（`sanrenpuku` / `plus` / `none`）を返す
3. 三連複の**段階**（予告 / CTA）はクライアントが従来どおり `sanrenpukuCtaStage.js` で確定する
4. Plus の詳細（phase・受付状況・商品 URL）は **channel が plus のときだけ**返す（存在秘匿）

**取得できないとき（未ログイン / API 不在 / 通信エラー）は `unknown` として従来動作を維持する。**
この機能の障害で既存の導線が消えたり、逆に 2 つ出たりしない。

## 6. 管理画面

`/admin/premium-plus-eligibility/` のタブ 1（Premium Plus 販売資格）に追加。

- **一覧**: 「販売CTA」（設定値: 自動 / 三連複 / Plus / なし）と
  「実表示」（顧客側で実際に見えるもの: 三連複CTA / 三連複予告 / Plus CTA / 表示なし）を**別列**で表示。
  実表示セルの `title` に理由（例: 三連複を保有済み / blocked / Light 対象外）が出る
- **フィルタ**: すべて / 自動 / 三連複 / Plus / なし
- **詳細・操作**: 「販売CTA」セクションで **radio（単一選択）**。チェックボックスは使わない
- 三連複保有済みの会員には `三連複` の選択肢を**無効化**（再購入 CTA は出せないため）
- 既存の `PremiumPlusEligibility` / `PremiumPlusReleaseOverride` の操作 UI は**そのまま残す**（統合しない）

> 「設定した値」と「顧客側で実際に何が見えるか」を必ず区別して表示する。
> 設定しても表示されない場合は理由を出す（空振りの操作をさせない）。

**警告を出す条件**は「本当に表示できないとき」だけです（`blocked` / Free・Light /
契約無効 / 三連複を保有済みなのに `sanrenpuku` を指定）。
**`eligibility` が未設定・review であることを理由にした警告は出しません**
（`plus` の明示指定がそのまま販売許可になるため）。原則として一覧の
「販売CTA」と「実表示」は一致します。

## 7. Airtable フィールド（**未作成 / 承認待ち**）

| 項目 | 値 |
|---|---|
| テーブル | `Customers` |
| フィールド名 | **`UpsellTarget`** |
| 型 | **単一選択（singleSelect）** |
| 選択肢 | `auto` / `sanrenpuku` / `plus` / `none`（**すべて小文字**） |
| 既定値 | **設定しない**（空 = `auto` として扱う） |
| migration | **不要**（既存レコードは空のままでよい） |

### なぜ singleSelect か

値は 4 つに固定で増減しない列挙であり、管理画面のフィルタ・集計とも相性が良い。
書き込みは `typecast: true` 付きの PATCH なので、選択肢の表記ゆれがあっても
Airtable 側で吸収される。読み取りは `normalizeUpsellTarget()` が小文字化して解釈し、
**未知の値は `auto`** に倒すため、フィールドの選択肢が後から増えても事故にならない。

### 有効化の手順（順序厳守）

| # | 手順 | 承認 |
|---|---|---|
| 1 | Airtable `Customers` に `UpsellTarget`（単一選択・4 択）を作成 | 要 |
| 2 | production env に `UPSELL_TARGET_FIELD_READY=1` を設定 → Build Hook 再デプロイ | 要 |
| 3 | 管理画面で 1 名だけ設定 → 顧客側の実表示を確認 → `auto` に戻す | — |
| 4 | 本番運用開始 | 要 |

⚠️ **順序を逆にしない。** 未作成フィールドへ PATCH すると Airtable は 422 を返し、
同じ PATCH の他の更新まで巻き添えで失敗する。
そのため `UPSELL_TARGET_FIELD_READY` が無い間、書き込み API は **503（`sideEffects: none`）**で止まる。
**読み取りには gate が不要**（未設定 = `auto`）なので、フィールド作成前でも画面は壊れない。

### rollback

- `netlify env:unset UPSELL_TARGET_FIELD_READY --context production` → 再デプロイで**設定変更のみ停止**
  （既に設定済みの値は残るが、`auto` へ戻したい場合は管理画面から 1 件ずつ戻す）
- コードを戻す場合は `git revert` の**新規コミット**（reset / force push は使わない）

## 8. 触ってはいけないこと

- `UpsellTarget` の書き込みで、**課金・権限フィールドを 1 バイトも書かない**
  （`プラン` / `PlanType` / `Status` / `有効期限` / `PaidAt` / `PaymentConfirmed` /
  `PaymentEmailSent` / `Requested*` / `LifetimeSanrenpuku` / `PremiumPlus*` / `PromotionalOffers` /
  カムバック特典フィールド）
- 三連複の**段階表示ロジックを迂回しない**（`sanrenpukuCtaStage.js` が単一源）
- ページ側に「誰に何を売るか」の条件を**再実装しない**（`upsellTarget.js` 経由のみ）
- `PremiumPlusEligibility` と `UpsellTarget` を**統合しない**（資格と導線は別概念）

## 9. 検証

`npm run test:upsell`（`check:safety` と CI に配線済み）

- `upsellTarget.test.mjs` — 26 本。auto の段階表示維持 / 明示指定 / 保有済み / blocked /
  Light・Free / 受付時間外 / 未設定互換 / **2 商品の同時表示が起きないこと**
- `upsellIntegration.guard.test.mjs` — 8 本。単一源経由 / 段階表示の非迂回 /
  書き込みは `UpsellTarget` 1 列 / env gate / 存在秘匿 / 管理画面の単一選択
