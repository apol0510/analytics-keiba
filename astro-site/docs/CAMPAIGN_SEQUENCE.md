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

## 9. 現行のシーケンス

### `free-to-premium-sequence`（無料会員 → 有料プラン / 全 4 通）

| step | 間隔 | 役割 | 件名 | CTA |
|---|---|---|---|---|
| 1 | 開始時 | 主価値 | 無料でご覧いただける予想について | 今日の無料予想を見る |
| 2 | +3 日 | 具体例・実績の見方 | 前日の買い目と結果を、そのまま公開しています | 昨日の買い目と結果を見る |
| 3 | +5 日 | 疑問・不安の解消 | よくいただくご質問にお答えします | プランと料金を見る |
| 4 | +7 日 | 選び方・再提案 | プランの選び方（この案内は今回で最後です） | プランを確認する |

対象は **無料プラン かつ 契約なし**（`enforce`）。有料会員・期限切れには送らない。

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
