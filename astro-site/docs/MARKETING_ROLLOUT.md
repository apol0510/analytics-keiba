# 大規模継続配信の運用基盤（MARKETING ROLLOUT）

CSV 取り込みの **14,489 名**（未付与 14,479 名 / 2026-08-15 実測）へ、
1 人あたり最大数十通のマーケティング接点を配り、反応で継続・停止・内容変更しながら、
**人が 145 回手操作しなくても回る**ようにするための土台。

> ⚠️ この文書は**土台の仕様**。実際の付与・送信は承認を得てから行う。
> 既定はすべて **OFF** で、何もしなければ 1 通も出ない。

---

## 1. 何が問題だったか（2026-08-15 の実測）

| 問題 | 実測 |
|---|---|
| 未付与が多い | **14,479 名**。100 名/日だと **145 日** |
| シーケンスが短い | 全 **4 通**。「数十通の接点」に足りない |
| 送信が時間上限に触れる | 同期 Function（上限 26 秒）で 1 通ごとに SendGrid + Airtable PATCH。**100 通で約 200 回**の外部呼び出し |
| 運用が手作業 | 毎バッチ env を開閉して redeploy。1 回の付与に人が張り付く |

## 2. 設計の骨子

**新しい外部サービスを増やさない。** 既に本番で動いているもの（Redis / Airtable /
SendGrid / Netlify Background Function）の組み合わせで解く。

```
rolloutPlan.js    … 今日いくつ進めてよいか（純粋）
rolloutStore.js   … 段階・件数・停止の状態（Redis が正本・CAS）
sequencePolicy.js … 数十通の間隔・頻度上限・訴求角度・反応での停止（純粋）
sendBudget.js     … 1 回の実行でどこまで送るか（純粋）
rolloutView.js    … 運用画面に出す件数（純粋）
marketing-campaign-dispatch(-background).js … 送信（経路は 1 本）
admin-marketing.js `action=rollout` … 運用画面（read-only）
```

判定はすべて**純粋モジュール**に置き、cron・画面・dry-run が同じ関数を通る。
「画面の人数と実際に送る人数がズレる」事故を構造的に防ぐ。

---

## 3. 段階展開（`rolloutPlan.js` / `rolloutStore.js`）

### 二段のスイッチ

| 層 | 何を決めるか | 変えるのに必要なもの |
|---|---|---|
| **env** `MARKETING_ROLLOUT_ENABLED` | 機能そのものの許可。**既定 OFF** | env 設定 + redeploy |
| **状態**（Redis） | 段階・1 日あたりの件数・緊急停止 | 状態の更新のみ（**redeploy 不要**） |

env だけで運用すると 145 回の開閉になる。状態だけにすると
「Redis を書ける人＝本番配信を始められる人」になる。**両方要る**。

### 段階

| 段階 | 1 日あたり既定 | 使いどころ |
|---|---|---|
| `paused` | 0 | 既定。止まっている |
| `canary` | 10 | 経路の確認 |
| `steady` | 100 | 通常運用 |
| `scale` | 500 | 拡大 |
| `completed` | 0 | 配り終えた |

- 1 日あたりの件数は状態で上書きできる。**絶対上限 2,000**（状態が壊れても超えない）
- 段階は**自動では上がらない**。`suggestNextStage()` が実績（到達率・バウンス率・
  苦情率）から提案するだけで、**適用は人が決める**
- バウンス > 5% / 苦情 > 0.1% なら**停止を提案**する

### 進めない条件（1 つだけ理由を返す）

`kill_switch` / `paused` / `not_armed` / `already_ran_today` /
`waiting_previous_step1` / `no_candidates` / `daily_limit_reached` /
`state_unreadable` / `completed`

- **kill switch は段階より強い。** 立てた次の tick から止まる
- **同じ日に二度走らせない**（cron の重複起動・手動再実行）
- **前回ぶんの Step1 が片付くまで次を配らない**（既存の関所をそのまま使う）
- **読めない値は「0 件」ではなく停止**（fail closed）

### 毎日 env を触らなくてよい理由

`alwaysArmed: true` にすると、日付指定（`armedFor`）を毎日置き直さずに継続運用できる。
日付指定で運用する場合は、**1 回実行すると自動的に閉じる**ので置きっぱなしでも暴走しない。

---

## 4. 送信の実行時間（`sendBudget.js` / Background Function）

### 件数ではなく**時間**で切る

「1 回 200 通まで」のような件数上限は、1 通あたりの所要が変われば意味を失う。
経過時間を見て、**次の 1 通を送る余裕が無ければそこで止める**。

- 同期 Function: 予算 **18 秒**（上限 26 秒に対し応答・後片付けの余白）
- Background Function: 予算 **8 分**（上限 15 分）
- 見積りは**実測で更新**する。遅い環境では自動的に早く止まる

止めた時点までは **1 通ごとに `sent` を書いてある**ので、
残りは次の実行が続きから処理する（`already_sent_in_job` で既送信を飛ばす）。
**ジョブは完了するまで `PENDING` のまま**にする（途中で SENT にしない）。

### 大きいジョブは Background で完走させる

`marketing-campaign-dispatch-background.js` が
「予算内で送る → 残りがあれば繰り返す」を関数の中で回す（最大 15 分）。

- **送信経路は増やさない。** 同期版の `runDispatch()` をそのまま呼ぶ
  （条件の再検証・除外・冪等性を二重に書かない）
- 排他は同期版と同じ鍵（`ak:marketing-dispatch:lock:<jobId>`）
- Background は結果を返せない（202 即返し）。**送信件数は台帳が正本**

### 起動には `expectedWillSend` が要る（安全策は外さない）

Background は `expectedWillSend` が無ければ **202 を返して 1 通も送らない**。
これは「確認した人数と実際の人数が違ったら送らない」ための安全策なので、外さない。
代わりに運転手が**起動直前に read-only の dry-run** を通して人数を数える。

| やること | 理由 |
|---|---|
| 起動直前に `dryRun: true` で `jobResults[].willSend` を取る | 作成後に配信停止・バウンス・購入・既送信が起きていれば対象は減っている |
| dry-run が失敗 / 形が違う / 自分のジョブが無い → **起動しない** | 分からないまま送らない |
| `willSend = 0` → **起動せず理由（`skipByReason`）を記録** | 全員が既送信・配信停止などで正常に 0 のことがある |
| `RecipientCount`（作成時の人数）は**使わない** | 古い数を渡すと送信直前ガードで 409 になり 1 通も出ない |

**202 は「送れた」ではない。** 起動時の送信済み件数を控えておき、次の tick で
台帳が進んだかを見る。進んでいなければ `dispatchStalled` として記録し、
**送信済みとは扱わず**、次の tick が同じ経路（dry-run から）を通す。

### provider 受理と delivered は別

`Status='sent'` は「送信基盤が受理した」。実配信は Event Webhook が別に記録する。
画面でも別項目として出す。

---

## 5. 数十通シーケンス（`sequencePolicy.js`）

### ポリシー

| 項目 | 既定 | 意味 |
|---|---|---|
| `maxSends` | 体験中 **6** / 終了後 **18** | 合計 **24 接点**（`journeyModel.js`） |
| `minIntervalDays` | 3 | 次の 1 通までの最小間隔 |
| `frequencyCap` | 7 日で 2 通 | 短期間の過剰配信を防ぐ |
| `slowdownAfterNoEngagement` | 3 | 無反応が続いたら間隔を伸ばす |
| `slowdownFactor` | 2 | 伸ばす倍率 |
| `stopAfterNoEngagement` | **`null`（打ち切らない）** | 下記の理由により無効 |
| `angles` | **16 種** | 訴求角度。**同じ角度を連投しない** |

> ⚠️ `maxSends` を上げただけでは増えない。**`steps` を足したうえで**上げる。
> ここに置くのは「送りすぎない」ための上限で、増やすための値ではない。

### なぜ「無反応で打ち切る」をやめたか

この施策の目的は **無反応の人にも接点を作って反応を見る**こと。
`stopAfterNoEngagement=8` だと、まさにその対象を 8 通目で切ってしまい、
24 通用意した意味が無くなる。そこで**無反応そのものでは止めない**方針へ変えた。

代わりに残すもの:

- **間隔は伸ばす**（`slowdownAfterNoEngagement=3` / `slowdownFactor=2`）。
  止めないが、無反応の人へ同じ密度では送らない
- **短期の出しすぎ防止は据え置き**（`minIntervalDays=3` / 7 日 2 通）
- **24 通で終わり**（`maxSends=24`）。無限には続かない

即座に止めるのは**相手の意思・不達・不適格だけ**:
購入 / 配信停止 / hard bounce / 苦情 / provider suppression / 対象外。

### 止める条件（強い順）

`purchased`（**最優先**。目的を達成したら販促を止める）→ `unsubscribed` →
`hard_bounce` → `complaint` → `suppressed` → `not_eligible` →
`max_sends_reached` → `no_engagement`

### 反応を次の判断へ使う

`countConsecutiveNoEngagement()` が開封・クリックの履歴から
「無反応が何回続いたか」を数え、間隔の延長・打ち切りの材料にする。
判定そのものは既存の `engagementGuard.js` を使い、ここでは重ねない。

---

## 5.5 運転手（`cron-marketing-rollout.js` / `rolloutOrchestrator.js`）

部品が揃っていても、**繋がっていなければ運用にならない**。
旧構成では 1 バッチ進めるのに人が 3 手（付与 cron → 管理画面で queue → 送信起動）、
さらに `LIGHT_TRIAL_AUTOGRANT_ARMED` へ**今日の日付を入れて redeploy** が要った。
14,479 名を 100 名ずつなら **145 回**繰り返すことになる。

運転手は 1 tick で **1 段階だけ**進める:

| 状況 | やること |
|---|---|
| 付与済みで Step1 未 queue の人がいる | **queue**（新しく配るより先） |
| 送信待ちジョブがある | **送信起動**（Background へ渡す） |
| 積み残しが無く、進めてよい | **付与**（今日ぶんの上限まで） |
| どれでもない | **理由付きで skip** |

- **1 tick 1 段階**。途中で落ちても、次の tick が**そのときの事実**から同じ判断で続きを拾う
- **付与した数だけ**を `lastRun` に刻む。queue が落ちても**同じ日に二重に配らない**
- 終わったジョブの実績は**進めない tick でも**集計へ写す（送ったのに 0 通のまま残さない）
- 事実が 1 つでも読めなければ**何もしない**（`Number(null) === 0` の罠に落ちない）

### 1 tick の優先順位

| 順 | 状況 | やること |
|---|---|---|
| ① | 終わったジョブがある | 台帳の実績を集計へ写す（**進めない tick でも行う**） |
| ② | 送信待ちジョブがある | **送信起動**（起動直前に dry-run で人数を確定） |
| ③ | 付与済みで Step1 未 queue | **queue** |
| ④ | 既存ユーザーに期日の Step がある | **最も早い期日の Step を queue**（Step2〜24） |
| ⑤ | 積み残しも期日も無い | **新規付与** |
| ⑥ | どれでもない | 理由付きで skip |

### Step2〜24 は既存の単一源が決める

「誰の次が何 Step か」を運転手は**決めない**。`action=sequence`
（`buildSequenceProgress` / `selectNextDueStep`）が、購入・配信停止・ハードバウンス・
苦情・provider suppression・対象外・間隔・頻度上限まで見たうえで返す
「いま流してよい人」だけを積む。

⚠️ **`sentCount + 1` のような独自判定を持たない。** 独自に数えると、
止めるべき人へ送る事故になる（この単一源が止めている理由を運転手は知らない）。

Step1 も Step2〜24 も**同じ安全経路**を通る:
`sequence 判定 → dry-run → planFingerprint / contentHash / shellVersion を固定 → queue
→ 送信直前 dry-run → expectedWillSend 付きで Background`。

### 書き込み経路を増やしていない

| 段階 | 実際に書く場所 |
|---|---|
| 付与 | `runLightTrialGrant`（Customers を書く唯一の経路） |
| queue | `admin-marketing` の `dryRun` → `send`（人が管理画面で押すのと同じ関数） |
| 送信 | `marketing-campaign-dispatch-background`（同期版と同じ `runDispatch`） |

運転手が持つのは**順番と再開の判断だけ**。除外・冪等・二重送信防止・TOCTOU（指紋・
文面 hash・組み立て版の突き合わせ）は既存のまま通る。テストがこれを固定している。

### 毎日の env 書き換えをやめた

「今日ぶんの武装」は**残す**が、置き場所を env から**展開状態（Redis）**へ移した。

- `killed` でなく、`stage != paused` で、`alwaysArmed`（または今日の `armedFor`）
  → このときだけ付与 Function へ渡す env に**当日日付を差し込む**
- 停止・再開・1 日上限・段階変更は**管理画面から即時**（redeploy 不要）

⚠️ **人間の許可は env のまま**（自動化のための抜け道を作らない）:
`MARKETING_ROLLOUT_ENABLED` / `COMEBACK_GRANT_FIELDS_READY` /
`COMEBACK_GRANT_ENABLED` / `LIGHT_TRIAL_AUTOGRANT_ENABLED` / 実送信ゲート。
どれか 1 つでも閉じていれば、運転手は**何も書かない**。

---

## 6. 運用画面（`action=rollout`）

`admin-marketing` の read-only アクション。**1 バイトも書かない**。

| 見えるもの | 内容 |
|---|---|
| `control` | kill switch / 段階 / 1 日あたり件数 / **進めない理由** |
| `batch` | 前回実行日と件数 / 累計 / 今日進められる件数 / 残り候補 / **残り日数の見積り** |
| `funnel` | 母集団と 5 分類（未開始・進行中・購入・停止・完了）+ 停止理由の内訳 |
| `steps` | Step 別の 送信 / いま送れる / 待機 / 失敗 / 開封 / クリック |
| `nextScheduledAt` | 次回予定 |
| `policy` | ポリシーの要約 |

- **集計が無ければ `metricsPartial: true`**。割合も件数も捏造しない
- 0 通の Step で反応率を作らない
- **アドレス・recordId は 1 つも返さない**（件数だけ）
- 展開状態を読めないときも**理由を出す**（`state_unreadable`）

### 本番規模の I/O（2026-08-15 に設計変更）

旧実装は 1 リクエストごとに **Customers 14,489 件 + 配信台帳 14,426 行（145 ページ）**を
読んでいた。実測 **156 秒**で、Function の上限（26 秒）を超えるため本番では開けない。

いまは**正本を読まない**。数えるのは**書いた側**（付与・queue・送信の完了時）で、
画面は Redis の集計を読むだけ:

| | 旧 | 現行 |
|---|---|---|
| Airtable ページ | 145+ | **0** |
| Redis GET | 0 | **2** |
| 母集団への依存 | 線形 | **無し**（14,489 名 × 24 Step でも同じ） |

- 集計の正本は**あくまで台帳**。Redis は写しで、ズレたら `reconcile()` で作り直す
- 集計が壊れている / 版が違う / 届かない → **`partial`**（0 と書かない）
- 送信件数は**終わったジョブの台帳値を写す**（運転手が次の tick で行う）。
  送信経路そのものには 1 行も足していない

---

## 6.5 工程ごとの env（`rolloutGates.js` が単一源）

必要な env は**工程ごとに違う**。「4 つ開ければ動く」ではない。

| 工程 | 必要な env | 閉じていると |
|---|---|---|
| 自動運転 | `MARKETING_ROLLOUT_ENABLED=true` | 何も起きない（付与も queue も送信も） |
| 無料付与 | `COMEBACK_GRANT_FIELDS_READY=1`<br>`COMEBACK_GRANT_ENABLED=true`<br>`LIGHT_TRIAL_AUTOGRANT_ENABLED=true` | 新規付与が進まない（既存ぶんの送信は進む） |
| キュー登録 | `MARKETING_CAMPAIGN_ENABLED=true` | 案内が積まれない（付与だけ進む） |
| 実送信 | `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true` | **メールが 1 通も出ない**（積まれるだけ） |

- **既存ゲートを迂回しない。** 運転手は判定を**写す**だけで、緩めない
- 判定に使った env と、実際に動く env（`process.env`）の**両方**で確かめる
  （Function を跨ぐと dispatcher / admin は `process.env` を読むため）
- `COMEBACK_GRANT_FIELDS_READY` だけ `'1'`（既存の付与ゲートに合わせる。`'true'` では開かない）
- 画面（`action=rollout`）が `gates` / `blocked` を返す。
  **閉じている env の名前と、そのせいで何が止まっているか**をそのまま出す（値は出さない）

### 本番で有効化するとき

1. 先に `MARKETING_ROLLOUT_ENABLED` **以外**を設定（付与 3 つ / queue / 送信）
2. 展開状態を管理画面から `stage` / `dailyLimit` / `alwaysArmed` で設定
3. 最後に `MARKETING_ROLLOUT_ENABLED=true`
4. env 変更は **redeploy しないと反映されない**（Netlify の仕様）

停止は `MARKETING_ROLLOUT_ENABLED` を外す（redeploy 要）か、
**管理画面の kill switch**（redeploy 不要・次の tick から止まる）。

---

## 7. 安全条件（触る前に必読）

- **Customers 全件走査へ戻さない。** 受信対象は宣言から formula を作って名指しで引く
- 配信台帳は **DeliveryKey / RecipientEmail / JobId で名指し**（`fetchAll` は使わない）
- **secret / PII をログ・鍵・応答へ入れない**。Redis の鍵に入れてよいのは
  `campaignId` と `jobId` だけ（形を正規表現で制限）
- 販促処理で **Customers の課金・会員フィールドを書かない**
- **実送信をテストに使わない。** 送信経路の試験は fetch を差し替えた偽 API で行う
- production と canary を混ぜない（canary は別 env・別鍵空間）

## 8. テスト

```bash
npm run test:marketing   # 下記すべてを含む
npm run check:safety     # 全 safety check
```

| ファイル | 見ているもの |
|---|---|
| `rolloutPlan.test.mjs` | 既定停止 / kill switch / 二重実行 / 関所 / fail closed / 段階提案 |
| `rolloutStore.test.mjs` | CAS / 緊急停止 / 名前空間 / PII / Redis 不通 |
| `sequencePolicy.test.mjs` | 購入・配信停止で即停止 / 最大回数 / 頻度上限 / 無反応 / 訴求角度 |
| `sendBudget.test.mjs` | 時間で切る / 実測追従 / 完了と打ち切りの区別 |
| `rolloutView.test.mjs` | 5 分類 / 割合を捏造しない / 0 通で率を作らない / PII |
| **`rolloutScale.test.mjs`** | **14,489 名 fixture** / 100・500・1000 名チャンク / 数十 Step / 1000 通の分割送信 / 重複起動 |
| `dispatchBackground.smoke.test.mjs` | Background でチャンク完走 / 排他 / ゲート / PII |
| `dispatcherHandler.smoke.test.mjs` | 同時 2 本で 1 通のみ / 解放結果 / 逐次再実行の冪等性 |
| **`rolloutOrchestrator.test.mjs`** | **積み残し優先 / 事実不明で停止 / 同日二重防止 / 14,479 名を tick だけで配り切る / 途中 kill** |
| **`rolloutOrchestratorFunction.test.mjs`** | **ゲート閉で無接続 / 武装は状態側 / 経路を増やしていない / 実績の写しを skip tick でも行う** |
| **`rolloutMetrics.test.mjs`** | **加算の atomic 性 / 未計測を 0 と書かない / 版違い・破損で partial / I/O が母集団に依存しない** |
| **`rolloutGates.test.mjs`** | **工程ごとの env / 既定は全部閉 / 名前をそのまま返す / 値を出さない** |
| **`rolloutJourney.integration.test.mjs`** | **30 日付与で期限切れをまたいで 24 通 / 順番 / 24 通で打ち止め / 無反応でも進む / 購入 3 パターン / 配信停止・バウンス・苦情・suppression / 再起動で二重 0 / 分割再開 / ゲート別の副作用** |
| **`journeyModel.test.mjs`** | **接点 1〜24 の対応（重複・欠番なし）/ 範囲外は null / 上限 24** |
| **`journeyTotals.test.mjs`** | **1 人が 1 分類（二重計上なし）/ 読めない値は null** |

## 9. まだやっていないこと

- **実顧客への付与・送信は 1 件もしていない**（この土台は既定 OFF）
- 段階の自動昇格はしない（提案のみ）
- Step5〜6（体験中）と終了後 18 通の**文面は初稿**。配信前に文言レビューを通す
- 集計の `reconcile()`（totals + steps の全書き換え）は手動の復旧口。
  人数だけの同期（`reconcileTotals`）は cron が毎 tick 行う
- 開封・クリックの計測は既存の Event Webhook に依存（click 計測はアカウント全体では
  有効化しない。magic link が壊れるため）


---

## 10. 2 フェーズ構成（無料期間 30 日 と 24 通の両立 / 2026-08-15 決定）

### 何が問題だったか

統合テストで通しに回して分かった: **30 日の無料期間に 24 通は入らない**。
最短 3 日間隔 + 無反応での間隔延長では 6 通前後で期限が来る。
配信対象が `requiresActiveGrant`（無料期間中のみ）なので、期限切れ後は
`grant_expired` で止まり、**Step7 以降が誰にも届かない**状態だった。

### どう解いたか（通数は減らさない）

**フェーズを 2 つに分ける。** 通数は 24 のまま、対象条件を事実に合わせる。

| フェーズ | campaignId | 通数 | 通し番号 | 対象条件 |
|---|---|---|---|---|
| 体験中 | `light-trial-to-premium-sequence` | 6 | 1〜6 | 期限付き Light 付与が**有効** + 取り込みコホート |
| 体験終了後 | `light-trial-post-expiry-sequence` | 18 | 7〜24 | Light 付与の痕跡があり**期限切れ** + 取り込みコホート |

- **既存の Step1 は 1 文字も変えていない**（送信済み 10 名。逐語で凍結）
- 体験中フェーズの `requiresActiveGrant` は**維持**（外さない）
- 終了後フェーズは `requiresActiveGrant` を**要求しない**。代わりに
  `requiresExpiredGrant: { tier: 'light' }`（新設の宣言）
- 通し番号の変換は `journeyModel.js` が単一源（`maxTouches = 24`）

### フェーズ移行（handoff）は記録を作らない

毎 tick、そのときの事実から導出する:

1. 体験中フェーズが期限切れを `grant_expired` で止める（**脱落ではない**）
2. 終了後フェーズの対象条件（痕跡あり + 期限切れ）に自動的に入る
3. 購入 / 配信停止 / バウンス / 苦情 / suppression / 対象外は既存の単一源が止める
4. 期日が来たら通常の安全経路を通る（dry-run → 指紋固定 → queue →
   送信直前 dry-run → `expectedWillSend` 付き Background）

**記録が無い＝二重に作れない。** cron が何度落ちて再起動しても、同じ事実から同じ結論になる。

### 文面（終了後 18 通）

`postExpirySteps.js`。**事実と異なる表現を置かない**:

- 「無料体験中」「まだ無料で利用できます」「無料期間の残り」→ **カタログ検証で禁止**
- `{{grantExpiry}}`（体験の終了日の差し込み）は使わない
- benefitType は `free_content`（**新しい権利は付かない**。`free_access` とは別物）

1 通目で「期間が終わったこと」と「いま何が見られるか」を必ず伝える。

### 管理画面

体験中 / 体験終了・フォロー中 / 購入 / 停止 / 24 通完了 / 現在の通し番号 / 次回予定。
人数の主計は**終了後フェーズの集計**から作る。両フェーズは同じ母集団を見ているので、
単純に足すと 1 人を 2 回数える。まとめ方は `journeyTotals.js` が単一源で、
**1 人が必ず 1 分類に入る**ことをテストで固定している。

集計は cron が毎 tick 同期する（`reconcileTotals`）。画面は Redis を 2 回読むだけ。

### 統合テストで固定していること

30 日の実付与で時計を進め、**期限切れをまたいで 24 通が人手ゼロで届く**こと。
1 人あたり 24 通ちょうど・重複 0。順番が入れ替わらない。24 通の後は 1 通も増えない。
無反応でも 24 通まで進む。5 通目のあと購入 / 期限切れ直前に購入 / 終了後 3 通目のあと購入 →
以降 0 通。配信停止 / ハードバウンス / 苦情 / suppression → 以降 0 通。
cron 再起動で handoff の二重作成 0・二重 queue / 送信 0。

---

## 11. 配信イベントの計測（2026-08-16 調査）

### EmailEvents（Airtable）が空なのは**仕様**

`MARKETING_EVENT_SINK=blob`（production）なので、イベント行は Airtable へ**書かない**。

| `MARKETING_EVENT_SINK` | Airtable `EmailEvents` | Blob 生ログ | Redis カウンタ |
|---|---|---|---|
| 未設定 / `airtable` | 書く | — | — |
| `dual` | 書く | 書く | 書く |
| **`blob`（現行）** | **書かない** | 書く | 書く |

理由: `EmailEvents` は Airtable の 37% を占め、`open` は重複排除されないため無制限に増える。

### 実際にイベントは届いている（実測）

| 確認 | 実測（2026-08-16） |
|---|---|
| SendGrid Event Webhook | **登録済み・有効**（URL は本番の `/.netlify/functions/sendgrid-webhook`） |
| ON になっている event | `delivered` / `open` / `bounce` / `dropped` / `spam_report` / `unsubscribe` |
| OFF の event | `click` / `deferred` / `processed` / `group_*` |
| 署名検証 | `SENDGRID_WEBHOOK_VERIFICATION_KEY` は production に**設定済み**（未設定なら 403 で fail closed） |
| 受信の生存確認 | engagement coverage の `lastEventAt` が**送信の 1 分後**を指す |
| provider 側統計 | requests 109 / **delivered 109** / opens 8（unique 4）/ bounces 0 / blocks 0 / deferred 0 / spam 0 / unsubscribes 0 |

⚠️ **click は provider 側で OFF**。クリック計測を有効化するとアカウント全体の
click tracking がかかり、**マジックリンクが壊れる**（既知の禁止事項）。有効化しない。

### 読み取り経路（現状の限界）

- **集計**（Redis）… `action=sequence` の `engagement.coverage`（観測開始・最終イベント・記録済み open 数）
- **生ログ**（Netlify Blobs `ak-email-events`）… 監査用。管理 API からの読み出し口は**まだ無い**
- **campaign / step / touch 別の delivered・open の内訳**を返す口は**無い**（次工程）

### 未計測は「無反応」ではない（2026-08-16 修正）

`countConsecutiveNoEngagement` は `opened !== true` を無反応として数えていた。
`sink=blob` では配信行に開封が載らないため、**全員が無反応**として扱われ、
`resolveIntervalDays` の減速（間隔 2 倍）が全員に掛かっていた。
将来 `stopAfterNoEngagement` に数値を入れると**全員が打ち切られる**状態でもあった。

修正後:

- 観測できた通（`opened` / `clicked` が真偽値、または `measured: true`）だけを数える
- **未計測に当たったらそこで数えるのを止める**（過去へ遡らない）
- `summarizeEngagementHistory()` が「無反応」と「未計測」を分けて返す（`unknown` フラグ付き）

エンゲージメント除外（`engagementPolicy`）側は従来から未計測を `unknown` として扱い、
**誰も除外しない**（本番実測でも 110 名が `unknown` / `blocked: 0`）。

---

## 12. 1 通ごとの計測（2026-08-16 追加）

### なぜ「受信者ごとの最新 open」ではだめか

受信者単位の集計だと「**どの通を**開いたか」が分からない。
古いメールを後から開いた場合、直近の touch を開封済みと**誤って帰属**する。
判断は必ず **DeliveryKey（campaign × version × step × 受信者の sha256）完全一致**で行う。

### 索引（`deliveryEventIndex.js`）

webhook 受信時、**resolved なイベントだけ**を Redis へ O(1) で畳む。

| 鍵 | `ak:delivery-events:<DeliveryKey>` |
|---|---|
| 持つもの | `d`（delivered 時刻）/ `o`（最初の open）/ `ol`（最後の open）/ `oc`（open 回数）/ `v`（版） |
| 持たないもの | **click**（provider 側 OFF。観測していないものを false にしない）／bounce・spam・unsubscribe（**既存の停止経路が正本**） |
| PII | 入れない（鍵は sha256、アドレスは保存しない） |
| 冪等 | delivered / first open は**より早い方**、last open は**より遅い方**、open 回数は provider の event id が未登録のときだけ +1 |
| 正本 | **Blob の生ログ**。索引は再構築できる写し |
| 失敗時 | webhook を落とさない（`deliveryIndex: failed` をログに残すだけ） |

### 履歴への結合（`touchMeasurement.js`）

配信台帳の行と索引を DeliveryKey 完全一致で結び、`sequencePolicy` が食える履歴にする。

| 索引の状態 | 履歴の行 |
|---|---|
| delivered あり + open あり | `measured: true` / `opened: true` |
| delivered あり + open なし | `measured: true` / `opened: false` |
| delivered を確認できない | `measured: false`（**無反応として数えない**） |
| 索引そのものが読めない | 全行 `measured: false` |

### 管理画面（`action=touchMeasurement`）

touch 別に `sent` / `delivered` / `opened` / `measured` / `unknown` と率を返す。

- `deliveryRate = delivered / **sent**`、`openRate = opened / **delivered**`（分母を応答に明記）
- 分母 0 のときは率を `null`（0% と書かない）
- 索引が読めなければ `measurementAvailable: false`
- **Blob 全件走査はしない**（`blobReads: 0`）。Redis は 1 リクエスト最大 500 鍵の bounded read

### 索引より前に届いたぶん（`action=eventBackfillDryRun`）

索引は webhook 受信時にしか積まれないので、**索引を作る前に届いたイベント**は入らない。
生ログ（Blob）から**対象の DeliveryKey だけ**を拾い直す下見を用意した。

- 走査は**日付で絞る**（`date: YYYY-MM-DD` 必須。Blob 鍵は `ak/email-events/YYYY/MM/DD/...`）
- 対象は「その campaign × version × step で実際に送った鍵」だけ
- `resolved` でないイベントは入れない
- 同じ鍵に別 campaign / version が混ざっていたら **conflict として書かない**
- **下見は 1 バイトも書かない**（`action=eventBackfillDryRun`）
- 実行は `action=eventBackfillRun`。**確認を 3 つ要求する**:
  `confirm: true` / 下見で見た `expectedWriteKeys` と一致 / `conflicts: 0`。
  1 つでも欠ければ **400 / 409 で書かない**（Blob は追記され続けるので、
  確認したときと対象が変わっていたら止める）
- 書くのは**索引だけ**。Customers・配信台帳・送信には触れない。
  畳み込みは webhook と**同じ関数**を通すので、何度実行しても結果は変わらない

---

## 13. 同日に複数バッチ（グループ配信 / 2026-08-17）

### 変えたこと

「**1 日 1 回**」（`lastRunDay === 今日 なら always 拒否`）を**やめた**。
約 15,000 件を配るのに 1 日 1 バッチでは 30 日かかり、目的（安全なグループ単位の連続配信）と
噛み合わないため。

| | 旧 | 現行 |
|---|---|---|
| 同じ日の 2 回目 | **常に拒否**（`already_ran_today`） | 上限と関所の範囲で**進める** |
| `dailyLimit` の意味 | 1 回に配る人数 = 1 日の人数 | **1 日に配れる合計人数**（回数ではない・**必須**） |
| 1 回に配る人数 | 同上 | **`batchSize`**（**必須**。1 日上限とは完全に別物） |
| 1 日の絶対上限 | 2000 固定 | **`ABSOLUTE_MAX_PER_DAY = 20000`**（15,000 件を 1 日で配り切れる） |
| `lastRunDay` の役割 | 同日 2 回目の禁止 | **今日の集計がどの日のものか**を示すだけ |

### 何が二重付与・二重送信を防ぐか

1. **関所（`previousOutstanding > 0` なら次を始めない）** … バッチを直列化する。
   付与 → queue → 送信 → 台帳確認 が終わるまで次は始まらない。cron が重複起動しても同じ判断。
2. **1 日の合計上限**（`dailyLimit` / 絶対上限 `ABSOLUTE_MAX_PER_DAY = 20000`）
3. **バッチごとに一意な `operationId`**
   - `light-trial-2026-08-17`（1 バッチ目 = **従来と同じ形**。既存データと互換）
   - `light-trial-2026-08-17-b2`, `-b3` …（同じ日の 2 バッチ目以降）
   - 同じ値なら付与は冪等。**別のバッチは必ず別の値**になる
4. **DeliveryKey**（campaign × version × step × 受信者）… 同じ人へ同じ touch を二度送らない
5. **kill switch**（全アクションに優先）

### バッチ間の健全性チェック（`batchHealth.js`）

2 バッチ目以降は、**前のバッチの結果を確かめてから**始める。
人が挟まらないので、機械が代わりに見る。

⚠️ **見るのは「増えたぶん」だけ**（2026-08-17 の誤検知）。バッチを始めるたびに累積値の
   スナップショット（`healthBaseline`）を控え、次のバッチの前に**差分**を取る。
   `byStopReason.provider_suppressed` は「候補を除外した理由」で**静的・累積**なので、
   そのまま苦情として渡すと、コホートに元から居る停止リスト該当者 1 名が
   0 件許容の苦情しきい値に永久に当たり、**二度と開始できない**（実際に 1 tick 目で止まった）。
   最初のバッチは比較相手が無いので健全性判定を行わない（関所・1 日上限・kill が守る）。

| 見るもの（**増分**） | 止める条件（既定） |
|---|---|
| duplicate | **1 件でも** |
| complaint（苦情） | **1 件でも** |
| failed（送信失敗） | 5% 超 |
| hard bounce | 2% 超 |
| unsubscribe | 2% 超 |
| `previousOutstanding` | 0 でない |
| provider suppression | **読めない**とき |

⚠️ **数えられない値が 1 つでもあれば進まない**（0 件として通さない）。
異常なら運転手が `stage: 'paused'` へ落として**自分で止まる**
（新規付与だけ止まり、積み残しの queue / 送信は続く）。

### 運用（例: 500 名単位）

```json
{"action":"rolloutStart","campaignId":"light-trial-to-premium-sequence",
 "stage":"scale","dailyLimit":2000,"batchSize":500,
 "alwaysArmed":false,"armedFor":"<実行日 JST>","expectedVersion":<stateVersion>}
```

→ 500 名 → 完了確認 → 500 名 …。`dailyLimit` が今日の天井、`batchSize` が 1 回の人数。

⚠️ `dailyLimit` も `batchSize` も**必ず明示する**（未指定は 400）。
   既定値で代用すると「15,000 名を 1 バッチで投げる」事故になる。
⚠️ `armedFor` は**その日のうち有効**（1 バッチで外れない）。翌日には失効する。

#### 🩹 候補の観測窓は `batchSize` に必ず合わせる（2026-08-17 の事故と恒久対策）

`batchSize=500 / dailyLimit=500` で開始したのに、tick が **100 名しか付与しなかった**。

原因は**事実収集の観測窓**。tick は候補数を数えるために
`loadAndPlanLightTrial()` を呼ぶが、ここに人数を渡していなかったため
付与側の既定（`LIGHT_TRIAL_AUTOGRANT_BATCH_SIZE` 未設定 = `DEFAULT_BATCH_SIZE` 100）で
候補の取得が打ち切られ、`remainingCandidates = 100` になった。
`allowance = min(batchSize, dailyRoom, remaining)` なので、**エラーを出さずに**
バッチが 100 名へ縮む（silent cap）。

対策（`resolveObservationWindow(state, nowMs, { perCallMax })` を単一源にした）:

| | 値 |
|---|---|
| 観測窓 | `min(batchSize, 今日の残り枠, 付与 1 回の上限)` |
| 例: `batchSize=500` / 今日まだ 0 名 | **500** |
| 例: `batchSize=500` / 今日すでに 100 名 | **400**（= `dailyLimit 500 − 100`） |
| 例: `batchSize=1000` / 今日まだ 0 名 | **500**（= 付与 1 回の上限。残り 500 は次の tick） |
| 例: 今日の残り枠 0 | **0**（読みにも行かない） |

#### 人数の上限は 4 軸あり、混同しない（**低い方が勝つ**）

| 軸 | 値 | 出どころ |
|---|---|---|
| **付与の計画**（`buildComebackPlan`） | **200**（`MAX_GRANT_RECORDS`） | 暴走防止。超えると **計画自体を作らない**（`too_many_records:N>200`）＝ **実効上限** |
| **付与 1 回**（`runLightTrialGrant` 1 呼び出し） | 500（`HARD_MAX_BATCH_SIZE`） | #319 以来。**超える値は実行しない**（fail closed） |
| **送信の子バッチ** | 既定 500 / 上限 1,000 | `docs/spec.md`（配送の実行モデル） |
| **1 日に配れる合計** | `dailyLimit`（絶対上限 `ABSOLUTE_MAX_PER_DAY = 20000`） | #354 |

運転手が 1 回に依頼する人数は **`GRANT_OPERATION_MAX = min(HARD_MAX_BATCH_SIZE, MAX_GRANT_RECORDS)` = 200**。
**この値をどこにも再定義しない**（正本は各モジュール）。`batchSize` が 200 で割り切れる必要はない
（例: `batchSize=500` は **200 → 200 → 100**）。

⚠️ `batchSize` に **500 / 1000 を指定してよい**（送信側の刻みとして正式に許可されている）。
   `rolloutStart` は**断らない**。付与だけは 1 回 **200**（`GRANT_OPERATION_MAX`）で刻み、
   残りは次の tick が続きを拾う（`dayGrantedCount` が積み上がるので `dailyLimit` の意味は変わらない）。
   **「設定を断る」のではなく「分けて配る」**。

| 設定 | 同じ日の進み方 |
|---|---|
| `batchSize=500` | **200 → 200 → 100**（計 500） |
| `batchSize=1000` | **200 × 5**（計 1000） |
| `batchSize=500` / 今日すでに 100 名 | **200 → 200**（残り枠 400 で止まる） |

#### 🩹 「配る予定があったのに 0 件」を成功として記録しない（2026-08-17 午後の事故）

`batchSize=500` から allowance 400 を **1 回で**依頼したところ、`MAX_GRANT_RECORDS=200` に掛かり
`too_many_records:400>200` で **付与 0 のまま 14 tick 空回り**した
（`batchSeq` だけ進み、`lastRunCount: 0` が正常実行として記録され、5 分ごとに永久に繰り返す状態）。

判定は `grantOutcome.js` の `classifyGrantOutcome()` が単一源:

| 結果 | 条件 | 状態の記録 | 自動停止 |
|---|---|---|---|
| `granted` | 1 人以上配れた（部分成功を含む） | **実数で settle** | しない |
| `idle` | 正常に配る相手が居ない（`no_candidates`） | **しない** | しない |
| `failed` | 予定があったのに 0 件（`too_many_records` / 書き込み失敗 / 理由不明） | **しない**（`batchSeq`・`dayGrantedCount`・`lastRunCount` を動かさない） | **する**（`stage: paused` + `note: auto-stop: <理由>`） |

#### 自動停止は CAS で確定させる（`rolloutPauseGuard.js`）

展開状態の保存は CAS（`expectedVersion`）なので、**競合すると保存されない**。
旧実装は保存の成否を見ずに `autoStopped: true` と返しており、
**「止めたと報告したのに止まっていない」**が起こり得た。

- 停止は `pauseWithRetry()` が担当。**毎回読み直してから**書く（新しい変更を古い値で潰さない）
- 競合したら**上限つき**（`PAUSE_MAX_ATTEMPTS = 3`）でやり直す
- すでに `paused` / `killed` なら書かずに完了扱い（**二重に書かない**）
- 確定できなければ **`abort: 'state_write_conflict'` / `autoStopped: false` / `sideEffects: 'none'`**
  で返す（**止まったと偽らない**。次の tick が改めて止める）
- どちらの結果でも `settleTick` は呼ばないので、`batchSeq` / `dayGrantedCount` /
  `lastRunCount` は動かない。Customers への再付与もしない

⚠️ **`idle` と `failed` を混ぜない。** 候補 0 は正常な終わり方、`too_many_records` は運用が直す異常。

- 残数は **`counts.candidates`（実際に配れる人の数）** で数える。
  `cohort.inCohort` は「読んだ Airtable の行数」なので、除外された人まで数えてしまう。
- `moreAvailable === true` のときの件数は「少なくともこれだけ居る」という**下限**。
  `remainingIsLowerBound: true` を facts に持たせ、**全残数として断定させない**。
- `moreAvailable === false` なら窓の中で拾えた分が確定値（**最後の端数を取りこぼさない**）。

⚠️ **env `LIGHT_TRIAL_AUTOGRANT_BATCH_SIZE` で回避しない。** 展開状態（`batchSize`）と
   env の 2 か所に人数の正本ができ、どちらが効いているか分からなくなる。
   人数の正本は**展開状態だけ**。

### 15,000 件を 1 日で配り切る

| 割り方 | バッチ数 | tick 数（1 バッチ = 付与 / queue / 送信の 3 tick） | 所要（5 分間隔） |
|---|---|---|---|
| 500 × 30 | 30 | 90 | 約 **7.5 時間** |
| 1000 × 15 | 15 | 45 | 約 **3.75 時間**（付与は 500 ずつ 2 回に分かれる。下記） |

cron は **5 分間隔**（毎時 1 回だと 90 時間かかり「1 日で配り切る」に届かない）。
⚠️ 速さを決めているのは cron の間隔ではなく**関所**。前のバッチの Step1 が送り終わるまで
次は始まらないので、送信基盤が詰まればその分だけ自然に遅くなる。

⚠️ **1 リクエストで 15,000 名へ投げる形にはしない。** 必ずグループ（`batchSize`）へ割り、
1 バッチずつ「付与 → queue → 送信 → 台帳確認」を終えてから次へ進む。


## 📏 touch 別実績は「1 リクエスト 1 ページ」で数える（2026-08-17）

`action=touchMeasurement` は配信台帳を**全件一括**で読み、受信者 × step ぶんの DeliveryKey を
その場で全部計算していた。配信行が **610 に増えた時点で 504（Inactivity Timeout）**。
最終的に 14,000 名規模になるため、**timeout や上限値を上げるだけの対応はしない**（必ずまた壊れる）。

### 変えたこと

| | 旧 | 現行 |
|---|---|---|
| 台帳の読み方 | `fetchAllStrict` で**全件** | **1 ページだけ**（`cursor` = Airtable の `offset`） |
| 1 リクエストの仕事量 | 行数に比例して増える | **`pageSize` で頭打ち**（既定 200 / 上限 500） |
| DeliveryKey の計算 | 全受信者 × 全 step | **そのページの受信者ぶんだけ** |
| イベント索引の読み | 先頭 500 件で頭打ち | 1 ページは必ず上限以下（`TOUCH_SCAN_MAX_PAGE ≤ MAX_READ_KEYS`） |
| 全体を見る方法 | （無い） | **`npm run scan:touch-measurement`**（cursor を辿って合算） |

### action は 2 つに分かれている（**契約を混ぜない**）

| action | 返すもの | 読み方 |
|---|---|---|
| `touchMeasurement` | **全体**（`schemaVersion: 2`） | 数え切れたときだけ `complete: true` + `touches` / `totals`。<br>数え切れないときは **`touches` も `totals` も返さない**（`complete: false` / `code: measurement_requires_scan` / HTTP 413） |
| `touchMeasurementPage` | **1 ページ** | 必ず `partial` と `scan.cursor` を持つ。合算は呼び出し側（`mergeTouchPage`） |

⚠️ 旧来 `touchMeasurement` は「全体の集計」を返す約束だった。**部分集計を同じ形で返さない**
（一部を全体として読まれるくらいなら数を出さない）。1 回で歩くページ数は
**`MEASUREMENT_INLINE_MAX_PAGES = 1`**（＝ 1 ページ版とまったく同じ仕事量）で頭打ちで、
**ここを増やして全件走査へ戻さない**。

⚠️ **2 ページにしてはいけない（2026-08-17 本番実測）。** 2 ページ歩く実装は 610 行の campaign で
   2 ページ目の途中に Function がタイムアウトし **504**（意図した「即 413 + 数字なし」に到達できない）。
   1 ページ版は同条件で完走することを本番で確認済み。**610 行規模では全体版は 413 を返す**ので、
   全体集計は `npm run scan:touch-measurement` を使う。

⚠️ 2026-08-17 時点で `touchMeasurement` を呼ぶ実装は **`scripts/touch-measurement-scan.mjs` だけ**
（管理画面にも他 Function にも読み手は無い）。`touchMeasurementContract.test.mjs` が
呼び出し元の一覧を固定しているので、増えたらテストが落ちる。

### 合算の約束

- 合算は `touchMeasurementScan.js` の `mergeTouchPage()` が単一源。
  **`pageIndex` で識別し、同じページを 2 回足しても増えない**（再試行で数が膨らまない）
- **率は合計してから 1 回だけ**計算する（ページごとの率を平均しない）
- 索引を読めなかったページが 1 つでもあれば `measurementAvailable: false`
  （読めなかったぶんを 0 件として通さない）
- 応答は `partial` と `scan.cursor` を必ず返す。**1 ページを全体として見せない**
- `RecipientEmail` は突き合わせに使うだけで、**応答にもログにも出さない**

検証: `npm run test:marketing`（`touchMeasurementScan.test.mjs` が 499 / 500 / 501 / 610 /
15,000 件の境界と多ページ・重複 0・PII なしを固定）


## 🤖 人手なしで最後まで配り切る（2026-08-18）

### 完成条件

**`dailyLimit=15000 / batchSize=500` で、約 15,000 名を同じ日に配り切る。**
一度開始したら、運用者は**毎日 arm もresume もしない**。異常のときだけ人が出る。

**数値の正本は `src/lib/marketing/rolloutTarget.js`（`ROLLOUT_TARGET`）**。
docs とコードは `rolloutTargetContract.test.mjs` が突き合わせるので、**片方だけ変えると CI が落ちる**。

| | 値 |
|---|---|
| 対象 | 取り込みコホート 約 15,000 名 |
| 1 日に配れる合計 | `dailyLimit = 15000` |
| 論理バッチ | `batchSize = 500` |
| 付与 1 回 | **200**（`GRANT_OPERATION_MAX`。500 は **200 + 200 + 100**） |
| 1 バッチの tick | 付与 3 + queue 1 + 送信起動 1 = **5 tick** |
| 全体 | 30 バッチ = **150 tick**。cron **2 分間隔**で約 **5 時間** |

⚠️ 2026-08-17 の「500 名で停止」は**カナリアと障害修正のため**であって仕様ではない。

### 関所は「論理バッチ単位」

500 名は付与 3 回に分かれるので、**その 3 回の途中は未処理があっても進む**
（`batchGrantedCount` がバッチの進み具合）。配り切ったら
queue → 送信 → 台帳確認（`outstandingStep1 = 0`）まで待ってから次のバッチへ。

- 未処理が「自分が配った数」を超えたら `outstanding_mismatch` で**停止**（説明できない状態）
- 頼んだ人数に届かなかったら**そのバッチを閉じる**（候補が尽きた合図。端数を取りこぼさない）

### 開始方式は `alwaysArmed`（既存の仕組みをそのまま使う）

`alwaysArmed: true` なら `armedFor` の書き換えが要らず、**日付が変われば
`dayGrantedCount` が 0 に戻って続きが進む**。新しい仕組みは足していない。

- **異常停止すると `planRolloutPause` が `alwaysArmed: false` にする**ので、
  自動では戻らない（人が `rolloutStart` するまで動かない）
- **completed に入ると `alwaysArmed: false` + `armedFor: null`**（翌日も動かない）

### 終端（completed）は「新しく配る相手が居ない」だけ

`isRolloutComplete()` が `候補 0` かつ `関所 0 / queue 待ち 0 / 送信待ち 0` を確かめ、
CAS（`completeWithRetry`）で `stage: completed` に入る。

⚠️ **completed でも tick は止まらない。** 既に配った人の Step2〜24 は何週間も続くので、
運転手は動き続け、`planRolloutTick` が**付与だけ**を止める。
（一時停止 `paused` のときだけ、台帳を読む前に抜ける）

### 運用状態は 6 つ（`rolloutOperationalState.js`）

| 状態 | 意味 | 人の操作 |
|---|---|---|
| `running` | 展開中 | 不要 |
| `waiting_previous` | 前のバッチの送信待ち | 不要 |
| `daily_limit_reached` | 今日の上限に到達。**日付が変われば自動で続く** | **不要** |
| `completed` | 配る相手がもういない | 不要（終端） |
| `paused` | 人が止めた | 再開が要る |
| `auto_stopped` | **異常で自動停止**（`stopReason` 付き） | **原因を直して開始し直す** |

⚠️ **`daily_limit_reached` と `auto_stopped` を同じ意味にしない。**
前者で毎日 resume を人に求める運用にはしない。

### 自動停止する条件（fail closed）

付与失敗（`too_many_records` / 書き込み失敗 / 理由不明）／**queue 失敗**／
**送信起動が 1 件も成功しない**／バッチ健全性（duplicate・苦情・失敗率・bounce・
unsubscribe・suppression 読めない）／`outstanding_mismatch`／事実が読めない／
CAS で停止を確定できない（`state_write_conflict` は「止めた」と報告しない）。

停止すると `stage: paused` + `autoStopped: true` + `stopReason` が残り、
**人が `rolloutStart` するまで再開しない**（`alwaysArmed` も外れる）。
