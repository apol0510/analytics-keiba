# メルマガ自動化 段階開放 runbook

対象: `feat/marketing-automation`（PR #237、squash `ba93eda` で main 反映済み・production deploy 済み）。
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

⚠️ **前提**: 下の「C-2 の制約」を先に読むこと。**Customers が約 4,000 件を超えると
`preview`（dry-run）が Function のタイムアウトに達する**。取り込みが進む前に済ませるか、
先に C-2 を直す。

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
- Customers が **4,000 件を超えていて C-2 未対応**（`preview` がタイムアウトする）
- 直近に campaign の版か本文を変えた（`campaign_drift` で ACTIVE 化が弾かれる／
  弾かれないなら**検査が壊れている**ので調査）

## C-2 の制約（**S2 の前に必ず読む**）

`preview`（dry-run）は Customers を**全件・逐次**取得する。本番実測:

| Customers | ページ数 | 実測 |
|---|---|---|
| 1,678 件（2026-08-06） | 17 | **7.6 s（cold）/ 3.5 s（warm）** |

Netlify の同期 Function のタイムアウトは既定 **10 秒**。
**約 4,000 件（40 ページ）でタイムアウト域に入る。**
外部無料ユーザーの取り込み（残り約 14,000 件）が完了すると **158 ページ ≒ 30〜70 秒**となり、
`preview` は**必ず失敗する**。

→ 取り込み完了前に S2〜S3 を済ませるか、**先に C-2 を直す**
（詳細は `docs/marketing-automation-preprod-audit.md` の「B-3 / B-4 / C-2 の read-only 監査」）。

## 関連

- 設計と blocker の記録: `docs/marketing-automation-preprod-audit.md`
- 進捗の正本: `docs/progress.md`
