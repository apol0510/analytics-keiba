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

## 5. 自動配信（**完全自動運用** / 2026-09-14 MK 確定）

一度有効にしたら、**人が途中で操作しないこと**を前提に回す。

```
対象判定 → due step 判定 → 除外判定 → enqueue → dispatch → 送信 → 台帳記録
        → 次 step 待機 → 次 step 送信 →（期間終了 or 完走で自動停止）
```

| 役割 | Function | 間隔 |
|---|---|---|
| 積む（enqueue）| `cron-campaign-sequence.js` | 10 分 |
| 送る（dispatch 起動）| `cron-marketing-dispatch.js` | 5 分 |

### 通常運用で開けたままにする env

| env | 役割 |
|---|---|
| `MARKETING_SEQUENCE_SCHEDULER_ENABLED=true` | 連続配信を進める |
| `MARKETING_CAMPAIGN_ENABLED=true` | キュー登録 |
| `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true` | 実送信 |

⚠️ **これは「配信のたびに開け閉めするスイッチ」ではない。**
開けたら**そのまま維持する**。配信後に UNSET して再閉鎖する運用は**廃止**（旧方式）。

`MARKETING_SEQUENCE_ARMED` は**置かない**のが通常運用（未設定＝常時武装）。
日付を入れるとその日しか動かないので、**異常時に 1 日だけ動かしたいときの絞り込み**にだけ使う。

`MARKETING_SEQUENCE_CAMPAIGN_ID` も**置かない**のが通常運用。
未設定なら**カタログの有効な連続配信すべて**を 1 tick で順に進める
（割引 3 本＝ free / light / premium も自動。人数が少ないことを理由に手動 enqueue しない）。
値を入れると**その 1 本だけ**に絞られるので、障害時の切り分け以外では使わない。

⚠️ 未設定＝**カタログへ足した連続配信は自動で tick の対象に入る**。
ただし **step1 は自動で撃たれない**（上の「変わらない安全装置」）ので、
まだ誰も受け取っていない campaign は `no_one_in_sequence` / `first_step_manual` で
**1 通も出ない**。出すには管理画面から step1 を撃つか、入口のゲートを開ける。

### 止め方（**例外運用**。通常状態ではない）

| 手段 | 効き方 |
|---|---|
| `MARKETING_CAMPAIGN_DISPATCH_ENABLED` を落とす | 実送信だけ止まる（キューは積まれる）|
| `MARKETING_SEQUENCE_SCHEDULER_ENABLED` を落とす | 新しいキュー登録が止まる |
| `rolloutKill`（展開のみ）| 体験→Premium の 24 接点が即停止（`rolloutResume` で戻す）|
| `cancelJob` | そのジョブだけ止める |

### 変わらない安全装置

- **step1（初回接触）は自動で撃たない。** 母集団が最大になるため、開始だけは管理画面から。
  step2 以降は自動。よって自動実行の走査対象は「その campaign で 1 通以上受け取った人」に限られ、
  Customers 全件走査（14,000 件超）を構造的に回避している
  - **例外は `sequence.autoStart` を宣言した campaign だけ**（2026-09-14〜 / §9-5）。
    母集団を「**登録が新しい無料会員**」に限り、1 回の人数にも上限を置くので全件走査へは戻らない。
    さらに **`MARKETING_DRM_AUTOSTART_ENABLED=true`**（既定 閉）が要る。
    ⚠️ この env が閉じている間は、宣言があっても step1 は**手動のまま**
- **step1 しか居ないとき以外は、step1 の人が混ざっても tick 全体を止めない**（除外して進む）
- 上限（1 tick 500 名）を超えたぶんは**切り捨てず次 tick へ持ち越す**
- `cron-campaign-sequence` は**メールを送らない**。作るのは `ScheduledEmails` の PENDING 行と
  `CampaignDeliveries` の queued 行だけで、実送信は既存 dispatcher が担う
- **`Customers` を 1 バイトも書かない**

### prospect（CSV 取り込み）にも送る（2026-09-14 追加）

prospect は Airtable に配信行を作らないので、送信時に `custom_args` の材料が無かった。
そこで **積むときに `jobId` ごとの対応表**（`emailHash → DeliveryKey`）を Redis へ置き、
dispatcher がそれを読む。

- 鍵は **enqueue 時の値をそのまま**持ち回る（**送信側で作り直さない**）
- 対応表を**置けなければそのバッチは積まない**（送れないのに予約だけ焼かない）
- 二重送信は **job ごとの送信済み集合**で防ぐ。**送る前に記録し、記録できなければ送らない**
- `delivered` は webhook が prospect レコードへ積む（**打ち切りの分母**）。
  `MARKETING_PROSPECT_EVENTS_ENABLED=true` が要る

単一源: `prospectDeliveryDescriptor.js` / `prospectDispatchContext.js`
（判定は [`ENGAGEMENT_SUPPRESSION.md` §2-b](./ENGAGEMENT_SUPPRESSION.md)）

### 多重起動を防ぐ tick 鍵（2026-09-14 追加）

`cron-campaign-sequence` は **1 つの tick 枠で複数回起動されることがある**（本番実測で 3 回）。
1 tick の上限（`MARKETING_SEQUENCE_MAX_PER_TICK`）は**1 起動あたり**に効くので、
多重起動すると意図した速度制御が効かない（50 指定でも 150 名）。

`cron-marketing-rollout` と同じ `dispatchLock` で鍵を取り、**取れなければ何も積まない**。

- 鍵 `tick:campaign-sequence` / TTL 240 秒（**次の tick の 10 分より短く**）
- Redis へ到達できないときも**積まない**（多重起動を防げない状態で走らせない）
- 検証: `sequenceTickLock.test.mjs`

### prospect だけを少数で実証する（canary / 2026-09-14 追加）

`selectNextDueStep` は出所を見ないため、母数の並び順しだいで
**Customers ばかりが選ばれる**（初回実配信 150 通は全員 Customers 由来だった）。

> ### ⚠️ env で絞ってはいけない（2026-09-14 の本番事故）
>
> 当初は `MARKETING_SEQUENCE_SOURCE_FILTER=prospect` という **production env** で絞っていた。
> ところが `cron-drm-autostart` は
>
> ```js
> const tickEnv = { ...env, MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'true' };
> await runSequenceTick({ env: tickEnv, campaignId });
> ```
>
> と **env をまるごと引き継ぐ**ので、絞り込みが **DRM の入口にも効いて**しまい、
> DRM の対象（Customers 由来）が黙って 0 人になる。
> しかも DRM は `SCHEDULER_ENABLED` を自分で合成するため、
> **`scheduler=false` にしても DRM は止まらない**＝「閉じてあるから無害」は成り立たない。
>
> **この env は廃止した。**絞り込みは `runSequenceTick` の**引数**でしか渡らない
> （`sequenceAudienceFilter.js` に env を読む口はもう無い。
> `sequenceCanaryIsolation.test.mjs` が固定している）。

| 何 | どうする |
|---|---|
| 絞り込み | `runSequenceTick({ sourceFilter: 'prospect' })`（**引数だけ**。既定は全部）|
| 人数 | `runSequenceTick({ maxRecipientsOverride: 50 })`（渡さなければ従来の env 由来）|
| 件数のズレ | `runSequenceTick({ expectedCount: 50 })`（違えば **1 件も積まない**）|
| 送る前の確認 | `admin-marketing` の `action='sequenceTickPreview'` |
| 少数の実配信 | `admin-marketing` の `action='sequenceCanaryRun'`（下記）|

#### `action='sequenceCanaryRun'`（管理用・1 回限り）

共有のスケジューラ env を開け閉めせずに、**この呼び出しの中だけ**で 1 tick 回す。

> ⚠️ **重い処理は同期 Function で走らせない**（2026-09-15 本番実測）。
> 入口から直接 `runSequenceTick` を呼んだら **504（31 秒）**で打ち切られた
> （書き込みは 0）。`runSequenceTick` は配信台帳の走査と prospect 索引 11,971 件の
> 読み込みを行うので同期では収まらない。**#529 が DRM で解決済みの問題と同型**。
> いまは入口が**受け付けるだけ**で、実行は `sequence-canary-background`
> （Background / 最大 15 分）が行う。入口は **202 即返し**で結果を返さない。
> 結果は `ScheduledEmails` / `prospectSequenceCheck` /
> `[sequence-canary-bg]` のログで確認する。

```json
{ "action": "sequenceCanaryRun", "campaignId": "campaign-discount-free",
  "sourceFilter": "prospect", "maxPerTick": 50, "expectedCount": 50,
  "confirm": "RUN PROSPECT CANARY", "apply": true }
```

| 守っていること | どう守るか |
|---|---|
| 他 campaign を巻き込まない | `campaignId` は**許可リスト必須**・既定値なし（DRM は入っていない）|
| DRM へ漏らさない | 絞り込み・上限・期待件数はすべて引数。production env は読みも書きもしない |
| 経路を作り直さない | 既存 `runSequenceTick` にそのまま委譲（除外・`DeliveryKey`・予約・dispatcher・webhook は通常どおり）|
| 件数がズレたら送らない | `expected_count_mismatch` で **予約より手前**に停止 |
| 出所が混ざったら送らない | `audience_source_mixed` で **予約より手前**に停止 |
| 二重で走らせない | 定期 tick と**同じ鍵**（`tick:campaign-sequence`）を取る。取れなければ `tick_busy` |
| 1 回限り | ハンドラに繰り返しが無い（`confirm` + `apply=true` が要る）|

⚠️ 開けるのは**スケジューラ判定 1 つだけ**。停止手段
（`MARKETING_SEQUENCE_ENQUEUE_ENABLED` / `MARKETING_CAMPAIGN_DISPATCH_ENABLED` /
`rolloutKill`）は**そのまま効く**（閉じていれば `gates_closed` で止まる）。

下見は**本番の tick と同じ関数**（`runSequenceTick({dryRun:true})`）を通り、
**予約より手前で返る**ので 1 バイトも書かない。応答に

```
うち prospect / うち Customers / 出所不明（送らない）/ 絞り込み後に送る人数
```

が出るので、**送る前に prospect が確実に入ることを数字で確認できる**。

#### 下見は**窓で切る**（2026-09-14 追加）

母数が 1 万件規模なので、下見を 1 回で終わらせると同期 Function の 30 秒を超える
（実測 **504 / 31 秒**）。`scope` / `offset` / `limit` / `digest` / `ledgerOffset` / `scanPages`
で 1 回の呼び出しを短く切り、**呼び出し側が全窓を合算**する。

| 引数 | 意味 |
|---|---|
| `scope` | `prospect` / `customer`（見ない側は**1 件も読まない**）|
| `offset` / `limit` / `digest` | prospect 索引の窓（`prospectSequenceCheck` と同じ刻み方）|
| `ledgerOffset` / `scanPages` | 配信台帳の窓（既定 2 ページ）|

応答の `window.nextOffset` / `window.nextLedgerOffset` が null になるまで繰り返す。
**`digest` が変わったら中止**して最初から取り直す（fail closed）。

⚠️ **下見は走査カーソルも集計も書かない。** 以前の実装は下見なのに
`scanStore.write` と `sequenceMetrics` を書いており、**本番 tick の進み位置を動かしていた**。
「read-only の下見」を名乗る以上どちらも書かない。

⚠️ 絞り込みは**減らす方向にしか働かない**。除外（配信停止・バウンス・購入済み・反応なし）・
`DeliveryKey` の冪等性・送信直前再検証は**一切変わらない**（既存の単一源のまま）。

### キュー登録は「書けたつもり」で終わらせない（2026-09-14 追加）

1. 配信行の upsert は**応答を見る**
2. 書いたあと**読み戻して確かめる**
3. 確かめられなければ、その tick で作ったジョブを**取り消す**（prospect の予約も戻す）
4. 積む前に、**名指しで**既存の配信行（`queued` / `sent`）を突き合わせる
   （台帳の窓読みだけに頼ると、窓の外にある行を見落として同じ人を積み直す）

検証: `npm run test:marketing`（`sequenceQueueIntegrity.guard.test.mjs` / `fullAutoOperation.test.mjs`）

## 6. 管理画面（`/admin/premium-plus-eligibility/`）

「セグメントの下見」の下に連続配信パネルがある。**送信前に**次を確認できる。

- キャンペーン名 / 自動配信 ON・OFF（OFF なら不足している env 名）/ 最大配信回数
- 対象人数（母数）/ 次に送れる人数（ステップと人数）/ 待機中 / 次回予定
- 配信完了 / 自動停止（**購入・反応なし・配信停止/バウンス・条件変化**の内訳）
- ステップごとの件名・間隔・**queue 済み / いま送れる**人数
- 各ステップの「文面を見る（実際に届く HTML）」= `action:'preview'` の HTML をそのまま iframe 表示

判定は全部サーバー（`sequenceProgress.js`）。**画面は数字を出すだけ**で再判定しない。

## 7. 運用手順（本番 / **通常は「何もしない」**）

**通常運用で人がやることは無い。** step2 以降の enqueue も dispatch も cron が進める。
人が触るのは次の 2 つだけ。

### 7-0. 新しい連続配信を始めるとき（step1 だけ）

1. 管理画面で「状況を見る」→ 対象人数を確認
2. 「文面を見る」で**実際に届く HTML**を確認
3. `dryRun`（`step` 必須）→ 除外理由・人数・fingerprint を確認
4. `send` で step1 を開始する

以後の step2 / step3 … は**自動**。管理画面から手で enqueue しない。

### 7-0-b. 異常が起きたとき

上の「止め方」で止め、原因を直してから戻す。
**「安全のため毎回 OFF に戻す」は禁止**（通常状態は ON）。

> 🚫 **旧方式（廃止・現行手順として読まない）**
> 配信のたびに `MARKETING_*` を開ける → 送る → `UNSET` して再閉鎖 → redeploy、
> `MARKETING_SEQUENCE_ARMED` に当日日付を毎日入れ直す、
> light / premium は人数が少ないので管理画面から手で enqueue する。
> これらは 2026-09-14 の MK 確定で**通常運用から外した**。

### 7-1. Step1 の直前確認（`preflight:light-trial-step1`）

Step1 は**母集団が最大**で、押した後に残る行（ScheduledEmails / CampaignDeliveries）も
いちばん多い。承認を取る前に**機械で前提を固定**する。
**1 回きりの道具ではなく、次のコホートの Step1 でも同じように使う。**

```bash
# 読むだけ。書き込み・送信・env 変更はしない（終了コード 0 = 押してよい / 1 = 不可）
MARKETING_ADMIN_SECRET=… npm run preflight:light-trial-step1 -- --expect 100
```

判定は `src/lib/marketing/step1Preflight.js`（純粋）。**母集団を自分で作り直さない**のが要点で、
`admin-marketing` の read-only アクション
（`sequence` / `duplicateCheck` / `trialGrant` / `jobs`）の答えを**検算するだけ**。
作り直すと画面の人数と preflight の人数がズレる。

#### 🛡️ 重複判定は campaign 単位ではなく **cohort 単位**

「この campaign のジョブが 1 つでもあれば止める」という判定は、
**1 回でも Step1 を流したら二度と通らない**。コホートは何度も来るので、
それでは 2 回目以降の Step1 を永久に承認できない。

見るのは「この campaign を過去に流したか」ではなく
「**いま選んでいる相手に、その通が既に出ているか**」。判定単位は不変キーの
**`DeliveryKey`（campaign × version × step × 受信者）**で、
**送信経路（`handlePlan`）が `already_delivered` に使う鍵と同一**。

`action=duplicateCheck`（read-only）が、`sequence` の確定した候補 `recordIds` だけを受け取り、

1. 宛先を `recordId` で名指し取得 → 各候補の `DeliveryKey` を計算
2. **その鍵の配信行だけ**を名指し取得（台帳の大きさに依存しない）
3. 候補に紐づくジョブの状態だけを確認
4. **送信待ちのジョブだけ**を引き（`AND({Status}='PENDING', <marketing 判定>)`）、
   その `Recipients` を現在候補と突き合わせる

を行い、**件数と状態の内訳だけ**を返す（アドレス・recordId・DeliveryKey は返さない）。

> ⚠️ **4 が要る理由**: `CampaignDeliveries → ScheduledEmailJobId → ScheduledEmails` と
> 辿るだけでは、**配信行が欠けているジョブ**が見えない。キュー登録は
> 「ジョブ行を作る → 配信行を upsert」の順なので、途中で落ちると
> **PENDING ジョブだけが残り配信行が無い**（＝本当の orphan）。見逃すと同じ人へ
> 2 通目を積む。`PENDING` は「いま詰まっているキュー」なので件数が小さく、
> campaign の全履歴走査にはならない。campaign / version の同一性を確認し、
> step の同一性は**内容 hash**で見る。

候補数の上限は `DUPLICATE_CHECK_MAX`（= `MAX_RECIPIENTS_PER_SEND`）。
**判定と表示で同じ定数**を使い、応答に `limit` / `given` を返す。
`recordIds` に重複があれば 400 で fail closed。

止まる条件（critical。1 つでも落ちたら押さない）:

| 見るもの | 落ちる条件 |
|---|---|
| 次のステップ | Step1 以外が来ている |
| 人数 | `--expect` と不一致（**増えていても止める**）/ 0 名 / 上限で切り捨て |
| **候補の重複** | `alreadyDelivered > 0`（その相手に既に queued/sent の鍵がある） |
| **候補のジョブ** | `pendingCandidates > 0`（候補が送信待ちジョブに載っている。**配信行が無くても検知**） |
| **配信行の整合** | `pendingLinkedJobs > 0`（配信行が送信待ちジョブを指している） |
| **判定不能** | `unresolved > 0`（顧客が引けない／メールが無く鍵を作れない）/ 応答なし |
| 進行 | `dueByStep[step] ≠ 対象数` / 検算が合わない |
| 関所 | `outstandingStep1 ≠ 対象数` |
| ゲート | **実送信が開いている**（登録した瞬間に飛ぶ）/ 段階と `sendEnabled` が食い違う |
| 自動配信 | cron が動く状態になっている |
| 除外材料 | 配信基盤の停止リストを確認できない（**fail closed**） |
| 応答 | `sideEffects` が `none` でない（書き込み経路を叩いた） |

**止める理由にしないもの**（info として必ず表示する）:

- この campaign を過去に流したこと（`sentByStep[step] > 0`）。
  母集団には前回コホートの受信者も含まれるので、**0 でないのが正常**
- 同 campaign の過去ジョブが `jobs` に見えること

> ⚠️ **`jobs` は新しい順に一部だけ返す**（2026-08-15〜）。
> ここから「無い」を推測しない。重複判定は `duplicateCheck` が正で、
> `jobs` は「実送信を開けたら何が飛ぶか」を見る**参考**にとどめる。

> ⚠️ **CI には入れない**（`check:safety` から本番の管理エンドポイントを叩かないため）。
> 判定ロジックの単体テストだけが `test:marketing` 経由で CI に乗る。

**現在の状態（2026-08-15）**: `light-trial-2026-08-13` の 10 名は Step1 を
**キュー登録済み**（PENDING / 未送信）。この状態で preflight を走らせると
「次が Step1 でない」「対象 0 名」で**正しく止まる**。
仮に同じ 10 名を候補へ入れても、`duplicateCheck` が
`alreadyDelivered=10` / `pendingCandidates=10` を返して**必ず落ちる**
（配信行が消えていても、送信待ちジョブの `Recipients` 側で検知する）。
一方、**まだ Step1 を出していない次のコホートには通る**
（過去ジョブがあっても、`jobs` が窓で切られていても）。

### 7-2. 実送信の排他（同一ジョブの二重起動を止める）

`marketing-campaign-dispatch` の live は

```
① CampaignDeliveries を読む → ② alreadySent を作る
→ ③ SendGrid へ送る → ④ sent を Airtable へ記録
```

の順で進む。①〜④ の間に**同じ jobId の live がもう 1 本**走ると、両方が
「まだ誰も送っていない」を読み、両方が `expectedWillSend` を通り、
**同じ相手へ 2 通**送れる（二重クリック / HTTP retry / Function の並行起動）。
**「逐次再実行には冪等」だけでは塞げない。**

対策は Redis の原子的排他（`src/lib/marketing/dispatchLock.js`）。
**新しい外部サービスも新しい本番 env も増やさず**、既に本番で動いている
`UPSTASH_REDIS_REST_*` と `automationStore.js` の `SET NX EX` + fencing token +
Lua（`LOCK_VERIFY_LUA` / `LOCK_RELEASE_LUA`）をそのまま共有する。

| 性質 | 実装 |
|---|---|
| 同一 jobId は 1 本だけ | `SET <key> <token> NX EX` |
| jobId ごとに独立 | 鍵は `ak:marketing-dispatch:lock:<jobId>` |
| 自分の token でしか解放しない | Lua で `GET` → 一致時のみ `DEL`（atomic） |
| 送信直前の再確認 | SendGrid を叩く前に `verify()`。奪われていたら **1 通も送らない** |
| 途中異常でも解放を試みる | 実行後に必ず解放を試み、**解放そのものが例外でも送信結果を失わない** |
| 解放失敗を「成功」にしない | 応答に `lockRelease: {ok, reason, retryAfterSec}` と `warning` を返す |
| 取得失敗・状態不明 | **送信 0・書き込み 0**（`409 busy` / `503 unavailable`） |
| dryRun | 鍵を取らない（何本走ってもよい） |

**解放に失敗したとき**（応答の `lockRelease.ok === false`）:

- **送信結果は事実どおり**（`sent` を 0 へ巻き戻さない）。巻き戻すと運用者が
  「送れていない」と読んで**もう一度送る**
- **`warning` の文言も事実に合わせる**。dispatch は送信前に 409（人数不一致・鍵の奪取）や
  503 で止まることがあり、そのとき `sent` は 0。一律に「送信は完了しています」と書くと
  「送れたのに解放だけ失敗した」と誤解させる（逆方向の事故）
  - `sent > 0` … 「**N 通の送信処理は完了していますが**、実行ロックを解放できませんでした」
  - `sent === 0` / 不明 … 「**メール送信は行われていません。**実行ロックを解放できませんでした」
- 鍵が残っている間、同じジョブの再実行は `409 busy` で弾かれる。
  **TTL（約 300 秒）が切れるまで再実行しない**。`retryAfterSec` は目安
- **自動で再実行しない。** 応答の `warning` にもそう書く
- TTL 明けに再実行しても、最後の砦として**既送信者は `sent` 判定で除外**される

**TTL 切れの安全性**: TTL は 300 秒で、Netlify Function の上限 26 秒より十分長い。
よって「送信中に TTL が切れて別実行が入る」ことは構造的に起きない。
それでも送信直前の `verify()` で奪取を検知する。

**採用しなかった案**:
- Netlify Blobs — read-after-write が eventual で、排他の判定に使えない（2026-07-16 実測）
- Airtable の `PENDING → PROCESSING` 更新 — CAS ではない（読んで書くまでに別実行が同じ遷移を書ける）

⚠️ 鍵に入れてよいのは `jobId` だけ。**アドレス・secret は 1 文字も入れない**
（`jobId` は `mkt-<campaign>-v<n>-<fingerprint>-<index>` で PII を含まない）。

### 7-3. キュー登録の rollback

| 状態 | 戻し方 |
|---|---|
| PENDING のジョブ | 管理画面 / `action=cancelJob`（**PENDING だけ**取り消せる。`operationId` 必須・冪等） |
| `queued` の配信行 | cancelJob が同時に処理する。**`sent` の行には 1 バイトも触らない** |
| SENT のジョブ | 取り消せない（送った事実）。`MARKETING_CAMPAIGN_DISPATCH_ENABLED` が閉じていれば SENT にならない |
| Customers | **触っていない**ので戻す対象が無い（送信側は Customers を書かない） |

再実行の冪等性は 3 段:

1. `deliveredKeys`（sent/queued の DeliveryKey）で `already_delivered` として除外
2. 除外の結果 0 名になれば `送信対象が 0 件です`（400）で**書き込み前に止まる**
3. CampaignDeliveries は `performUpsert(DeliveryKey)`。同じ人に 2 行作らない

加えて `planFingerprint` が対象集合と文面を封じているので、
dry-run から母集団が変わっていれば 409 で中止する（TOCTOU 防止）。

### 7-4. 大規模展開（14,479 名を段階展開する）

100 名/日の固定運用では 145 日かかり、毎回 env を開閉して redeploy する必要がある。
段階展開・時間予算・数十通ポリシー・運用画面は
**[`MARKETING_ROLLOUT.md`](./MARKETING_ROLLOUT.md)** が単一源。

要点だけ:

- **二段のスイッチ**: env（機能の許可・既定 OFF）と 状態（段階・件数・緊急停止・redeploy 不要）
- **送信は時間で切る**: 同期 18 秒 / background 8 分。ジョブは完了するまで `PENDING` のまま
- 大きいジョブは `marketing-campaign-dispatch-background` が完走させる
  （**送信経路は同期版の `runDispatch` を再利用**。自前の送信ループを持たない）
- 数十通は `sequencePolicy.js`（最大回数・最小間隔・頻度上限・訴求角度・反応での停止）
- 運用画面は `action=rollout`（read-only・件数だけ）

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

**入口を自動化する場合**（4 ゲートを開けたときだけ）

```
cron-light-trial-grant が 1 日 1 回:
  ① 候補を **Airtable 側で絞って必要な分だけ**読む（Email 昇順・全件走査しない）
  ② **関所**: 自動付与で配って体験中の人だけを読み、Step1 が片付いたか数える（read-only）
     → 未処理が 1 件でもあれば **waiting_for_step1 で終了**（付与しない）
  ③ 取得した中から候補を確定（過去付与・有料・期限なし付与・付与中・配信不可を除外）
  ④ **先頭 100 件だけ**付与（← Customers へ LightGrant* を書く。buildComebackPlan が正本）
  → 残りは翌日以降の実行が順に処理する（offset は持たない）
  → **キューも送信も作らない。** Step1 は管理画面から別途

運用のリズム: 付与 100 名 → 管理画面で Step1 を dry-run → キュー登録 → 翌日の付与が進む
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

**既定 OFF。4 つのゲートが全て開くまで Customers へ 1 バイトも書かない。**

| # | env | 意味 |
|---|---|---|
| 1 | `COMEBACK_GRANT_FIELDS_READY=1` | 既存の付与ゲート（列の実在） |
| 2 | `COMEBACK_GRANT_ENABLED=true` | 既存の付与ゲート（実行許可） |
| 3 | `LIGHT_TRIAL_AUTOGRANT_ENABLED=true` | 自動化の許可 |
| 4 | 当日ぶんの武装 | **env には置かない**。展開状態（Redis）の `alwaysArmed` / `armedFor` から `cron-marketing-rollout` が差し込む |

1・2 は**手動付与と同じゲートを再利用**する（自動化のための抜け道を作らない）。

> 🚫 **旧方式（廃止）**: `LIGHT_TRIAL_AUTOGRANT_ARMED=<当日 JST>` を env に置き、
> **毎日書き換えて redeploy** する運用。人が毎日 env を触る運用は続かないので、
> 武装の置き場所を env から展開状態（Redis）へ移した。redeploy 不要で管理画面から即時に変えられる。

> ⚠️ **配信系ゲート（`MARKETING_CAMPAIGN_ENABLED` / `MARKETING_CAMPAIGN_DISPATCH_ENABLED`）は
> 要求しない。** この経路は**権利を付けるだけ**でメールを 1 通も作らないため、
> 権利を配るのに配信を開ける必要がない（開ければ事故の範囲が広がるだけ）。

### 付与と送信は完全に分離する

```
cron-light-trial-grant : Customers の LightGrant* を書く。**キューも送信も作らない**
Step1 の送信          : 管理画面の dry-run → キュー登録（別工程・別ゲート）
```

Step1 の対象は「**無料期間中であること**」で決まる（`requiresActiveGrant`）。
付与に失敗した人は権利が無いので、**Step1 の対象に入りようがない**。
「付与に成功した人だけ送る」は運用手順ではなく**構造**で保証されている。

### 段階実行（14,000 件規模でも全体 abort しない）

1 回の実行では**未付与の候補の先頭 N 件だけ**を処理する。

| 項目 | 値 |
|---|---|
| 既定 | **100 件/回** |
| 変更 | `LIGHT_TRIAL_AUTOGRANT_BATCH_SIZE`（任意） |
| 絶対上限（hard max） | **500 件**。超える指定は**実行しない**（fail closed） |
| 壊れた指定 | `abc` / `0` / `-5` / `10.5` などは**実行しない**（空文字だけは未設定扱い） |

- **offset の正本を作らない。** 付与すると `LightGrantedAt` が入って
  **Airtable の formula から外れる**ので、再実行すると自然に次の N 件へ進む
- 失敗した人は候補に残るため、**次回そのまま再評価**される
- 並びは **`Email` 昇順**で決定的（重複解消済みで一意）。同じ本番状態なら毎回同じ N 件・同じ `planFingerprint`
- **同一顧客への二重付与は起きない**（候補判定 + `operationId` の二重防御）

### 🛡️ 全件走査をやめた（2026-08-12）

Customers 15,962 件・コホート 14,489 件に育ち、全件走査は**動かなくなっていた**。

| 経路 | 旧実装の壊れ方 |
|---|---|
| cron | `MAX_PAGES=60`(6,000件) を超えて `customers_fetch_truncated` で**必ず落ちる** |
| 管理画面の下見 | `MAX_PAGES=40`(4,000件) で**黙って打ち切り**、コホート 3,629 / 候補 3,588 と過少表示（真値 14,489 / 14,320）|

145 ページの取得は実測 ~41 秒で、関数タイムアウトにも収まらない。そこで
**「全体を数える」のをやめ「次の N 人を取る」**に変えた（正本 `lightTrialSelection.js`）。

- **超集合の原則**: formula は `checkAutoGrantCandidate` が通す人を **1 人も落とさない**。
  落とすとその人は永久に候補へ出てこない。総当たりテストで固定している
- **退会（`WithdrawalRequested`）を formula に書かない**。`resolveSendability` は退会を
  suppression にしていない（契約状態であってメール拒否ではない）
- **有料判定も formula に書かない**。`resolveEntitlements` の組み合わせ判定なので
  列だけの近似は過剰除外になりやすい。JS 側で落とす
- **silent truncation を作らない**。上限に達したら `candidate_scan_limit` /
  `barrier_scan_limit` で **fail closed**（付与しない）

#### 正確な残数は出さない

全件を数えないので `remainingExact` は **`null`** を返す。代わりに **`moreAvailable`**
（まだ候補があるか）と `pagesFetched` / `recordsFetched` を返す。
画面にも「残り（正確な数）: 未算出」と出す。**推測値を残数として出さないこと。**

### 関所: 案内していない付与を溜めない（read-only barrier）

付与と送信を分けた結果、**Step1 をまだ案内していないのに次の 100 名へ付与が進む**と、
使われないまま無料期間 30 日だけが減る人が積み上がる。そこで関所を置く。

```
outstandingStep1 > 0 の間は、次の付与バッチを実行しない（abort: waiting_for_step1）
```

- 対象は **自動付与で配った人**（`ComebackGrantSource = light-trial-autogrant`）のうち
  **いま Light 無料期間中**の人
- **`CampaignDeliveries` は read-only で参照するだけ。**
  この経路はキュー登録も送信も**絶対にしない**
- 判定に使う DeliveryKey は Step1 のもの（`campaign × version × step1 × 受信者`）

**片付いた（resolved）とみなす条件** — 送信できない人が関所を**永久に塞がない**ため:

| 条件 | 理由コード |
|---|---|
| Step1 が **queued / sent** になった | `step1_queued` |
| 配信停止・バウンス・停止アカウント等（`sendable !== true`） | `not_sendable` |
| 配信基盤の suppression に載っている | `provider_suppressed` |
| 有料契約が成立した（目的達成） | `purchased` |
| 無料期間が終了・取消（もう体験中でない） | `grant_ended` |

`planFingerprint` には**関所の状態も混ぜる**（同じ 100 件でも、関所が開いているかで
実行の意味が違うため）。待機中は指紋を出さない。

### 下見と実行が同じものを見る

管理画面の下見も cron の実行も **`loadAndPlanLightTrial()` の 1 本**を通る。
formula / sort / 関所の集合 / `planFingerprint` が**構造的に一致する**。

下見が返すもの: 今回処理予定 / batch size / 除外理由別 / `pagesFetched` /
`recordsFetched` / `moreAvailable` / **`remainingExact: null`** /
`planFingerprint` / 1 回の上限と hard max / 自動付与ゲートの状態 /
**関所（`outstandingStep1` / `resolved` / `nextBatchAllowed` と片付いた内訳）**。

> ⚠️ **scheduled function は本番から HTTP で叩けない**（Netlify が 403 で塞ぐ）。
> したがって **本番の正規 dry-run は管理画面の `action='trialGrant'`**（read-only）。
> cron 側の `{"dryRun":true}` はローカル・テスト用と考えること。

下見だけ「もし N 件なら」を試せる（`batchSize` を渡す）。**実行には効かない**（env が正本）。

```bash
POST /.netlify/functions/admin-marketing
  x-admin-secret: <MARKETING_ADMIN_SECRET or PREMIUM_PLUS_ADMIN_SECRET>
  { "action": "trialGrant", "batchSize": 10 }
```

```bash
# 管理画面の「無料体験の入口を数える（付与しません）」と同じ内容
POST /.netlify/functions/cron-light-trial-grant
  x-admin-secret: <COMEBACK_ADMIN_SECRET or PREMIUM_PLUS_ADMIN_SECRET>
  {"dryRun": true}
```

どちらも**ゲートが閉じていても実行でき、1 バイトも書かない**。

## 9-5. 入口の自動開始（`sequence.autoStart` / 2026-09-14〜）

**無料登録から DRM が自動で始まる**ための宣言。これを持つ campaign だけ step1 を自動で撃てる。

```js
sequence: {
  autoStart: { kind: 'free_signup', withinDays: 14, maxPerTick: 50 },
}
```

| | |
|---|---|
| ゲート | 既存 4 枚 ＋ **`MARKETING_DRM_AUTOSTART_ENABLED=true`**（既定 閉）|
| 候補 | `CREATED_TIME()` で絞った bounded read。**新しい列を足していない** |
| 窓 | 登録から `withinDays` 以内。**遡って一斉に撃たない** |
| 上限 | 1 回 `maxPerTick` 名。超過は `carriedOver` で次回へ（**黙って捨てない**）|
| 並び | recordId 昇順で決定的（同じ入力なら毎回同じ対象）|
| 選定 | `drm/drmAutoStart.js`（純粋）。**新しい停止条件を作らない** |

**入口に入れない条件**（既存の単一源の結果をそのまま使う）:
配信停止・バウンス等で送れない / すでに有料 / 対象条件に合わない /
**すでに 1 通でも受け取っている** / 窓の外 / 段が違う / **登録時刻が読めない**。

### ⚠️ 入口は**共有スケジューラから分離**した（2026-09-14）

本番の実測値がこうだったため、入口を `cron-campaign-sequence` に相乗りさせられなくなった:

| env | 実測 |
|---|---|
| `MARKETING_SEQUENCE_SCHEDULER_ENABLED` | **`false`**（4 ゲートの 1 枚が閉）|
| `MARKETING_SEQUENCE_CAMPAIGN_ID` | `campaign-discount-free,-light,-premium` |

DRM の入口（無料登録者 15 名）を開けるには scheduler を true にするしかなく、
その瞬間に**割引 3 本が tick される**（step1 は 15,509 通配信済み・**step2 は保留中**）。
15 名のために数千通のリスクを負う構造だった。

そこで **`cron-drm-autostart.js`** を別 Function として置いた。

| | |
|---|---|
| 入口のスイッチ | **`MARKETING_DRM_AUTOSTART_ENABLED` だけ**。`MARKETING_SEQUENCE_*` は**1 つも読まない** |
| 対象 | **固定の許可リスト**（`DRM_ENTRY_CAMPAIGN_IDS` = `free-signup-onboarding`）。割引 3 本は**構造的に選べない** |
| 送信の土台 | `MARKETING_CAMPAIGN_ENABLED` / `..._DISPATCH_ENABLED` は**既存のまま尊重**（安全装置を迂回しない）|
| キュー登録 | **作り直さない**。`runSequenceTick` に委ねる（`DeliveryKey` の二重防止・購入/停止の除外・配信行の読み戻し確認・失敗時のジョブ取消をそのまま使う）|
| 定期実行 | **1 日 1 回**（10:00 JST）。ゲートが閉じている間は何も起きない |
| 人数の確認 | 手動実行は `expectedCount` 必須。**下見と 1 でも違えば 1 通も送らない** |

⚠️ **共有スケジューラの env（`SCHEDULER_ENABLED` / `CAMPAIGN_ID`）は別任務の状態**。
   この Function は読まないし、運用でも変えない。

#### ⚠️ scheduled Function は**本番 URL から直接起動できない**（2026-09-14 本番実測）

`export const config = { schedule }` を持つ Netlify Function は**定期実行専用**で、
公開 URL への POST は **403・本文 0 バイト**で弾かれる。**認証の有無に関係なく**、
**payload も渡せない**（`dryRun` / `expectedCount` を外から指定できない）。

したがって担当を分ける:

| 経路 | 担当 |
|---|---|
| `cron-drm-autostart`（scheduled）| **定期実行（1 日 1 回）**。`dryRun:false` / `manual:false` |
| `admin-marketing` の `action:'drmEntryRun'` | **手動の下見・人数を確認して撃つ**（HTTP 到達可・secret 認証済み）|

どちらの経路も **同じ `runDrmEntry()`** を通る（判定・許可リスト・`expectedCount`・
委譲先は 1 つ）。

```bash
# 下見（同期・ゲートが閉じていても返る・書き込みゼロ）
curl -X POST .../admin-marketing -H 'x-admin-secret: …' \
  -d '{"action":"drmEntryRun"}'

# 実行（Background を 202 起動するだけ。結果はこの応答に**含まれない**）
curl -X POST .../admin-marketing -H 'x-admin-secret: …' \
  -d '{"action":"drmEntryRun","dryRun":false,"expectedCount":16}'

# 許可リストの効きだけを確かめる（**送信 0**・ゲートが閉じていても返る）
#   ⚠️ **窓で切る**。1 窓目は offset なし
curl -X POST .../admin-marketing -H 'x-admin-secret: …' \
  -d '{"action":"drmEntryAllowlistCheck","limit":2000,"scanPages":2}'

#   2 窓目以降は 1 窓目が返した next.* と planner* を**必ず**渡す
curl -X POST .../admin-marketing -H 'x-admin-secret: …' \
  -d '{"action":"drmEntryAllowlistCheck","limit":2000,"scanPages":2,
       "offset":2000,"digest":"<next.digest>","ledgerOffset":null,
       "plannerCount":3,"plannerDigest":"<1 窓目の plannerDigest>"}'
```

#### `action:'drmEntryAllowlistCheck'`（read-only）

2026-09-14 の事故（承認 16 名に対し Recipients 50 / SentCount 46）の直しは
**最終 recipient 集合を許可リストで縛る**こと。それが効いているかを、
**1 通も送らずに**本番で確かめるための経路。

中身は既存の 2 つを繋いだだけで、**新しい候補選定・送信判定・queue 処理は作っていない**。

1. **その窓でも** `previewEntry` を走らせ直して recordId の許可リストを作る（fresh）
2. 許可リストの**指紋**（`plannerDigest`）を採る。1 窓目と違えば **fail closed**
3. **同じ呼び出しの中で** `runSequenceTick({ dryRun: true, entryAllowlist, preview })` を実行
4. その窓の最終人数 / 出所内訳 / 許可リスト外の残り / 続きの位置を返す

### 窓契約は `sequenceTickPreview` と同じ

`scope` / `offset` / `limit` / `digest` / `ledgerOffset` / `scanPages`。
**別の刻み方を作らない**（片方だけ直したときに意味がズレる）。

窓で切らずに呼ぶと prospect 索引（約 12,000）を一度に読み、同期 Function に収まらない
（2026-09-15 に **504** を実測。書き込みは 0 だった）。

`next.offset` / `next.ledgerOffset` が**両方 `null`** になるまで続ける（`next.done: true`）。

### 合否の決め方（**足さない**）

⚠️ **窓ごとの `finalRecipients` を単純加算して判定しない。**
同じ許可リスト対象は窓をまたいで何度も観測されるので、足した数には意味が無い。
安全条件は「**固定した `plannerDigest` の集合の外へ出ていない**」こと。

| 条件 | 期待 |
|---|---|
| `plannerCount` / `plannerDigest` | **全窓で同じ**（違えば `planner_changed` で最初からやり直し）|
| `entryAllowlist.許可リスト外の残り` | **全窓で 0** |
| `最終対象の出所.prospect` | **全窓で 0** |
| `finalRecipients` | **全窓で `plannerCount` 以下**（減るのは許容・増えるのは禁止）|
| `window.prospectSkipped` | `prospect_index_changed` なら**不合格**（読み飛ばしを合格にしない）|
| `next.done` | **`true` になるまで「効いている」と言わない** |
| `sideEffects` | **全窓で `none`** |

判定の正本は `src/lib/drm/drmAllowlistWindow.js`
（`digestRecordIds` / `assertPlannerStable` / `judgeWindow` / `mergeWindowRun` / `finalizeWindowRun`）。

### 守っていること

⚠️ 下見は**予約（`claimDelivered`）より手前で return する**ので、
下見カーソル / `sequenceMetrics` / claim / queue / `CampaignDeliveries` /
`ScheduledEmails` / provider 送信は**すべて書かない**。
⚠️ ゲートは**合成しない**（live 経路と違い `scheduler=true` を作らない）。
⚠️ `campaignId` を明示で渡すので **割引 3 本は一切 tick されない**。
⚠️ 排他ロックは**取らない**（確認が live の邪魔をしない）。
⚠️ 応答に **recordId もメールアドレスも出さない**（集合の同一性は指紋だけで見る）。

#### ⚠️ 重い処理は Background だけが実行する（2026-09-14 の 504 を受けて）

入口の live を同期 Function で走らせたら **HTTP 504**（書き込みは 0 だったが完走せず）。
**scheduled Function は 30 秒**で切られるので日次経路も同じ問題を持つ。
そこで**手動 live も日次自動も、同じ `drm-entry-background` へ委譲**する。

| | |
|---|---|
| 実行するのは | **`drm-entry-background` だけ**（最大 15 分）。`runDrmEntry()` をそのまま呼ぶ |
| payload | `campaignId` / `expectedCount` / `manual` / `runId` **だけ**（アドレス・recordId を持たせない）|
| 再確認 | Background 側で**改めて** DRM gate / 土台 gate / 許可リスト / `expectedCount` / 購入・停止 / 既送信 / `DeliveryKey` |
| 排他 | 入口の鍵 TTL **960 秒**（Background 最大 900 秒を覆う）。共有 cron の 240 秒を流用しない |
| 結果 | **202 即返しで返らない**。`CampaignDeliveries` / `ScheduledEmails` / `action:'drmProgress'` / 関数ログで確認 |

⚠️ **手動実行は `expectedCount` が必須**（`manual: true` で強制）。
付け忘れたら `expected_count_required` で止まり、**1 通も出ない**。

### 下見（送らずに数える）

管理画面 `/admin/drm/` の「入口の下見」、または
`admin-marketing` の `action: 'drmAutoStart'`。
**ゲートが閉じていても返る**（開ける前に中身を確認するため）。
**1 バイトも書かない**・アドレスは返さない。

⚠️ 入口の候補が読めなくても、**進行中の配信は止めない**（入口だけ開かない）。

## 9-2. 現行のシーケンス

### `free-signup-onboarding`（無料登録者 育成 / 全 6 通・**DRM の入口**）

| step | 間隔 | 役割 | CTA |
|---|---|---|---|
| 1 | 開始時 | ご登録のお礼と入口 | 無料予想を見る |
| 2 | +2 日 | 予想ページの見方 | 今日の予想で使い方を確認する |
| 3 | +3 日 | 直近の実績 | 的中実績アーカイブを見る |
| 4 | +7 日 | 買い目の考え方（メインレース 5 点） | 今日の買い目を見る |
| 5 | +14 日 | プラン比較 | プランを比較する |
| 6 | +21 日 | 上位プランの機能 | 上位プランの機能を見る |

- 対象は **無料・契約なし**（`audienceRule` で enforce）。**付与も価格提示もしない**
- **入口が自動で開く**（`sequence.autoStart` / §9-5）
- **反応別 routing**: 開封 → step5（プランの違い）/ 到達・未開封 → step3（実績）
- 購入（Light / Premium / 三連複のいずれか）で停止する
- 文面は既存ステップメール `newsletter/step-sequences.js` の `signup-onboarding` を移送したもの。
  旧側は **`supersededBy` で live 送信を拒否**する（同じ 6 通が二度届かないように）

### `light-to-premium-sequence`（Light ご利用中 → Premium / 全 4 通）

| step | 間隔 | 役割 | CTA |
|---|---|---|---|
| 1 | 開始時 | 見られる範囲の違い | プランの内容を確認する |
| 2 | +7 日 | 料金の考え方 | 料金を確認する |
| 3 | +7 日 | 直近の買い目と結果 | 南関の結果を見る |
| 4 | +7 日 | レース数を増やしたい場合 | プランの内容を確認する |

- 対象は **Light が有効な方**。⚠️ 停止は `premium` / `sanrenpuku` の購入だけ
  （`light` で止めると 1 通目の直後に全員停止する）
- 分岐: 開封 → Step4（検討の材料へ前倒し）/ 到達・未開封 → Step3（記録で入口を変える）
- 文面は承認済み `postExpirySteps.js`（Step9/10/13/17）の流用。**前提の 1 行 × 2 箇所だけ**編集

### `sanrenpuku-upsell-sequence`（Premium ご利用中 → 三連複 / 全 4 通・**草案**）

| step | 間隔 | 役割 | CTA |
|---|---|---|---|
| 1 | 開始時 | 三連複の自動絞り込みとは | 三連複予想の詳細 |
| 2 | +7 日 | 戦略選びとオッズ確認が要らない | 自動判定の仕組みを見る |
| 3 | +7 日 | 対象の開催と使い方 | 買い目の例を見る |
| 4 | +7 日 | お支払いは一度だけ | 三連複の内容を確認する |

- 対象は **Premium が有効かつ三連複 未保有**。停止は `sanrenpuku` の購入だけ
- 案内先は既存の公開ページ `/sanrenpuku-demo/`（有料予想 4 ページが既に使用）
- ⚠️ **価格・実績数値・お客様の声は載せていない**（ページが正本）。
  根拠の対照表は `sanrenpukuUpsellSteps.js` 冒頭

### `light-trial-to-premium-sequence`（Light 無料体験 → Premium / 全 6 通）

| step | 間隔 | 役割 | 件名 | CTA |
|---|---|---|---|---|
| 1 | 開始時 | 無料体験の開始 | Lightプランを30日間 無料でお使いいただけます | ログインして使いはじめる |
| 2 | +3 日 | 使い方・買い目の見方 | メインレースの買い目の見方 | メインレースの買い目を見る |
| 3 | +5 日 | 期間中に確認してほしいこと | 無料期間中にご確認いただきたいこと | 無料期間中の予想を見る |
| 4 | +7 日 | Premium の提案 | 他のレースもご覧になりたい場合は | プランと料金を見る |
| 5 | +4 日 | 当日の見方（レース前） | （`lightTrialSteps.js`） | — |
| 6 | +4 日 | 中央（JRA）の予想 | （`lightTrialSteps.js`） | — |

> ⚠️ Step5〜6 は**末尾への追加**（`lightTrialSteps.js`）。既存 Step の鍵を変えないので再送は起きない。

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
| `drm/drmAutoStart.test.mjs` | 入口のゲート・除外理由・上限・決定性・次段接続 |
| `drm/drmFreeSignupJourney.test.mjs` | **無料登録 → 育成 → 反応別分岐 → 購入/停止**の通し |
| `drm/drmRealPathWiring.guard.test.mjs` | cron / 管理画面が反応と入口を実際に通しているか |
| `drm/drmStepMailSupersession.guard.test.mjs` | 旧ステップメールと後継 campaign が**二重送信しない** |
| `marketingStatusScan.regression.test.mjs` | 台帳 **6,110 行 fixture** でも 10 名を 10 名と数える（実ハンドラ起動） |
| `marketingStatusScan.guard.test.mjs` | 状態表示が打ち切る取得へ戻らない・fail closed の維持 |
| `step1Preflight.test.mjs` | Step1 直前確認の判定（**確認できないものを ok にしない**／queue 済みで止まる・未 queue で通る） |
| `step1PreflightScript.guard.test.mjs` | preflight スクリプトが read-only のままか（許可アクション固定） |
| `dispatchLock.test.mjs` | 実送信の排他（1 本だけ・自分の token でしか解放しない・状態不明は例外） |
| `dispatcherHandler.smoke.test.mjs` | **同時 2 本でも送信は 1 通**・Redis 不通は送信 0・dryRun は鍵を取らない |
| `rolloutPlan.test.mjs` / `rolloutStore.test.mjs` | 段階展開の判断と状態（既定停止・kill switch・CAS） |
| `sequencePolicy.test.mjs` | 数十通の間隔・頻度上限・購入で停止・訴求角度 |
| `sendBudget.test.mjs` | 送信を時間で切る（完了と打ち切りの区別） |
| `rolloutView.test.mjs` | 運用画面の集計（割合を捏造しない） |
| **`rolloutScale.test.mjs`** | **14,489 名 fixture**・100/500/1000 名チャンク・1000 通の分割送信 |
| `dispatchBackground.smoke.test.mjs` | Background でチャンク完走・排他・ゲート・PII |

## 配信台帳も名指しで読む（2026-08-15 / 状態表示の打ち切りを廃止）

Customers の全件走査は 2026-08-13 に廃止したが、**`CampaignDeliveries` 側は残っていた**。
台帳が 4,000 行を超えて育った結果（**実測 14,426 行**・`{EmailType}='campaign'`）、`fetchAll` の
`MAX_PAGES=40`（4,000 行）打ち切りに掛かり、**Step1 を 10 名ぶん登録した直後に
「送信済み 1 名 / 残り 9 名」と過少表示**した（本番実測）。

「`{EmailType}='campaign'` で絞ってあるから全件走査ではない」は**もう成り立たない**。
絞っても **14,426 行**ある（2026-08-15 実測 / 145 ページ / 162 秒）。

| 経路 | 読み方 |
|---|---|
| `handleSequence` | 受信対象の**宛先だけ**（`fetchDeliveriesByEmails`） |
| `handleJobs` | ScheduledEmails は `MARKETING_JOB_FORMULA` で絞り、配信行は **JobId 名指し** |
| `handleCancelJob` | JobId 名指し。**取れなければ 1 バイトも書かない**（部分取消の防止） |
| `loadCustomerMarketing` | 表示する顧客の**宛先だけ** |
| `handleHistory` | 母数が台帳全体なので名指し不可 → **打ち切りを例外化**（`fetchAllStrict`） |

- **状態表示は部分集合を全体として出さない。** 数えられないなら数を出さずに落とす
  （`deliveries_fetch_incomplete` / `jobs_fetch_incomplete` / `history_fetch_incomplete`）
- 取得失敗を `.catch(() => [])` で潰さない（**失敗と 0 件が区別できなくなる**）
- `fetchAll`（黙って打ち切る）で `CampaignDeliveries` / `ScheduledEmails` を読むことは
  **禁止**。`marketingStatusScan.guard.test.mjs` が検知する
- 送信経路（`handlePlan`）は元から `fetchDeliveredKeys` の名指し・fail closed なので
  **二重送信の防壁は影響を受けていなかった**（同じ 10 名の再 dryRun で `willSend 0` を実測）
- `cron-campaign-sequence.js` は元から `assertFetchComplete` で fail closed

## 受信対象は Airtable 側で絞る（2026-08-13 / 全件走査を廃止）

### 何が起きていたか

`handleSequence`（進行状況）と `handlePlan` の**引き継ぎ経路**が Customers を
**無フィルタで先頭から GET** し `MAX_PAGES=40`（先頭 4,000 件）で黙って打ち切っていた。

本番実測（Customers 15,962 件）:

| | 見えていた人数 |
|---|---|
| 旧: 無フィルタ先頭 4,000 件 | **2 / 10 名** |
| 新: 受信対象 formula | **10 / 10 名** ✅ |

この状態で queue を積むと **8 名へ案内が飛ばず、関所（`outstandingStep1`）も開かない**。

### 対処

キャンペーンは受信対象を**宣言**している。それを formula へ翻訳する
（正本 `src/lib/marketing/campaignAudienceFormula.js`）。

```
AND(
  OR( NOT({LightGrantedAt}=BLANK()), NOT({LightGrantUntil}=BLANK()),
      {LightGrantLifetime}, NOT({LightGrantRevokedAt}=BLANK()) ),   ← requiresActiveGrant
  FIND('customer-import:', {Source}) = 1                             ← requiresImportCohort
)
```

実測 **10 件 / 1 ページ / 1.4 秒**。

- **`MAX_PAGES` は増やさない**
- **並び順を `Email` 昇順で固定**（既定ビュー順に左右されない）
- **対象集合・集計・dry-run・queue 候補はすべて同じ `audience.records` から作る**
- 上限到達は `audience_scan_limit`、宣言が無いキャンペーンは `audience_not_narrowable` で
  **fail closed**。**少ない人数のまま集計も queue も進めない**
- 引き継ぎは `LightGrantOp` / `PremiumGrantOp` で**名指し**（全件走査しない）

#### 🛡️ 落としてよい人 / 落としてはいけない人

落としてよいのは、宣言に照らして**構造的に対象になり得ない人**だけ:

- `grant_required` … 無料付与の痕跡が 1 つも無い（15,962 件の大半）
- `not_in_cohort` … 取り込みコホート外

**期限切れ・取消・期限なし付与は残す**（`grant_expired` / `grant_revoked` /
`grant_lifetime` として理由付きで数えるため）。

⚠️ **配信停止・退会・購入済み・無反応除外を formula に足さないこと。**
これらは送信可否であって受信対象の定義ではなく、既存の単一源
（`resolveSendability` / `engagementPolicy` / `sequenceProgress`）が持っている。
特に**無反応除外は Customers のフィールドではない**（Redis 集計 + CampaignDeliveries 由来の
配信抑止で、Customers を書き換えないし削除もしない）ため formula では表現できない。

#### 母集団の定義が変わる点（明示）

体験を経ずに既に有料の会員（付与の痕跡なし）は受信対象に入らない。
このシーケンスの「購入・契約成立」は**体験からの転換**を数える列なので、
体験を受けていない既存有料会員をそこへ混ぜない。

### 同型箇所の棚卸し（`check:no-unbounded-scan`）

`scripts/check-no-unbounded-customer-scan.mjs` が「Customers を無フィルタで全件走査し、
上限で黙って `break` する」箇所を静的に検出する。**既知の残件は件数まで固定**してあり、
1 つでも増えると CI が落ちる。

| ファイル | 状態 |
|---|---|
| `admin-marketing.js`（trialGrant / sequence / plan） | **修正済み**（PR #320 / 本 PR） |
| `premium-plus-eligibility.js` | **修正済み**（PR #321） |
| `admin-marketing.js`（`loadCustomerMarketing`: customers / customerDetail / segments） | 残件 |
| `admin-comeback-grants.js` | 残件 |
| `admin-customer-import.js` / `admin-customer-import-run.js` | 残件（全件突合が要件。打ち切りを fail closed へ） |

---

## 11. 連続配信が「無言で止まる」4 つの原因（2026-09-08 恒久修正）

2026-08-24 開始の割引キャンペーン（3 区分・15,509 通）で、**2 通目以降が 1 通も出なかった**。
エラーも警告も出ておらず、管理画面にも異常は見えなかった。本番の read-only 調査で
**独立した 4 つの原因**が特定できたので、それぞれ不変条件として固定する。

| # | 原因 | 単一源 | 固定したテスト |
|---|---|---|---|
| 1 | 宛先条件と「購入で停止」が衝突していた | `sequencePurchaseStop.js` | `sequencePurchaseStop.test.mjs` |
| 2 | 走査カーソル（Airtable offset）の失効から自力復帰できない | `sequenceLedgerScan.js` | `sequenceLedgerScanRecovery.test.mjs` |
| 3 | step1 未送信者が step2 以降を巻き添えで止める | `sequenceAutomation.js` / `sequenceProgress.js` | `sequenceFirstStepIsolation.test.mjs` |
| 4 | 最終 step がキャンペーン期間からはみ出す定義を置ける | `sequenceWindowFit.js` | `sequenceWindowFit.test.mjs` |
| 5 | 送れない PENDING ジョブがあると、運転手が片付けを保存できず**完了ジョブを毎 tick 数え直す** | `cron-marketing-rollout.js`（正本は [`MARKETING_ROLLOUT.md`](./MARKETING_ROLLOUT.md)）| `rolloutSettleIdempotency.test.mjs` |

### 11-1. 「購入で停止」は campaign が宣言する

停止条件 `purchased` は**このシーケンスの目的を達成したか**であって、
「有料会員かどうか」ではない。**上位商品を案内するシーケンスでは、
宛先条件そのものが停止条件と一致してしまう**。

| campaign | 宛先 | 売るもの | 宣言 |
|---|---|---|---|
| `campaign-discount-free` | 無料・期限切れ | Light / Premium | 宣言なし（＝ Light or Premium で停止） |
| `campaign-discount-light` | **Light 有効** | Premium 年額 / 買い切り | `stopOnPurchase: { signals: ['premium','sanrenpuku'] }` |
| `campaign-discount-premium` | **Premium 有効** | 三連複 買い切り | `stopOnPurchase: { signals: ['sanrenpuku'] }` |

- 宣言が無い campaign は**従来どおり**（Light / Premium のどちらかが有効なら停止）
- 宣言が壊れていたら**既定へ倒す**（「止めない」に倒さない）
- **カタログに衝突する campaign を置けない**: `findPurchaseStopAudienceConflicts()` が
  「宛先が要求する権利 ∩ 停止条件」を検出し、1 件でもあればテストが落ちる

> 実測（2026-09-08）: light 5 名 / premium 13 名が step1 送信の直後から
> `stopReason: 'purchased'` で恒久停止。台帳を 1 周読み切った確定集計にも step2 の行が 0。

### 11-2. 走査カーソルは失効したら先頭から読み直す

台帳の走査は Airtable の `offset` を Redis（`ak:marketing:seq-scan:v1:<campaign>:v<n>`）へ
保存し、10 分後の tick で再利用する。**offset は短命**で失効しうる。

- 失効した offset で落ちたら、**カーソルを捨てて先頭から読み直す**（`shouldResetCursorOnFailure`）
- 5xx（Airtable 側の一時障害）は待てば直るので**カーソルを触らない**
- offset を渡していない失敗はリセットで直らないので**投げ直す**
- 復帰したら `走査カーソル復帰` をログへ出す（**無言で直さない**）

走査が重複しても送信は重複しない（冪等性は `DeliveryKey` が持つ）。読み直しの代償はページ数だけ。

> 実測（2026-09-08）: `campaign-discount-free` の集計が **2026-08-27T20:50:48Z / pass 15 /
> 読み切り前**で凍結し、10 日間 1 度も進まなかった。台帳が小さく offset を持たない
> light / premium だけが無傷だったのが決め手。

### 11-3. step1 未送信者は「除外」であって「中止」ではない

`selectNextDueStep` は**いちばん小さい due step**を返す。step1 未送信の人が 1 人でも
混ざると step が 1 になり、`planSequenceTick` が `first_step_manual` で
**tick 全体を中止**していた。

- `selectNextDueStep(progress, { excludeSteps: [1] })` … step1 の人を**候補から外す**
- 外した結果ゼロなら `excludedOnly: true` を返し、呼び出し側が
  `first_step_manual`（step1 しか居ない）と `no_due`（そもそも居ない）を区別する
- **初回接触を自動で撃たない**という契約は変えていない

> 実測（2026-09-08）: prospect 11,976 名のうち **328 名が step1 未送信**。
> そのために step2 を待っていた **11,648 名が 1 通も進まなかった**。

### 11-4. 最終 step は期間内に収まっていること

期間限定キャンペーンは期間外になると `enabled` が false になり、途中まで送った人は
`campaign_disabled` で**恒久停止**する（期間外に案内すると割引が適用されないので、
この停止自体は正しい）。**配り切れない定義を置けてしまう**のが問題だった。

- `delayDays` は直前の送信からの日数なので、最終 step は開始から**総和**日後に届く
- `disabledReason: CAMPAIGN_DISABLED_REASON.WINDOW_CLOSED` を持つ campaign は
  `CAMPAIGN_WINDOW` に収まることをテストで固定する
- 1 通目が期間の初日に出るとは限らない（本番の 1 通目は開始翌日）。
  `startedAtMs` を渡せば実運用の開始時刻で検査できる

> 実測（2026-09-08）: 期間は 8/24 00:00 〜 **9/7 00:00 JST**。
> 集計の最終更新は light `2026-09-06T14:50:44Z` / premium `14:51:14Z`（＝ JST 23:50 / 23:51）で、
> **期限の 9 分前**を最後に tick が `not_a_sequence` で即終了している。

### 11-5. 誰がどのシーケンスを進めるか（**混同しない**）

| 仕事 | 進める Function | 補足 |
|---|---|---|
| 割引 3 本を**積む** | `cron-campaign-sequence`（10 分ごと） | `MARKETING_SEQUENCE_CAMPAIGN_ID` **未設定＝有効な連続配信を全部**。値を入れるとその分だけ |
| **積まれたジョブを送る** | **`cron-marketing-dispatch`（5 分ごと）** | 2026-09-14 新設。マーケ系の PENDING を古い順に起動する |
| `light-trial-to-premium-sequence`（体験中 6 通） | **`cron-marketing-rollout`**（5 分ごと・`FOLLOW_UP`） | 展開状態（Redis）の `stage` に従う。送信起動も自分で行う |
| `light-trial-post-expiry-sequence`（体験終了後 18 通） | 同上 | `JOURNEY_PHASES` の 2 番目。`cron-campaign-sequence` は触らない |

⚠️ `MARKETING_SEQUENCE_CAMPAIGN_ID` に値を入れると、**入れた campaign しか進まない**。
通常運用では**置かない**（障害時の切り分け専用）。

⚠️ **2026-09-14 以前は「積む」だけで「送る」担当が居なかった**。
`cron-marketing-rollout` は自分が積んだジョブ（`pendingJobIds`）しか起動しないため、
割引キャンペーンのジョブは PENDING のまま 4,307 件溜まり、**step2 は 1 通も出なかった**。
`cron-marketing-dispatch` はこの欠けていた輪を埋めるもので、**消さないこと**。
