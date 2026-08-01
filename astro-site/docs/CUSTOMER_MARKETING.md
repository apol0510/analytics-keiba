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
`blacklist`（`EmailBlacklist` の `HARD_BOUNCE` / `COMPLAINT`）/ `suspended` / `test_account`

### ⚠️ 退会は「課金停止」であって「メール拒否」ではない（2026-07-30 業務定義）

**`Status='withdrawn'` / `WithdrawalRequested=true` は送信除外にしない。**
退会はクレジット継続課金を停止するための契約上の状態で、メール配信の拒否を意味しない。

根拠（`netlify/functions/process-withdrawal.js`）:

- 退会受付メールが会員本人へ「**メルマガは引き続き配信されます。配信停止をご希望の場合は
  こちらから配信停止手続きを行ってください**」と案内している
- 退会処理が書くのは `WithdrawalRequested` / `WithdrawalDate` / `WithdrawalReason` / `有効期限` のみで、
  **`UnsubscribedAnalyticsKeiba` を書かない**
- 処理内容も「Stripe 定期支払いの停止」「契約期間終了後は Free へ切替」＝課金・契約のみ

退会者をマーケティングから外すことは、AK 自身が本人へ伝えた内容と矛盾する。
**メールを止める意思表示は `UnsubscribedAnalyticsKeiba`（＋ provider suppression）が担う。**

- 退会は `withdrawn: true` フラグと `withdrawn:yes` セグメントとして**表示・絞り込みにだけ**使う
- 管理画面は契約欄に「退会」バッジを出し、送信列は「送信可能」と表示する
  （契約状態と送信可否が別概念だと分かる UI）
- `expired-comeback` の対象にもなる（会員権限・Premium・有効期限は**一切変更しない**）
- **`suspended` / `banned` は引き続き除外**（AK 側が意図的に止めた相手なので別扱い）

> 本番実測（2026-07-30 / read-only）: 旧判定で「除外: withdrawn」だった **37 名**が
> 全員「送信可能」になった（unsubscribe / blacklist / provider suppression の重複該当は 0 名）。

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

| campaignId | v | 状態 | 対象条件（すべて enforce） |
|---|---|---|---|
| `marketing-canary` | 1 | 🧪 **運用テスト専用** | `NEWSLETTER_TEST_RECIPIENTS` 一致者のみ |
| `expired-comeback` | 2 | ✅ 使用可能 | 契約=expired |
| `premium-renewal` | 2 | ✅ 使用可能 | 契約=expired/expiring_soon かつ Premium 系 |
| `sanrenpuku-offer` | 2 | ⛔ **使用停止** | 契約=active/expiring_soon かつ Premium |
| `premium-plus-offer` | 2 | ✅ 使用可能 | 三連複保有 **＋ 販売資格 eligible ＋ PHASE 3 以上** |
| `dormant-reactivation` | 2 | ✅ 使用可能 | 契約=none/expired（**課金継続中は除外**） |
| `general-announcement` | 1 | ⛔ **使用停止** | 制限なし |

各定義は `campaignId` / `version` / `name` / `description` / `subject` / `body` /
`recommendedSegments` / `ctaUrl` / `ctaLabel` / `enabled` / `audienceRule` /
（任意）`extraAudience` / `disabledReason` を持つ。

### 🧪 `marketing-canary` は運用テスト専用（一般顧客には送れない）

配信基盤（dry-run → enqueue → dispatch → 実送信）を安全に検証するための専用キャンペーン。
**顧客向けの案内ではない。**

- 対象は **env `NEWSLETTER_TEST_RECIPIENTS` に登録されたアドレスのみ**（これが正本）
- 一般顧客は管理画面で選択しても `campaign_mismatch` で除外される。
  **管理者が対象を手動で広げることはできない**
- **env 未設定なら誰にも送れない**（fail closed）。Customers 側に email が無い場合も除外
- email 比較は正規化（trim + lowercase）して行う
- 本文に商品案内・価格・契約誘導を入れない（guard テストで禁止）
- **テスト用だからといって guard をバイパスしない**。provider suppression / EmailBlacklist
  (hard・soft) / 配信停止 / 退会 / 停止 / test / 不正メール / 重複 / 24h 頻度ガード /
  DeliveryKey / planFingerprint / dispatch 直前再検証をすべて通常どおり適用する
- 既存キャンペーンの `audienceRule` は**一切緩めていない**（テスト都合で商品条件を変えない）

判定は `campaignAudienceRules.js` の `marketing_canary_recipient` に閉じ込める。
判定モジュールは純粋なので env を直接読まず、Function 層が
`newsletter/test-recipients.js` の `parseTestRecipientsEnv()` で正規化して `context` で渡す。
`customerMarketingAudience.js` にはテスト用ロジックを一切入れない（guard テストで固定）。

管理画面では選択肢・説明・確認画面の 3 箇所に 🧪「運用テスト専用」を表示する。

> 本番データ実測（2026-07-30 / read-only）: テスト受信者 1 名のみ選択 → **1/1/0**。
> 一般顧客 50 名を選択 → **willSend 0**。両方を同時選択 → **テスト受信者 1 名のみ**。
> env を空にすると **0 名**。

### 使用停止の理由（2026-07-30 レビュー）

- **`sanrenpuku-offer`**: 三連複を**説明・販売する公開ページが存在しない**。
  `/pricing/` の顧客可視領域に「三連複」の記載は 0 件（本番 HTML 実測）。実際の購入導線は
  `dashboard.astro` の「三連複を追加」ボタン → モーダル（`showPurchaseCta = canPurchaseSanrenpuku`
  でゲート・ログイン必須）。`/plan-upgrade-guide/` は旧プラン体系の説明で現行仕様と不一致。
  → **推測で URL を作らず** `ctaUrl: ''` のまま停止。案内先が決まったら設定して version を上げる。
- **`general-announcement`**: 本文が初期テンプレート（「お知らせがございます」のみ）。
  `isPlaceholderTemplate: true` で `isTemplateConfigured()` が検知し、dry-run 自体を拒否する。

停止中でも**本文プレビューは可能**（送信経路ではないため）。管理画面のセレクトでは選択不可になり、
理由がその場に表示される。

### version の意味（冪等性の鍵）

`version` を上げると DeliveryKey が変わり、**同じ人へもう一度送れる**ようになる。
逆に言えば version を変えない限り同じ相手には二度と送られない。
**本文を実質的に変更したら必ず version を上げること**（据え置くと直した内容が届かない）。

これを事故防止のため**テストで固定**している。`campaignCatalog.test.mjs` の
`【version ロック】` が `computeCampaignContentHash()`（subject / body / ctaLabel / ctaUrl の
SHA-256 先頭 16 桁）を既知値と突き合わせる。本文を変えるとテストが落ち、
**version を上げてロック表を更新するまで通らない**。

### 本文の決まり

- 差し込みは **`{{salutation}}` のみ**。これは**完成した宛名**で、テンプレート側で
  `{{salutation}} 様` のように敬称を後付けしてはいけない
  （氏名未登録の会員が大多数のため、後付けすると「お客様 様」の二重敬称になる）
  - 氏名あり → `山田 様` / 氏名なし → `お客様`
  - HTML・テキスト双方で検証済み（`buildSalutation()` が単一源）
- 未解決の差し込みが残る本文は**描画しない**（fail closed）
- 氏名に `{}` `<>` が含まれる場合は名前として採用せず「お客様」へ倒す
- **配信停止リンクを本文に書かない**。送信基盤が全通に配信停止リンクと
  `List-Unsubscribe` ヘッダを自動付与する（二重に出さない）
- CTA URL は `https://analytics.keiba.link/` のみ（`analytics.keiba.jp` / `*.netlify.app` は guard で禁止）

### キャンペーン固有の追加条件（`extraAudience`）

契約状態 × プランだけでは決められない条件は `campaignAudienceRules.js` に閉じ込める。
**`customerMarketingAudience.js` を Premium Plus 販売判定で汚さない。**

`premium_plus_release`（`premium-plus-offer` が使用）:
- CTA 先 `/premium-plus/` は段階公開の対象で、PHASE 3 未満・非 eligible では **404**
- そのため `PremiumPlusEligibility === 'eligible'` **かつ** `showProductPage === true`
  （PHASE 3 以上）の会員だけを対象にする
- 判定は既存正本 `resolvePremiumPlusRelease()` へ委譲し、**PHASE 計算を複製しない**
- PHASE 1/2・review・blocked・route none は `campaign_mismatch` として dry-run で除外
- 未知の `extraAudience` 値は**全員除外**（定義ミスで全員へ送らない）

> 本番データ実測（2026-07-30）: 三連複保有者 13 名のうち、この条件を満たすのは **2 名**。
> 追加条件が無ければ残り 11 名は 404 に着地していた。

## 5. 送信の流れと安全設計

```
顧客一覧（セグメント絞り込み・最終ログイン絞り込み）
  → 行の「カルテ」で 1 顧客の全状況を確認（read-only）
  → checkbox で複数選択
  → キャンペーン選択 → 本文プレビュー
  → dry-run（対象・除外理由・件数を確定 / 書き込みゼロ）
  → 最終確認ダイアログ（対象 N / 除外 M / 実送信 K）
  → 送信 = ScheduledEmails(PENDING) + CampaignDeliveries(queued) を作るだけ
  → 📮 実配信「配信内容を確認」→「実際に配信する」で marketing-campaign-dispatch を実行
```

**2026-08-01 まで、最後の実配信だけ画面にボタンが無く、運用者が API を叩く必要があった。**
「対象者とテンプレを選んで送る」ための画面なのに送信が完結しない状態だったため、
実配信も管理画面から行えるようにした（安全装置は下記のとおり据え置き）。

### 📮 実配信ボタン（2026-08-01 追加）

管理画面から `marketing-campaign-dispatch` を呼ぶ。**送信の実装は移していない**
（`admin-marketing` は引き続き 1 通も送れない）。画面側の安全装置:

- **2 段操作**。「配信内容を確認（送信しない）」＝ `dryRun:true` を先に必ず実行する。
  実配信ボタンは既定で `disabled`、**確認が成功し、かつ送信対象が 1 名以上のときだけ**開く
- 実行前に「送信したメールは取り消せません」と明示した確認ダイアログ
- 実行後は成功・失敗にかかわらずボタンを再び無効化する（**二重配信防止**。もう一度送るには再確認から）
- 結果に `sent` / `skipped` と**理由別の内訳**、provider suppression の照合可否を表示する

`MARKETING_CAMPAIGN_DISPATCH_ENABLED` が未設定なら dispatcher が 503 を返すので、
**ボタンがあっても env が閉じている限り実送信はされない**（ゲートは無効化していない）。

### 顧客カルテ（`action='customerDetail'` / 2026-08-01 追加）

一覧の行から 1 顧客の全状況を read-only で開く。判定は既存の単一源へ委譲し
（`memberResolution` / `resolveEntitlements` / `customerMarketingAudience` / `offerCampaignLink`）、
`customerDossier.js` は組み立てだけを行う。

| 区分 | 内容 |
|---|---|
| ① ログイン | ログイン可否・理由・ログイン方法・セッションのプラン・権限の根拠・**最終ログイン** |
| ② メール到達性 | 送信可否と除外理由 / provider suppression / ブラックリスト / ソフトバウンス / 配信停止 / 送信履歴 |
| ③ 特典・オファー | 無料特典の残期限 / 割引オファー（価格・期限・状態）/ Premium Plus 資格 |
| ④ 契約・決済 | プラン・期限・退会・三連複買い切り・入金・申込中 |
| ⑤ 閲覧できるもの | 無料 / Light / Premium / 三連複 |

- カルテは**更新系 action を一切呼ばない**（guard テストで固定）
- オファーの `OfferKey` / `TokenHash` は返さない（鍵素材を管理画面へ持ち出さない）
- provider suppression を確認できなかった場合は `false` ではなく **`null`（不明）** を返す

### ⏰ 最終ログインは 3 つの出所がある

最終ログインの記録は次の 3 つに割れている。
画面は**どの記録由来かを必ず併記**する（混同すると休眠判定を誤る）。

| # | 出所 | 対象 | 期間 | 画面表示 |
|---|---|---|---|---|
| 1 | **Customers `最終ログイン`（既存列）** | 全員 | 2026-08-01 以降 | ログイン記録 |
| 2 | `AuthTokens`（Used=true の最新） | 有料会員のみ | 2026-05-21 以降 | ログインリンク履歴 |
| 3 | `最終ポイント付与日` | 全員 | 〜2026-07-08（旧ログインポイント運用の副産物）| 旧ポイント履歴 |
| 4 | （どれも無い） | — | — | 記録なし |

**優先順位は「新しい順」ではなく「信頼できる順」**（1 → 2 → 3 → 4）。
**`最終ログイン` に値が入ったら、他の代替情報より必ず優先する。**

### 書き込み先は既存列 `最終ログイン`（新しい列を作らない）

Airtable Customers には **以前から `最終ログイン`（dateTime）列が存在**していた
（値は全 1,452 レコード空・コードからも未使用）。Airtable API は「値のあるフィールド」しか
返さないため実データ走査では見つからず、当初は `LastLoginAt` を新設する計画だった。
**同義の空列を 2 本並べないため、既存列をそのまま使う**（2026-08-01 確定）。
既存の命名規約（`氏名` / `有効期限` / `登録日` / `最終ポイント付与日`）とも揃う。

列名は `src/lib/auth/lastLoginRecord.js` の **`LAST_LOGIN_FIELD` が単一源**で、
書き込み側（Function）も表示側（カルテ）もこの定数を参照する（guard テストで固定）。

`auth-user`（**無料ログイン成功時**）と `verify-magic-link`（**有料マジックリンク検証成功時**）が
**best-effort で書く**。ログイン経路が Customers を書き換えない原則の**唯一の例外**で、
書けるのはこの 1 列だけ。

- 認証失敗・未登録・token 不正/期限切れ/使用済み・`denied`・`requiresMagicLink` では**書かない**
- 保存値は**サーバー時刻の ISO dateTime**（クライアント申告の時刻は使わない）
- 書き込み失敗（列が無い・権限・通信）は握りつぶし、**ログインを止めない**
- 連続ログインでの過剰更新を避けるため **6 時間以内は再書き込みしない**
- `最終ポイント付与日` は**読むだけ**（旧記録として表示に使う）。書き換えない

### 管理画面の Function は自分でメールを送らない

`admin-marketing.js` は **SendGrid の送信 API を呼ぶコードを持たない**（guard テストで固定）。
SendGrid へ触れるのは suppression の **GET のみ**。送信キューを作るだけなので、
この Function 単体では 1 通も送れない。

### 三重ガード

| # | ガード | 既定 |
|---|---|---|
| 1 | 認可 `x-admin-secret`（`MARKETING_ADMIN_SECRET` 優先 / 無ければ `PREMIUM_PLUS_ADMIN_SECRET`） | secret 未設定なら機能ごと 503 |
| 2 | live enqueue `MARKETING_CAMPAIGN_ENABLED === 'true'` | **未設定 = 503・書き込みゼロ** |
| 3 | 実送信 `MARKETING_CAMPAIGN_DISPATCH_ENABLED === 'true'`（マーケ専用） | **未設定 = 送信されない** |

### ⚠️ `NEWSLETTER_AUTOMATION_ENABLED` に依存させない（2026-07-30 監査で是正）

当初設計では実送信に `NEWSLETTER_AUTOMATION_ENABLED=true` が必要だった。しかしこれは
**AK の全メール自動化のマスタースイッチ**で、実測 16 Function が参照している
（`cron-email-scheduler` / `send-newsletter` 系 / `expiry-notification` /
`expiry-warning-notification` / `retry-failed-emails` / step メール系 ほか）。
マーケティングのために ON にすると、滞留 `ScheduledEmails` の一斉送信や期限通知・
メルマガの同時解禁を招く。

そこで **マーケティング専用ゲート `MARKETING_CAMPAIGN_DISPATCH_ENABLED`** を導入し、
2 方向の独立性を guard テストで固定した。

| 操作 | 既存メール経路 | キャンペーン |
|---|---|---|
| `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true` | **動かない** | 専用 dispatcher からのみ送信可 |
| `NEWSLETTER_AUTOMATION_ENABLED=true` のみ | 動く（従来どおり） | **送信されない** |
| **両方 `true`** | 動く | **共有 executor からは送信されない** |

- 専用 dispatcher `netlify/functions/marketing-campaign-dispatch.js` は
  `NEWSLETTER_AUTOMATION_ENABLED` を**読まない**
- マーケティングジョブの識別は既存フィールドのタグだけで行う（新フィールドを増やさない）:
  `CreatedBy='admin-marketing'` / `TargetPlan='campaign:<id>'` / `JobId='mkt-…'`

### 🔒 共有 executor は marketing job を **常に** 送らない（2026-07-30 恒久化）

当初は「専用ゲートが true なら共有 executor でも送れる」設計だったが、その場合
`NEWSLETTER_AUTOMATION_ENABLED=true` ＋ `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true` で
**15 分毎の `cron-email-scheduler`（Netlify scheduled `*/15 * * * *`）→ 共有 executor 経由**で
キャンペーンが飛ぶ。共有 executor は**固定宛先リストに対して per-recipient の送信直前再検証を
行わない**ため、配信停止・バウンス・退会・24h 頻度・キャンペーン固有条件の再判定を素通りする。

そこで **env に関係なく常に skip** する形へ変更した。

```js
export function canSharedExecutorSend(fields) {   // ← env を受け取らない
  if (!isMarketingJob(fields)) return { allowed: true, reason: null };
  return { allowed: false, reason: 'marketing_job_dedicated_dispatcher_only' };
}
```

- **引数に env を持たせない。** 持たせると「env 次第で共有 executor から送れる」条件を
  将来また作れてしまうため、構造的に不可能にしている（guard テストで
  `canSharedExecutorSend.length === 1` と関数本体の env 非参照を固定）
- 共有 executor 側も `canSharedExecutorSend(fields)` と呼ぶ（env を渡さない）
- スキップ時はレコードの状態を**一切変えない**（PENDING のまま残る）
- **マーケティング以外のジョブ（newsletter / step / race_main / expiry 等）の挙動は不変**

**マーケティングジョブの唯一の実送信経路は `marketing-campaign-dispatch`。**
この dispatcher だけが送信直前の per-recipient 再検証
（provider suppression / EmailBlacklist / 配信停止 / 退会 / 24h 頻度 / extraAudience /
campaign availability / Customers 存在）を行う。

### 🛡️ SendGrid suppression を毎回照合する（fail closed）

AK の `EmailBlacklist` は **Event Webhook が動き始めて以降のイベントしか持たない**。
過去分は SendGrid 側にしか無く、Webhook 同期では永久に埋まらない。

**2026-07-30 read-only 実測:**

| | 件数 |
|---|---|
| SendGrid suppression（bounces 58 / blocks 4） | **61** |
| AK `EmailBlacklist` 全行 | 12（HARD_BOUNCE 4 / SOFT_BOUNCE 8） |
| AK が実際に送信除外していた数 | **4** |
| AK 判定では送信可能なのに SendGrid が suppress 済み | **43 名**（＋ソフトバウンス 4 名） |

対策として `providerSuppression.js` が dry-run / send / dispatch のたびに
SendGrid の suppression を **GET で照合**する。

- 参照リスト: `bounces` / `blocks` / `spam_reports` / `invalid_emails` / `unsubscribes`
- **1 つでも取得に失敗したら送信計画を作らない**（`provider_suppression_unavailable` → 503）。
  「確認できないから送る」を構造的に禁止する
- provider へは **GET のみ**。suppression の追加・削除はしない
- 販促メールでは AK の **SOFT_BOUNCE も除外**する（取引メールとは基準を分ける）
- 5 分キャッシュ。失敗はキャッシュしない

### 🛡️ 送信直前の再検証

共有 executor は **固定宛先リスト（explicit）のジョブに対して suppression を再チェックしない**
（`Recipients.split(',')` するだけ）。キュー登録から実送信までの間に配信停止・バウンス・退会が
起きても、そのまま送られてしまう。

専用 dispatcher は 1 通ごとに `verifyBeforeSend()` で
**provider suppression / EmailBlacklist / 配信停止 / 退会**を再判定し、
該当したら送らずに `skipped-*` で台帳へ記録する。provider suppression を確認できない場合は
**1 通も送らない**。

### 🛡️ キャンペーン横断の頻度ガード（24 時間・hard safety floor）

DeliveryKey は**同一 campaignId × version の重複しか防がない**。`expired-comeback` と
`premium-renewal` のように対象が重なるキャンペーンを管理者が続けて実行すると、
同じ人へ同日に複数通が届く。これを構造的に防ぐ。

- 定数 `MARKETING_MIN_INTERVAL_MS = 24h`（`campaignSend.js` の 1 箇所のみ。**24 時間未満へ下げない**）
- 判定材料は **`CampaignDeliveries`（`EmailType='campaign'`）の最終送信日時だけ**。
  入金確認メール v2・問い合わせ・ステップメール等の**取引メールは含めない**
  （含めると必要な連絡が止まる）
- dry-run で `recent_marketing_contact` として理由付き除外
- send でも同じ関数で再計算（dry-run と件数がズレない）
- **dispatch 直前にも再検証**（`verifyBeforeSend`）。このとき**自ジョブの配信記録は除外**する
  （自分の `queued` を見て自分を止めてしまわないため）。該当は `skipped-frequency-cap` で台帳へ記録
- 履歴が読めない場合は**止めない**（ここを fail closed にすると履歴欠損で全員が永久に送れなくなる）。
  未来日時はデータ不正として止める

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

## 7-2. 受信者ごとの申込 URL を使うキャンペーン（`comeback-offer` / 2026-07-31）

カムバックの割引案内は、**その顧客だけが使える申込 URL**（`/offer/?t=<token>`）を
CTA に入れる必要がある。ここが崩れると「他人のオファーで買える」「誰も使えない URL を配る」
のどちらかが起きるため、結合条件を `src/lib/promotions/offerCampaignLink.js` に閉じ込めた。

### 送信できるのは「既に issued のオファーを持つ人」だけ

キャンペーン定義に `requiresOfferUrl: true` を付けると、その campaign は
**有効な割引オファーを持つ受信者にしか送られない**。

| 段階 | 何をするか |
|---|---|
| dry-run / send（計画） | 受信者ごとに台帳を突合。結び付かない人を**理由付きで除外** |
| キュー登録 | 本文の CTA は差し込み印 `{{offerUrl}}` のまま保存する |
| dispatch（送信直前） | 台帳を読み直して **URL を再生成**し、1 通ずつ差し替えて送る |

これにより **「オファー発行 → URL 確定 → 送信」の順序が構造的に守られる**。
オファー発行に失敗していれば `issued` の行が無く、そもそも対象にならない。

### URL は保存せず、送信直前に再生成する

`signOfferToken()` は `offerKey` と `email` と鍵だけの HMAC で、**乱数も時刻も含まない**。
したがって台帳の 1 行と `PROMO_OFFER_SECRET` があれば同じ URL を再現できる。

- 生トークンを `ScheduledEmails` にも `CampaignDeliveries` にも**保存しない**
- ログにも出さない（guard テストで固定）
- キュー登録後に `redeemed` / `revoked` / 期限切れになった人は、**送信直前の再判定で落ちる**

### 除外理由（すべて「送らない」に倒す）

| 理由 | 意味 |
|---|---|
| `offer_missing` | 有効な（issued・期限内）オファーが無い |
| `offer_ambiguous` | 有効なオファーが複数あり特定できない（**推測しない**） |
| `offer_mismatch` | 本文に書いた種別・価格と、その人のオファーが違う |
| `offer_secret_unavailable` | `PROMO_OFFER_SECRET` が無く URL を作れない |
| `offer_url_unresolved` | 送信直前に差し込みを解決できなかった（実装不整合） |

台帳そのものが読めない / 鍵が無い場合は、**計画自体を作らず 503**
（全員が `offer_missing` になって原因が件数に埋もれるのを防ぐ）。

### ⚠️ 汎用 URL へフォールバックしない

「URL が作れなければ `/pricing/` を案内する」は**やらない**。通常価格のページへ誘導すると
案内した割引価格と食い違う。guard テストが `/pricing/` `/login/` の混入を検知する。

### メール失敗でオファーを動かさない

送信経路（`admin-marketing` / `marketing-campaign-dispatch`）は
**`PromotionalOffers` へ 1 バイトも書かない**。`redeemed` になるのは
顧客が `/offer/` から申し込んだときだけ（`offer-application`）。
メールが失敗しても、オファーは `issued` のまま残り再送できる。

### 文面のルール（`comebackEmailTemplate.js`）

- **受信者の契約状態を断定しない**。「ご利用いただきありがとうございました」のような
  過去形は、三連複買い切り（`LifetimeSanrenpuku`）のように**今も有効な権利を持つ人**が
  読むと「自分の権利が終わった」と誤読される
- **「ご利用開始済み」「入金確認済み」を書かない**。権限が付くのは MK の入金確認の後
- 案内であることを明示する（「この時点ではお申し込みもお支払いも発生していません」）
- 個人名の署名を使わない（フッタは `KEIBA Analytics` のみ）
- `**強調**` のような記法を使わない。本文はプレーンテキストのまま HTML へ入るので
  **アスタリスクがそのまま顧客に見える**

### 運用手順（管理画面）

```
🎁 カムバック特典タブ
  → 対象顧客を選択 → 割引オファーを選ぶ → dry-run → 実行（オファー発行）
💌 顧客マーケティングタブ
  → 同じ顧客を選択 → campaign 'カムバック割引案内（専用URL）' → 文面プレビュー
  → dry-run（対象 / 除外理由 / オファー価格 / 有効期限 / CTA を確認）
  → 送信（ScheduledEmails + CampaignDeliveries を作るだけ）
  → marketing-campaign-dispatch を人が叩いて実送信
```

最終確認には **オファー種別 / 通常価格 / オファー価格 / 割引率 / 有効期限（最短） / CTA の種類 /
発行済みオファー件数** が出る。

## 8. 関連ファイル

| 目的 | ファイル |
|---|---|
| マーケティング対象判定（純粋） | `src/lib/marketing/customerMarketingAudience.js` |
| キャンペーン定義（単一源） | `src/lib/marketing/campaignCatalog.js` |
| キャンペーン固有の追加条件（純粋） | `src/lib/marketing/campaignAudienceRules.js` |
| 送信対象確定・冪等性・頻度ガード（純粋） | `src/lib/marketing/campaignSend.js` |
| 送信ゲート・送信直前再検証（純粋） | `src/lib/marketing/marketingDispatchGate.js` |
| SendGrid suppression 読み取り（GET のみ） | `src/lib/marketing/providerSuppression.js` |
| 管理 API（キュー登録まで） | `netlify/functions/admin-marketing.js` |
| **キャンペーン専用 dispatcher（実送信）** | `netlify/functions/marketing-campaign-dispatch.js` |
| 管理画面 | `src/pages/admin/premium-plus-eligibility.astro`（マーケティングタブ） |
| 既存の除外基盤（再利用） | `src/lib/newsletter/airtable-fetch.js` / `delivery-key.js` / `brand-config.js` |
| 共有 executor（マーケジョブは専用ゲート必須） | `netlify/functions/execute-scheduled-emails-background.js` |

検証: `npm run test:marketing`（`check:safety` に組込済み）

## 9. 有効化に必要な承認（未実施）

実送信を有効にするには、次を**明示承認のうえ**順に行う。順序を守ること。

1. 本文・件名・CTA の最終確認（`campaignCatalog.js`）
2. production deploy（PR のマージ）
3. `MARKETING_CAMPAIGN_ENABLED=true` を Netlify production へ設定（**キュー登録**の解禁）
4. 専用テスト受信者だけを選んで dry-run → 送信し、`ScheduledEmails` / `CampaignDeliveries` を目視確認
5. `marketing-campaign-dispatch` を `dryRun:true` で叩き、再検証結果を確認
6. `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true`（**実送信**の解禁）
7. `marketing-campaign-dispatch` を `dryRun:false` で実行

**`NEWSLETTER_AUTOMATION_ENABLED` は触らない。** マーケティングの有効化に不要で、
ON にすると既存メール経路まで解禁される。

rollback:
- `MARKETING_CAMPAIGN_DISPATCH_ENABLED` を unset → 実送信が止まる（キューは残る）
- `MARKETING_CAMPAIGN_ENABLED` を unset → キュー登録も止まる

いずれもコード変更不要。

## 10. 既知の残課題

- **AK `EmailBlacklist` と SendGrid suppression の恒常的な乖離**は解消していない。
  送信計画のたびに provider へ照会することで**誤送信は防いでいる**が、AK 台帳自体は古いまま。
  過去分を AK へ取り込む backfill は別タスク（本番 write を伴うため未実施）。
- **`unsubscribe` イベントの扱い**: `sendgrid-webhook.js` は `unsubscribe` を受けても
  `Status='SOFT_BOUNCE'` 相当で `EmailBlacklist` に書き、`UnsubscribedAnalyticsKeiba` は立てない。
  販促メールでは SOFT_BOUNCE も除外するため実害は無いが、
  意味的には配信停止として扱うべき（別タスク）。
  なお AK が送るメールの `List-Unsubscribe` は AK 自身の `unsubscribe` Function を指すため、
  ワンクリック配信停止は AK 側に正しく記録される。
- **provider 受理と実配信の区別**は現状のまま（`delivered` / `bounce` の反映は後続 Phase）。
