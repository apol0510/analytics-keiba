# DRM（Direct Response Marketing）基盤

「一斉に送る仕組み」ではなく、**顧客の反応を計測し、反応に応じて次の訴求を変え、購入まで辿る**ための土台。
既存の 24-touch・CTA・購入停止・suppression・頻度 guard は**一切変えていない**。

## 責務の分かれ方（二重化しない）

| 問い | 単一源 |
|---|---|
| 送ってよいか / 待つか / 止めるか | `marketing/sequencePolicy.js`（既存） |
| いま何通目か・誰が対象か | `marketing/sequenceProgress.js`（既存） |
| **どんな反応だったか** | `drm/drmResponseState.js`（新） |
| **その反応に何を訴求するか** | `drm/drmRouting.js`（新） |
| **購入をどの 1 通に結ぶか** | `drm/drmAttribution.js`（新） |
| **ファネルをどう見せるか** | `drm/drmMetrics.js`（新） |

⚠️ `drmRouting` は**送信可否も頻度も判定しない**（テストで固定）。
行き先を選ぶだけで、送ってよいかは `sequencePolicy` が決める。

## 1. response state（`drmResponseState.js`）

既存単一源だけから顧客 1 人の反応を 1 つに畳む。**強い順**に:

`purchased` → `suppressed` → `clicked` → `opened` → `delivered` → `sent` → `not_sent` → `unknown`

| 材料 | 出どころ |
|---|---|
| delivered / opened | `webhooks/deliveryEventIndex.js`（DeliveryKey 単位）＋ `marketing/touchMeasurement.js` |
| purchased | `customerMarketingAudience.js` の `premiumActive` / `lightActive`（**課金契約のみ**） |
| 退会・停止・バウンス | `resolveSendability` / `providerSuppressed` / `softBounced` |

⚠️ **無料特典（`promo*`）を購入に数えない。**
⚠️ **`clicked` は常に `null`（未計測）。** provider 側の click tracking が OFF
（有効化するとアカウント全体に掛かりマジックリンクが壊れる）。`false` ではない。
⚠️ open が測れていなければ `delivered` とも `未開封` とも言わず **`unknown`**。

## 2. response-driven routing（`drmRouting.js`）

反応層 → 次の touch / variant / angle を**宣言で**選ぶ。
キャンペーン固有ロジックを Function へ直書きしない。

**実際の sequence へ配線済み**: `sequenceProgress.resolveRecipientProgress` が
`campaign.sequence.responseRoutes` を宣言した campaign でだけ `resolveRoutedStep` を通す。
`responseByEmail`（任意）を渡さない / 宣言が無い場合は**従来どおり完全に線形**。

```js
sequence: {
  responseRoutes: [
    { when: 'clicked',  step: 9, variant: 'close-a', angle: 'urgency' },
    { when: 'opened',   step: 7, angle: 'social-proof' },
    { when: 'delivered', step: 5, angle: 'benefit', minSent: 2 },
  ],
}
```

- 宣言順が強さ（先に書いたものが勝つ）
- `minSent` / `maxSent` で段階を絞れる
- **知らない `when` は採用しない**（勝手な条件を増やさない）
- **`unknown` 用の route が無ければ既定の線形へ落とす**（推測で反応前提の枝へ入れない）
- ⚠️ **`purchased` / `suppressed` には宣言があっても行き先を作らない**（`step: null`）。
  停止は `sequencePolicy` / `sequenceProgress` が決めるが、**行き先を作らないことでも二重に塞ぐ**
- ⚠️ **既に送った step は選ばない**（同じ人への二重送信・過去への逆戻りを構造的に防ぐ）
- ⚠️ 停止判定を**通過した後**にしか効かない（`hasPurchased` の `stop()` より後ろに置いてある）

### A/B — **まだ運用できません**

`variant` は**キャンペーン定義（コード）側の識別子**で、route が返せるところまで作った。

⚠️ **「A/B 実施可能」とは書かない。** 現状 `DeliveryKey` は
campaign × version × step × 受信者で作られており、**variant を含まない**。
そのため今は次が揃っていない:

  - variant 別に**送り分ける**経路
  - variant 別の**帰属**
  - variant 別の**重複防止**（同じ人へ両方の variant が届かない保証）

今回の到達点は **「将来 variant を識別できる routing 契約を持つ」まで**。
実運用するには、既存作法どおり version か step を分けるか、
`DeliveryKey` の作り方を変える設計判断が別途要る（本 PR では扱わない）。

## 3. conversion attribution（`drmAttribution.js`）

購入を campaign / version / touch(step) / DeliveryKey / offer まで結ぶ。
確からしさは既存 `crm/campaignOutcome.js` と同じ語彙:

| 段階 | 条件 |
|---|---|
| `direct` | その 1 通の**クリック**が確認できる（**click 計測が有効なときだけ**） |
| `correlated` | その 1 通の開封後・窓（既定 30 日）の中に購入（時間相関のみ） |
| `unattributed` | 上のどちらでもない（窓の外 / 時刻不明 / touch 無し） |

⚠️ AK は click 計測が無効なので **`direct` は原則成立しない**。
その事実（`clickMeasured`）を一緒に返し、「direct 0 件＝効果なし」と誤解させない。
⚠️ 購入より**後**に送った通へは結ばない。
⚠️ `unattributed` を集計から落とさない。

### 購入帰属は**分析専用の別 Function**（`admin-drm-attribution`）

購入がどの 1 通に結び付くかを知るには「**いつ有料になったか**」が要る。
その正本は `Customers.PaidAt` — `bankPaymentFlow.buildConfirmationFields` が
`PaidAt: confirmedAt.toISOString()` として書く、**入金確認 ＝ 有料化が確定した時刻**。

⚠️ **`checkout`（申込）時刻ではない。** 申込フォーム送信時には書かれない
（申込時は `Requested*` へ退避するだけ）。

#### なぜ送信経路から分けたのか

`offerCampaignFunction.guard.test.mjs` は**送信経路**
（`admin-marketing.js` / `marketing-campaign-dispatch.js`）が決済メール v2 の
フィールドへ触れないことを守っている。これは
「販促メールを出す経路が決済状態に依存して二重送信・状態汚染を起こさない」ための契約で、
**帰属のために緩めない**。

そこで**責務を分けた**:

| 経路 | 決済フィールド | 役割 |
|---|---|---|
| `admin-marketing` / `marketing-campaign-dispatch`（**送信**） | **触れない**（guard 継続） | 誰に何を送るか |
| **`admin-drm-attribution`（分析専用・read-only）** | 購入確定時刻だけ読む | 購入をどの 1 通に結ぶか |

新しい商品仕様ではなく、**内部の責務分離**。

#### 使う正本（別実装しない）

`premiumPlus/purchaseAnchorLookup.js` の既存 read-only I/O をそのまま使う。
DRM 用に**時刻 1 つだけ返す薄いラッパ** `lookupPaidConfirmedAt()` を同モジュールへ追加した。

| 戻り | 意味 |
|---|---|
| `{ paidAtMs, reason: 'ok' }` | 有料化確定時刻 |
| `reason: 'missing'` | `PaidAt` が無い（＝有料化を確認できない） |
| `reason: 'invalid'` | 値を時刻として解釈できない |
| `reason: 'not_found'` / `'unavailable'` | レコードが無い / 読めない |

⚠️ `ok` 以外は**購入者として数えず、帰属もしない**（`unattributed`）。
**推測で時刻を補完しない。** ⚠️ `PaidAt` を独自の Airtable query で別実装しない。
⚠️ raw fields を DRM 側へ返さない（時刻と理由だけ）。

## 4. DRM metrics（`drmMetrics.js`）

sent / delivered / open / click / purchase / CVR / touch 別 conversion / unattributed。

⚠️ **未計測を 0 にしない。** `crm/deliveryMeasurement.js` の 3 状態
（`enabled` / `disabled` / `unknown`）をそのまま使い、数えてよいときだけ件数を返す（他は `null`）。
⚠️ **provider 受理（accepted）と delivered を混同しない。**
`action:'drm'` の面は増分集計（送信側の数）しか持たないので、
**delivered は `null` / `unknown`**。`sent` で代用しない。
1 通単位の到達が要るときは `action:'drmCohort'`（宛先を名指し）で
`deliveryEventIndex` から引く。
⚠️ **CVR の母数は送信済み。** 到達基準は `cvrOnDelivered` として別に持つ。
⚠️ 母数 0 なら率を作らない（`null`）。

## 5. operator UI

`/admin/drm`（read-only）。「誰に何を送るか」ではなく
**「どの反応層に、次に何を訴求するか」**を出す。

- 反応層ごとの人数・次の touch・angle・variant・停止理由
- ファネルと touch 別 conversion
- 計測していない指標は **0 ではなく「—」**

read-only API は `admin-marketing` の **`action: 'drm'`**（**送信面**に新しい Function を作らない）。
購入の帰属だけは分析専用の **`admin-drm-attribution`** が担当する（理由は 3 節）。
増分集計（Redis）だけを読み、**正本の全件走査はしない**（`handleRollout` と同じ理由）。

⚠️ この面では**反応層の人数を出さない**（`segmentCounts: null` /
`segmentCountsReason: 'per_customer_unavailable'`）。
`sent` / `opened` / `purchased` / `stopped` は**同じ人が複数に入る累積指標**で、
1 人 1 state の排他的な層ではないため。

### `action: 'drmCohort'`（bounded・実データ）

`recordIds` で**宛先を名指し**して、その人たちだけを読む（上限は既存 `DUPLICATE_CHECK_MAX`）。
ここでだけ次を返す:

- **1 人 1 state** の排他的な反応層（`segmentCounts`）
- 1 通単位の到達・開封（`deliveryEventIndex` が読めたときだけ。読めなければ `unknown`）

⚠️ **この面は購入の帰属を返さない。** 帰属には購入確定時刻が要るが、送信経路は
決済メール v2 のフィールドへ触れない既存契約（`offerCampaignFunction.guard.test.mjs`）を
守るため読まない。担当を `attributionEndpoint: 'admin-drm-attribution'` として案内するだけ。

⚠️ 全件走査はしない。⚠️ 1 件も書かない。⚠️ アドレスは返さない。

### `admin-drm-attribution`（分析専用・bounded・read-only）

`campaignId` ＋ `recordIds` ＋ 同じ順・同じ数の `emails` を渡すと、その人たちの
**購入確定時刻 → 実 touch（DeliveryKey）** の帰属だけを返す。

| 返すもの | 中身 |
|---|---|
| `purchases` | 有料化を確認できた人数 |
| `attribution` | `direct` / `correlated` / `unattributed` の内訳 |
| `attributed` | `campaignId` / `version` / `step` / `DeliveryKey` / `offerKey` / confidence |
| `purchaseTimeReasons` | 購入時刻を取れなかった理由の**件数だけ**（`missing` / `invalid` / …）|
| `measurement` | click は `disabled`、open / delivered は読めたかどうか |

- 認証は既存管理 Function と同等（secret 未設定は 503・不一致は 403）
- 入力は bounded（`MAX_RECORD_IDS = 500`・名指し formula・ページ上限・**全件走査なし**）
- **書き込み・queue 登録・dispatch 呼出・メール送信・PromotionalOffers 書込みなし**
- アドレス・氏名・`recordId` を**レスポンスにもログにも出さない**

⚠️ click tracking は無効なので `direct` は成立しない。UI は 0 ではなく「—」で出し、
**「direct 0 件＝効果なし」と読ませない**。

> **状態: 完了（2026-08-19 MK 判断でクローズ・残件なし）。**
> 下の 11 項目が完成条件の**正本であり全部**。11 項目とも達成済み（PR #374 / `6ed73865` 本番反映済み）。
> 本番 read-only 実測で `correlated` の実例が未観測であることは**事実の記録**で、**完成条件ではない**。
> 完成条件に独自の追加条件を足さない。**再監査しない。**

## DRM の完成条件

- response-driven routing が**実 sequence** で動く
- `responseRoutes` 未定義なら**既存挙動不変**
- purchase / suppression 停止が最優先
- `sent` と `delivered` を混同しない
- 未計測を 0 にしない
- 顧客 segment は**排他的**（1 人 1 state）
- 帰属不能は正直に `unattributed`
- **Premium / Light の購入確定時刻から実 touch へ帰属できる**
- **送信経路の決済フィールド guard を維持したまま**である
- duplicate send なし
- operator UI で反応層・次訴求・conversion を確認できる

## 6. safety

- 購入後は即停止（`sequencePolicy.resolveStop` が最優先で判定 ＋ routing が行き先を作らない）
- 退会 / complaint / hard bounce / suppression へは絶対に送らない
- `DeliveryKey` 冪等性は既存のまま（DRM 側は**書き込みを一切しない**）
- 反応が読めないときに推測で分岐しない
- provider 受理と delivered を混同しない
- open 未計測を `open = 0` にしない
- 実顧客でテストしない（テストは合成データのみ・`example.com`）

## 変えていないもの

`sequencePolicy` / `sequenceProgress` / `campaignSend` / `campaignCatalog` の既存契約、
24-touch の構成、CTA、購入停止、suppression、頻度 guard、`DeliveryKey` の作り方。
**新しい schema / production env / production datastore は追加していない。**
