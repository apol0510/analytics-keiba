# 大規模継続配信 activation runbook（100 名カナリア → 段階拡大）

**状態: 未実行。** production env 変更・Redis 書込み・実付与・実送信はまだ 1 件も行っていない。
このドキュメントは**承認後にそのまま実行できる手順**として書いてある。

対象: `journeyId = light-trial-to-premium-v1`（体験中 6 通 + 体験終了後 18 通 = 最大 24 接点）
実装: PR #348（squash `5cfeb22b`）本番反映済み・全ゲート OFF

---

## 1. activation preflight（production env の現状 / 2026-08-15 実測）

値は表示せず、設定の有無だけを確認した。

| # | 工程 | env | 現在 | activation で必要 | 変更 |
|---|---|---|---|---|---|
| 1 | 付与（列の実在） | `COMEBACK_GRANT_FIELDS_READY` | `1` | `1` | **不要** |
| 2 | 付与（実行許可） | `COMEBACK_GRANT_ENABLED` | `true` | `true` | **不要** |
| 3 | 付与（自動化の許可） | `LIGHT_TRIAL_AUTOGRANT_ENABLED` | UNSET | `true` | **要設定** |
| 4 | キュー登録 | `MARKETING_CAMPAIGN_ENABLED` | UNSET | `true` | **要設定** |
| 5 | 実送信 | `MARKETING_CAMPAIGN_DISPATCH_ENABLED` | UNSET | `true` | **要設定** |
| 6 | 自動運転 | `MARKETING_ROLLOUT_ENABLED` | UNSET | `true` | **要設定**（最後に開ける） |

補助（既に PRESENT・変更不要）: `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` /
`PREMIUM_PLUS_ADMIN_SECRET` / `SENDGRID_API_KEY`。

⚠️ `LIGHT_TRIAL_AUTOGRANT_ARMED`（当日日付）は **設定しない**。
自動運転が展開状態（Redis）から当日日付を差し込むため、env での日次書き換えは不要。

⚠️ **env 変更は redeploy しないと反映されない**（Netlify の仕様）。
`netlify env:set` の後に production build を 1 回回す。

---

## 2. Redis rollout state（開始時に入れる予定値 / **まだ書いていない**）

鍵: `ak:marketing-rollout:state:light-trial-to-premium-sequence`
（道のり単位。キャンペーンが 2 本でも状態は 1 つ）

### stage に使える値は 5 つだけ

`rolloutPlan.js` の `ROLLOUT_STAGE` が正本。**これ以外の値は書かない**
（正規化で `paused` に倒れ、意図せず止まる）。

| stage | 1 日あたりの既定 |
|---|---|
| `paused` | 0（既定） |
| `canary` | 10 |
| `steady` | 100 |
| `scale` | 500 |
| `completed` | 0 |

⚠️ `canary10` / `steady100` のような値は**存在しない**。

### 100 名カナリアの開始値（one-shot）

| 項目 | 値 | 意味 |
|---|---|---|
| `stage` | **`canary`** | 経路を確かめる段階 |
| `dailyLimit` | **`100`** | **stage 既定（canary = 10）を上書きして 100 名にする** |
| `killed` | `false` | 緊急停止は入れない |
| `alwaysArmed` | **`false`** | **1 回だけ**。翌日に自動で次バッチへ進ませない |
| `armedFor` | **`<実行日の JST 日付 YYYY-MM-DD>`** | この日だけ新規付与を許可する |
| `note` | `activation canary 100 (one-shot)` | 誰が何のために開始したか |
| `pendingHandoffOp` / `pendingJobIds` / `jobSteps` / `dispatchWatch` | 空 | 実行中に自動で埋まる |

**「canary だから 10 名」ではない。** 人数を決めるのは `dailyLimit` で、
`resolveDailyLimit()` が `dailyLimit`（指定があればそれ）> stage 既定 の順に解決し、
`HARD_DAILY_MAX = 2000` で頭打ちにする。したがって `stage: canary` + `dailyLimit: 100` = **100 名**。

**CAS 前提値**: 現在キーは**存在しない**（`action=rollout` が `metricsPartial: not_initialized`）。
初回書き込みは `expectedVersion: null`（新規作成）。
既にキーがある場合は `load()` が返した `state.version` をそのまま渡す。**版が違えば書かない**。

### one-shot は「新規付与だけ」を止める（実装で確認済み）

`armedFor` が切れた翌日以降も、**付与済みの人の queue と送信は最後まで進む**。
止まるのは新規付与だけ。テストで固定している:

| 確認 | テスト |
|---|---|
| 武装した当日は `dailyLimit` ぶん配る（canary でも 100） | `rolloutOrchestrator.test.mjs` |
| 翌日は新規付与を止める（`paused`） | 同上 |
| 武装が切れても queue の積み残しは進む | 同上 |
| 武装が切れても送信待ちジョブは流す（1 / 3 / 30 日後） | 同上 |
| 武装が切れても期日の follow-up は進む | 同上 |
| **実 I/O**: 当日 queue → 翌日以降に送信完了（二重送信 0） | `rolloutJourney.integration.test.mjs` |
| **実 I/O**: 送信が途中で切れても翌日に残りだけ送る | 同上 |
| **実 I/O**: 翌日以降に新規付与が自動で始まらない | 同上 |

つまり**最小修正は不要**だった（`envEnabled` は新規付与の判定にしか使われていない）。

### 100 名が片付いたあとの停止（**自動で次バッチへ進ませない**）

`armedFor` は翌日に自然と切れるので、放置しても次の 100 名は始まらない。
そのうえで結果確認が終わるまで、**明示的に止めた状態**にしておく:

- `stage: 'paused'`（推奨。積み残しの queue / 送信は引き続き処理される）
- 異常があった場合は `killed: true`（次 tick から全停止）

### 500 名へ拡大する場合（**別承認が必要**）

100 名の成功条件（§4）を満たしたうえで、改めて承認を得てから:

```json
{"action":"rolloutStart","campaignId":"light-trial-to-premium-sequence",
 "stage":"scale","dailyLimit":500,
 "alwaysArmed":false,"armedFor":"<実行日の JST 日付>",
 "expectedVersion":<いまの版>,"note":"scale 500"}
```

（既存キーを更新するので `expectedVersion` は `action=rollout` で読んだ版を渡す）

**rollback 時の状態**（**効き方が 3 段階ある。混同しない**）:

| やり方 | 何が止まるか | 何が止まらないか | 反映 |
|---|---|---|---|
| `action=rolloutKill`（緊急停止） | **次の cron tick 以降の自動処理を全部**（新規付与 / キュー登録 / 送信起動 / touch2〜24 の続き） | **既に起動済みの Background 送信**（そのジョブは走り切ることがある） | 次 tick（最長 1 時間・redeploy 不要） |
| `action=rolloutPause`（`stage: paused`） | **新規付与だけ** | 積んだぶんのキュー登録・送信・続きの通は**進む**（意図的） | 次 tick |
| `MARKETING_CAMPAIGN_DISPATCH_ENABLED` を UNSET + redeploy | **送信経路そのもの**（積むだけになる） | — | redeploy 後（数分〜十数分） |
| env 4 件を UNSET + redeploy | 自動運転すべて | — | redeploy 後 |

```bash
# 緊急停止（競合しても通る。止める操作は通す）
curl -s -X POST "$SITE/.netlify/functions/admin-marketing" \
  -H 'Content-Type: application/json' -H "x-admin-secret: $SECRET" \
  -d '{"action":"rolloutKill","campaignId":"light-trial-to-premium-sequence","note":"incident"}'

# 新規付与だけ止める / 停止の解除（段階は上がらない）
#   {"action":"rolloutPause",  "campaignId":"..."}
#   {"action":"rolloutResume", "campaignId":"..."}
```

⚠️ **`killed: true` でも、既に起動した Background ジョブは取り消せない**（送信中のバッチは走り切る）。
**送信そのものを確実に止める最終手段は `MARKETING_CAMPAIGN_DISPATCH_ENABLED` を UNSET + redeploy。**

⚠️ `killed: true` の tick は**何も書かない**（`sideEffects: 'none'`）。集計の同期も止まるので、
状況は台帳（`action=jobs` / `action=sequence`）で確認する。

**実装で固定していること**（`rolloutOrchestrator.test.mjs` / `rolloutJourney.integration.test.mjs`）:

| 状態 | 結果 |
|---|---|
| `killed: true` + 送信待ちジョブあり | 送信起動 **0**（`reason: kill_switch`） |
| `killed: true` + queue 積み残しあり | キュー登録 **0** |
| `killed: true` + 期日の follow-up あり | 続きの通 **0** |
| `killed: true` + 付与候補あり | 付与 **0** |
| `killed: true`（実 I/O） | ジョブ・台帳・送信・Background 起動すべて増加 **0** |
| `killed` 解除後 | 積み残しが**続きから**処理される（二重送信 0） |
| `MARKETING_ROLLOUT_ENABLED` OFF | 従来どおり `sideEffects: 'none'` で abort |

---

## 3. 第 2 カナリア = 100 名（read-only preflight / 2026-08-15 実測）

いきなり 14,479 名へ開放しない。**まず 100 名**。

| 項目 | 実測 | 出所 |
|---|---|---|
| 候補として読んだ件数 | **100**（1 ページ） | `action=trialGrant`（batchSize=100） |
| うち付与予定（eligible） | **100** | `batch` |
| 除外（理由別） | **0 件**（`excludedByReason: {}`） | 同上 |
| 既付与との重複 | **0**（既付与 10 名は候補に入らない） | 付与済みは formula の対象外 |
| 既送信との重複 | **0**（Step1 送信済みは既付与 10 名のみ） | `sequence`: `sentByStep[1] = 10` |
| 関所（前回ぶんの未処理） | **0** → `nextBatchAllowed: true` | `barrier.outstandingStep1` |
| まだ候補がある | `true`（残りは 14,000 名規模） | `moreAvailable` |
| コホート | `imp-2026-08-09-001` | `cohort.byBatch` |
| 想定 Step1 送信数 | **付与に成功した人数（最大 100）** | 付与直後に Step1 が期日（`delayDays: 0`） |

除外の内訳が 0 件なのは、**未付与・非有料・配信可能な人だけが候補として引かれる**ため
（過去付与 / 有料会員 / 期限なし付与 / 付与中 / 配信不可は formula と plan の両方で外れる）。
配信停止・バウンス・suppression は**送信直前にもう一度**判定される（二重の防御）。

⚠️ 100 名は**このバッチの先頭 100 名**であり、名簿は付与実行時にもう一度確定する
（`planFingerprint` が一致しなければ実行しない）。

---

## 4. 100 名実行後の成功条件（次段階へ進める判定）

**全部満たしたときだけ**次（500 名）へ進む。1 つでも欠けたら停止して原因を潰す。

| # | 指標 | 合格ライン | 確認方法（read-only） |
|---|---|---|---|
| 1 | grant 成功件数 | **95 以上 / 100**（失敗は理由が説明できること） | cron ログ / `action=trialGrant` の再実行で残数が減っている |
| 2 | queue 件数 | **付与成功数と一致** | `action=jobs` の `recipientCount` |
| 3 | sent | **queue 件数と一致**（`failed` は 0 が目標、5% 未満まで許容） | `action=jobs` の `counts.sent` / `sentCount` |
| 4 | skipped | 理由が説明できること（配信停止・バウンス等） | `counts.skipped` / `skipByReason` |
| 5 | duplicate | **0**（同じ人へ同じ touch が 2 通いかない） | `action=sequence` の `sentByStep` と受信者数が一致 |
| 6 | hard bounce | **2% 未満** | EmailBlacklist の増分 |
| 7 | complaint（苦情） | **0.1% 未満**（1 件でも出たら内容を確認） | EmailBlacklist / provider |
| 8 | unsubscribe | **2% 未満**（超えたら文面と頻度を見直す） | EmailBlacklist の増分 |
| 9 | provider acceptance | 送信数 = SendGrid 受理数 | dispatcher のログ / `sentCount` |
| 10 | **delivered は別計測** | Event Webhook の `delivered` で後追い（受理 ≠ 着弾） | `EmailEvents` |
| 11 | Customers の課金系変更 | **0**（`プラン` / `PlanType` / `Status` / `有効期限` が変わっていない） | 実行前後で対象レコードを read-only 比較 |
| 12 | gate 再閉鎖 / kill switch | **再閉鎖できる**か、`killed: true` で次 tick が止まる | `action=rollout` が `canProceed: false` を返す |

⚠️ 3 と 10 を混同しない。**`sent` は「送信基盤が受理した」**であって着弾ではない。

---

## 5. activation 実行手順（承認後）

### Step 0. 直前確認（read-only）

1. `action=rollout` … `canProceed: false` / 閉じている env 名が出ること
2. `action=trialGrant`（batchSize=100） … `batch` / `excludedByReason` / `barrier.nextBatchAllowed: true`
3. `action=jobs` … PENDING の marketing ジョブが**無い**こと
4. `planFingerprint` を控える（実行時に一致を要求する）

### Step 1. env を開ける（4 つ）

```bash
netlify env:set LIGHT_TRIAL_AUTOGRANT_ENABLED true --context production --force
netlify env:set MARKETING_CAMPAIGN_ENABLED true --context production --force
netlify env:set MARKETING_CAMPAIGN_DISPATCH_ENABLED true --context production --force
netlify env:set MARKETING_ROLLOUT_ENABLED true --context production --force   # ← 最後
```

### Step 2. deploy（env を効かせる）

Build Hook を 1 回叩き、`origin/main` を production build する。
**deploy 完了まで自動運転は動かない**（env が読めないため）。

### Step 3. Redis rollout state を開始（CAS 新規作成 / one-shot）

**管理 API から行う**（2026-08-16 に追加。それ以前は書き込み口が無く開始できなかった）。

```bash
# ① いまの版を読む（新規なら state が無い = expectedVersion は null）
curl -s -X POST "$SITE/.netlify/functions/admin-marketing" \
  -H 'Content-Type: application/json' -H "x-admin-secret: $SECRET" \
  -d '{"action":"rollout","campaignId":"light-trial-to-premium-sequence"}'

# ② 開始（CAS 必須。expectedVersion は ① の版。新規作成なら null）
curl -s -X POST "$SITE/.netlify/functions/admin-marketing" \
  -H 'Content-Type: application/json' -H "x-admin-secret: $SECRET" \
  -d '{"action":"rolloutStart","campaignId":"light-trial-to-premium-sequence",
       "stage":"canary","dailyLimit":100,
       "alwaysArmed":false,"armedFor":"<実行日の JST 日付>",
       "expectedVersion":null,"note":"activation canary 100 (one-shot)"}'
```

→ `action=rollout` で `canProceed: true` と `dailyLimit: 100` を確認。

⚠️ `alwaysArmed: true` にしない。**翌日に次の 100 名が自動で始まってしまう**。
⚠️ `armedFor` は**その日の cron tick が実際に走る JST 日付**。
   深夜 0 時をまたぐ時間帯に設定すると、翌日の日付でないと武装されない。
⚠️ `dailyLimit` は**必ず明示する**（未指定は 400。「100 名のつもりが canary 既定の 10 名」を防ぐ）。

受け付けない値は 400 で返り、**1 バイトも書かない**:
段階が 5 値以外 / `dailyLimit` が整数でない・0 未満・2000 超 /
`armedFor` が過去・7 日より先・形式違い / `expectedVersion` の指定漏れ。
版が食い違えば **409**（誰かが同時に触った）。

### Step 4. 付与（自動 / cron が 1 tick で実行）

cron は 1 時間ごと。**`dailyLimit`（= 100）まで**付与する（`stage` の既定ではない）。
`armedFor` の当日なので 1 回だけ走り、翌日以降は新規付与を行わない。
手動で先に進めたい場合も**新しい経路を作らない**（cron を待つ）。

### Step 5. queue（自動 / 次の tick）

付与の引き継ぎ（`pendingHandoffOp`）から Step1 を dry-run → 指紋一致 → 登録。

### Step 6. background dispatch（自動 / 次の tick）

起動直前に dry-run で `expectedWillSend` を確定してから Background を起動。
**202 は送信成功ではない**。台帳で確認する。

### Step 7. 台帳確認（read-only）

`action=jobs` … `counts.sent` / `failed` / `skipped`、
`action=sequence` … `sentByStep`、`action=rollout` … 進行と現在の touch。

### Step 8. 停止（結果確認まで次バッチへ進ませない）

`armedFor` は翌日に切れるので次バッチは自動では始まらないが、**明示的に止めておく**:

- 正常時: `action=rolloutPause`（積み残しの queue / 送信は引き続き処理される）
- 異常時: `action=rolloutKill`（次 tick から全停止）、必要なら env を UNSET + redeploy

そのうえで §4 の成功条件を read-only で確認する。**500 名へ進むには別承認が必要。**

---

## 6. rollback

| 事象 | 対応 | 所要 |
|---|---|---|
| 送信内容が想定と違う | **① `killed: true`（次 tick から自動処理を全停止）→ ② `MARKETING_CAMPAIGN_DISPATCH_ENABLED` を UNSET + redeploy**（起動済みジョブも含めて送信経路を閉じる） | 次 tick + 数分 |
| 付与が想定より速い / 多い | `dailyLimit` を下げる or `stage: 'paused'`（Redis・redeploy 不要。積んだぶんは送られる） | 即時（次 tick） |
| 全部止めたい | `killed: true` → そのうえで env 4 つを UNSET + redeploy | 次 tick + 数分 |
| 付与してしまった人を戻したい | **自動では戻さない**。`admin-comeback-grants` の取消（`LightGrantRevokedAt`）を手動で | 手動 |
| 送ってしまったメール | **取り消せない**。配信停止の申し出に個別対応する | — |

⚠️ **付与の取消は自動化しない。** 権利を勝手に剥がすと、既に使い始めた人の体験を壊す。

---

## 7. まだやらないこと（次の承認境界）

- production marketing gate の ON
- Redis rollout state の本番開始設定
- 100 名への実付与 / 実メール送信
- 500 名以降への拡大（100 名の成功条件を満たし、**別承認を得てから** `stage: 'scale'` / `dailyLimit: 500`）

---

## 8. 500 名 one-shot（2026-08-17 JST 予定 / **未実行**）

100 名カナリアの結果を受けての次段階。**当日まで実行しない。**

### 前提（2026-08-16 時点の実測）

| 項目 | 値 |
|---|---|
| 状態 | `stage=paused` / `killed=false` / `armedFor=null` / `totalGranted=100` |
| `lastRunDay` | **2026-08-16**（当日はもう配れない = `already_ran_today`） |
| gate 4 件 | **ON のまま**（env 変更・redeploy は不要） |
| touch1 | sent 110 / delivered 100 / opened 6 / measured 100 / unknown 10 |

⚠️ **8/16 中に `rolloutStart` して 500 名を足さない。** 同じ JST 日には配れない仕様なので、
仮に開始しても `already_ran_today` で拒否される。`lastRunDay` を手で消す・Redis を直接
書き換えるのも**禁止**（二重付与の防波堤を自分で外すことになる）。

### ① 実行直前の read-only 確認（既存 110 名）

```bash
# 配信の実績（touch 別）
{"action":"touchMeasurement","campaignId":"light-trial-to-premium-sequence"}
# ⚠️ 数え切れない規模になると数字を返さない（complete:false / measurement_requires_scan）。
#    そのときは `npm run scan:touch-measurement`（cursor を辿って合算）を使う。
#   → delivered / opened / measured / unknown、measurementAvailable: true
# 進行と停止理由（購入・配信停止・バウンス・苦情・suppression）
{"action":"sequence","campaignId":"light-trial-to-premium-sequence"}
#   → summary.byStopReason（purchased / not_sendable / soft_bounce / provider_suppressed …）
#   → engagement.coverage.lastEventAt（**Webhook が生きているか**）
# ジョブ（duplicate / failed / skipped）
{"action":"jobs"}
```

| 見るもの | 合格の目安 |
|---|---|
| delivered / opened | 数字が出ている（`measurementAvailable: true`） |
| bounce / dropped / spam / complaint / unsubscribe | `byStopReason` と EmailBlacklist の増分が 0 に近い |
| duplicate | 配信行の DeliveryKey 重複 0 / 宛先重複 0 |
| stopped / purchase | `byStopReason` に理由つきで出る（購入は歓迎すべき停止） |
| `lastEventAt` | 直近（Webhook 受信が生きている） |

### ② 新規候補の preflight（500 名）

```bash
{"action":"trialGrant","batchSize":500}
```

| 見るもの | 2026-08-16 時点の実測 |
|---|---|
| eligible（`batch`） | **500** |
| 除外理由 | 配信停止・バウンス・停止アカウント等 **6**（= suppression が効いている） |
| 既付与との重複 | **0**（付与済み 110 名は候補に入らない） |
| 関所 `outstandingStep1` | **0** → `nextBatchAllowed: true` |
| コホート | `imp-2026-08-09-001` 499 / `imp-2026-08-04-001` 1 |

⚠️ この下見は `abort: gates_closed` と返る。`LIGHT_TRIAL_AUTOGRANT_ARMED` を env に
置かない運用（当日日付は展開状態から注入する）ため**正常**。
⚠️ 同じ理由で `planFingerprint` も下見では空になる。**指紋の一致は cron の中で強制**される
（`loadAndPlanLightTrial` が下見と実行で同じ 1 本を通るため、別経路にはならない）。

### ③ 開始（8/17 JST に 1 回だけ）

```bash
# 1) いまの版を読む（**expectedVersion に渡す値**）
{"action":"rollout","campaignId":"light-trial-to-premium-sequence"}
#    → stateVersion（新規なら null）

# 2) 開始（CAS）
{"action":"rolloutStart","campaignId":"light-trial-to-premium-sequence",
 "stage":"scale","dailyLimit":500,
 "alwaysArmed":false,"armedFor":"2026-08-17",
 "expectedVersion":<① の stateVersion>,"note":"activation scale 500 (one-shot)"}
```

- **env の変更・redeploy は不要**（gate 4 件は ON のまま）
- `stage: scale` の既定は 500 だが、**`dailyLimit` は明示する**（未指定は 400）
- `armedFor` は **cron tick が実際に走る JST 日付**。深夜 0 時をまたぐ時間帯は翌日日付にする

### ④ 実行後（当日中）

1. cron が 1 tick ごとに 付与 → queue → 送信起動 と進む（1 時間ごと）
2. 完了したら **`{"action":"rolloutPause"}`** で明示的に止める
   （`armedFor` は翌日に失効するので自動継続はしないが、明示的に閉じる）
3. read-only で確認:

| 指標 | 確認方法 |
|---|---|
| grant | `rollout` の `batch.lastRunCount` / `totalGranted` |
| queue / sent / failed / skipped | `jobs` の `counts` |
| duplicate | 配信行の DeliveryKey・宛先の重複 0 |
| delivered / opened | `touchMeasurement`（小規模）/ `npm run scan:touch-measurement`（全体・索引が積まれるまで数分〜） |
| bounce / complaint / unsubscribe | `sequence` の `byStopReason` + EmailBlacklist の増分 |
| purchase | `sequence` の `byStopReason.purchased` |
| **Customers 課金系変更** | 付与した人の `プラン` / `Status` / `PlanType` / `有効期限` が**空のまま** |

### ⑤ 異常時

- `{"action":"rolloutKill"}` … 次 tick 以降の自動処理を全停止（redeploy 不要）
- 送信経路を閉じるなら `MARKETING_CAMPAIGN_DISPATCH_ENABLED` を UNSET + redeploy
- 付与済みの権利は**自動で戻さない**（必要なら手動 revoke）
