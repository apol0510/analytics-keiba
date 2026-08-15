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
| 4 | `LIGHT_TRIAL_AUTOGRANT_ARMED=<当日 JST>` | 当日ぶんの武装（翌日閉じる） |

1・2 は**手動付与と同じゲートを再利用**する（自動化のための抜け道を作らない）。

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
| `marketingStatusScan.regression.test.mjs` | 台帳 **6,110 行 fixture** でも 10 名を 10 名と数える（実ハンドラ起動） |
| `marketingStatusScan.guard.test.mjs` | 状態表示が打ち切る取得へ戻らない・fail closed の維持 |
| `step1Preflight.test.mjs` | Step1 直前確認の判定（**確認できないものを ok にしない**／queue 済みで止まる・未 queue で通る） |
| `step1PreflightScript.guard.test.mjs` | preflight スクリプトが read-only のままか（許可アクション固定） |
| `dispatchLock.test.mjs` | 実送信の排他（1 本だけ・自分の token でしか解放しない・状態不明は例外） |
| `dispatcherHandler.smoke.test.mjs` | **同時 2 本でも送信は 1 通**・Redis 不通は送信 0・dryRun は鍵を取らない |

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
