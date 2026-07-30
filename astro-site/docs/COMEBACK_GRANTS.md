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

| フィールド | 型 | 用途 |
|---|---|---|
| `LightGrantLifetime` / `PremiumGrantLifetime` | Checkbox | 無期限の無料権利 |
| `LightGrantUntil` / `PremiumGrantUntil` | Date (ISO) | 期限付き無料権利の終了時刻（空 = なし） |
| `LightGrantedAt` / `PremiumGrantedAt` | Date (ISO) | 付与日時 |
| `LightGrantedBy` / `PremiumGrantedBy` | Text | 付与した管理者 |
| `LightGrantOp` / `PremiumGrantOp` | Text | **operationId（冪等性の鍵）** |
| `LightGrantRevokedAt` / `PremiumGrantRevokedAt` | Date (ISO) | 取り消し日時 |
| `LightGrantRevokeReason` / `PremiumGrantRevokeReason` | Text | 取り消し理由 |
| `ComebackGrantSource` | Text | 施策名（例 `comeback-2026-07`） |

台帳テーブルではなく Customers のカラムにした理由:

- 権限判定（`resolveEntitlements` / `memberResolution`）は **Customers 1 レコードの fields だけ**を
  入力にする純粋関数。別テーブルにするとログインのたびに追加照会＋新しい fail closed 判断が要る
- 各ティアの有効な権利は 1 つだけ。台帳の多行性が不要
- **Light と Premium が同じレコードなので 1 PATCH で同時に確定する**（§7 原子性）

### 期間の計算

`Until = 付与時刻 + N 日`（実時間）。`有効期限` の JST 暦日計算（`addOneYearJst`）とは
**別物**なので JST 丸めをしない。丸めると「23:50 に付与した人だけ 1 日短い」が生まれる。

### 取り消し

値を消し（`Lifetime=false` / `Until` を空に）、`RevokedAt` / `RevokeReason` を残す。
runtime を「値が無ければ権利が無い」という最も壊れにくい判定に保つため。
値が残ったまま `RevokedAt` の方が新しいレコードは **fail closed で権利なし**と解釈し、
`inconsistent` として管理画面に出す（自動修復はしない）。

### 強い方を採用する

弱い付与は既存の権利を縮めない（`already_granted` でスキップ）。
30日 → 無期限、30日 → 90日 のような**強化だけ**が書き込まれる。

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

### 未実装（次フェーズ）

**申込ページ `/offer/?t=<token>` と、そこから既存 bank flow への受け渡しは未実装。**
本 PR に含むのはモデル・トークン検証・発行までで、顧客向けページと
`bank-transfer-application` への `RequestedPlan` 引き渡しは別 PR。
（決済経路そのものを触るため、承認と本番検証を分けたい）

---

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
| 1 | Airtable Customers に §3 の 15 フィールドを作成 | 要 |
| 2 | Airtable に `PromotionalOffers` テーブルを作成（§5） | 要（割引を使う場合） |
| 3 | `COMEBACK_GRANT_FIELDS_READY=1` / `COMEBACK_OFFER_TABLE_READY=1` を production に設定 → redeploy | 要 |
| 4 | `PROMO_OFFER_SECRET`（32 文字以上のランダム）を production に設定 → redeploy | 要（割引を使う場合） |
| 5 | 管理画面で dry-run（この時点で実行ボタンは無効） | — |
| 6 | `COMEBACK_GRANT_ENABLED=true` を production に設定 → redeploy | 要 |
| 7 | **1 名（自分のテストアカウント）で付与 → ログイン確認 → 取り消し** | — |
| 8 | 本番対象へ実行 | 要 |
| 9 | 付与済みを確認してから案内キャンペーンを有効化して送信 | 要 |

⚠️ 順序を逆にしない。フィールド／テーブル未作成のまま PATCH すると Airtable は 422 / 404 を返し、
**同じ操作の他の書き込みも巻き添えで失敗する**（Premium Plus 導入時と同じ罠）。

⚠️ 割引オファーを実際に「買える」ようにするには §5 の未実装分（`/offer/` ページ）が必要。
それまでは offer を発行しても、管理者が手動で案内するしかない。

### rollback

- `netlify env:unset COMEBACK_GRANT_ENABLED --context production` → redeploy で実行を停止
  （既に付与した権利・発行済み offer は残る）
- 付与済みの取り消しは管理画面の「無料特典を取り消す」（promotional grant だけを消す）
- 発行済み offer の無効化は `buildOfferRevokeFields`（Status=revoked）

---

## 10. 関連ファイル

| 目的 | ファイル |
|---|---|
| **無料権利の単一源** | `src/lib/entitlements/promotionalGrants.js` |
| **特典カタログ（価格・期間）** | `src/lib/promotions/promotionOfferCatalog.js` |
| **割引オファー（台帳・トークン）** | `src/lib/promotions/promotionalOffer.js` |
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
- 特典付与とメール送信を 1 操作に結合しない
- `canPurchaseSanrenpuku` / Premium Plus の `premiumActive` に無料特典を混ぜない
  （`paidPremiumActive` を使う）
- **Premium 買い切り（`PlanType=Lifetime`）と三連複買い切り（`LifetimeSanrenpuku`）は別権利。**
  片方をもう片方に流用しない
- gate を「一時的に」外さない
