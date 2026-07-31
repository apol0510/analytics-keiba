# カムバック施策（無料特典 と 割引オファー）

以前 AK を離れた顧客へ、現在の AK をもう一度体験してもらうための**無料特典**と
**その顧客専用の割引価格**を管理画面から設定する機能。
`/admin/premium-plus-eligibility` の「🎁 カムバック特典」タブ。

> **状態: 未本番（2026-07-30）**
> Airtable のフィールド／テーブルは**未作成**、env gate は**未設定**、本番への付与・発行実績は**ゼロ**。
> 有効化には §9 の承認手順が必要。

---

## 1. 4 つの概念を混同しない

| | 何か | どこに書くか | この機能から |
|---|---|---|---|
| **A. entitlement** | 実際に何を閲覧できるか | （計算結果。保存しない） | `resolveEntitlements` が返す |
| **B. paid contract** | 通常購入による契約 | `プラン` / `PlanType` / `有効期限` / `Status` / `PaidAt` / `PaymentConfirmed` | **読むだけ（1 バイトも書かない）** |
| **C. promotional grant** | 無料で付与した閲覧権 | Customers の**特典専用カラム**（§3） | 書く |
| **D. promotional offer** | 割引価格などの**購入条件** | `PromotionalOffers` テーブル（§5） | 書く（**権利は与えない**） |

**D を作っても閲覧権は 1 ミリも増えない。** 支払い完了 → 既存の入金確認フロー
（`confirm-bank-payment`）が B を更新して初めて権利になる。
キャンペーン都合で `PaymentConfirmed` / `PaidAt` / `PaymentEmailSent` を偽装しない。

---

## 2. Light の位置づけ（重要）

**Light は「Premium 終了後に fallback する特典」ではない。**
メイン買い目のみ閲覧できる**独立した低位プラン**であり、カムバック施策では
**最初から無料開放するベース特典**として使う。Premium はその上に**追加で**乗る上位オファー。

runtime の合成規則はひとつだけ:

> **強い権利を優先する。特典は権利を増やすだけで、減らさない。**
>
> 実効ティア: `premium-sanrenpuku` > `premium` > `light` > `free`

Light 無料権利と Premium 無料権利は**同時に存在**する。Premium が終わると、
既にある Light 権利が再び最上位になるだけ ―― **期限到来時の書き込みは一切不要**（純粋な時刻比較）。

### 不変を維持するもの

- `LifetimeSanrenpuku`（三連複買い切り）— 無料特典の影響を受けない
- `canPurchaseSanrenpuku`（三連複の購入資格）— **有料** Premium だけ
- Premium Plus 販売資格 — `premiumPlusMember` は `ent.paidPremiumActive`（有料のみ）を見る

---

## 3. 無料権利のデータモデル（Customers のカラム 15 個）

**ティア × 期間**の汎用モデル。`light_lifetime` / `premium_trial_30d` のような
固定種別は持たない。ティア（light / premium）と期間（日数 or 無期限）の組み合わせだけで
Light 永久無料 / Light 30日無料 / Premium 30日無料 / Premium 365日無料 /
Premium 買い切り相当（無期限）まで全部表現する。

| フィールド | Airtable 型 | クリア値 | 用途 |
|---|---|---|---|
| `LightGrantLifetime` / `PremiumGrantLifetime` | Checkbox | `false` | 無期限の無料権利 |
| `LightGrantUntil` / `PremiumGrantUntil` | **Date（時刻あり）** | **`null`** | 期限付き無料権利の終了時刻（無ければ権利なし） |
| `LightGrantedAt` / `PremiumGrantedAt` | **Date（時刻あり）** | （常に値を書く） | 付与日時 |
| `LightGrantedBy` / `PremiumGrantedBy` | Single line text | `''` | 付与した管理者 |
| `LightGrantOp` / `PremiumGrantOp` | Single line text | `''` | **operationId（冪等性の鍵）** |
| `LightGrantRevokedAt` / `PremiumGrantRevokedAt` | **Date（時刻あり）** | **`null`** | 取り消し日時 |
| `LightGrantRevokeReason` / `PremiumGrantRevokeReason` | Long text | `''` | 取り消し理由 |
| `ComebackGrantSource` | Single line text | `''` | 施策名（例 `comeback-2026-07`） |

#### ⚠️ 日時フィールドは dateTime 型・クリアは `null`（テキスト型で作らない）

`*GrantUntil` / `*GrantRevokedAt` / `*GrantedAt` の 6 つは **Airtable の Date 型（時刻を含む）**で作る。
期限フィルタ・並べ替え・管理画面表示・将来の集計をフィールド型として正しく保つため、
文字列型で代用しない。

そのぶん**クリアは必ず `null`** で行う。空文字 `''` は日付として解釈できず 422 になり得て、
**同じ PATCH に含まれる他のフィールドまで巻き添えで失敗する**（Light と Premium は
1 PATCH で同時に書くので、片方の空文字が両方を落とす）。

- 書き込み側は `promotionalGrants.js` の `buildGrantFields()` / `buildRevokeFields()` に閉じており、
  この 4 つ（`*GrantUntil` / `*GrantRevokedAt`）へは `null` しか書かない
- 読み取り側 `toMs()` は `null` / `undefined` / `''` / ISO 文字列 / `Date` / 数値をすべて解釈する
  （旧データに `''` が残っていても壊れない）
- **テキスト列は従来どおり `''` でクリアする。null 化を課金フィールドや既存列へ波及させない**
- 検証: `promotionalGrants.test.mjs`（フィールド単位）/ `comebackGrantPlan.test.mjs`
  （PATCH payload に日時の空文字が 1 つも無いこと）

台帳テーブルではなく Customers のカラムにした理由:

- 権限判定（`resolveEntitlements` / `memberResolution`）は **Customers 1 レコードの fields だけ**を
  入力にする純粋関数。別テーブルにするとログインのたびに追加照会＋新しい fail closed 判断が要る
- 各ティアの有効な権利は 1 つだけ。台帳の多行性が不要
- **Light と Premium が同じレコードなので 1 PATCH で同時に確定する**（§7 原子性）

### 期間の計算

`Until = 付与時刻 + N 日`（実時間）。`有効期限` の JST 暦日計算（`addOneYearJst`）とは
**別物**なので JST 丸めをしない。丸めると「23:50 に付与した人だけ 1 日短い」が生まれる。

### 取り消し

値を消し（`Lifetime=false` / `Until` を **`null`** に）、`RevokedAt` / `RevokeReason` を残す。
runtime を「値が無ければ権利が無い」という最も壊れにくい判定に保つため。
値が残ったまま `RevokedAt` の方が新しいレコードは **fail closed で権利なし**と解釈し、
`inconsistent` として管理画面に出す（自動修復はしない）。

### 強い方を採用する

弱い付与は既存の権利を縮めない（`already_granted` でスキップ）。
30日 → 無期限、30日 → 90日 のような**強化だけ**が書き込まれる。

---

## 3-2. `memberType='paid'` は「支払済み」ではない（横断監査 2026-07-30）

無料特典を持つ顧客は `resolveMembership()` が `memberType: 'paid'` を返す。
これは **「有料階層のセッションを発行してよいか」だけを表す認可ラベル**であって、
支払い実績ではない。repository 全体を grep して consumer を確認した結果は以下。

| # | consumer | 用途 | 課金判定か |
|---|---|---|---|
| 1 | `authPolicies.decideFreeLogin` | paid → マジックリンク必須（即時 Free ログインしない） | ✗ 認証経路 |
| 2 | `authPolicies.shouldSendMagicLink` | paid のみログインリンク送信 | ✗ 認証経路 |
| 3 | `sessionIssuance.issuePaidSessionCookie` | paid のみ Cookie 発行 | ✗ 認可 |
| 4 | `sessionRefresh` | paid のみセッション更新 | ✗ 認可 |
| 5 | `verifyMagicLinkFlow` | paid のみ検証成功 | ✗ 認可 |
| 6 | `auth-user` / `login.astro` | `'free'` 分岐の表示 | ✗ 表示 |

**課金判定に使っている consumer は 1 つも無い。** Cookie payload にも入らない
（`sub` / `plan` / `venueAccess` / `sessionVersion` / `v` / 時刻のみ。テストで固定）。

課金実績が前提の判定は、いずれも**別の値**を見ている:

| 判定 | 参照している値 | 無料特典で開くか |
|---|---|---|
| Premium Plus 販売資格（ROUTE B） | `ent.paidPremiumActive` | **開かない** |
| 三連複購入資格 | `ent.canPurchaseSanrenpuku`（有料 Premium のみ） | **開かない** |
| マーケの契約区分 `contract` | `プラン` / `有効期限` / `Status` / `PlanType`（Airtable の課金列） | **変わらない** |
| マーケの `premiumActive` / `lightActive` | `ent.paidPremiumActive` / `paidLightActive` | **立たない**（特典は `promoPremiumActive` / `promoLightActive` で別軸） |
| 契約更新・期限通知・入金確認・PayPal | Airtable の課金列を直接読む（entitlement を読まない） | **無関係** |

将来 consumer を増やすときのために、`resolveMembership()` は根拠を
**`entitlementSource`**（`paid_contract` / `promotional_grant` / `none`）で返す。
**課金実績が要るなら `memberType` ではなくこちらを見ること。**
この値は Cookie に載らず、既存のセッション契約（payload の形）は変えていない。

差分は `promotionalGrantSeparation.test.mjs` が 1 つの表として固定する
（promo Light / promo Premium / paid Premium / LifetimeSanrenpuku / 退会 / 停止 ×
権限・Plus 販売資格・三連複購入資格・マーケ区分・Cookie payload）。

### 価格資格（`/pricing/` の会員向け価格）も grant では付かない

**grant は price eligibility を付与しない。**

| 何 | 由来 |
|---|---|
| 閲覧できる範囲 | effective entitlement（`resolveEntitlements` / 無料特典で上がる） |
| **会員向け通常特価**（Light 会員の乗り換え価格 ¥44,820 等） | **paid contract のみ**（`pricingEligibility.js`） |
| その顧客だけの特別価格 | **PromotionalOffer**（`PromotionalOffers` テーブル → `/offer/?t=…`） |

無料 Light 特典の顧客へ特別価格を出したい場合は、**PromotionalOffer で明示的に発行する**。
「Light が見られるようになったから Light 会員価格も使える」は作らない。

- 判定の単一源は `src/lib/pricing/pricingEligibility.js` の `resolvePaidPricingTier()`。
  `canViewLight` / `canViewPremium`（無料特典で true になる）ではなく
  **`paidLightActive` / `paidPremiumActive`** だけを見る
- ログイン応答（`verify-magic-link` の `userPlan`）に**サーバーが算出した `pricingTier`** を載せ、
  `/pricing/` はそれを最優先で使う。クライアントに「閲覧できる＝会員価格が使える」と
  推測させない（`entitlementSource='promotional_grant'` のときは出し分け自体を行わない）
- **実際の請求額に効く経路**（`bank-transfer-application`）では、会員限定価格
  （`... - Campaign`）の申込に対して Airtable の課金契約を**サーバー側で再判定**する。
  資格が確認できない場合も**申込は拒否せず**（振込済みの人を締め出さないため）、
  管理者メールに警告を出して `PaymentConfirmed` の前に判断できるようにする。
  この経路は Airtable を 1 バイトも書かず、金額も書き換えない
- 検証: `npm run test:pricing-tiers`（`pricingEligibility.test.mjs` を含む）

### ログイン後にクライアントの古い期限フラグを消す（`/auth/verify`）

`AccessControl` は localStorage の `isExpired` / `validUntil` を見て**プランを Free に落とす**。
カムバックの主対象は**期限切れ顧客**なので、この値が残っていると
「サーバーはセッションを発行したのに画面は Free のまま」になり特典が機能しない。
`src/pages/auth/verify.astro` は、サーバーがセッションを発行した直後に
`isExpired` / `originalPlan` / `validUntil` / `expiryDate` を削除する。
権限の真実源は Cookie（`ak_session`）であり、過去に書かれた非権威フラグでそれを上書きさせない。

---

## 4. 特典カタログ（`src/lib/promotions/promotionOfferCatalog.js`）

「30日無料」をハードコードしない。各 offer は
`kind` / `targetTier` / `term` / `duration` / `isLifetime` / `regularPrice` /
`offerPrice` / `discountType` / `discountValue` / `isFree` / `version` / `enabled` を**データ**として持つ。

| offerId | 種類 | 内容 |
|---|---|---|
| `light-lifetime-free` | 無料 | Light 永久無料（**ベース特典**） |
| `light-30d-free` / `light-90d-free` | 無料 | Light 30 / 90 日無料 |
| `light-custom-free` | 無料 | Light 任意日数 無料 |
| `premium-30d-free` | 無料 | Premium 30 日無料 |
| `premium-custom-days-free` | 無料 | Premium 任意日数 無料 |
| `premium-annual-free` | 無料 | Premium 365 日無料 |
| `premium-lifetime-free` | 無料 | Premium 無期限無料（買い切り相当） |
| `premium-30d-half` | 割引 | ¥18,000 → ¥9,000 |
| `premium-annual-half` | 割引 | ¥49,800 → ¥24,900 |
| `premium-annual-custom` | 割引 | 年額 任意価格 |
| `premium-lifetime-half` | 割引 | ¥78,000 → ¥39,000 |
| `premium-lifetime-custom` | 割引 | 買い切り 任意価格 |

### 通常価格の正本

表示の正本は `/pricing/`。カタログの `REGULAR_PRICE` はその写しで、
`promotionOfferCatalog.test.mjs` が **pricing.astro の `openBankModal(...)` 実引数と突き合わせ**、
ズレたら落ちる。

| | 通常価格 | PlanType |
|---|---|---|
| Light | ¥4,980 / 30日 | Monthly |
| Premium 30日 | ¥18,000 | Monthly |
| Premium 年額 | ¥49,800 | Annual |
| Premium 買い切り | ¥78,000 | **Lifetime** |

### 任意入力の検証（安全性優先）

- 任意日数: 1〜3650 の整数のみ
- 任意価格: 整数・¥1,000 以上・**通常価格未満**（値上げと 0 円を通さない）
- 割引 offer は必ず `offerPrice > 0`（無料にしたいなら無料 offer を使う）

---

## 5. 割引オファー（`PromotionalOffers` テーブル）

grant と違い、offer は同じ顧客へ時期違いで複数発行しうる。runtime の権限判定は
offer を**読まない**（購入時にだけ読む）ので、専用テーブルへ 1 行ずつ積む。

| フィールド | 用途 |
|---|---|
| `OfferKey` | 一意キー（**merge key**。冪等 upsert） |
| `CustomerRecordId` / `Email` | 対象顧客 |
| `OfferId` / `OfferVersion` | カタログの offer |
| `TargetTier` / `BillingTerm` / `PlanName` / `PlanType` | 何を買えるか（既存 bank flow の語彙） |
| `RegularPrice` / `OfferPrice` / `DiscountType` / `DiscountValue` | 価格条件 |
| `StartsAt` / `ExpiresAt` | 有効期間（既定 14 日） |
| `Status` | `issued` → `redeemed` / `expired` / `revoked`（**一方向**） |
| `OperationId` / `Source` | どの操作・施策で発行したか |
| `TokenHash` / `RedeemedAt` / `Notes` | 監査 |

### URL を知っている第三者が使えない設計

トークン = `<offerKey>.<HMAC-SHA256(PROMO_OFFER_SECRET, offerKey + ':' + email)>`

- 保存するのは**ハッシュだけ**。生トークンは**発行応答（管理画面）と案内メールにしか存在しない**
- 検証（`verifyOfferToken`）は署名一致 **かつ** 申込フォームの email 一致 **かつ**
  `Status=issued` **かつ** 期限内 のときだけ通る
- トークンを転送されても、他人の email では `email_mismatch` で落ちる

### 二重課金・二重昇格の防止

- `OfferKey` は (operationId, offerId, version, recordId) から決まる → 再実行しても 1 行のまま
- 利用は `issued → redeemed` の**一方向遷移**。`redeemed` / `revoked` / `expired` は再利用不可
- 昇格自体は既存フローの冪等性（承認時に `Requested*` をクリア）で守られている

---

## 5-2. 申込ページ `/offer/?t=<token>`（2026-07-30 実装）

割引オファーを受け取った顧客が、**通常価格ではなくオファー価格で**銀行振込の申込を出す経路。
昇格そのものは触らない（`PaymentConfirmed` → `confirm-bank-payment` が唯一の経路）。

| 経路 | 役割 |
|---|---|
| `src/pages/offer/index.astro` | 静的シェル（`noindex` / robots `Disallow: /offer/`）。表示内容は API から取得 |
| `netlify/functions/offer-lookup.js` | token → **表示してよい値だけ**返す（read-only。Customers を読まない） |
| `netlify/functions/offer-application.js` | 申込を Customers の `Requested*` に退避 → offer を `redeemed` に → 通知メール |
| `src/lib/promotions/offerIntake.js` | 判定の単一源（純粋）。プラン・請求額を offer から決める |
| `src/lib/promotions/offerIntakeEmail.js` | 通知メールの文面（純粋・送信しない） |

### 🔒 フォームの申告値でプラン・請求額を決めない（この phase の核）

既存 `/pricing/` 経路は `productName` / `transferAmount` をフォームから受け取り、
そこから planName / planType を導いている（同じ画面の JS が入れる値なので実害は無い）。
**offer 経路は割引価格を扱うので、同じ作りにすると DevTools で
「¥1,000 で Premium 買い切り」を自己申告できてしまう。**

| Airtable | 出所 |
|---|---|
| `RequestedPlan` | offer 台帳の `PlanName` を `'Premium'` へ正規化した値（allowlist は `Premium` のみ） |
| `RequestedPlanType` | offer 台帳の `PlanType`（空なら `BillingTerm` から復元） |
| `RequestedAmount` | offer 台帳の **`OfferPrice`**（請求すべき金額） |
| 申告された振込金額 | **Airtable に書かない**。管理者メールに載せるだけ |

金額差異（申告 ≠ オファー価格）は**拒否せず警告**にする。既に振り込んだ人を締め出さないため。
差異があれば管理者メールの**件名**に「金額差異あり」が付き、本文で通帳確認を促す。

### 認証を置かない（意図的）

案内対象には**退会済みでログインできない顧客が含まれる**。`AccessControl` を置くと
いちばん申し込んでほしい相手が入れない。本人性は URL の HMAC トークン +
「申込 email が offer の email と一致するか」のサーバー検証で担保する。

### 書き込み順序（途中で失敗したときに一番マシな状態で止める）

1. offer 台帳を read → `verifyOfferToken`（`claimedEmail` 付き）
2. **Customers に `buildApplicationFields()` の戻り値を PATCH**（唯一の必須書き込み。失敗＝申込不成立で 502）
3. offer を `redeemed` に更新（失敗しても申込は成立。二重申込は同じ `Requested*` の上書きになるだけ）
4. 管理者メール → 申込者メール（失敗してもロールバックしない。Airtable が正本）

対象 Customers レコードが見つからないときは**推測で新規作成しない**（409 + サポート案内）。
offer は既存顧客にのみ発行されるため、見つからない = レコード削除等の異常。

### 申込者メールに書かないこと

「ご利用開始いただけます」「アクセスを開放しました」等、**権限が付いたと誤解させる表現は禁止**
（権限は MK の入金確認まで付かない）。guard テストで固定している。

### 検証

`npm run test:promotions` に以下が入る（`check:safety` / CI 経由で実行）:

- `offerIntake.test.mjs` — 申告金額を書き換えても請求額が offer 価格のままであること 他 22 本
- `offerIntakeEmail.test.mjs` — 金額差異の警告 / 誤解表現の禁止 / HTML エスケープ
- `offerIntakeFunction.guard.test.mjs` — Function 実装を grep して固定（lookup は read-only /
  Customers への PATCH は単一源の戻り値のみ / 権限フィールド名がコードに現れない /
  gate / 生トークンをログに出さない / ページの noindex・非ログイン）

---

## 5-3. 発行済みオファーの取り消し（誤発行の救済 / 2026-07-31 実装）

管理画面「🎁 カムバック特典」タブ下部の **「発行済み割引オファー」**から、
誤って発行したオファーを 1 件ずつ `Status=revoked` にする。

> **以前は本番経路が無かった。** `buildOfferRevokeFields()` は実装済みだったが
> **テストからしか呼ばれておらず**、admin の `revoke` / `revokeDryRun` は
> **無料特典（grant）専用**だった。そのため誤発行を消すには Airtable を手で触るか
> 使い捨てスクリプトを書くしかなく、allowlist 検証も操作記録も通らなかった。

### revoke は「権利の変更」ではない

割引オファーは §1 の **D（購入条件）**であって閲覧権ではない。したがって取り消しても:

- **Customers は 1 バイトも書かない**（`customersWritten: 0` を応答で返す）。
  `Status` / `プラン` / `PlanType` / `有効期限` / `PaymentConfirmed` / `PaidAt` /
  `PaymentEmailSent` / `Requested*` / `LifetimeSanrenpuku` / promo grant /
  `UpsellTarget` / `PremiumPlusEligibility` はすべて不変
- **閲覧権も課金契約も動かない**（顧客から見て「特別価格の案内が使えなくなる」だけ）
- **メールは送らない**（`emailSent: false`）。取り消しの通知は必要なら別途手動で

### 操作は 3 段（いきなり書き込まない）

| # | action | 何をするか |
|---|---|---|
| 1 | `offerList` | 台帳を一覧。**PII / 生トークン / `TokenHash` は返さない** |
| 2 | `offerRevokeDryRun` | 対象 1 件の内容と可否を確定し `offerFingerprint` を返す（**書き込みなし**） |
| 3 | `offerRevoke` | `offerFingerprint` 一致時のみ `Status` / `Notes` を書く |

画面に出すのは オファー種別 / 対象ティア / 期間 / 通常価格 / オファー価格 / 状態 / 有効期限。
**顧客のメールアドレス・氏名・トークンは表示しない**（誤発行の取り消しに PII は要らない）。

### 取り消せる条件（すべて満たすときだけ）

- レコードが存在する
- **実効状態が `issued`**（`Status` 列だけでなく **`ExpiresAt` と現在時刻でも判定**する。
  期限切れは台帳に書き戻されないため、`Status='issued'` のまま期限切れの行が普通に存在する）
- `OperationId` / `CustomerRecordId` / `OfferKey` が dry-run 時と一致する
- `offerFingerprint` が一致する（**不一致は 409 で 1 バイトも書かない**）

**取り消せない**（fail closed・理由を必ず返す）: `redeemed` / `expired` / `revoked` /
レコード不存在 / `OperationId` 不一致 / `CustomerRecordId` 不一致 / `OfferKey` 不一致 /
有効期限が読めない。**二重 revoke は行わない**。
UI 側でも `issued` 以外には**取り消しボタンを出さない**。

### 取り消し後

- **専用 URL（トークン）は再利用できない。** `verifyOfferToken` が
  `not_issued:revoked` で落ち、`/offer/?t=…` は `state='revoked'` を返して
  **オファー内容（価格）を一切返さない**。当然**申込もできない**
- 台帳の行は**消さない**。`Status=revoked` ＋ `Notes` に取り消し時刻と理由を残し、
  監査証跡とする（削除は別の高リスク操作。この機能からは行わない）
- 同じ `operationId` で再発行すると `OfferKey` upsert により**同じ行が `issued` に戻る**。
  意図せず復活させたくない場合は**新しい operationId で発行する**

### gate

`COMEBACK_OFFER_TABLE_READY`（台帳の存在）のみ。**`COMEBACK_GRANT_ENABLED` は要求しない。**
取り消しは「配ってしまった購入条件を消す」**減算方向の安全操作**であり、発行を緊急停止した
直後こそ実行したい。発行の kill switch で取り消しまで止めると、誤発行が消せないまま残る。

### 検証

`npm run test:promotions` … `offerRevokePlan.test.mjs`（14 本・状態遷移と fail closed）/
`offerRevokeFunction.guard.test.mjs`（10 本・Function 実装を grep で固定）。
`npm run test:comeback` … `adminComebackUi.guard.test.mjs` に UI 契約 6 本を追加。
いずれも**違反を注入して落ちることを確認済み**（空振りしていない）。

## 6. 対象外の判定（dry-run で必ず件数を出す）

| 理由 | 無料付与 | 割引オファー |
|---|---|---|
| `data_incomplete`（メール未登録/不正） | ✗ | ✗ |
| `account_suspended`（停止・banned・テスト） | ✗ | ✗ |
| `withdrawal_blocked`（退会・強制ログアウト） | **✗** | **✓ 発行できる** |
| `already_granted` / `already_applied` | ✗ | ✗ |
| `paid_stronger`（有料契約が優先） | ✗ | — |
| `already_offered`（有効な同一 offer あり） | — | ✗ |
| `grant_inconsistent`（特典データ不整合） | ✗ | ✗ |

### 退会者の扱い（前バージョンからの変更）

退会（`WithdrawalRequested=true`）は `memberResolution` の拒否ゲートに該当し**ログインできない**。
そのため**無料付与はしない**（付けても使えず、案内が破られる）。

一方、**割引オファーは発行できる**。支払い完了時に既存の入金確認フローが
退会フラグをリセットして昇格させるため、退会者が戻ってくる正規の導線として成立する。

退会フラグ・`ForceLogout` はこの機能から**絶対に書き換えない**（`PROMO_FORBIDDEN_FIELDS`）。

---

## 7. 原子性・冪等性・復旧

### 顧客単位では原子的

Light と Premium の無料権利は**同じ Customers レコードの別フィールド**。
**1 顧客 = 1 PATCH** で両方が同時に確定し、「片方だけ付いた」状態は**構造上作れない**。

### grant と offer の間は原子的でない（別テーブル）

**grant → offer の順**で実行し、どちらも同じ `operationId` を持つ。

- grant が落ちたら **offer は発行しない**（`sideEffects: 'none'` / `'partial'` を返す）
- grant 成功・offer 失敗 → 同じ operationId で再実行すれば **offer だけ**が対象になる
- offer は `OfferKey` upsert なので重複行にならない

つまり「途中で落ちても、同じ operationId でやり直せば必ず収束する」。
`action='reconcile'` で適用状況（grant / offer）を read-only で突合できる。

### TOCTOU 防止

`apply` は dry-run が返した `planFingerprint` が必須。対象集合・選んだ特典・
**価格**のいずれかが変わっていれば **409 で全体停止**（1 バイトも書かない）。

---

## 8. メールとの分離（厳守）

- Function は SendGrid / ScheduledEmails / CampaignDeliveries に**一切触れない**（guard テストで固定）
- `action='preview'` は**文面を返すだけ**（送信しない）
- 「付与 → 自動メール」は禁止。付与・発行の完了後に管理者がマーケティングタブから送る
- 付与前に案内メールを送らない（使えない特典・買えない価格を約束することになる）
- メール失敗を理由に成功済みの grant / offer を巻き戻さない

### 文面は offer から生成する

`src/lib/promotions/comebackEmailTemplate.js` が選んだ特典から件名・本文を作る。
金額・期間を手書きしないため、書き間違いが起こらない。

**表現のルール**（テストで固定）:
- ✅「その後も継続的に改善を重ね、現在の KEIBA Analytics を改めてお試しいただきたい」
- ❌ 自社否定（「以前は未完成」「序章」等）／的中率・回収率の数値／煽り／配信停止リンク

`campaignCatalog.js` の `comeback-offer`（v1・**enabled=false**）は、既定の組み合わせ
（Light 永久無料 ＋ Premium 30日無料）で生成した版。

---

## 9. 本番化に必要な手順（順序厳守）

| # | 手順 | 承認 |
|---|---|---|
| 1 | Airtable Customers に §3 の 15 フィールドを作成（**日時 6 つは Date 型・時刻あり**） | 要 |
| 2 | Airtable に `PromotionalOffers` テーブルを作成（§5） | 要（割引を使う場合） |
| 3 | `COMEBACK_GRANT_FIELDS_READY=1` / `COMEBACK_OFFER_TABLE_READY=1` を production に設定 → redeploy | 要 |
| 4 | `PROMO_OFFER_SECRET`（32 文字以上のランダム）を production に設定 → redeploy | 要（割引を使う場合） |
| 5 | 管理画面で dry-run（この時点で実行ボタンは無効） | — |
| 6 | `COMEBACK_GRANT_ENABLED=true` を production に設定 → redeploy | 要 |
| 7 | **1 名（自分のテストアカウント）で付与 → ログイン確認 → 取り消し**（下の確認項目を参照） | — |
| 8 | 本番対象へ実行 | 要 |
| 9 | 付与済みを確認してから案内キャンペーンを有効化して送信 | 要 |

⚠️ 順序を逆にしない。フィールド／テーブル未作成のまま PATCH すると Airtable は 422 / 404 を返し、
**同じ操作の他の書き込みも巻き添えで失敗する**（Premium Plus 導入時と同じ罠）。

**手順 7 で必ず見ること**（1 名のテストアカウントで）:

1. 付与 PATCH が **422 にならない**（日時 6 列が Date 型で作られており、`null` クリアが通る）
2. `LightGrantUntil` が **空**（無期限付与のとき）、`PremiumGrantUntil` に**日時が入る**（期限付き）
3. 対象レコードの `プラン` / `有効期限` / `Status` / `PaidAt` / `PaymentConfirmed` /
   `LifetimeSanrenpuku` / `PremiumPlus*` が **1 バイトも変わっていない**
4. その顧客でログイン → **特典のティアで閲覧できる**（期限切れ表示のままにならない）
5. 三連複購入 CTA / Premium Plus が**開いていない**（無料特典で販売動線を配らない）
6. 取り消し → 権利が消え、`RevokedAt` に日時が入り、課金列は変わらない

⚠️ 割引オファーの申込ページ（`/offer/?t=<token>`・§5-2）は **手順 3 / 4 の
`COMEBACK_OFFER_TABLE_READY` と `PROMO_OFFER_SECRET` が揃うまで 503 で閉じている**。
どちらか欠けた状態では、正しいトークンでもページに内容が出ず申込もできない（fail closed）。

⚠️ 割引を使う場合の追加検証（手順 7 と同じタイミングで）:
自分のテストアカウントへ割引 offer を 1 件発行 → 発行応答の URL を開く →
金額・期限・伏せ字メールが出ることを確認 → 申込送信 → Airtable で
`RequestedPlan=Premium` / `RequestedPlanType` / `RequestedAmount=オファー価格` /
`Status` が active に**なっていない**ことを確認 → offer が `redeemed` になったことを確認 →
最後に `PaymentConfirmed` を押して昇格 1 回だけ起きることを確認。

### rollback

- `netlify env:unset COMEBACK_GRANT_ENABLED --context production` → redeploy で実行を停止
  （既に付与した権利・発行済み offer は残る）
- 付与済みの取り消しは管理画面の「無料特典を取り消す」（promotional grant だけを消す）
- 発行済み offer の無効化は**管理画面の「発行済み割引オファー」から取り消す**（§5-3）

---

## 9-2. E-5（実顧客への初回配信）の判断資料 — 2026-07-31 実測

E-5 ＝ §9 手順 8・9 に相当する「**実顧客へ割引オファーを発行し、案内メールを送る**」段階。
**この節は実行前の判断資料**であり、記載の実行手順は**MK の承認を得てから**着手する。
下記の数値は 2026-07-31 17:48 JST に**本番データを read-only で取得**したもの
（Customers / `PromotionalOffers` / `CampaignDeliveries` / `EmailBlacklist` の GET と
SendGrid suppression の GET のみ。書き込み・送信はゼロ）。

### 母集団（本番実測 / 全 1,446 名）

| 契約状態 | 人数 | プラン区分 | 人数 |
|---|---|---|---|
| `none`（Free） | 1,356 | free | 1,356 |
| **`expired`** | **70** | premium | 53 |
| `active` | 18 | premium_sanrenpuku | 21 |
| `expiring_soon` | 2 | light | 16 |

### 第一候補 `contract=expired`（70 名）の内訳

| 項目 | 件数 |
|---|---|
| expired 総数 | **70** |
| うち `WithdrawalRequested=true`（退会＝課金停止） | 31 |
| うち 非退会 | 39 |
| marketing sendable | **70**（suppression 0 件） |
| unsubscribed / blacklist / suspended / test / メール不正・未登録 | **すべて 0** |
| SendGrid `provider_suppressed` | **0**（全体では 62 件・うち 44 件は Free 層） |
| soft bounce | 0 |
| 頻度ガード `recent_marketing_contact`（24h） | 0 |
| `already_delivered`（comeback-offer:v2） | 0 |
| 有効な issued offer 保有 | 0 |
| redeemed / revoked offer 履歴 | 0 / 0 |
| promotional grant（無料特典）保有 | 0 |
| `LifetimeSanrenpuku=true` | **0** |
| 三連複を閲覧できる状態（`canViewSanrenpuku`） | 0 |
| Premium Plus `eligible` | 0 |
| `RequestedPlan` / `RequestedPlanType` / `RequestedAmount` あり | 0 |
| `PaymentConfirmed=true` | 0 |
| 有効な有料契約（`paidPremiumActive` / `paidLightActive`） | 0 / 0 |
| `checkOfferable` = true | **70**（block 0） |
| **最終 candidate** | **70** |

プラン区分の内訳: premium 42 / premium_sanrenpuku 18 / light 10。
期限切れからの経過日数: 0–30日 6 / 31–90日 11 / 91–180日 20 / 181–365日 33（1年超 0）。
氏名は **70 名すべてに登録あり**（`{{salutation}}` が「お客様」に落ちない）。

> ⚠️ プラン欄が `Premium Sanrenpuku` の 18 名も **`LifetimeSanrenpuku` フラグは false** で、
> 現時点で三連複を閲覧できる者は 0 名。したがって本配信で
> 「買い切り三連複の権利を失効させたと誤読される」リスクは**構造的に発生しない**
> （フラグ保有者 1 名は `active` で candidate に含まれない）。

### セグメント比較（なぜ expired なのか）

| | セグメント | 人数 | 判定 |
|---|---|---|---|
| A | expired 全体 | 70 | ○ |
| B | expired かつ sendable（退会者含む） | 70 | ○（A と同一） |
| C | expired から契約・offer・申込途中・権利競合を除いた安全 subset | **70** | **○（A・B と完全一致）** |
| D | contract `none`（Free 1,356） | — | **対象外**。有料契約の実績が無く「カムバック」ではない。suppression 52 件・provider 44 件が混ざり、初回配信のバウンス率を無意味に上げる |
| E | plan `light`（16） | — | 対象外。うち 6 名は **有効な Light 契約**。期限切れ分は既に A に含まれる |
| F | plan `premium`（53） | — | 対象外。うち 11 名は**有効な Premium 契約**。有効契約者へ年額半額を送ると既存契約の値引き要求・二重契約になる |
| G | plan `premium_sanrenpuku`（21） | — | 対象外。3 名は有効契約・3 名は Premium Plus eligible。期限切れ分は A に含まれる |

**A / B / C が完全一致したため、除外ロジックの選択は結果に影響しない。**
「メール送信可能」と「この商品を売って安全」の 2 判定を別々に評価しても、
今回はどちらも同じ 70 名になる。

### offer 発行 dry-run（本番 `admin-comeback-grants` / 書き込み 0）

- `action:'dryRun'` / `premiumOfferId:'premium-annual-half'` / recordIds 70 件
- 結果: **selected 70 / willOffer 70 / willGrant 0 / skipped 0 / `sideEffects:'none'`**
- `partSkips` 空（duplicate / ambiguous / already_offered / contract conflict / Requested* conflict /
  PaymentConfirmed conflict / pricing mismatch すべて 0）
- preview 全件で **`before` == `after`**（＝閲覧権は 1 ミリも増えない。仕様どおり）
- gate: `fieldsReady` / `offerTableReady` / `writeEnabled` / `offerTokenReady` すべて true
- **Customers write 0 / `PromotionalOffers` write 0 / grant 0 / メール 0**
- `operationId` と `planFingerprint` は**実行直前に取り直す**（時間が経つと 409 で止まる設計）

### campaign 想定 dry-run

- **本番 `admin-marketing` の実 dry-run（offer 未発行の現状）**: selected 70 / **excluded 70
  （全件 `offer_missing`）/ willSend 0**。`sendEnabled=false` / `dispatchEnabled=false`。
  SendGrid suppression 取得は成功（62 件）＝ fail closed が空振りしていない。**これは正常**
  （オファー発行 → URL 確定 → 送信の順序が構造的に守られている証拠）
- **オファー発行後を想定したローカル再現**（本番の `buildCampaignPlan` に、発行済みと同じ形の
  台帳行を合成して投入）: **willSend 70 / excluded 0**（suppression・頻度・重複・
  contract・offer conflict すべて 0）
- 配信キューは 1 ジョブ（`RECIPIENTS_PER_JOB=100`）、上限 `MAX_RECIPIENTS_PER_SEND=500`

### 案内メール（本番コードから取得・`comeback-offer` v2）

件名: `【KEIBA Analytics】Premium プランの特別価格のご案内`
CTA: `特別価格の詳細を見る` → **受信者ごとの `/offer/?t=…`**（本文中は `{{offerUrl}}`、
`marketing-campaign-dispatch` が 1 通ずつ差し替える）

確認済み: ¥49,800 → ¥24,900（年額・50%OFF）/ `/pricing/` `/login/` へのフォールバック無し /
個人名署名なし / `**` 記法なし / 「申込済み」「支払済み」「利用開始済み」と誤認させる表現なし /
「ご利用開始は、お振込の確認が取れた後に」明記 / 三連複を含む既存権利を否定する記述なし。

### 推奨（1 案）

**`contract=expired` の 70 名へ `premium-annual-half`（¥49,800 → ¥24,900 / 年額）を、
管理画面の絞り込みを使った 2 波で配信する。**

| Wave | 対象（管理画面の絞り込み） | 人数 | タイミング |
|---|---|---|---|
| 1 | `contract=expired` × `退会=いいえ` | 39 | 承認後すぐ |
| 2 | `contract=expired` × `退会=はい` | 31 | Wave 1 の delivered / bounce / complaint を確認した翌日以降 |

- 70 名は 1 回で送れる規模だが、**初回の実顧客配信**であり、バウンス率・苦情率を
  一度確認してから残りへ広げる。波の切り方を「退会の有無」にすると
  **管理画面のフィルタだけで再現でき、手作業で行を選ばない**（誤選択事故を構造的に防ぐ）
- 3 波以上に刻む価値は無い（母数 70・除外 0）。売上機会を無意味に遅らせない
- 各 Wave で「offer 発行 dry-run → apply → campaign dry-run → 送信」を**その Wave 分だけ**行う
  （オファーの有効期限は発行から 14 日なので、送らない分を先に発行しない）

### E-5 で実際に発生する production write

| 対象 | 内容 | 備考 |
|---|---|---|
| `PromotionalOffers` | Wave ごとに N 行 upsert（`OfferKey` 一意） | 権利は増えない。生トークンは apply 応答にのみ現れる |
| `ScheduledEmails` | Wave ごとに 1 ジョブ（PENDING） | `CreatedBy='admin-marketing'` |
| `CampaignDeliveries` | Wave ごとに N 行（`queued` → `sent`） | 冪等キー `DeliveryKey` |
| Netlify env | `MARKETING_CAMPAIGN_ENABLED` → `MARKETING_CAMPAIGN_DISPATCH_ENABLED` の順に `true` | **変更のたびに Build Hook で redeploy**。終了後に**両方 unset して再閉鎖** |
| **Customers** | **write 0** | 申込が来た時に `offer-application` が `Requested*` を書くのは**顧客の行動由来**であり、この配信の副作用ではない |

`NEWSLETTER_AUTOMATION_ENABLED` は **触らない**（現在 `false`）。マーケティング送信は
専用ゲート（`marketingDispatchGate.js`）で完全に独立しており、既存メール経路を解禁しない。

### rollback（E-5）

| 事象 | 対処 |
|---|---|
| 送信前に中止 | env を unset（`MARKETING_CAMPAIGN_DISPATCH_ENABLED` → `MARKETING_CAMPAIGN_ENABLED`）→ redeploy。キュー済みジョブは送信されない |
| 誤発行した offer | 管理画面「発行済み割引オファー」から 1 件ずつ取り消し（§5-3）。Customers は不変 |
| 発行そのものを緊急停止 | `COMEBACK_GRANT_ENABLED` を unset → redeploy（**取り消しは引き続き可能**） |
| **送信済みメール** | **取り消せない**（唯一の不可逆。だから Wave 1 を先に確認する） |

### 未解決（送信前に判断が要る 1 点）

**案内メールに申込期限が書かれていない。** オファーの有効期限は発行から
`DEFAULT_OFFER_TTL_DAYS = 14` 日で、期限後に `/offer/?t=…` は内容を返さない（fail closed）。
本文へ期限行を入れるには `campaignCatalog` の version を 3 へ上げ、LOCKED ハッシュを更新して
**deploy が必要**になる。今回は次のいずれかを選ぶ:

1. **（推奨）v2 のまま送り、期限切れ後に申込希望が来た相手には個別に再発行する**
   （dry-run → apply を 1 名分。数分の作業で、送信前の追加 deploy が要らない）
2. 本文に期限を明記する（version 3 + ハッシュ更新 + deploy を E-5 の前段に足す）

管理画面からの発行は TTL 14 日固定（UI は `offerTtlDays` を送らない）。
延ばす場合は Function を直接呼ぶ必要がある（`MAX_OFFER_TTL_DAYS=90`）。

---

## 10. 関連ファイル

| 目的 | ファイル |
|---|---|
| **無料権利の単一源** | `src/lib/entitlements/promotionalGrants.js` |
| **特典カタログ（価格・期間）** | `src/lib/promotions/promotionOfferCatalog.js` |
| **割引オファー（台帳・トークン）** | `src/lib/promotions/promotionalOffer.js` |
| **オファー取り消しの判定（単一源）** | `src/lib/promotions/offerRevokePlan.js` |
| **申込の判定（プラン・請求額）** | `src/lib/promotions/offerIntake.js` |
| 申込通知メールの文面 | `src/lib/promotions/offerIntakeEmail.js` |
| 申込ページ | `src/pages/offer/index.astro` |
| 申込 API（read / write） | `netlify/functions/offer-lookup.js` / `offer-application.js` |
| 案内文面の生成 | `src/lib/promotions/comebackEmailTemplate.js` |
| 権限合成（閲覧） | `src/lib/entitlements/resolveEntitlements.js` |
| 権限合成（ログイン） | `src/lib/auth/memberResolution.js` |
| 実行計画（dry-run・冪等・fingerprint） | `src/lib/comeback/comebackGrantPlan.js` |
| 一覧・絞り込み | `src/lib/comeback/comebackAudience.js` |
| 管理 API | `netlify/functions/admin-comeback-grants.js` |
| 管理画面（タブ3） | `src/pages/admin/premium-plus-eligibility.astro` |
| 案内メール（下書き） | `src/lib/marketing/campaignCatalog.js` の `comeback-offer` |

検証: `npm run test:comeback` / `npm run test:promotions` / `npm run test:entitlements`
（すべて `check:safety` と CI に組込済み）

---

## 11. 触ってはいけないこと

- allowlist（`PROMO_WRITABLE_FIELDS` / `OFFER_WRITABLE_FIELDS`）を広げない
- 退会フラグ・`ForceLogout` を特典付与の副作用で書き換えない
- 割引 offer の発行で `プラン` / `PaymentConfirmed` / `有効期限` を書かない
- **offer の取り消しで Customers を読み書きしない**（`offerRevoke` は台帳の 1 行だけ）。
  grant の取り消し（`revoke` / `tiers`）と経路を混ぜない
- **offer 取り消しの Status / Notes を Function 内で組み立てない**。必ず
  `offerRevokePlan.js` → `buildOfferRevokeFields()` を経由する
- 取り消し済み offer のレコードを削除しない（監査証跡として残す）
- **`/offer/` の申込でプラン・請求額をフォーム入力から決めない**（offer 台帳が唯一の出所）。
  `offer-application.js` の Customers PATCH は `buildApplicationFields()` の戻り値のみ
- `/offer/` に `AccessControl` を置かない（退会者が申し込めなくなる）
- 特典付与とメール送信を 1 操作に結合しない
- `canPurchaseSanrenpuku` / Premium Plus の `premiumActive` に無料特典を混ぜない
  （`paidPremiumActive` を使う）
- **Premium 買い切り（`PlanType=Lifetime`）と三連複買い切り（`LifetimeSanrenpuku`）は別権利。**
  片方をもう片方に流用しない
- gate を「一時的に」外さない
