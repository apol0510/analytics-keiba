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
| `maxSends` | **24** | 1 人あたりの最大回数（**24 通の実文面がある**） |
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
| **`rolloutJourney.integration.test.mjs`** | **時計を進めるだけで Step1→24→完了 / 購入・配信停止で以降 0 通 / 再起動で二重 0 / 分割再開 / ゲート別の副作用** |

## 9. まだやっていないこと

- **実顧客への付与・送信は 1 件もしていない**（この土台は既定 OFF）
- 段階の自動昇格はしない（提案のみ）
- Step5〜24 の**文面は初稿**。配信前に文言レビューを通す
- 集計の `reconcile()` は**手動で叩く復旧口**。定期実行はまだ配線していない
- **30 日の無料期間には 24 通は入り切らない**（下記）
- 開封・クリックの計測は既存の Event Webhook に依存（click 計測はアカウント全体では
  有効化しない。magic link が壊れるため）


---

## 10. 判明した制約: 無料期間 30 日 と 24 通は両立しない

統合テストで通しに回して分かった事実（`rolloutJourney.integration.test.mjs` が固定）:

- 配信対象は `requiresActiveGrant: { tier: 'light', termedOnly: true }`。
  **無料期間が終わると `grant_expired` で停止**し、後続 Step は積まれない
- 間隔は最短 3 日 + 無反応 3 連続で 2 倍。**30 日では 6 通前後**しか入らない
- 無料期間を十分長くすれば **Step1 → Step24 → 完了まで人手ゼロで到達する**（テスト済み）

つまり現状のまま本番で回すと、**Step7 以降は誰にも届かない**。
Step12 以降は「期限前 / 期限後 / 復帰 / 継続の提案」を書いてあるので、
**届けたい相手は無料期間が終わった人**であり、この制約と噛み合っていない。

### 選べる直し方（**どれも配信対象の定義を変えるので、判断が要る**）

| 案 | 内容 | 影響 |
|---|---|---|
| A | 期限切れ後も一定期間は対象に含める | `requiresActiveGrant` の宣言と `sequenceProgress` の停止理由に手が入る（**共有ロジック**） |
| B | 無料期間中に収まる通数へ減らす（6〜8 通） | 24 通の文面が余る。接点を増やす目的からは後退 |
| C | 期限後ぶんを**別キャンペーン**に分ける | 既存の進行を壊さずに済む。DeliveryKey も分かれる |

⚠️ **勝手に選ばない。** ここを変えると「誰に送るか」が変わるため、
本番の配信対象そのものの判断になる。現状は事実をテストで固定するに留めている。
