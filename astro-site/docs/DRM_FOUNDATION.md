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
  停止は `sequencePolicy` が決めるが、**行き先を作らないことでも二重に塞ぐ**

### A/B（将来拡張）

`variant` は**キャンペーン定義（コード）側の識別子**。
`campaignId` / `version` / `step` と並べて使う。
**新しい schema も列も要らない**（`DeliveryKey` は campaign × version × step × 受信者で既に一意なので、
配信を分けたいときは既存作法どおり version か step を分ける）。

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

## 4. DRM metrics（`drmMetrics.js`）

sent / delivered / open / click / purchase / CVR / touch 別 conversion / unattributed。

⚠️ **未計測を 0 にしない。** `crm/deliveryMeasurement.js` の 3 状態
（`enabled` / `disabled` / `unknown`）をそのまま使い、数えてよいときだけ件数を返す（他は `null`）。
⚠️ **provider 受理（accepted）と delivered を混同しない。**
⚠️ **CVR の母数は送信済み。** 到達基準は `cvrOnDelivered` として別に持つ。
⚠️ 母数 0 なら率を作らない（`null`）。

## 5. operator UI

`/admin/drm`（read-only）。「誰に何を送るか」ではなく
**「どの反応層に、次に何を訴求するか」**を出す。

- 反応層ごとの人数・次の touch・angle・variant・停止理由
- ファネルと touch 別 conversion
- 計測していない指標は **0 ではなく「—」**

read-only API は `admin-marketing` の **`action: 'drm'`**（新しい Function を作らない）。
増分集計（Redis）だけを読み、**正本の全件走査はしない**（`handleRollout` と同じ理由）。

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
