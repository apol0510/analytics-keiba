# AK 顧客販売・マーケティング管理

`/admin/premium-plus-eligibility/` を「Premium Plus 販売資格だけを見る画面」から
**顧客販売・マーケティング管理**へ拡張したときの仕様。

> **AK 独自機能。keiba-marketing-automation（KMA）とは統合しない。**
> KMA の schema / env / 顧客 / 送信ロジックを AK へ持ち込まない。同一 Airtable Base に
> `CampaignDeliveries_MarketingAutomation` が存在するが、これは **KMA 側のテーブル**であり
> AK は読みも書きもしない。AK は AK 自身の `CampaignDeliveries`（`EmailType='campaign'`）だけを使う。
> guard テストで固定済み（`adminMarketingFunction.guard.test.mjs`）。

## 1. 3 つの判定を混ぜない

AK には性質の違う判定が 3 つあり、**それぞれ別モジュール**で管理する。
1 つの関数に兼務させると「販売資格が無い＝連絡先も存在しない」のような事故になる
（2026-07-30 に Premium Plus 側で実際に起きた。`PREMIUM_PLUS_STAGED_RELEASE.md` 参照）。

| # | 判定 | 単一源 | 決めること |
|---|---|---|---|
| 1 | 公開 | `premiumPlus/premiumPlusRelease.js` | 顧客に Premium Plus を見せるか |
| 2 | Plus レビュー候補 | `premiumPlus/premiumPlusAdminAudience.js` | Plus 販売画面に名前を出すか |
| 3 | **マーケティング対象** | `marketing/customerMarketingAudience.js` | キャンペーンメールの母集団 |

**`premiumPlusAdminAudience` を万能顧客抽出ロジックへ膨らませないこと。**

## 2. 管理できるセグメント

`resolveCustomerMarketing()` が 1 顧客につき次を返す。判定は既存正本
`entitlements/resolveEntitlements.js` を再利用し、**再実装しない**。

### 契約状態（有料契約についての状態）

| 値 | 条件 |
|---|---|
| `active` | 有料 tier かつ 有効期限が先 / `PlanType=Lifetime` |
| `expiring_soon` | 有効期限まで **14 日以内**（`EXPIRING_SOON_DAYS`） |
| `expired` | 有効期限 < 現在 JST、または `Status=expired` / `unpaidrefunded` |
| `none` | Free（契約が無い） |
| `unknown` | **有料 tier なのに期限も Status も手掛かりが無い legacy**（推測しない） |

> `resolveEntitlements` は「期限が空＝期限なし＝有効」と解釈する（誤って弾かないため）。
> マーケティング画面はその曖昧さを `unknown` として**可視化するだけ**で、判定を書き換えない。
> `登録日` / `createdTime` は無料登録日、`有効期限` は加入日からの導出値であり、
> どちらも契約開始日の代用にしない。

### プラン区分（「何を買った人か」）

`premium_sanrenpuku`（`LifetimeSanrenpuku=true` または旧 tier を含む）/ `premium` / `light` / `free`

### マーケティング（送信可否・fail closed）

1 つでも該当したら送らない。理由は必ず件数表示する（黙って落とさない）。

`no_email` / `invalid_email` / `unsubscribed`（`UnsubscribedAnalyticsKeiba`）/
`blacklist`（`EmailBlacklist` の `HARD_BOUNCE` / `COMPLAINT`）/ `withdrawn` / `suspended` / `test_account`

### Premium Plus 資格・送信履歴

`pp:eligible|review|blocked|unset` / `history:never|sent|recent`（30 日以内）

## 3. 販売管理とマーケティング管理の分離

画面はタブで分ける。**API も別**（`premium-plus-eligibility` / `admin-marketing`）。

| | Premium Plus 販売 | 顧客マーケティング |
|---|---|---|
| 操作 | 段階公開で販売可 / 今すぐ販売可 / 保留 / 販売対象外 | 顧客選択 → キャンペーン → preview → dry-run → 送信 |
| 単位 | 詳細パネルで 1 顧客ずつ | 一覧の checkbox で複数選択 |
| 書き込み先 | Customers の Plus 専用フィールド | CampaignDeliveries / ScheduledEmails |
| 期限切れ会員 | **対象外**（自動復活させない） | **対象にできる** |

**期限切れ会員へメールを送っても、`Status` / `プラン` / `PlanType` / `有効期限` /
`LifetimeSanrenpuku` / `PaymentConfirmed` は一切変わらない。**
「無料◯日復活」のような実際の権限付与は別 Phase（本実装の対象外）。

## 4. キャンペーン定義

単一源 `marketing/campaignCatalog.js`。**件名・本文を Function や画面へ散らさない。**

| campaignId | 用途 | 対象条件（enforce） |
|---|---|---|
| `expired-comeback` | 期限切れ会員 カムバック | 契約=expired（強制） |
| `premium-renewal` | Premium 再契約 | 契約=expired/expiring_soon かつ Premium 系（強制） |
| `sanrenpuku-offer` | Premium Sanrenpuku 案内 | 契約=active/expiring_soon かつ Premium（強制） |
| `premium-plus-offer` | Premium Plus 案内 | プラン=三連複保有（強制） |
| `dormant-reactivation` | 長期休眠会員向け | 制限なし |
| `general-announcement` | 汎用 | 制限なし |

各定義は `campaignId` / `version` / `name` / `description` / `subject` / `body` /
`recommendedSegments` / `ctaUrl` / `ctaLabel` / `enabled` / `audienceRule` を持つ。

### version の意味（冪等性の鍵）

`version` を上げると DeliveryKey が変わり、**同じ人へもう一度送れる**ようになる。
逆に言えば version を変えない限り同じ相手には二度と送られない。
**本文を実質的に変更したら必ず version を上げること**（据え置くと直した内容が届かない）。

### 本文の決まり

- 差し込みは `{{name}}` のみ。未解決の差し込みが残る本文は**描画しない**（fail closed）
- 氏名に `{}` `<>` が含まれる場合は名前として採用せず「お客様」へ倒す
- **配信停止リンクを本文に書かない**。送信基盤が全通に配信停止リンクと
  `List-Unsubscribe` ヘッダを自動付与する（二重に出さない）
- CTA URL は `https://analytics.keiba.link/` のみ（`analytics.keiba.jp` / `*.netlify.app` は guard で禁止）

## 5. 送信の流れと安全設計

```
顧客一覧（セグメント絞り込み）
  → checkbox で複数選択
  → キャンペーン選択 → 本文プレビュー
  → dry-run（対象・除外理由・件数を確定 / 書き込みゼロ）
  → 最終確認ダイアログ（対象 N / 除外 M / 実送信 K）
  → 送信 = ScheduledEmails(PENDING) + CampaignDeliveries(queued) を作るだけ
  → execute-scheduled-emails-background が実送信（既存の送信基盤）
```

### この Function は自分でメールを送らない

`admin-marketing.js` は **SendGrid API を呼ぶコードを持たない**（guard テストで固定）。
送信キューを作るだけなので、この機能単体では 1 通も送れない。

### 三重ガード

| # | ガード | 既定 |
|---|---|---|
| 1 | 認可 `x-admin-secret`（`MARKETING_ADMIN_SECRET` 優先 / 無ければ `PREMIUM_PLUS_ADMIN_SECRET`） | secret 未設定なら機能ごと 503 |
| 2 | live enqueue `MARKETING_CAMPAIGN_ENABLED === 'true'` | **未設定 = 503・書き込みゼロ** |
| 3 | 実送信 `NEWSLETTER_AUTOMATION_ENABLED === 'true'`（既存の送信基盤側） | production は **false** |

### 二重送信を防ぐ 4 層

1. **DeliveryKey** = `sha256(brand|marketing|campaignId|fixed|admin-selected|email|v{version}|fromEmail|campaign:id:vN)`
   … `performUpsert(fieldsToMergeOn=['DeliveryKey'])` なので何度実行しても 1 行
   （**日付を含めない**。日付を入れると翌日に再送できてしまう。再送は version で表現する）
2. **既送信突合** … `CampaignDeliveries` の `sent` / `queued` を dry-run 時点で除外（`already_delivered`）
3. **planFingerprint** … dry-run が返す対象集合のハッシュ。send はこのトークン必須で、
   母集団が 1 人でも変わっていたら **409 で中止**（TOCTOU 防止）
4. **送信基盤側** … ジョブは `PENDING` で作られ、実送信は上記ガード 3 に依存

そのほか: 選択内の重複アドレス除外 / 1 回の上限 500 件 / 二重クリック防止 /
送信不可の顧客は UI 上でも選択できない。

## 6. 送信履歴

正本は `CampaignDeliveries`（`EmailType='campaign'`）。**Customers に履歴を書かない。**

- 顧客ごと: 最終送信日時 / 最終キャンペーン / 送信回数
- キャンペーンごと: `campaignId:vN` / 登録 / 処理済 / 失敗 / スキップ / 実行日時

> **provider 受理と実配信を混同しない。** `Status='sent'` は「送信基盤が処理した」であって
> 配信完了ではない。`delivered` / `bounce` は SendGrid Event Webhook から取る後続 Phase の題材で、
> 現時点では画面に出さない（`SENDGRID_WEBHOOK.md` 参照）。

## 7. 決済メール v2 と混ぜない

`PaymentEmailSent` / `PaymentEmailStatus` / `PaymentEmailIdempotencyKey` などの
決済メール状態機械のフィールドは**読みも書きもしない**（`MK_FORBIDDEN_CUSTOMER_FIELDS` で固定）。
マーケティングの冪等性は `CampaignDeliveries.DeliveryKey` が単独で担う。

## 8. 関連ファイル

| 目的 | ファイル |
|---|---|
| マーケティング対象判定（純粋） | `src/lib/marketing/customerMarketingAudience.js` |
| キャンペーン定義（単一源） | `src/lib/marketing/campaignCatalog.js` |
| 送信対象確定・冪等性（純粋） | `src/lib/marketing/campaignSend.js` |
| 管理 API（唯一の I/O） | `netlify/functions/admin-marketing.js` |
| 管理画面 | `src/pages/admin/premium-plus-eligibility.astro`（マーケティングタブ） |
| 既存の除外基盤（再利用） | `src/lib/newsletter/airtable-fetch.js` / `delivery-key.js` / `brand-config.js` |
| 実送信（既存・本 Function は呼ぶだけ） | `netlify/functions/execute-scheduled-emails-background.js` |

検証: `npm run test:marketing`（`check:safety` に組込済み）

## 9. 有効化に必要な承認（未実施）

実送信を有効にするには、次を**明示承認のうえ**順に行う。順序を守ること。

1. 本文・件名・CTA の最終確認（`campaignCatalog.js`）
2. `MARKETING_CAMPAIGN_ENABLED=true` を Netlify production へ設定（キュー登録の解禁）
3. 専用テスト受信者だけを選んで dry-run → 送信し、キューと台帳を目視確認
4. `NEWSLETTER_AUTOMATION_ENABLED=true`（**送信基盤の解禁。他のメール経路にも影響する**）
5. 小さいセグメントで実送信を検証してから本番運用へ

rollback: `MARKETING_CAMPAIGN_ENABLED` を unset すれば、コード変更なしにキュー登録が止まる
（既に PENDING のジョブは残るため、必要なら Airtable 上で Status を変更する）。
