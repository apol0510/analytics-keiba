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
- 列（**12 列**）: `OperationId` / `OccurredAt` / `CustomerRecordId` / `ProductKey` /
  `CouponId` / `CouponVersion` / `OperationType` / `Actor` / `Reason` /
  `BeforeState` / `AfterState` / `Detail`
- ⚠️ **`Email` は持たない。** 会員の正本は `CustomerRecordId` で、アドレスは参照用にすぎない。
  append-only の履歴へ **PII を重複保存しない**。表示に要るときは
  `CustomerRecordId` から Customers を引く
- gate: `COUPON_HISTORY_TABLE_READY=1`（**未設定のあいだは 1 行も積まない**）
- ⚠️ **課金・権限の列を 1 つも持たない**（履歴が権利の根拠になってはいけない）

### 冪等キー `OperationId`（**現在時刻を材料にしない**）

```
sha256("ak-coupon-op|" + productKey + "|" + couponId + "|" + version
       + "|" + customerRecordId + "|" + operationType + "|" + anchor).slice(0, 32)
```

`atIso`（wall-clock）を混ぜると**再送のたびに別の操作**になり、
「同じ操作の再送で履歴が増えない」を保証できない。代わりに **anchor**
＝「その操作が書き換えようとしている状態」を使う。

| 操作 | anchor |
|---|---|
| `grant` | `none`（取得履歴が無い状態からの初回付与）|
| `correct` | `claim:<いま取り消そうとしている取得日時>` |
| `reissue` | `prev:<訂正で失った取得日時>`（無ければ `src:<訂正前の取得元>`）|
| `revokeReservation` | `resv:<予約の OfferKey>`（無ければ `resvrec:<レコードID>`）|

- **成功する前の再送** → 状態が変わっていない → **同じ anchor＝同じ OperationId**
- **成功した後の再送** → その操作自体が拒否される（`already_claimed` 等）

⚠️ binding が `resolveOperationAnchor()` を持つ場合はそちらを優先する
（商品側にしか無い安定 ID を使いたいときの逃げ道）。

### 排他は **状態変更より前**に取る（本体 PATCH の race を閉じる）

⚠️ **履歴の直前で排他を取るだけでは足りない。** 同じ未取得会員へ `grant` が同時に 2 本来ると、
両方が未取得を read して **Customers PATCH まで成功**し、`Source` / `Actor` / `Reason` / `at` が
後勝ちで上書きされる。履歴が `OperationId` で 1 件になっても、
**Customers の最終監査値と履歴が食い違う**ので不可。

**実行順序（4 操作すべてに適用）**:

```
① 現状態を read（Customers + 予約台帳）
② 安定 OperationId を算出（現在時刻は材料にしない）
③ Redis SET NX で operation lock を取得   ← **状態変更より前**
④ 取得できた 1 本だけが authoritative state を**もう一度 read**（TOCTOU を閉じる）
⑤ server-side 条件を**再判定**（OperationId が変わっていたら stale として拒否）
⑥ 書く直前に lock を verify（奪われていたら書かない）→ Customers / 予約行を変更
⑦ 同じ OperationId で history append
⑧ 状態成功 / history 失敗なら `op=` から history-only repair
⑨ lock は token 一致時のみ release。crash 時は TTL で回復
```

- **lock を取れない要求は副作用ゼロで拒否**（`409 operation_in_progress`）
- **Redis unavailable でも書かない**（`503 lock_unavailable`・fail closed）
- 鍵は `ak:coupon-op:lock:<OperationId>`。OperationId は会員・商品・クーポン・操作・anchor から
  作られるので、**他会員・他商品・別操作は自動的に別の鍵**（互いに block しない）
- 鍵に載せるのは **OperationId だけ**（アドレス・氏名・理由は 1 文字も入れない）
- **token が一致しないと release しない**（他プロセスの鍵を消さない）
- 実装 `src/lib/coupons/couponOperationLock.js`。`SET NX` / `INCR` の fencing token /
  検証・解放の Lua は **`marketing/automationStore.js` の既存 primitive を再利用**する
  （新しい外部基盤を足さない）
- ⚠️ **状態成功後の履歴失敗で、状態を rollback しない**

### 同時実行（Airtable に unique 制約は無い）

「検索して無ければ create」だけでは、**同時に 2 本走ると両方が「無い」を読む**ため 2 行できる。
既存の primitive（`marketing/automationStore.js` の `SET NX` ＋ 墓標）と同じやり方で防ぐ。
**新しい外部基盤は増やさない**（`UPSTASH_REDIS_REST_*` は本番稼働中）。

```
① 既存行を OperationId で検索 → 有れば何もしない（収束済み）
② SET ak:coupon-history:mark:<opId> <token> NX EX 300 → 取れなければ何もしない
③ Airtable に 1 行 create
```

- ⚠️ **墓標には TTL を付ける**。②の後に落ちると行が無いまま鍵が残るので、
  TTL 切れのあとに repair が①で「行が無い」を見て積み直せるようにする
  （TTL 無しの永久墓標にすると、落ちた 1 回の履歴が永遠に欠ける）
- ⚠️ **Redis が使えないときは append しない**（fail closed）。
  状態変更は成功しているので、下の `op=` から後で repair できる

**保証の範囲（正直に書く）**: 単発の create では exact-once を保証できない。
上の①②③ ＋ 収束 repair により、**結果として 1 行に収束する（exact-once 相当）**。
Redis が落ちている最中は履歴が**遅れる**（欠落ではなく未記録として検出できる）。

### 部分成功（状態は成功・履歴だけ失敗）

**順序**: `authoritative なクーポン状態変更の成功` → **その後で**同じ `OperationId` で history append。

- 状態変更の監査文字列に **`op=<OperationId>`** を残す（`encodeCouponAudit`）
- `op` が履歴に無ければ「**状態変更は済み・履歴だけ未記録**」と分かる
  （`findHistoryRepairTargets()`）
- repair は **history-only**。`buildRepairRecord()` が**同じ OperationId・当時の実行者と時刻**で
  1 行を作り直すので、何度実行しても 1 件へ収束する
- ⚠️ **成功済みの顧客状態を、履歴の失敗だけで巻き戻さない**

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
