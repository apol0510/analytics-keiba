# DRM（Direct Response Marketing）基盤

「一斉に送る仕組み」ではなく、**顧客の反応を計測し、反応に応じて次の訴求を変え、購入まで辿る**ための土台。
既存の 24-touch・CTA・購入停止・suppression・頻度 guard は**一切変えていない**。

> ## ⚠️ この文書は**部品の技術仕様**であって、完成条件でも完了報告でもない
>
> | 知りたいこと | 正本 |
> |---|---|
> | **DRM の事業目的・ファネル・完成条件** | `docs/spec.md`「🚧 DRM（無料登録者 → 有料転換）」 |
> | **いまどこまで出来ているか・残作業** | `docs/progress.md` 先頭の常設ブロック |
> | **いつ何を決めたか** | `docs/decisions.md`（2026-09-14） |
> | 各モジュールの契約・禁止事項 | **この文書** |
>
> **2026-08-19 の「DRM 基盤完成・クローズ」は 2026-09-14 に取り消された。**
> あれは**基盤完成のみ**を意味しており、実 campaign による実運用の完成条件は未達だった。
> 当時そろっていたのは純粋関数・管理画面・テスト専用オーバーレイ（`withRoutes`）だけで、
> 実カタログの `responseRoutes` は **0 件**、実配信経路は `responseByEmail` を
> **誰も渡していなかった**（＝本番は最後まで線形）。
>
> **この文書の項目がすべて ✅ でも「DRM 完成」とは書かない。** 完成条件は spec 側にある。

## 責務の分かれ方（二重化しない）

| 問い | 単一源 |
|---|---|
| 送ってよいか / 待つか / 止めるか | `marketing/sequencePolicy.js`（既存） |
| いま何通目か・誰が対象か | `marketing/sequenceProgress.js`（既存） |
| **どんな反応だったか** | `drm/drmResponseState.js`（新） |
| **その反応に何を訴求するか** | `drm/drmRouting.js`（新） |
| **購入をどの 1 通に結ぶか** | `drm/drmAttribution.js`（新） |
| **ファネルをどう見せるか** | `drm/drmMetrics.js` |
| **どの段の人か・段の実装が揃っているか** | `drm/drmFunnel.js` |
| **入口に入れてよいか・次段へ繋ぐか** | `drm/drmAutoStart.js` |
| **反応を実配信の事実から組み立てる** | `drm/drmResponseInputs.js` ＋ `drm/drmResponseLoader.js` |

⚠️ `drmRouting` は**送信可否も頻度も判定しない**（テストで固定）。
行き先を選ぶだけで、送ってよいかは `sequencePolicy` が決める。

## 1. response state（`drmResponseState.js`）

既存単一源だけから顧客 1 人の反応を 1 つに畳む。**強い順**に:

`purchased` → `suppressed` → `clicked` → `opened` → `delivered` → `sent` → `not_sent` → `unknown`

| 材料 | 出どころ |
|---|---|
| delivered / opened | `webhooks/deliveryEventIndex.js`（DeliveryKey 単位）＋ `marketing/touchMeasurement.js` |

⚠️ **DRM の campaign は `summarizeByCampaignStep()` で数える**（`campaignId` × `step`）。
`summarizeByTouch()` は `journeyModel.js` に載る **Light 無料体験 24 接点の専用**で、
DRM の 3 本はそこへ登録しない。登録されていない campaign を接点番号で数えると
**行があるのに 0 件**になる（2026-09-14 実測）。詳細は
[`DELIVERY_MEASUREMENT.md` §5-2](./DELIVERY_MEASUREMENT.md)。

| purchased | `customerMarketingAudience.js` の `premiumActive` / `lightActive`（**課金契約のみ**） |
| 退会・停止・バウンス | `resolveSendability` / `providerSuppressed` / `softBounced` |

⚠️ **無料特典（`promo*`）を購入に数えない。**
⚠️ **`clicked` は常に `null`（未計測）。** provider 側の click tracking が OFF
（有効化するとアカウント全体に掛かりマジックリンクが壊れる）。`false` ではない。
⚠️ open が測れていなければ `delivered` とも `未開封` とも言わず **`unknown`**。

## 2. response-driven routing（`drmRouting.js`）

反応層 → 次の touch / variant / angle を**宣言で**選ぶ。
キャンペーン固有ロジックを Function へ直書きしない。

`sequenceProgress.resolveRecipientProgress` が
`campaign.sequence.responseRoutes` を宣言した campaign でだけ `resolveRoutedStep` を通す。
`responseByEmail` を渡さない / 宣言が無い場合は**従来どおり完全に線形**。

### 実 campaign の宣言（2026-09-14〜）

**`light-trial-post-expiry-sequence`（体験終了後フェーズ / 18 通）** が最初の実宣言。
送信実績が 0 通の campaign なので、**進行中のコホートを乱さない**。

```js
sequence: {
  maxSends: 18,
  steps: POST_EXPIRY_STEPS,
  responseRoutes: [
    // 読んでいる人 → 使い方の続きより先に「プランで何が変わるか」
    { when: 'opened',    step: 9,  minSent: 3, maxSent: 8 },
    // 届いても開かない人 → 案内を積まず、入口を変える 1 通
    { when: 'delivered', step: 16, minSent: 5, maxSent: 12 },
  ],
}
```

⚠️ **進行中の `campaign-discount-*` / `light-trial-to-premium-sequence` には宣言しない**
（別途進めている約 15,000 件の配信復旧と混ぜない）。

### 反応の作り方（**この 2 つが欠けていた**）

| 追加 | 役割 |
|---|---|
| `drm/drmResponseInputs.js` | 配信の事実（`indexDeliveries`）＋ 開封索引 → 1 人 1 state。読み取りは**受信者単位で bounded**（`planResponseKeyReads`） |
| `drm/drmResponseLoader.js` | 実経路が**同じやり方で**反応を得る 1 か所。読めない理由を必ず `reason` で返す |

- `cron-campaign-sequence`（自動配信）と `admin-marketing` の `action=sequence`（画面）が
  **同じ loader** を呼ぶ。別々に読むと画面の「次の 1 通」と実際に送る 1 通がズレる
- 索引が読めない / 予算を超えた相手は `unknown` = **線形**（「開封 0 件」にしない）
- 宣言の無い campaign では索引を **1 鍵も読まない**（既存のコストと挙動のまま）
- 管理画面の応答に `responseRouting`（`active` / `reason` / `routed` / `byRoute`）を返す。
  **効かなかったことが運用から見える**ようにするため

- 宣言順が強さ（先に書いたものが勝つ）
- `minSent` / `maxSent` で段階を絞れる
- **知らない `when` は採用しない**（勝手な条件を増やさない）
- ⚠️ 実行時に黙って捨てると**書き間違いが「静かに線形のまま」**になるため、
  宣言の形は `validateResponseRoutes` が `validateSequence` 経由で CI で落とす。
  `purchased` / `suppressed`（行き先を作らない層）と `clicked`（**計測していない**）は
  **宣言そのものを禁止**する — 書けると「効いている」と誤読するため
- **`unknown` 用の route が無ければ既定の線形へ落とす**（推測で反応前提の枝へ入れない）
- ⚠️ **`purchased` / `suppressed` には宣言があっても行き先を作らない**（`step: null`）。
  停止は `sequencePolicy` / `sequenceProgress` が決めるが、**行き先を作らないことでも二重に塞ぐ**
- ⚠️ **既に送った step は選ばない**（同じ人への二重送信・過去への逆戻りを構造的に防ぐ）
- ⚠️ 停止判定を**通過した後**にしか効かない（`hasPurchased` の `stop()` より後ろに置いてある）

### A/B — **まだ運用できません（非ブロッカー）**

⚠️ **DRM 完成の残件に数えない**（2026-09-14 MK 確定）。将来課題として残すだけで、
実運用の完成条件（`docs/spec.md`）には**含めない**。

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

### `action: 'drmProgress'`（進行の下見・bounded・read-only）

シーケンスの進みを **配信台帳から**読む。`action=sequence` とは**母集団の取り方が逆**。

| | `action=sequence` | `action=drmProgress` |
|---|---|---|
| 何から読むか | **受信対象（Customers）から** | **配信台帳（`CampaignDeliveries`）から** |
| 絞り込めない campaign | `audience_not_narrowable` で **400** | 台帳を campaignType で絞るので**関係ない** |
| 母数が大きいとき | 配信履歴の突き合わせで **504** | 上限を超えたら**数字を出さずに 413** |
| まだ誰も入っていない | 400 / 504 になり得る | `inSequence: 0` と**正直に返る** |

⚠️ 進行と反応は **`buildSequenceProgress` / `loadResponseByEmail`**（実配信と同じ単一源）を通る。
画面の人数と実際に送る人数がズレない。
⚠️ **1 バイトも書かない・1 通も送らない。** 読み切れなければ数字を出さない。
⚠️ cron / 実送信経路はこの面を**使わない**（表示専用）。

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

## 基盤の条件（11 項目・2026-08-19 時点で充足）

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

⚠️ この 11 項目は**部品の条件**であって、事業目的の達成条件ではない。
1 項目めの「実 sequence で動く」は当時 **`responseRoutes` を宣言した campaign が 1 件も
無い状態**で満たしたと記録されており、実際には**誰にも効いていなかった**。
事業目的の達成条件は `docs/spec.md` の 6 条件（実配信での確認）。

## 実運用の完成条件は **`docs/spec.md`** にある

この文書には書かない（2 か所に置くと必ず食い違う）。
現在地と残作業は `docs/progress.md` 先頭の常設ブロック。

## 6-b. 入口を動かす 2 つの経路（**scheduled は HTTP で叩けない**）

⚠️ **2026-09-14 本番実測**: `export const config = { schedule }` を持つ Netlify Function は
**定期実行専用**で、公開 URL への POST は **403・本文 0 バイト**。
**認証の有無に関係なく、payload も渡せない**。
（同型の `cron-light-trial-grant` でも同じ挙動を確認。そちらの docs に残る
「手動 dryRun できる」という記述の訂正は**別任務**。）

| 経路 | 担当 | 人数の確認 |
|---|---|---|
| `cron-drm-autostart`（scheduled・1 日 1 回）| **Background を起動するだけ** | `maxPerTick` と入口の窓が上限 |
| `admin-marketing` の `action:'drmEntryRun'`（`dryRun:true`）| **手動の下見**（同期・軽い）| — |
| `admin-marketing` の `action:'drmEntryRun'`（`dryRun:false`）| **Background を 202 起動するだけ** | **`expectedCount` 必須** |
| `admin-marketing` の `action:'drmEntryAllowlistCheck'` | **許可リストの効きを下見で確認**（read-only・**窓で刻む**）| **送信 0**。窓ごとの人数・出所を返す（**足さずに** `plannerDigest` の外へ出ていないかで判定）|
| **`drm-entry-background`** | **重い処理はここだけ**（最大 15 分）| Background 側で**改めて**突き合わせ |

⚠️ **重い処理を同期 Function で完走させない**（2026-09-14 に本番で **504**。
書き込みは 0 だったが完走しなかった）。**scheduled Function は 30 秒**で切られるため、
日次経路も Background へ委譲する。
⚠️ **候補を Background へ注入しない。** payload は `campaignId` / `expectedCount` /
`manual` / `runId` だけ。候補は Background が読み直すので、
**送信直前の再検証が短絡しない**。
⚠️ **入口の鍵 TTL は Background の最大実行時間を覆う**（960 秒 > 900 秒）。
共有 cron の 240 秒を流用すると**途中で切れて二重 enqueue** になる。
⚠️ Background は **202 即返し**。結果は返らないので
**`CampaignDeliveries` / `ScheduledEmails` / `action:'drmProgress'` / 関数ログ**で確認する。

⚠️ どちらも **同じ `runDrmEntry()`** を通る。admin 側は**薄い呼び出しだけ**で、
判定・許可リスト・`planAutoStartEntries`・`runSequenceTick`・`DeliveryKey`・
購入/停止/二重防止を**作り直さない**。

## 7. ファネル（`drmFunnel.js`）

段（無料登録者 → Light/Premium → Premium → 三連複）の**宣言だけ**を持つ。
送信条件・停止条件はここで作らない（作ると判定が二重化する）。

- `resolveFunnelStage(marketing)` … **1 人 1 段**（排他）。判定できなければ `null`（推測しない）
- ⚠️ **反応層の購入判定は campaign ごと**（`resolveResponseState({ campaign })`）。
  渡さないと既定の「Light か Premium が有効なら購入済み」になり、
  **上位商品を案内する段では宛先全員が `purchased`** に見える。
  送信経路だけでなく **cohort 表示（`action:'drmCohort'`）でも渡す**
  （2026-09-14 本番実測: Premium 有効 12 名が三連複の段で全員 `purchased` と表示されていた）
- `assessFunnel(CAMPAIGNS)` … 宣言と実装の食い違いを `gaps` で返す。**欠けを省略しない**
- 検査する食い違い: 担当 campaign が無い / 連続配信でない / `responseRoutes` 未宣言 /
  **入口のプランで購入停止している**（2026-09-08 の障害）/ 到達目標で停止していない /
  期間限定でしか動かない / 入口で自動開始しない

⚠️ `assessFunnel().declarationsReady` は**宣言と実装の整合だけ**。
**実配信で層ごとに別の 1 通が出た実績は含まない**（＝これを「完成」と読まない）。
⚠️ 三連複保有者は**終点**。段の宣言を持たせない（買った人へ売り続けないため）。

## 8. 入口の自動開始（`drmAutoStart.js`）

`cron-campaign-sequence` は既定で **step1 を自動で撃たない**（母集団が最大になるため）。
`sequence.autoStart` を宣言した campaign だけ、**限定した入口**を開ける。

```js
sequence: {
  autoStart: { kind: 'free_signup', withinDays: 14, maxPerTick: 50 },
}
```

- ⚠️ **入口は共有スケジューラから分離した**（2026-09-14 / `cron-drm-autostart.js`）。
  本番は `MARKETING_SEQUENCE_SCHEDULER_ENABLED=false` かつ
  `MARKETING_SEQUENCE_CAMPAIGN_ID=campaign-discount-*` なので、共有 cron に相乗りすると
  **入口を開けた瞬間に割引 3 本（step2 保留中）が tick される**。
  専用 Function は **`MARKETING_DRM_AUTOSTART_ENABLED` だけ**を読み、
  対象は**固定の許可リスト**（割引 3 本は構造的に選べない）。
  キュー登録は作り直さず `runSequenceTick` に委ねる。詳細は `CAMPAIGN_SEQUENCE.md` §9-5
- 除外は**既存の判定の結果をそのまま使う**（`resolveSendability` /
  `hasPurchasedForCampaign` / `matchesCampaignAudience` / `resolveFunnelStage`）。
  **新しい停止条件を作らない**
- 入れない理由は件数で返す（`not_sendable` / `purchased` / `audience_mismatch` /
  `already_started` / `outside_window` / `stage_mismatch` / `no_registration_time`）
- **登録時刻が読めない人は入れない**（推測しない）
- **すでに 1 通でも受け取っている人は入口に入れない**（`hasStarted`）

> ## ⚠️ `MARKETING_DRM_AUTOSTART_ENABLED` は **step1 の入口専用**
>
> **step2 以降の実行 gate ではない**（2026-09-15 MK 確定）。
> `planSequenceTick` の `excludeSteps = allowFirstStep ? [] : [1]` が示すとおり、
> このスイッチが左右するのは **step1 を選べるかどうかだけ**。
> step2 以降は `selectNextDueStep` が**期限の来ている最小の step** を選ぶので、
> このスイッチとは無関係に選ばれる。
>
> **2 通目（R2）のためにこの env を開けてはいけない。**
>
> さらに、**開けても 2 通目は出せない**。`runDrmEntry` は入口の下見が返した recordId
> （＝**まだ 1 通も受け取っていない人**）を許可リストとして渡すので、
> step2 の対象（既に受け取っている人）は**全員が許可リストの外**になり、
> 最終対象 0 →`no_due_recipients` で止まる。**構造的に 2 通目は出ない。**
>
> 2 通目を出すには別の経路と**別の承認**が要る。現在地と手順は
> `docs/progress.md` の「R2 の進め方」を正本とする。
- 並びは recordId 昇順で決定的・上限超過は `carriedOver` として次回へ（**黙って捨てない**）

`resolveStageEntry()` は段が進んだ人を次段の**育成**へ繋ぐ。
⚠️ 育成の無い段では繋がない（**期間限定のオファーを自動の入口に代用しない**）。

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
