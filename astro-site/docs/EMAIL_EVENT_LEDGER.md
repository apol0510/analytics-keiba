# メール配信反応の恒久台帳（EmailEvents / Phase 1）

配信基盤の履歴は**保持期間が短く**（実測 3 日）、それ以前の開封・クリックは取得できない。
AK 側にイベントを保存していないため、いまは「反応が無かった」のか「記録が消えただけ」なのかを
**永久に区別できない**。届いた Event Webhook を AK の台帳へ append-only で残し、
顧客カルテ・時系列履歴・施策判断が事実に基づけるようにする。

> Phase 0（署名検証つき受信）は 2026-07-22 に本番稼働済み。詳細は `SENDGRID_WEBHOOK.md`。
> 本書は **Phase 1（恒久保存）** の設計と、本番有効化に必要な承認事項をまとめる。

## 1. 現状（2026-08-01 実測）

| 項目 | 状態 |
|---|---|
| Event Webhook | **稼働中**（署名検証あり・鍵未設定なら 403 で fail closed）|
| 受信後の処理 | bounce / blocked / dropped / spamreport / unsubscribe → `EmailBlacklist` へ反映。**それ以外は捨てている** |
| open / click | **保存していない**（配信基盤の API を都度参照するのみ・保持 3 日）|
| 決済メール v2 | `custom_args`（`record_id` / `idempotency_key` / `purpose`）を刻んでおり、イベントを 1 通へ結び付けられる |
| **マーケ配信** | **`custom_args` を刻んでいない**（`marketing-campaign-dispatch.js` の送信ペイロードに無い）|
| 送信時の message id | **記録していない**（`CampaignDeliveries` に列が無い）|

⚠️ したがって**いま届くマーケ関連イベントは `email` しか手掛かりが無い**。
同一アドレスの重複 Customers が実在するため、**メール単独で顧客へ結び付けてはならない**。

## 2. 採用する schema：**C（append-only 台帳＋集約の併用）**

| 案 | 評価 |
|---|---|
| A. イベント台帳のみ | 顧客カルテのたびに全イベント走査が必要。件数が増えると管理画面が遅くなる |
| B. `CampaignDeliveries` に集約列だけ | **open/click の回数・初回/最終が復元できない**。順不同到着で壊れる。監査もできない |
| **C. 併用（採用）** | 事実は台帳に全部残し、表示は集約で速く出せる。集約が壊れても台帳から再計算できる |

Phase 1 では **台帳（`EmailEvents`）だけ**を作る。集約列（`CampaignDeliveries` への
`FirstOpenAt` / `OpenCount` 等）は台帳が動いてから追加する（Phase 1c）。

### `EmailEvents`（新規テーブル / 作成はユーザー操作）

| 列 | 型 | 用途 |
|---|---|---|
| `EventKey` | Single line text | **一意キー**（upsert のマージキー）|
| `EventType` | Single line text | processed / delivered / deferred / bounce / dropped / open / click / spamreport / unsubscribe ほか |
| `EventAt` | Date (incl. time) | provider のイベント発生時刻 |
| `ReceivedAt` | Date (incl. time) | AK が受信した時刻（遅延・順不同の調査用）|
| `DeliveryKey` | Single line text | 配信 1 通の一意キー（`CampaignDeliveries`）|
| `CampaignDeliveryRecordId` | Single line text | `CampaignDeliveries` recordId |
| `CustomerRecordId` | Single line text | `Customers` recordId |
| `CampaignId` / `CampaignVersion` | Single line text | どの案内か |
| `Provider` | Single line text | `sendgrid` 固定（将来の乗り換え用）|
| `ProviderMessageId` / `ProviderEventId` | Single line text | provider 側の識別子 |
| `UrlCategory` / `UrlPath` | Single line text | クリック先の**分類**（token・クエリは保存しない）|
| `ReasonText` / `BounceClass` | Single line text | bounce/dropped の理由（120 字まで）|
| `EmailHash` | Single line text | 宛先の SHA-256 先頭 32（**生アドレスは保存しない**）|
| `VerificationStatus` | Single line text | `verified`（署名検証を通ったもののみ受け入れ）|
| `ResolutionStatus` | Single line text | `resolved` / `unresolved` / `conflict` |
| `ResolutionReason` | Single line text | `no_custom_args` / `delivery_not_found` / `customer_mismatch` ほか |
| `CreatedBy` | Single line text | `sendgrid-webhook` |

**保存しないもの（意図的）**: 生メールアドレス / IP / User-Agent / 生 URL（token 付き）/
raw payload。施策判断に不要で、漏えい時の被害が大きい。
列名は `emailEventLedger.js` の `LEDGER_WRITABLE_FIELDS` が単一源で、
それ以外を書こうとしたら `assertOnlyLedgerFields()` が弾く。

## 3. 冪等性・順不同・誤紐付け防止

| 論点 | 設計 |
|---|---|
| 一意キー | `sg_event_id` があれば `sg:<id>`。無ければ `c:<messageId>:<type>:<timestampMs>:<emailHash16>` |
| 再受信 | `EventKey` をマージキーにした **upsert**。同じイベントが何度届いても 1 行 |
| 同一バッチ内の重複 | `EventKey` で畳んでから書く |
| open / click の複数回 | **時刻までキーに含める**ので別行として残る（回数・初回・最終が復元できる）|
| 順不同（delivered の後に bounce） | append-only なので順序に依存しない。集計は台帳から再計算する |
| 未知イベント | **成功扱いにしない**。`rejected.unknown_event_type` として数え、保存しない |
| 紐付け | 送信時に刻んだ識別子だけを信頼（`delivery_key` → `campaign_delivery_id`）。**メール単独では結び付けない** |
| 食い違い | 候補が複数／custom_args の顧客と台帳の顧客が不一致 → **`conflict`**（どちらも採らない）|
| 解決不能 | `unresolved` として**保存はする**（事実は残す）が、顧客へは結び付けない |

## 3-2. 書き込み経路（バッチ upsert + bounded retry / 2026-08-02 追加）

台帳は **append-only で後から復元できない**。「落ちたのに黙って捨てる」実装は、
欠測に気付けないまま事実が永久に失われることを意味する。書き込みは単一源
**`src/lib/webhooks/emailEventLedgerWriter.js`**（I/O 注入・純粋にテスト可能）に集約する。

| 論点 | 設計 | 定数 |
|---|---|---|
| バッチ化 | **10 レコード / 1 リクエスト**（Airtable upsert の上限）。1 行 1 リクエストにしない | `LEDGER_BATCH_SIZE=10` |
| 送信前 dedupe | 同一 `EventKey` を**送る前に**畳む。同一リクエスト内に同じマージキーが 2 件あると**リクエストごと失敗する**ため | — |
| 再試行する | **429 / 5xx / timeout / transport error のみ** | `LEDGER_MAX_ATTEMPTS=3`（初回 + 2 回）|
| 再試行しない | **403 / 404 / 422 / 400**（権限不足・テーブル/列不足・型不一致＝叩いても直らない）| — |
| backoff | 指数 + **上限で頭打ち**。`Retry-After` があれば優先するが上限は同じ | `200ms` → 上限 `2000ms` |
| リクエスト timeout | `AbortSignal.timeout`（未対応環境では無指定） | `5000ms` |
| 全体の締切 | 超過分は送らず `deadline_exceeded` として数える（Function 全体を道連れにしない）| `8000ms` |
| 失敗の可視化 | **沈黙させない**。理由コード別に集計して応答・ログへ出す | 下表 |
| 冪等性 | `EventKey` マージの upsert。provider のリトライ・再送で**行は増えない** | — |
| 応答本文 | **読まない**（PII / secret 混入の遮断）。status と `Retry-After` のみ参照 | — |

### 集計フィールド（Webhook 応答・ログの `ledger`）

| キー | 意味 |
|---|---|
| `received` / `accepted` | 受信イベント数 / 台帳行として組み上がった数 |
| `attempted` | 実際に送った行数（dedupe・列チェック後）|
| `written` | 書き込み成功した行数 |
| `failed` | 送ったが失敗した行数（**`attempted = written + failed`**）|
| `skipped` | 許可列以外を含み送らなかった行数 |
| `deduped` | 送信前に重複として畳んだ行数 |
| `batches` / `failedBatches` | 送ったバッチ数 / 落ちたバッチ数 |
| `retryCount` | 再試行した回数の合計 |
| `failureReasons` | 理由コード → 件数。`rate_limited` / `server_error` / `timeout` / `transport_error` / `forbidden` / `not_found` / `unprocessable` / `bad_request` / `client_error` / `field_not_allowed` / `deadline_exceeded` / `unknown` |

**運用の見方**: `accepted > written` なら欠測が起きている。`failureReasons` が
`forbidden` / `not_found` / `unprocessable` を示す場合は**設定不備**（PAT 権限・テーブル名・列の型）で、
再試行では直らない。`rate_limited` が続く場合はバッチが飽和している。

## 4. 署名検証

Phase 0 の `sendgridSignature.js` をそのまま使う（再実装しない）。

- 署名対象は `timestamp + 受信したままの raw body`（再直列化した JSON では一致しない）
- 検証鍵が未設定なら **403・write 0**（素通り禁止）
- 検証を通った body だけを parse する
- reason コード以外（鍵・署名・timestamp・アドレス）をログ・応答に出さない
- リプレイ窓は既定 24 時間（provider のリトライを取りこぼさないため）

台帳への書き込みは**検証成功後にのみ**発生する。

## 5. 有効化の段取り（すべてユーザー操作・未実施）

| Phase | 内容 | リスク |
|---|---|---|
| **1a** | 純粋モジュール・テスト・受信側の配線（**既定 OFF**）・本書（PR #199 merged `8a493ce`）| なし（write 0）|
| **1a-2**（本 PR） | 書き込みのバッチ化・bounded retry・失敗集計（§3-2）。**既定 OFF のまま** | なし（write 0）|
| **1b** | Airtable に `EmailEvents` を作成（**2026-08-02 完了**: `tblWkaxu7p0MRuUwL` / 21 列 / primary=`EventKey` / 0 行）→ `EMAIL_EVENT_LEDGER_ENABLED=true` + redeploy（**未実施**）| 台帳への write 開始 |
| **1c** | 送信側で `custom_args`（delivery_key / campaign_id / customer_record_id）を刻む | 送信経路の変更 |
| **1d** | 受信側へ配信索引を渡し `resolved` を有効化。集約列を追加 | 表示の変更 |

**1b より前は 1 バイトも書かない。** env 未設定・鍵未設定・列不足のいずれでも write 0。

### 見込み件数

現状の配信規模（カムバック 68 通 / 月数百通）で、1 通あたり processed + delivered +
open 数回 + click 0〜数回 ≒ **3〜8 イベント**。
**月あたり数百〜数千行**を見込む。Airtable の 1 テーブル上限（Pro: 50,000 行）に対しては
年単位で余裕があるが、**1 年ごとに古い行のアーカイブ方針を決める**こと。

### rollback / cleanup

| 事象 | 対処 |
|---|---|
| 台帳を止める | `EMAIL_EVENT_LEDGER_ENABLED` を unset → redeploy（受信は継続・書き込みだけ止まる）|
| 誤った行が入った | `EmailEvents` の行を削除（**append-only なので他機能へ影響しない**）|
| テーブルごと廃止 | テーブル削除。`EmailBlacklist` / 決済メール v2 の経路には影響しない |
| コードを戻す | 該当 PR を revert（受信 Function は Phase 0 の状態へ戻る）|

## 6. admin 表示のルール

- **「未開封」と「取得不能」を必ず区別する。** 台帳が無い期間は 0 ではなく**不明**
- 台帳運用開始前のメールについて、過去分が復元できるとは**書かない**
- 表示するのは取得できた事実だけ（配信済み / 初回・最終開封 / 開封回数 / 初回・最終クリック /
  クリック回数 / クリック先分類 / bounce / unsubscribe / spam / データ取得元）
- `unresolved` のイベントは**顧客カルテに出さない**（誰のものか確定していないため）
