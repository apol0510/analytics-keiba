# メルマガ自動化 段階開放 runbook

対象: メルマガ自動化（PR #237 / squash `ba93eda`）と **見込み客プール**（PR #241 / squash `37090c0`）。
どちらも main 反映・production deploy 済み。
**コードは本番にあるが、env が全て閉じているため何も起きない状態**からの開放手順。

> この文書は**開放の順序と、各段で何を観測してから次へ進むか**を先に決めておくためのもの。
> 1 段ずつ進め、**合格条件を満たさなければ次へ進まない**。迷ったら閉じる。

## 現在地（S0）

| 項目 | 状態 |
|---|---|
| コード | main `ba93eda` / production deploy 済み |
| `MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` | **unset** |
| `MARKETING_AUTOMATION_SCHEDULER_ENABLED` | **unset** |
| `MARKETING_AUTOMATION_DISPATCH_ARMED` | **unset** |
| `MARKETING_AUTOMATION_ENQUEUE_ENABLED` | **unset** |
| `MARKETING_PROSPECT_WRITE_ENABLED` | **unset** |
| `MARKETING_PROSPECT_AUTO_PROMOTE_ENABLED` | **unset** |
| `MARKETING_PROSPECT_EVENTS_ENABLED` | **unset** |
| `MARKETING_CAMPAIGN_ENABLED` / `..._DISPATCH_ENABLED` | true（**既存機能のもの。触らない**） |
| Redis `index:active` | 空（`list` 実測 `保存済み: []`） |
| cron 公開 URL | 403 / 本文 0 バイト（scheduled function） |

## 全段共通のルール

- **env 変更は redeploy が要る**（AK の実績）。`netlify env:set` の後、
  production build を 1 回回して初めて Function に反映される
- **1 段につき env は 1 つだけ**動かす。2 つ同時に開けない
- 各段の観測は **read-only**（`netlify logs` / 管理画面の read / `list` `get` `preview`）
- **rollback は常に `env:unset` + 反映 deploy**。コード変更を伴う rollback はしない
- 合格条件を 1 つでも満たさなければ **その場で閉じる**。「たぶん大丈夫」で次へ進まない

---

## S1: schedule が起動することの確認（**env 変更なし**）

初回発火は **JST 10:00**（cron `0 1 * * *` = UTC 01:00）。

```bash
netlify logs --source functions --function cron-marketing-automation --since 2h --json
```

### 合格条件

- **invocation が 1 件以上ある**（起動している）
- `ran: false`
- `reason: "gates_closed"`
- `接続: {redis:false, airtable:false}`
- `sideEffects: "none"`
- `未設定のゲート` に `MARKETING_AUTOMATION_SCHEDULER_ENABLED` と
  `MARKETING_AUTOMATION_DISPATCH_ARMED(=<当日>)` が並ぶ

### 実測結果（2026-08-07・read-only）

| 確認 | 結果 |
|---|---|
| **初回スケジュール起動** | **`2026-08-07T01:00:40.662Z`（JST 10:00:40）に invocation 1 件** ✅ |
| 実行時間 | `Duration: 79.69 ms` / `Init Duration: 345.03 ms`（コールドスタート）|
| error / warn ログ（7 日） | **0 件**（`store_unavailable` / `internal error` / `enqueue 失敗` のいずれにも到達していない）|
| `ScheduledEmails` | 30 件・**PENDING 0**（起動前後で不変）|
| `CampaignDeliveries` | 136 件・最終 SentAt **2026-08-04T07:33:12.873Z から不変** |
| メール送信 | **0** |

production への投入は `2026-08-06T05:41:59Z`（01:00 UTC より後）なので、
**2026-08-07 01:00 が最初のスケジュール機会**であり、そこで確実に起動している。
→ **schedule 登録は機能している。**

同時刻の他 cron との比較（Redis / Airtable へ触れていない傍証）:

| Function | Duration | 接続 |
|---|---|---|
| `cron-marketing-automation` | **79.69 ms** | （下記のとおり未確認だが、この速さは I/O 無しと整合）|
| `cron-prospect-worker` | 486 ms | Redis + Airtable 写し |
| `payment-email-dispatcher` | 1,184 ms | Airtable |
| `cron-payment-email-reconciler` | 1,234 ms | Airtable |

### 合格条件はログで確認する（2026-08-08 に観測可能化）

早期 return の 2 経路に構造化ログを 1 行ずつ追加した。目印は **`[marketing-automation]`**。

```bash
netlify logs --source functions --function cron-marketing-automation --since 24h --json
```

> ⚠️ **ログが `message: ''`（空）で出るときは実装側の不具合を疑う。**
> 2026-08-08 01:00:52Z の起動で実際に空レコードになり、変更前は出ていたランタイムの
> `Duration:` 行まで消えた（同時刻の他 cron は正常）。原因は `console.log` を
> **detach して呼んでいた**こと（Netlify Lambda は console を差し替えているため
> レシーバを失う）。**`console.log` は必ず直接・1 引数の文字列で呼ぶ。**
> 再発防止は `automationTickLog.test.mjs` の guard で固定済み。

| 実際の挙動 | ログ | 意味 |
|---|---|---|
| 200 | `{"ran":false,"reason":"gates_closed","未設定のゲート":[...],"接続":{"redis":false,"airtable":false},"sideEffects":"none"}` | **合格**。仕組みは正常で、env を開ければ動く |
| 404 | `{"ran":false,"reason":"not_scheduled_payload","接続":{...},"sideEffects":"none"}` | **不合格**。`next_run` を受け取れておらず、env を開けても動かない。原因調査へ |

- **ログに env の値は 1 つも出さない。** 出すのは判定結果と**未設定 env の名前**だけ
- **404 経路のログはゲートの設定状況を書かない**（設定を漏らさない方針を維持）
- ログ出力が失敗しても処理は止まらない
- **レスポンス本文は変えていない**（観測性だけの変更）

固定テスト: `src/lib/marketing/automationTickLog.test.mjs`（13 件。
経路を無言に戻すと fail することを確認済み）。

#### それまでの経緯（2026-08-07）

初回起動そのものは確認できた（下記「実測結果」）が、当時は 2 経路とも `console.log` を
呼ばず、Netlify のログに `Duration:` 行しか残らなかった。そのため
「gates_closed で正常」と「404 で機能が死んでいる」を区別できず、
上記の合格条件が**検証不能**だった。本ログ追加でその穴を塞いだ。

### invocation が 1 件も無いとき

**env を開けない。** `isScheduledPayload` が要求する `next_run` 付き本文を
Netlify が渡していない可能性がある（fail-closed で安全側だが機能は止まる）。

1. `netlify logs --source functions --since 24h` で他の cron（`cron-expiry-check` 等）が
   起動しているかを見る → 起動していれば本 Function 固有の問題
2. Netlify のビルドログで scheduled function として認識されているか確認
3. 公開 URL への POST が **403 / 本文 0 バイト**であることを再確認
   （自前の JSON が返るなら **schedule 未登録**）
4. 原因が判明するまで **S2 へ進まない**

---

## S2: 管理 write の開放（Definition の作成・保存まで。**ACTIVE 化しない**）

⚠️ **前提**: 顧客一覧の**写しが作られていること**（下の「顧客一覧の写し」を先に読む）。
写しが無い / 古いと dry-run と ACTIVE 化は **fail-closed で 503** になる。
（C-2 は PR #241 で解消済み。**件数を理由に急ぐ必要は無い**。）

```bash
netlify env:set MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED true --context production
# → production build を 1 回（反映）
```

### 手順

1. 管理画面 `/admin/premium-plus-eligibility` → 自動化一覧を読み込む
2. **保存系ボタンが有効になる**ことを確認（`writeEnabled: true`）
3. プリセットを 1 つ選び、**`maxRecipients` を最小（1〜5）**にする
4. **下見（dry-run）** → 件数・除外理由・snapshot 指紋を記録
5. **保存**（`create`）→ `configVersion: 1`
6. **ACTIVE 化はしない**

### 合格条件

- `create` が 200 で、`get` が保存内容を返す
- `list` の `保存済み` に現れる
- **メール送信 0 / ScheduledEmails への行追加 0**（`admin-marketing` の送信状況で確認）
- Customers の件数・内容が**変わっていない**

### rollback

`netlify env:unset MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED --context production` + 反映 deploy。
保存済み Definition は残るが、`status` が DRAFT なら scheduler は動かない。

---

## S3: ACTIVE 化（**scheduler はまだ閉じたまま**）

S2 の env を開けたまま行う。**新しい env は開けない。**

1. **もう一度 dry-run**（対象が変わっていないか）
2. **ACTIVE 化**（`activate`）— 申告した指紋が再計算値と一致しなければ `snapshot_mismatch` で弾かれる
3. `get` で `status: ACTIVE` / `enabled: true` / `snapshotFingerprint` / `snapshotCount` /
   `snapshotOccurrenceDate` が保存されていることを確認

### 合格条件

- `activate` が 200、`承認したsnapshot` に件数と暦日が入る
- `list` の `保存済み` に ACTIVE として現れる
- **翌日の JST 10:00 に cron が動いても `gates_closed` のまま**
  （`SCHEDULER_ENABLED` が閉じているため）→ ログで確認
- **メール送信 0**

### rollback

管理画面から **一時停止**（`pause`）→ `status: PAUSED` / 索引から除去。

---

## S4: scheduler の開放（**当日武装は出さない**）

```bash
netlify env:set MARKETING_AUTOMATION_SCHEDULER_ENABLED true --context production
# → production build を 1 回（反映）
```

翌 JST 10:00 のログを見る。

### 合格条件

- `ran: false` / `reason: "gates_closed"`
- `未設定のゲート` が **`MARKETING_AUTOMATION_DISPATCH_ARMED(=<当日>)` だけ**になる
- `接続: {redis:false, airtable:false}` / **Redis へ 1 コマンドも出ていない**
- **メール送信 0**

> ここまでで「scheduler は起動するが、当日武装が無いので何もしない」状態が確認できる。
> **この状態が最も安全な定常状態**。急いで S5 へ進まない。

---

## S5: 当日武装 → 初回の実配信（**1 日 1 回・少数**）

⚠️ **ここで初めて実際にメールが送られる。** 実施日を決め、送信直後に見る人を確保してから行う。

```bash
# 当日の JST 日付を入れる（翌日には自動的に閉じる）
netlify env:set MARKETING_AUTOMATION_DISPATCH_ARMED 2026-08-XX --context production
# → production build を 1 回（反映）
```

### 直前チェック（実行前）

- 対象 automation は **1 つだけ**か
- `maxRecipients` は最小のままか
- 直前に dry-run して、**承認済み snapshot と一致**しているか
- `MARKETING_CAMPAIGN_DISPATCH_ENABLED` が true か（既存・変更しない）

### 実行後（JST 10:00 以降）に確認

| 観点 | 見るもの |
|---|---|
| 起動 | cron ログに `ran: true` |
| 対象 | `queued` / `excluded` / `failed` と `snapshotCount` の合計が一致 |
| 突合 | `reconciliation` が `OK`（`BLOCKED` なら**人が確認するまで進めない**） |
| 実送信 | ScheduledEmails / CampaignDeliveries の行数が `queued` と一致 |
| 顧客 | Customers が**書き換わっていない**（昇格・特典・期限が動いていない） |

### 合格条件

- 送信数が `maxRecipients` を超えない
- `reconciliation.verdict === 'OK'`
- 苦情・バウンスが想定内
- **Customers への write 0**

### rollback

1. `netlify env:unset MARKETING_AUTOMATION_DISPATCH_ARMED --context production` + 反映 deploy
   （何もしなくても**翌日には日付不一致で自動的に閉じる**）
2. 止めきるなら `MARKETING_AUTOMATION_SCHEDULER_ENABLED` も unset
3. **送信済みは取り消せない**。`cancel` は未送信（PENDING）だけを止める

---

## 開放してはいけない条件

- S1 で **invocation が確認できていない**
- `reconciliation` が `BLOCKED` のまま
- **顧客一覧の写しが無い / 古い**（dry-run と ACTIVE 化が fail-closed で止まる）
- 直近に campaign の版か本文を変えた（`campaign_drift` で ACTIVE 化が弾かれる／
  弾かれないなら**検査が壊れている**ので調査）

## 顧客一覧の写し（**S2 の前に必ず読む**）

かつて `preview`（dry-run）は Customers を**全件・逐次**取得しており、本番実測 1,678 件で
3.5〜7.6 秒。同期 Function の上限 10 秒に対し **約 4,000 件でタイムアウト域**だった（C-2）。

**PR #241（`37090c0`）で解消済み。** 走査は `cron-prospect-worker`
（**Scheduled Function・10 分ごと**）だけが行い、同期側は Redis の写し
（`ak:customer-snapshot:`）を読む。件数に依らず速い。

| | |
|---|---|
| 写しの作り方 | **手動作成は不要**。`cron-prospect-worker` が **写しが無い / 6 時間より古い**ときに**自動で作り直す**（2026-08-06 の実測: 初回 tick が `snapshot_missing` を検知して自動生成） |
| 早めたいとき | 管理画面「顧客一覧の写しを更新（依頼）」→ **Redis に依頼札が立つだけ**。次の tick（最大 10 分）が拾って作る |
| 公開 URL から起動 | **できない**（scheduled function への HTTP は Netlify が 403） |
| 写しが無い / 古い（6 時間）/ 壊れている | **fail-closed で 503**（古い対象で送らせない） |

### ⚠️ **全閉鎖でも `ak:customer-snapshot:` だけは Redis write が発生する**

写しの生成・更新は **どの env でもゲートしていない**。読み手（dry-run / ACTIVE 化 /
prospect の照合）を fail-closed にするために、写しが無いと何も判断できなくなるため。
**自動化・見込み客の env が全て未設定でも、10 分ごとの tick が写しの鮮度を見て、
必要なら Airtable から読み直して Redis へ書く。**

| | |
|---|---|
| Airtable | **GET のみ**（`Email` 列だけ・ページング）。**write は 1 度も発生しない** |
| Redis | `ak:customer-snapshot:meta` と `ak:customer-snapshot:emails:<gen>:<i>` を書く |
| 配信系 write との区別 | **これは配信ではなくキャッシュ更新**。ScheduledEmails / CampaignDeliveries / Customers には触れない |
| 頻度 | 6 時間ごと（`SNAPSHOT_MAX_AGE_SEC`）。tick は 10 分ごとだが、鮮度内なら `更新不要` で何もしない |

> 「本番 Redis write 0」を条件にする場面では、**この名前空間だけは例外**として扱うこと。
> 止めたい場合は scheduled function 自体を外す必要があり、そうすると
> dry-run も ACTIVE 化も fail-closed で止まる（**現時点では止めない方針**）。

### P1 でやること（作成ではなく確認）

1. 管理画面「件数を確認」→ `status` が **200**
2. 「配信の下見」→ `preview` が **200**（`snapshot_missing` / `snapshot_stale` が出ないこと）
3. `cron-prospect-worker` のログで `写し` の **件数**と**経過秒**が妥当なこと
   （`更新不要: true` が続いていれば健全。`契機: snapshot_missing` が毎回出るなら異常）

## 見込み客プール（外部リスト）の開放

自動配信（S1〜S5）とは**別の鍵**で開ける。順序は次のとおり。

| 段 | 内容 | 動かす env |
|---|---|---|
| P1 | **写しの存在・鮮度・件数を確認**（作成は自動。下記参照）＋ `status` / `preview` が 200 | なし |
| P2 | CSV を**少数**取り込む（既存顧客・除外済みは入らないことを確認） | `MARKETING_PROSPECT_WRITE_ENABLED` |
| P3 | webhook から反応を拾えることを確認（開封 1 件で ENGAGED になる） | `MARKETING_PROSPECT_EVENTS_ENABLED` |
| P4 | 反応者の**自動登録**（Customers へ CREATE） | `MARKETING_PROSPECT_AUTO_PROMOTE_ENABLED` |

### P2〜P4 の合格条件

- **P2**: `intake` の応答で「既存顧客」「台帳で復活拒否」が意図どおり。Customers の件数が**変わらない**
- **P3**: 開封した相手が `lookup` で `ENGAGED` になる。**Airtable は書かれていない**
- **P4**: `cron-prospect-worker` のログで **CREATE 成功数 = PROMOTED 数**。
  同じ相手が **2 回登録されていない**（`promotedRecordId` が 1 つ）。
  失敗が出たら **ENGAGED のまま**残っていること（次の tick で再試行される）

### rollback

いずれも `env:unset` + 反映 deploy。**既に Customers へ作られた行は消さない**
（重複が出た場合は Airtable 側で確認してから手当てする）。

## S5 の前に: enqueue の開放

cron が ScheduledEmails の PENDING 行を作るには
**`MARKETING_AUTOMATION_ENQUEUE_ENABLED=true`** も要る（S4 と S5 の間で開ける）。
開けていなければ tick は計画までで止まり、`skipped.enqueue_disabled` が記録される。

## 既知の課題（**すべて対応済み**）

| # | 内容 | 状態 |
|---|---|---|
| B-4 | `activate` / `cancel` の索引更新が 2 段 | ✅ **解消**（PR #242）。CAS と索引を 1 回の Lua で更新し、tick の先頭で `reconcileActiveIndex()` が収束させる |
| B-5 | run キーに TTL が無い | ✅ **解消**（PR #242）。run 本体は 120 日 TTL、二重開始の判定は **TTL の無い墓標**（`run-mark:`） |

### 運用で見るところ

- tick の応答に **`索引の掃除`** が出たら、古い不整合を掃除した記録（`removed` / `missing`）。
  毎回出続けるなら**書き込み側を疑う**
- run の保持は **120 日**。履歴表示（既定 30 日 / 最大 90 日）より長い。
  120 日より前の run を見たいときは Function ログを使う

## 関連

- 設計と blocker の記録: `docs/marketing-automation-preprod-audit.md`
- 見込み客プールの設計: `docs/spec.md`「見込み客プール（外部リスト）」/ `docs/decisions.md` 2026-08-06
- 進捗の正本: `docs/progress.md`

---

# 段階開放 preflight（2026-08-07 作成・read-only 調査に基づく）

開放の**直前**に毎回この節を上から確認する。**1 つでも合わなければ開けない。**

## env と、開けたときに到達可能になる write 経路

production の状態は `netlify env:list --context production --json` で確認する
（`env:get` は応答が折り返して誤判定しやすい。**`env:list --json` を正とする**）。

| 段 | env | production | 開けると到達可能になる write |
|---|---|---|---|
| S2 | `MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` | **UNSET** | 自動化 Definition の `create` / `update` / `activate` / `pause` / `cancel`（**Redis のみ**。Airtable へは書かない） |
| S4 | `MARKETING_AUTOMATION_SCHEDULER_ENABLED` | **UNSET** | scheduler が Redis へ接続し `claim` / `createRun` を書く（**ScheduledEmails はまだ作らない**） |
| S4.5 | `MARKETING_AUTOMATION_ENQUEUE_ENABLED` | **UNSET** | **ScheduledEmails の PENDING 行**を作る + prospect の送信回数を記録 |
| S5 | `MARKETING_AUTOMATION_DISPATCH_ARMED` | **UNSET** | 当日ぶんの武装（日付一致）。ここまで揃うと**実配信が起きる** |
| P2 | `MARKETING_PROSPECT_WRITE_ENABLED` | **UNSET** | `intake`（Redis）/ `promote`（**Customers へ CREATE**）/ `suppress` / `purge` |
| P3 | `MARKETING_PROSPECT_EVENTS_ENABLED` | **UNSET** | webhook が prospect の状態を Redis へ書く（**Airtable へは書かない**） |
| P4 | `MARKETING_PROSPECT_AUTO_PROMOTE_ENABLED` | **UNSET** | `cron-prospect-worker` が **Customers へ CREATE**（自動） |
| 既存 | `MARKETING_CAMPAIGN_ENABLED` / `..._DISPATCH_ENABLED` | **SET(true)** | 既存機能のもの。**触らない** |

> ⚠️ **Customers へ書けるようになるのは P2（手動）と P4（自動）だけ。**
> S2〜S5 は Redis と ScheduledEmails までで、Customers には触れない。

## 各段の合格条件・停止条件・rollback

| 段 | 合格条件 | 停止条件（1 つでも該当したら閉じる） | rollback |
|---|---|---|---|
| S2 | `create` 200 / `get` が保存内容を返す / `list` に出る / 送信 0 / Customers 件数不変 | `store_unavailable` が出る / `list` に出ない / Customers が増えた | `env:unset` + 反映 deploy。保存済みは DRAFT なので動かない |
| S3 | `activate` 200 / `承認したsnapshot` に件数と暦日 / 翌 tick も `gates_closed` | `snapshot_mismatch` が続く / `campaign_drift` | 管理画面から `pause` |
| S4 | `ran:false` / `未設定のゲート` が `DISPATCH_ARMED` と `ENQUEUE_ENABLED` だけ / 接続 0 | 接続が `true` になる / `claim` が積み上がる | `env:unset` + 反映 deploy |
| S4.5 | tick が `enqueue_disabled` を出さなくなる / ScheduledEmails が **0 のまま**（武装前） | 武装前に ScheduledEmails が増えた | `env:unset` + 反映 deploy |
| S5 | 送信数 ≤ `maxRecipients` / `reconciliation.verdict === 'OK'` / Customers write 0 | `reconciliation` が `BLOCKED` / 想定を超える送信 | `DISPATCH_ARMED` を unset（**翌日には日付不一致で自動的に閉じる**）。**送信済みは取り消せない** |
| P2 | `intake` の内訳が意図どおり / Customers 件数**不変** | Customers が増えた / `台帳で復活拒否` が想定外 | `env:unset`。取り込んだ prospect は `suppress` + `purge` で消せる |
| P3 | 開封した相手が `ENGAGED` になる / Airtable write 0 | Airtable が増える | `env:unset` |
| P4 | CREATE 成功数 = PROMOTED 数 / 同一相手が 2 回登録されない | 失敗が続く / 重複が出た | `env:unset`。**作成済みの Customers 行は消さない**（Airtable 側で確認してから手当て） |

---

# P2 少数 canary 実行計画（**実行前チェックリスト**）

**本番への取り込みはまだ行わない。** 開放が承認されたときに、この順で実施する。

## 使うアドレス

- **実顧客は使わない。** `canary+<n>@example.invalid` 形式の**到達しないアドレス**を **3〜5 件**
- 実在ドメインを使わない（送信が起きても外部へ出ない）
- 氏名・その他の個人情報は入れない（`intake` は `email` だけを見る）

## 実行前チェック

| # | 確認 | 期待 |
|---|---|---|
| 1 | `MARKETING_PROSPECT_WRITE_ENABLED` 以外の automation env | **すべて UNSET** |
| 2 | 顧客写しの鮮度 | `status` が 200 / `件数` が想定内 / `更新不要` |
| 3 | Customers 件数（開始値） | 記録しておく（**canary 後に不変**であること） |
| 4 | prospect 件数（開始値） | `送信候補` / `反応済み未登録` / `永久除外` を記録 |
| 5 | 使うアドレスが **Customers に無い** | `lookup` で `not_found`（重複登録を作らない） |
| 6 | 使うアドレスが **抑止台帳に無い** | `intake` の応答で `permanently_blocked` が 0 |
| 7 | 使うアドレスが **blacklist に無い** | `intake` の応答で `unsubscribe` が 0 |

## 作成される Redis キー（`ak:prospect:` 配下のみ）

| キー | 件数 | 内容 |
|---|---|---|
| `ak:prospect:p:<sha256(email)>` | 投入件数ぶん | prospect 1 件（**配信中のみアドレスを持つ**） |
| `ak:prospect:index:active` | 1（member が増える） | 送信候補の集合 |

**この段階では `blocked:` / `index:blocked` / `promo-lock:` は作られない。**
Airtable / ScheduledEmails へは**一切書かない**。

## 冪等性

- 同じ CSV を 2 回投入しても `addIfAbsent` が既存を上書きしないので **件数は増えない**
- 抑止台帳に載った相手は**再投入しても復活しない**
- `intake` の応答 `実際に追加` が 2 回目に **0** になることで確認できる

## cleanup（canary 後）

1. 各アドレスに `suppress`（`reason: 'manual'`）→ 台帳へ載り、送信候補から外れる
2. `purge` → `ak:prospect:p:<hash>` が消える（**生アドレスが消える**）
3. `status` で `送信候補` が開始値に戻り、`永久除外` が +投入件数 になることを確認

> ⚠️ **台帳（`blocked:`）は残す設計**。消すと再取り込みで復活してしまう。
> canary 用アドレスが台帳に残ることは**正常**。

## 想定件数

| 項目 | 想定 |
|---|---|
| 投入 | **3〜5 件** |
| `実際に追加` | 投入件数と同じ |
| Customers の増加 | **0** |
| ScheduledEmails の増加 | **0** |
| 送信 | **0** |

---

# 段階開放後に見る監視指標（**数字だけ**）

PII・メールアドレス・Redis の値は出さない。**件数と時刻だけ**を見る。

| 指標 | 取得元 | 正常 |
|---|---|---|
| prospect 状態別件数（`送信候補` / `反応済み未登録` / `永久除外`） | 管理画面「件数を確認」 | 意図した増減のみ |
| ScheduledEmails の PENDING 件数 | 既存の送信状況画面 | 武装前は **0**。武装後は `queued` と一致 |
| Customers の増加数 | 開始値との差 | P2 では **0**。P4 では昇格数と一致 |
| 顧客写しの件数 | `cron-prospect-worker` ログの `写し.件数` | Customers 件数と概ね一致 |
| 顧客写しの鮮度 | 同 `写し.経過秒` | **21,600 秒未満**。超え続けるなら更新が失敗している |
| 送信数 | 既存の配信ジョブ | `maxRecipients` を超えない |
| error 数 | 両 cron ログの `level=error` と `errors: []` | **0** |
| 自動昇格の結果 | `cron-prospect-worker` ログ `昇格.登録 / 失敗 / 取り合い` | `失敗` が続かない |

### 異常の見分け方

- `写し.契機: snapshot_missing` が**毎回**出る → 写しの保存が失敗している
- `昇格.失敗` が減らない → Airtable 側の拒否（列・権限）を疑う
- `索引の掃除.removed` が毎回出る → 索引を壊す書き込み経路がある
