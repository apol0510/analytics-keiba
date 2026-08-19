# クーポン基盤（**Premium Plus 専用ではない**）

> **ルールの正本はこのファイル。** クーポンに関わる実装・設計は、まずここを読む。

## 🚩 確定方針（2026-08-20 MK）

**クーポンは Premium Plus 専用ではない。今後ほかの商品・プランでも利用する。**

- **Premium Plus は共通クーポン基盤の「最初の利用商品」**にすぎない。特別扱いしない
- クーポン定義 / 所持 / 適用 / 使用済み / 取消 / 訂正 / 再発行 / 監査履歴は
  **可能な限り共通化**する
- admin に**特定商品専用ロジックを増殖させない**。商品 / クーポンを識別して運用する
- 履歴は **append-only**
- **商品・会員・couponId/version・operationId** を明確に識別できること
- **他商品・他会員へ影響しない**こと
- 所持 / 対象商品 / 有効性 / 使用状態 / 価格は **server-side で再検証**する
- **二重適用・二重使用・二重履歴を防止**する
- 迷ったら **fail closed**
- **Premium Plus の既存仕様（10,000円OFF / 再募集開始から 14 日 等）を壊さない**

### まだ確定していないもの（**創作しない**）

| 未確定 | 決め方 |
|---|---|
| Premium Plus 以外でどの商品へ導入するか | 商品ごとに MK が決定 |
| 各商品の割引額 / 率 | 同上 |
| 有効期限 | 同上 |
| 配布条件 | 同上 |
| 併用可否 | 同上（**決まるまで 1 商品 1 枚**）|
| 自動付与条件 | 同上 |

決まったら `src/lib/coupons/couponCatalog.js` へ 1 件足し、このファイルへ追記する。
⚠️ **決まっていない条件を既定値で埋めない**（`terms.determined = false` のまま置く）。

## 商品固有と共通の境界

```
┌─ 共通 ────────────────────────────────────────────────────────────────┐
│ src/lib/coupons/couponPlatform.js                                      │
│   操作の種類 / 排他規則 / 状態遷移 / 監査の書式 / fail closed の条件    │
│ src/lib/coupons/couponCatalog.js                                       │
│   どんなクーポンが存在するか（商品識別子つき）・適用可能なクーポン      │
│ src/lib/coupons/couponOperationHistory.js                              │
│   append-only 履歴のレコード形（**本番テーブルは未作成**）              │
└────────────────────────────────────────────────────────────────────────┘
             ▲ binding（商品ごとに 1 つ。読む / 書く場所だけを教える）
┌─ 商品固有 ────────────────────────────────────────────────────────────┐
│ Premium Plus: premiumPlusReopenCoupon.js（3 列 + 割引条件）             │
│               premiumPlusCouponAdmin.js（binding のみ）                 │
└────────────────────────────────────────────────────────────────────────┘
```

**binding の契約**:

```js
{
  couponId, version, productKey,
  readHolding(fields)     -> { claimed, claimedAtMs, claimedAtIso, couponId, source }
  buildClaimFields(input) -> object|null   // 取得を書く（付与 / 再発行 / 顧客取得）
  buildClearFields(input) -> object|null   // 取得を消す（誤取得訂正）
  isStorageEnabled(env)   -> boolean       // 保存先が本番で有効か（fail closed）
}
```

⚠️ **共通層は Airtable も商品ページも知らない**（判定材料は引数だけ）。
`couponPlatform.js` / `couponOperationHistory.js` は**特定商品のモジュールを import しない**
（`couponPlatform.test.mjs` が import 文を検査して落とす）。

## 2 商品目を足すときにやること

**Premium Plus のコードはコピーしない。** 足すのは次の 3 つだけ:

1. `couponCatalog.js` に定義を 1 件（`couponId` / `version` / `productKey` / `terms` / `bindingId`）
2. binding を 1 つ（保有状態をどこに読み書きするか）
3. 呼び出し側の配線（管理画面のどの画面から操作するか）

判定（排他 / 使用済み / 予約中 / 台帳不明 / 監査の書式）は**共通層がそのまま効く**。
`couponPlatform.test.mjs` は合成の「2 商品目」で全規則を検査しており、
**Premium Plus を 1 行も import せずに**通ることを固定している。

## 操作と排他規則（全商品共通）

| 操作 | 意味 |
|---|---|
| `claim` | お客様ご自身の取得 |
| `grant` | 管理者が付与（**取得履歴が一度も無い会員だけ**）|
| `reissue` | 管理者が再発行（**訂正・失効で一度失った会員だけ**）|
| `correct` | 誤取得の訂正（取得を取り消す。履歴は残す）|
| `revokeReservation` | 入金確認前の利用予約の取消（保有状態は触らない）|

**付与と再発行は排他**（履歴の有無で一方だけ）:

| 状態 | 付与 | 再発行 |
|---|---|---|
| 取得履歴が一度も無い | ✅ | ❌ `coupon_no_history` |
| 履歴あり・訂正済みで現在未取得 | ❌ `coupon_history_exists` | ✅ |
| 取得済み / 利用予約中 / 使用済み / 台帳確認不能 | ❌ | ❌ |

⚠️ **UI だけの制御にしない。** サーバーが同じ判定を必ず再実行する。

## 監査の書式（全商品共通）

保有状態の `Source` 相当の列へ**構造化 1 行**を書く。

```
admin-grant|by=MK|at=2026-08-20T…|why=お電話でのご依頼
admin-correct|by=MK|at=…|prev=2026-08-18T22:07:54.803Z|from=pause-notice|why=誤操作のため訂正
admin-reissue|by=MK|at=…|prev=…|from=admin-grant|why=訂正後に改めて発行
```

- `why=` は**必ず最後**（理由に `|` や `=` が入っても壊れない）
- **訂正でも履歴を消さない**（`prev` に元の取得日時、`from` に元の取得元）
- ⚠️ **書式を変えると既存レコードが読めなくなる**。追加は末尾の新しいキーで行う
- 顧客側の取得元 allow-list に `admin-*` は**無い**ので、クライアントは管理者操作を騙れない

## append-only 履歴（**本番テーブル未作成 / MK 判断待ち**）

Customers の 1 列に畳む方式では**直近 1 回の操作しか残らない**。
完全な履歴には**本番 schema 変更**が要るため、**テーブルは作っていない**。
設計だけ `src/lib/coupons/couponOperationHistory.js` に固定してある。

- テーブル名: `CouponOperationHistory`（**商品名を含めない**）
- 列: `OperationId` / `OccurredAt` / `CustomerRecordId` / `Email` / `ProductKey` /
  `CouponId` / `CouponVersion` / `OperationType` / `Actor` / `Reason` /
  `BeforeState` / `AfterState` / `Detail`
- gate: `COUPON_HISTORY_TABLE_READY=1`（**未設定のあいだは 1 行も積まない**）
- 冪等キー `OperationId` = `customerRecordId|couponId|version|operationType|atIso`
  （**乱数を使わない**＝再実行で二重に積まない）
- ⚠️ **課金・権限の列を 1 つも持たない**（履歴が権利の根拠になってはいけない）

### なぜ `PromotionalOffers` に混ぜないか

あの台帳は「価格の入った購入条件」で、`offerFilterModel.js` / `customerTimeline.js` /
`recommendedActions.js` が `Status` / `ExpiresAt` / `OfferPrice` で顧客を分類している。
価格の無い監査行を混ぜると**嘘の分類**が生まれる
（利用予約行を `Source` で除外しているのと同じ理由）。**別テーブルにする。**

## 関連ファイル

| 目的 | ファイル |
|---|---|
| 共通の判定・監査 | `src/lib/coupons/couponPlatform.js` |
| クーポン定義の正本 | `src/lib/coupons/couponCatalog.js` |
| append-only 履歴の設計 | `src/lib/coupons/couponOperationHistory.js` |
| Premium Plus の条件 | `src/lib/premiumPlus/premiumPlusReopenCoupon.js` |
| Premium Plus の binding | `src/lib/premiumPlus/premiumPlusCouponAdmin.js` |
| 利用予約 → 使用済み | `src/lib/premiumPlus/premiumPlusCouponReservation.js` |
| 価格・商品の正本 | `src/lib/promotions/promotionOfferCatalog.js` |

検証: `npm run test:coupons`（`check:safety` に組込済み）
