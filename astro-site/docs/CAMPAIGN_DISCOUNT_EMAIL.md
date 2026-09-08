# キャンペーン割引のメール配信（全会員向け）

サイト側で動いている **全会員向けキャンペーン割引**（`docs/decisions.md` 2026-08-24）を、
ご登録いただいている方へ**メールでご案内する**ための定義と手順。

- 文面の単一源: `astro-site/src/lib/marketing/campaignDiscountSteps.js`
- 定義: `campaignCatalog.js` の `campaign-discount-free` / `-light` / `-premium`
- 検証: `campaignDiscountEmail.test.mjs`（`npm run test:marketing` に含まれる）

⚠️ **新しい配信基盤は作っていない。** 既存の campaign / sequence / dispatcher に
定義を 1 つ足しただけで、送信経路・冪等性・配信停止・計測はすべて従来どおり。

---

## 1. 誰に何を送るか（3 区分）

案内する割引は契約によって違う（**持っているものは勧めない**）ため、宛先を 3 つに分ける。
出し分けの正本は `campaignOffers.resolveCampaignOfferIdsFor()` で、
**メールの区分はその出力と 1 対 1**（テストで固定。ズレたら落ちる）。

| campaignId | 宛先 | audienceRule | 案内する割引 | 通数 |
|---|---|---|---|---|
| `campaign-discount-free` | 有料の閲覧権が無い方（無料 / 期限切れ）| contract: none, expired × plan: free, light, premium | Light 月額 / Premium 年額 / Premium 買い切り | 3 |
| `campaign-discount-light` | Light 有効 | contract: active, expiring_soon × plan: light | Premium 年額 / 買い切り | 2 |
| `campaign-discount-premium` | Premium 有効・三連複なし | contract: active, expiring_soon × plan: premium | 三連複 買い切り | 2 |

- **三連複をお持ちの方には送らない**（最上位で売るものが無い）。
  `plans` に `premium_sanrenpuku` を入れないことで**構造的に**外れる
- **契約状態を確定できない方（`unknown`）にも送らない**（fail closed）
- 3 区分は排他。**1 人が 2 通の別内容を受け取ることはない**（テストで固定）
- `enforce: true`。条件に合わない受信者は dry-run 時点で除外され、理由が件数で出る

## 2. 金額・期限は 1 文字も手で書かない

メールに出る金額は `promotionOfferCatalog.js` から、期限は
`campaignOffers.describeCampaignDeadline()` から**生成**する。
文面ファイルに `¥` や日付を書くとテストが落ちる。

- 価格を直す → メールの文面も自動で変わる → **`contentHash` が変わる**
  → `campaignCatalog.test.mjs` の LOCKED が落ちる
  → **version を上げてから** LOCKED を更新する（＝別の案内として配り直す）
- 期限表示は画面と同じ文字列（**`CAMPAIGN_WINDOW` から自動生成**。第 2 期は `2026年9月23日まで`）

## 3. 期間外は自動的に送れなくなる（fail closed）

`enabled` は毎回 `isCampaignActive()` を評価する。開催期間
（`CAMPAIGN_WINDOW`: **第 2 期 2026-09-10 00:00 〜 2026-09-24 00:00 JST**）の外では

- `getCampaign()` が `null` を返す → **dry-run も enqueue も送信もできない**
- 管理画面の一覧には「キャンペーン期間外のため利用不可」と理由付きで残る

期間外に送ると「案内は届くが 1 円も割り引かれない」（申込側も fail closed）ため、
**片方だけ動く状態を作らない**のがこの設計の目的。

⚠️ 停止中キャンペーンの**本数**をテストで固定しないこと（期間が終わった日に CI が落ちる）。

## 4. 行き先は `/dashboard/` だけ

⚠️ **未ログインの方には割引価格が表示されない。** キャンペーン価格は
`localStorage` の契約（＝ログイン済み）を見て出しており、未ログインでは
通常価格と「無料登録で◯◯円OFF」が出る（`public/js/campaign-price.js`）。
**ご登録済みの方にその文言を見せないため、入口はログインに固定**している。

- ログイン後 `/dashboard/` のお知らせに、割引後の価格と申込ボタンが出る
- **三連複には公開の販売ページが無い**。購入導線はマイページの
  「三連複を追加」モーダルだけ（`/premium-sanrenpuku/` は保有者専用 → 302）。
  **推測で URL を作らない**（2026-08-24 に本番で踏んだ）

> 📌 **未解決の論点**: 母集団の大半は取り込みコホートで**一度もログインしていない**。
> 「メール → ログイン → 申込」の 2 段になる。ログイン無しで割引価格を見せるには
> 受信者ごとの識別が要るが、**未登録の方に割引価格を見せると「画面の額 < 請求額」**に
> なり、`shownPriceMatchesCharge.test.mjs` が守っている不変条件を壊す。
> 変えるなら MK 判断（本 MD には現状の仕様だけを書く）。

## 5. 送信手順

**Step1（初回）は自動で撃たない。** 母集団が最大になるため、管理画面から明示的に開始する。
Step2 以降は `cron-campaign-sequence` が **1 日 1 回・1 ステップだけ**進める。

### 5-1. 事前確認（read-only・env 変更なし）

1. `/admin/premium-plus-eligibility/` の連続配信パネルでキャンペーンを選ぶ
2. 各ステップの「文面を見る（実際に届く HTML）」で 3 区分すべてを目視
3. `dryRun` で対象人数・除外人数・除外理由・`planFingerprint` を確認

### 5-2. 実配信（**毎回 MK の明示承認**）

| gate | 用途 |
|---|---|
| `MARKETING_CAMPAIGN_ENABLED=true` | live enqueue |
| `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true` | 実送信 |
| `MARKETING_SEQUENCE_SCHEDULER_ENABLED=true` | Step2 以降の自動進行 |
| `MARKETING_SEQUENCE_ARMED=<当日の JST 日付>` | 当日武装（翌日には自動で閉じる）|
| `MARKETING_SEQUENCE_CAMPAIGN_ID=<campaignId>` | 自動進行の対象（**1 本だけ**）|

- env の反映には **redeploy が要る**（Build Hook を curl。CLI deploy は 401 regression のため使わない）
- enqueue は 500 件 × N バッチ、ジョブは 100 件単位。**約 120 通/分**（15,000 名で約 2 時間）
- **速度のために並列化しない**（`alreadySent` は呼び出し開始時点のスナップショット。
  同一ジョブへの並行 dispatch は二重送信を作る）
- 送信後は gate を **UNSET + redeploy** して再閉鎖する

### 5-3. 自動進行は 1 本ずつ

`cron-campaign-sequence` は `MARKETING_SEQUENCE_CAMPAIGN_ID` の**1 キャンペーンだけ**を進める。
3 区分すべてを自動で回すことはできないので、

- 母集団が最大の `campaign-discount-free` を自動進行に割り当てる
- `-light` / `-premium` は人数が少ないので、**Step2 を管理画面から明示 enqueue** する

## 6. 触ってはいけないこと

- **送信元 `noreply@keiba.link` を変えない**（`from` は DeliveryKey の構成要素。
  変えると既送分と鍵が変わり**二重送信**になる）
- version を据え置いたまま文面を変えない（既送信者へ修正版が二度と届かない）
- `enabled` を固定値 `true` に戻さない（期間外の空振り案内を防いでいる）
- 停止中キャンペーンの本数をテストで固定しない

---

## 8. 第 2 期（再募集 / 2026-09-10 〜 09-23）

### 経緯

第 1 期（2026-08-24 〜 09-06）は **step1 を 3 区分あわせて 15,509 通**配ったところで、
連続配信の不具合（[`CAMPAIGN_SEQUENCE.md`](./CAMPAIGN_SEQUENCE.md) §11）により
**step2 以降が 1 通も出ないまま期間が終了**した。不具合は修正・本番反映済み（PR #499）なので、
**同じ割引条件で期間を取り直す**。

| 項目 | 第 1 期 | **第 2 期** |
|---|---|---|
| 開始 | 2026-08-24 00:00 JST | **2026-09-10 00:00 JST** |
| 終了 | 2026-09-07 00:00 JST | **2026-09-24 00:00 JST**（14 日間）|
| メール記載の期限 | 2026年9月6日まで | **2026年9月23日まで** |
| 割引条件 | Light 月額 500円OFF / Premium 年額 5,000円OFF / Premium 買い切り 10,000円OFF | **同一**（`campaignOffers.js` 不変）|
| version | 1 | **1 のまま**（下記）|

### 配信計画（step1 は送り直さない）

| step | 対象 | 送信日（目安）| 内容 |
|---|---|---|---|
| step1 | — | **送らない** | 第 1 期に配信済み（15,509 通）|
| **step2** | step1 受領者 | **開始日 = 09-10**（期日は 08-30 に到来済みのため、再開後の最初の tick で送られる）| 「割引を再度ご用意しました（Light と Premium の違い）」|
| **step3** | step2 受領者 | **step2 の 6 日後 = 09-16** | 「割引のご案内は 2026年9月23日までです」|

step3 から期限まで **7 日**の余白がある（届いてから検討できる）。

### version を上げない理由（**重要**）

`DeliveryKey = campaignId × version × step × 受信者` で、**本文ハッシュを含まない**
（`campaignSend.computeCampaignDeliveryKey`）。version を上げると既に配った step1 が
「未送信」に戻り、**全員へ再送**される。よって第 2 期は **version 1 のまま**運用する。

- step2 / step3 の文面変更は **(B) 未送信 Step の修正**（誰にも届いていないので許可）
- **step1 の文章は 1 文字も変えない。** それでも `contentHash` が動くのは、
  件名・本文へ `DISCOUNT_DEADLINE`（＝ `CAMPAIGN_WINDOW` 由来）が差し込まれるため。
  期間を取り直せば step1 のハッシュは必ず動く（＝ `delivered` に登録できない）

### 文面の方針（第 2 期）

期限だけ差し替えると「前に見た期限と違う」とだけ映るので、step2 / step3 は
**一度締め切ったこと**と**改めて期間を設けたこと**を先に書く。
日付・金額は**書かない**（期間と offer カタログから導出される）。

### 固定しているテスト

`src/lib/promotions/campaignRelaunchWindow.test.mjs`

- **メールに書く期限＝購入画面で割引が乗る最後の JST 暦日**（完全一致）
- 期限当日は `resolveCampaignPricing` が `applied: true`、翌 0:00 は `outside_window`
- 文面の定義に日付・金額を直書きしていない / `**`（Markdown 強調）を残していない
- 割引 3 本とも `sequenceWindowFit` を満たす（最終 step まで期間内に配り切れる）
- step2 から再開しても step3 が期間内に収まり、期限まで 2 日以上の余白がある
- **version を上げていない**（上げると step1 が全員へ再送される）
- step1 の文章が第 1 期のまま／step2 が再募集であることを説明している

⚠️ 期間を変えるときは `CAMPAIGN_WINDOW` **1 か所だけ**を直す。メール・画面・申込の
どこにも日付を書き写さない（書き写した瞬間に「案内した額と請求額が違う」事故に戻る）。
