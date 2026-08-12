# 連続配信（キャンペーンシーケンス）

1 通で終わらせず、**キャンペーンごとに規定回数まで、内容を変えながら**配信する仕組み。
目的は購買転換で、ステップごとに件名・プリヘッダー・本文・CTA・見た目を変える。
**同じ文面の繰り返しは定義できない**（カタログ検証が拒否する）。

---

## 1. 設計の骨子: ステップは「キャンペーンの変種」

新しい配信基盤を作らない。`resolveSequenceStep(campaign, n)` が返すのは
**campaign と同じ形のオブジェクト**なので、既存の

`renderCampaign` / `computeCampaignContentHash` / `buildCampaignPlan` /
`computeCampaignDeliveryKey` / benefit guard / engagement guard / dispatcher

が **1 行も変わらずそのまま**使える。ステップ専用の送信経路は存在しない。

```
campaignCatalog.js          … 文面の単一源（sequence.steps を持つ）
campaignSequence.js         … ステップ解決・検証・間隔（純粋）
sequenceProgress.js         … 誰が何通目か（純粋・送信の事実から導出）
sequenceAutomation.js       … 自動実行 1 回ぶんの計画とゲート（純粋）
admin-marketing.js          … 状況 API / プレビュー / dry-run / enqueue（I/O）
cron-campaign-sequence.js   … 自動で次ステップを queue（I/O・既定 OFF）
```

## 2. 1 ステップが持つもの

| 項目 | 必須 | 備考 |
|---|---|---|
| `stepNumber` | ✅ | 1 から連番 |
| `delayDays` | ✅ | step1 は 0、step2 以降は **2 日以上** |
| `subject` | ✅ | **他ステップと重複禁止** |
| `preheader` | ✅ | 受信箱の一覧に出る 1 文 |
| `body` | ✅ | **他ステップと重複禁止**。URL は書かず CTA に寄せる |
| `ctaLabel` / `ctaUrl` | ✅ | campaign 側の既定にフォールバック可 |
| `benefitType` / `benefitDescription` | ✅ | benefit guard 用（campaign 側にあればフォールバック） |
| `badge` / `headline` / `benefitTitle` / `benefitItems` / `ctaNote` / `footerNote` | 任意 | HTML シェルの見た目 |

`sequence.maxSends` が**規定回数**。定義済みステップ数を超えることはできない。

## 3. 冪等性（二重 queue / 二重送信を起こさない）

DeliveryKey は **campaign × version × step × 受信者**。

- 同じステップを二度実行しても `already_delivered` で落ちる
- `CampaignDeliveries` は `DeliveryKey` で upsert するので行も増えない
- **進行状態を別に保存しない。** 「送った step」は DeliveryKey の存在から導く
  （保存すると送信の事実とズレた瞬間に二重送信か送信漏れになる）
- `version` を上げると進行はリセットされる（別の配信として扱う）

> ⚠️ `sequenceStep` を持たない従来キャンペーンの DeliveryKey は **1 文字も変えていない**
>（テストで固定）。変えると既送信者へ再送されてしまう。

## 4. 止まる条件（強い順・最初に当たった理由だけを数える）

| 理由 | 判定 |
|---|---|
| `not_sendable` | 配信停止・ブラックリスト・停止アカウント・アドレス不正 |
| `provider_suppressed` / `soft_bounce` | 配信基盤の停止リスト / ソフトバウンス |
| **`purchased`** | 有料契約が有効になった（このシーケンスの目的を達成） |
| `audience_mismatch` | プラン・契約状態が変わり対象外になった（`enforce` のときだけ） |
| **`engagement_blocked`** | 反応なしが続いた（#313 の判定をそのまま使用） |
| `campaign_disabled` | キャンペーン停止中 |
| `max_sends_reached` | 規定回数まで配信済み（= 完了） |

**UNKNOWN・計測不足では止めない。** engagement の判定 Map が渡されなければ素通りする
（`engagementGuard.js` の fail closed 条件をそのまま継承）。
取引メール（決済・認証・サポート・期限通知）はシーケンスの対象外。

## 5. 自動配信

`cron-campaign-sequence.js` が **1 日 1 回・1 ステップだけ**進める。

**4 つのゲートが全て true でなければ、Airtable にも SendGrid にも接続しない**:

1. `MARKETING_SEQUENCE_SCHEDULER_ENABLED=true`
2. `MARKETING_SEQUENCE_ARMED=<今日の JST 日付>`（置きっぱなしでも翌日閉じる）
3. `MARKETING_CAMPAIGN_ENABLED=true`（既存の live enqueue）
4. `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true`（既存の実送信）

- **step1（初回接触）は自動で撃たない。** 母集団が最大になるため、管理画面から明示的に開始する。
  よって自動実行の走査対象は「その campaign で 1 通以上受け取った人」に限られ、
  Customers 全件走査（14,000 件超）を構造的に回避している
- 上限（1 回 200 名）を超えたら**切り捨てずに中止**する
- この Function は**メールを送らない**。作るのは `ScheduledEmails` の PENDING 行と
  `CampaignDeliveries` の queued 行だけで、実送信は既存 dispatcher が担う
- **`Customers` を 1 バイトも書かない**

## 6. 管理画面（`/admin/premium-plus-eligibility/`）

「セグメントの下見」の下に連続配信パネルがある。**送信前に**次を確認できる。

- キャンペーン名 / 自動配信 ON・OFF（OFF なら不足している env 名）/ 最大配信回数
- 対象人数（母数）/ 次に送れる人数（ステップと人数）/ 待機中 / 次回予定
- 配信完了 / 自動停止（**購入・反応なし・配信停止/バウンス・条件変化**の内訳）
- ステップごとの件名・間隔・**queue 済み / いま送れる**人数
- 各ステップの「文面を見る（実際に届く HTML）」= `action:'preview'` の HTML をそのまま iframe 表示

判定は全部サーバー（`sequenceProgress.js`）。**画面は数字を出すだけ**で再判定しない。

## 7. 送るまでの手順（本番）

1. 管理画面で「状況を見る」→ 次に送れるステップと人数を確認
2. 各ステップの「文面を見る」で**実際に届く HTML**を確認
3. 対象を選び `dryRun`（`step` 必須）→ 除外理由・人数・fingerprint を確認
4. `send`（`MARKETING_CAMPAIGN_ENABLED` が必要）→ ScheduledEmails / CampaignDeliveries に登録
5. 実配信は既存 dispatcher（`MARKETING_CAMPAIGN_DISPATCH_ENABLED`）
6. step2 以降は、上のゲートを開ければ cron が自動で進める

## 8. やってはいけないこと

- 同じ件名・本文を別ステップに置く（検証で落ちる）
- 的中・利益の保証、断定的な儲け話、「今だけ」の煽り（`FORBIDDEN_PHRASES`）
- **実績数値をメールに書き写す**（更新されずズレる。実データのページへ誘導する）
- 価格をメールに書く（`/pricing/` が正本）
- 閾値・間隔・上限を Function や画面へ直書きする
- 進行状態を別テーブルに持つ
- 取引メールをシーケンスにする

## 9. 無料体験を前提にするシーケンス（`requiresActiveGrant`）

`requiresActiveGrant: { tier: 'light', termedOnly: true }` を宣言すると、
**期限付きのその無料権利が有効な人にだけ**送る。

- `termedOnly: true` … **期限なし（`light-lifetime-free`）は対象外**。
  「無料期間は◯日まで」と書けず、体験からの転換という前提も成り立たないため
- 無料期間の終了日は **`{{grantExpiry}}`**（`LightGrantUntil`）を受信者ごとに差し込む。
  「付与日から 30 日間」という固定説明は**終了日が読めなかったときの保険**にすぎない
  （付与日と送信日は一致しない）

- **シーケンス（送信側）自身は無料付与を 1 件も作らない。**
  付与を書けるのは次の 2 つだけで、どちらも `buildComebackPlan` を正本に使う:
  1. `admin-comeback-grants`（管理画面からの手動付与・`operationId` で冪等）
  2. `cron-light-trial-grant`（**入口の自動化**・既定 OFF・6 ゲート・付与成功者だけ Step1 へ）
- 付与の正本は `promotionOfferCatalog.js` の `light-30d-free`
  （`kind: entitlement_grant` / `grantTier: light` / `durationDays: 30` /
  `restoresPaidContract: false` / `allowedEntitlements: ['light']`）
- 権利の判定は既存の単一源だけを使う
  （`resolveCustomerMarketing().promoLightActive` → 無ければ `resolveEntitlements`）。
  「未付与」と「期間終了」の区別は `resolvePromotionalGrants` の生の値で行う
- **期間が終わっても書き込みは発生しない**（`LightGrantUntil` との時刻比較だけ）。
  自動で課金されることはない
- 無料期間の終了日は `{{grantExpiry}}` として**送信直前に受信者ごとへ差し替える**
  （キュー登録時点では印のまま。dispatcher が `LightGrantUntil` から解決する）

### 運用の順序（付与 → 案内）

**手動で始める場合**

```
1. 管理画面「無料体験の入口を数える」で 対象総数 / 付与候補 / 除外理由 を確認（書き込みゼロ）
2. 管理画面「カムバック特典」で Light 30日無料を付与（← Customers を書くのはこの操作）
3. 連続配信パネルで対象人数を確認（付与前の人は grant_required で対象外）
4. step1 を dry-run → 内容と人数を確認 → キュー登録
5. step2 以降は間隔が来たぶんだけ（自動配信 ON なら cron が 1 日 1 ステップ）
```

**入口を自動化する場合**（6 ゲートを開けたときだけ）

```
cron-light-trial-grant が 1 日 1 回:
  ① CSV コホートを数える（観測できなければ中止）
  ② 候補を選ぶ（過去付与・有料・期限なし付与・付与中・配信不可を除外）
  ③ 付与（← ここで Customers へ LightGrant* を書く。buildComebackPlan が正本）
  ④ **付与に成功した recordId だけ**を Step1 の対象にする
  ⑤ Step1 をキュー登録（実送信は既存 dispatcher）
```

> ⚠️ **Customers を書くのは付与の 2 経路だけ**（手動 `admin-comeback-grants` /
> 自動 `cron-light-trial-grant`）。**送信側（`cron-campaign-sequence` / `admin-marketing`）は
> Customers を 1 バイトも書かない。**

## 9-3. 対象コホート（`requiresImportCohort`）

「CSV で取り込んだ会員だけ」に限定する宣言。判定の正本は **取り込み時に書いた `Source`**。

| 判定順 | 材料 | 備考 |
|---|---|---|
| 1 | `Source` が `customer-import:` で始まる | `buildCreateFields()` が **CREATE 時に必ず**書く |
| 2 | `ImportBatchId` に値がある | 列が実在する環境のみ |
| 3 | `CreatedBy === 'customer-import'` | 列が実在する環境のみ |

- **どれも読めなければコホート外**（fail closed）。推測で新しい旗を作らない
- ⚠️ **更新（UPDATE）で取り込んだ既存会員には `Source` が付かない**ため、
  「既存会員だが CSV にも載っていた人」は**判別できない**。コホート外として扱う
- 取り込みの痕跡が **1 件も無ければ `cohort_unverifiable` で中止**する
  （「まだ取り込んでいない」と「`Source` を読めていない」を区別できないため）

## 9-4. 無料体験の入口（自動付与 / `cron-light-trial-grant.js`）

**既定 OFF。6 つのゲートが全て開くまで Customers へ 1 バイトも書かない。**

| # | env | 意味 |
|---|---|---|
| 1 | `COMEBACK_GRANT_FIELDS_READY=1` | 既存の付与ゲート（列の実在） |
| 2 | `COMEBACK_GRANT_ENABLED=true` | 既存の付与ゲート（実行許可） |
| 3 | `LIGHT_TRIAL_AUTOGRANT_ENABLED=true` | 自動化の許可 |
| 4 | `LIGHT_TRIAL_AUTOGRANT_ARMED=<当日 JST>` | 当日ぶんの武装（翌日閉じる） |
| 5 | `MARKETING_CAMPAIGN_ENABLED=true` | Step1 のキュー登録 |
| 6 | `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true` | 実送信の既存ゲート |

1・2 は**手動付与と同じゲートを再利用**する（自動化のための抜け道を作らない）。

### 実行の順序（壊れると「使えないのに案内が届く」）

```
① CSV 取り込みコホートを数える  → 観測できなければ中止
② 候補を選ぶ（有料 / 期限なし付与 / 付与中 / 過去付与 / 配信不可 を除外）
③ 付与       ← buildComebackPlan の計画をそのまま PATCH（形も冪等性も既存が単一源）
④ 成功した recordId だけを抽出  ← recipientsAfterGrant()
⑤ Step1 をキュー登録            ← 付与前・失敗分には 1 通も送らない
```

- 付与の冪等性 … `operationId`（`light-trial-<JST日付>`）＋ 有効な付与保有者は `already_granted`
- 送信の冪等性 … DeliveryKey（campaign × version × step × 受信者）
- 上限 100 名 / 回。超えたら**切り捨てずに中止**
- **再付与しない**: 過去に無料付与の記録がある人は `granted_before` で除外

### 下見（書き込みゼロ）

**管理画面**の「無料体験の入口を数える（付与しません）」ボタンが正規の入口。
`admin-marketing` の `action:'trialGrant'` が、**自動付与と同じ判定**で次を返す:

- 自動付与の ON / OFF（OFF なら不足している env 名）
- **CSV 取り込みの対象総数**とバッチ別内訳
- **付与候補**の人数と 1 回の上限
- **除外理由別の人数**（有料 / 期限なし付与 / 付与中 / 過去付与 / 配信不可 / コホート外）
- 取り込みの痕跡が 0 件なら「**この状態では誰にも付与しません**」と明示

cron 側も同じ内容を返す（運用で API から確認したい場合）:

```bash
POST /.netlify/functions/cron-light-trial-grant
  x-admin-secret: <COMEBACK_ADMIN_SECRET or PREMIUM_PLUS_ADMIN_SECRET>
  {"dryRun": true}
```

どちらも**ゲートが閉じていても実行でき、1 バイトも書かない**。

## 9-2. 現行のシーケンス

### `light-trial-to-premium-sequence`（Light 無料体験 → Premium / 全 4 通）

| step | 間隔 | 役割 | 件名 | CTA |
|---|---|---|---|---|
| 1 | 開始時 | 無料体験の開始 | Lightプランを30日間 無料でお使いいただけます | ログインして使いはじめる |
| 2 | +3 日 | 使い方・買い目の見方 | メインレースの買い目の見方 | メインレースの買い目を見る |
| 3 | +5 日 | 期間中に確認してほしいこと | 無料期間中にご確認いただきたいこと | 無料期間中の予想を見る |
| 4 | +7 日 | Premium の提案 | 他のレースもご覧になりたい場合は | プランと料金を見る |

対象は **CSV 取り込みの会員**のうち **期限付き Light 無料期間中**の人
（`requiresImportCohort` + `requiresActiveGrant: { tier:'light', termedOnly:true }`）。
契約状態・プランでは絞らない（付与されていること自体が対象条件）。

> ⚠️ **プラン間の買い目点数を比較して書かない。** メインレース以外の点数は一律ではないため、
> 「上位プランでも点数は増えない」という断定は**不正確**。プランの違いは
> **ご覧いただける範囲**としてのみ説明する（2026-08-12 に該当文面を削除）。

## 10. テスト

```bash
npm run test:marketing   # 定義・進行・自動化・描画・配線 guard
npm run check:safety     # 上記を含む全 safety check
```

| ファイル | 見ているもの |
|---|---|
| `campaignSequence.test.mjs` | 解決・DeliveryKey・**同じメールの繰り返し禁止**・禁止表現 |
| `sequenceProgress.test.mjs` | 1→2→3 の進行・停止条件・冪等性・version 変更 |
| `sequenceAutomation.test.mjs` | ゲート・1 ステップだけ・step1 手動・上限中止 |
| `sequenceRender.test.mjs` | HTML/text 両方・モバイル・本番文面の表現・benefit guard |
| `sequenceWiring.guard.test.mjs` | 管理 API / cron / 画面の配線と安全条件 |
