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

### provider 受理と delivered は別

`Status='sent'` は「送信基盤が受理した」。実配信は Event Webhook が別に記録する。
画面でも別項目として出す。

---

## 5. 数十通シーケンス（`sequencePolicy.js`）

### ポリシー

| 項目 | 既定 | 意味 |
|---|---|---|
| `maxSends` | 4 | 1 人あたりの最大回数。**数十へ設定可能** |
| `minIntervalDays` | 3 | 次の 1 通までの最小間隔 |
| `frequencyCap` | 7 日で 2 通 | 短期間の過剰配信を防ぐ |
| `slowdownAfterNoEngagement` | 3 | 無反応が続いたら間隔を伸ばす |
| `slowdownFactor` | 2 | 伸ばす倍率 |
| `stopAfterNoEngagement` | 8 | 無反応が続いたら打ち切る（`null` で無効） |
| `angles` | 4 種 | 訴求角度。**同じ角度を連投しない** |

> ⚠️ `maxSends` を上げただけでは増えない。**`steps` を足したうえで**上げる。
> ここに置くのは「送りすぎない」ための上限で、増やすための値ではない。

### 止める条件（強い順）

`purchased`（**最優先**。目的を達成したら販促を止める）→ `unsubscribed` →
`hard_bounce` → `complaint` → `suppressed` → `not_eligible` →
`max_sends_reached` → `no_engagement`

### 反応を次の判断へ使う

`countConsecutiveNoEngagement()` が開封・クリックの履歴から
「無反応が何回続いたか」を数え、間隔の延長・打ち切りの材料にする。
判定そのものは既存の `engagementGuard.js` を使い、ここでは重ねない。

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

- **母集団を読み切れなければ `partial: true`**。割合を捏造しない
- 0 通の Step で反応率を作らない
- **アドレス・recordId は 1 つも返さない**（件数だけ）
- 展開状態を読めないときも**理由を出す**（`state_unreadable`）

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

## 9. まだやっていないこと

- **実顧客への付与・送信は 1 件もしていない**（この土台は既定 OFF）
- `steps` は現行 4 通のまま。数十通へ伸ばすのは**文面を書いてから**
- 段階の自動昇格はしない（提案のみ）
- 開封・クリックの計測は既存の Event Webhook に依存（click 計測はアカウント全体では
  有効化しない。magic link が壊れるため）
