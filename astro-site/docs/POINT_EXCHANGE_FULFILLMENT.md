# ポイント交換の提供フロー（現状の欠陥と、冪等な管理フローの設計案）

**この文書は設計案。実装も本番操作もまだ行っていない。**

## 1. いま起きていること（2026-08-12 監査）

`PointExchangeRequests` は **7 件すべて `Status=Pending`** だが、実際には
**提供済み・ポイント減算済みの申請が混ざっている**。Status が実態と同期していない。

| 申請 | Gmail の証拠 | 申請時 pt → 現在 pt | 実態 |
|---|---|---|---|
| `recSQS3N0bbLO7Th2`（2025-11-06 / 1,000pt） | **完了メールあり**（件名に申請 ID） | 1,091 → **121**（−970） | **提供済み・減算済み** |
| `rechMTQgCKlmOcGGe`（2025-12-03 / 1,000pt） | 提供メールなし | 1,230 → 1,230（±0） | 未提供・未減算 |
| `recPYBFN9JbZi2akM`（2026-01-27 / 1,000pt） | 提供メールなし | 1,110 → 1,230（+120） | 未提供・未減算 |
| `recFkpnHzUZOJ8UXg`（2026-01-23 / 1,000pt） | 管理者通知**未照合** | 1,050 → 1,230（+180） | 不明・未減算 |
| `recL2D5BFu2kBKWoR`（2025-10-22 / 1,000pt） | **未照合** | 1,710 → 660（−1,050） | 不明・**減算の痕跡あり** |
| `rec12DhAPYThoJO1D` / `recmTm4C193Dah651`（2025-12-26 / 2,000pt・**29 秒差の二重申請**） | 提供メールなし | 2,022 → **0**（−2,022） | 不明・**減算の痕跡あり** |

### ここから分かる重大な事実

1. **ポイントは実際に減っている。** ところが減算するコードは AK にも旧サイトにも無い
   （`point-exchange.js` / `claim-reward.js` は申請と通知だけ）。
   → **Airtable 画面での手動減算**が運用として行われている
2. **Status / ProcessedDate / Notes は更新されていない。** 更新する経路がコードに無く、
   管理画面は読み取り専用のため
3. → **「提供したか」「引いたか」を Airtable だけでは判定できない。**
   今回も Gmail の送信済みと突き合わせて初めて実態が分かった
4. **二重申請が実在する**（29 秒差）。多重クリックを止める仕組みが無い

## 2. なぜ危ないか

- 二重提供・二重減算が起こりうる（誰も止めていない）
- 減算だけ行われて提供が漏れる（`t***` の −2,022 は提供メールが見つからない）
- 残高の内訳が復元できない（履歴テーブルが無く、手動調整も混ざる）
- 重複レコードの整理でポイントを判断材料にできない（手動調整が混ざるため）

## 3. 設計案: 1 つの冪等なフローに閉じる

**入金確認メール v2（`PAYMENT_EMAIL_V2.md`）と同じ考え方**を使う。状態機械 + lease + 期待値 CAS。

### 3-1. 状態

```
pending ──▶ processing ──▶ points_deducted ──▶ completed
   │            │                                  ▲
   │            └── 失敗 ─▶ needs_review ──────────┘（人が確認して再実行）
   └── 重複と判定 ─▶ duplicate（提供もしない・引きもしない）
```

`PointExchangeRequests` に追加する列（**Airtable UI で手動作成**。API では作れない）:

| 列 | 型 | 用途 |
|---|---|---|
| `Status` | 既存 | 上の状態を入れる（`Pending` / `Processing` / `Completed` / `NeedsReview` / `Duplicate`） |
| `ProcessedDate` | dateTime | 完了時刻（既存・現在は未使用） |
| `Notes` | text | 判断の記録（既存・現在は未使用） |
| `FulfillmentKey` | text | **冪等キー**（`recordId` 由来。再実行で同じ値） |
| `PointsDeducted` | number | 実際に引いた点数（0 なら未減算） |
| `PointsBefore` / `PointsAfter` | number | 減算の前後（後から検証できる） |
| `DeliveryMessageId` | text | 提供メールの provider message id |
| `LeaseUntil` | dateTime | 二重実行防止（worker の占有） |

### 3-2. 実行順序（1 回の実行 = 1 申請）

```
① CAS: Status が Pending のときだけ Processing + LeaseUntil を書く
      （既に Processing / Completed なら **何もしないで終了** ＝ 二重実行防止）
② 期待値 CAS でポイント減算
      expectedPointsBefore（実行直前に読んだ実値）と一致しなければ中止
      PointsBefore / PointsAfter / PointsDeducted を同時に記録
③ 提供メール送信（件名に申請 ID を含める。**現行の完了メールと同じ形式**）
      idempotency key = FulfillmentKey。provider の message id を保存
④ Completed + ProcessedDate + Notes を確定
```

- どこで落ちても、**残っている状態から再開できる**（再実行は同じ結果になる）
- ②で引いたのに③が落ちた場合は `points_deducted` で止まり、再実行は**③から**やり直す
  （二重減算しない）
- ③が成功して④が落ちた場合は `DeliveryMessageId` があるので**再送しない**

### 3-3. 重複申請の扱い

同一アドレス × 同一 `RewardName` × 短時間（例 10 分）の 2 件目以降は
**`Duplicate` にして提供も減算もしない**。判定は申請作成時（`point-exchange.js`）と
実行時の両方で行う（作成時に止めるのが本筋だが、既存データにも対応するため両方）。

### 3-4. ゲート（既存の作法に合わせる）

- 既定 OFF。`POINT_EXCHANGE_FULFILL_ENABLED=true` が無ければ **1 バイトも書かない**
- 管理画面のボタンから 1 件ずつ実行（一括実行は作らない）
- dry-run で「引く点数・送るメール・変わる状態」を**事前に全部見せる**

## 4. 既存データの是正（設計案・未実施）

コードを直しても、いまの 7 件は自動では直らない。**人が事実を確定してから**、
上のフローの「④だけを実行するモード」で Status を後追い更新する。

| 申請 | 提案 |
|---|---|
| `recSQS3N0bbLO7Th2` | `Completed`（ProcessedDate=2025-11-06 / Notes に「Gmail の完了メールと −970 の減算で確認」） |
| `rechMTQgCKlmOcGGe` | 提供するか否かを決める。提供するならフロー①〜④を通す |
| `recPYBFN9JbZi2akM` | 同上 |
| `recFkpnHzUZOJ8UXg` / `recL2D5BFu2kBKWoR` / `rec12DhAPYThoJO1D` / `recmTm4C193Dah651` | **Gmail 照合を完了してから**判断（減算だけ済んでいる可能性がある） |

⚠️ **推測で Completed にしない。** 証拠（提供メール or 減算の記録）が揃った申請だけ確定する。

## 5. いま決めないこと

- 退会済み・期限切れの顧客へ提供するかどうか（運用判断）
- 減算の是非（提供済みなのに引いていない申請があれば、引くか免除するか）
- 過去の手動調整の遡及是正（履歴が無いため復元できない）
