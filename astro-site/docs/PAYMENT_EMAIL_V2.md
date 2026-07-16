# 入金確認メール v2（状態機械 + worker + Activity reconciler）

銀行振込の入金確認メールを、`PaymentEmailSent` 1 bit から**明示的な状態機械**へ作り直す設計。

> **現状（legacy）の欠陥**: 昇格 PATCH に `PaymentEmailSent=true` を送信の**前**に書き、その後の送信失敗を
> `.catch` で握りつぶす。そのため「メール 0 通なのに `PaymentEmailSent=true`」が起きる（2026-07-14 発生・
> 修正 `33ca21d` を本番投入後 `f3172dd` で緊急 revert）。1 bit では
> pending / attempting / accepted / failed / delivered を区別できない。

## 確定した方針（2026-07-16 承認）

- cutover は **D1**（入口停止 → A2 OFF 目視 → v2 deploy → カナリア1件 → 段階有効化）
- 非本番カナリアは **テスト用 Base/テーブルを分離**（production Customers に触れない）
- 二重送信対策に **Upstash Redis + fencing token を採用**（**exactly-once は保証しない**）

## 満たすべき不変条件（再掲）

1. 昇格 PATCH 成功前に完了メールを送らない
2. 昇格 PATCH 失敗時に完了メールを送らない
3. provider 受理後は最終的に受理事実を永続状態へ残す
4. 受理後の状態不明を放置しない
5. 通常経路で二重送信しない（**exactly-once ではない**）
6. 未昇格/昇格済/送信試行中/受理済/失敗を区別できる
7. メール送信失敗で昇格を巻き戻さない
8. 失敗後に安全に再試行できる
9. provider 受理と実配信を混同しない
10. fail closed

---

## 状態機械

```
                昇格 PATCH と同一 PATCH で pending 同梱（原子化）
                                │
                                ▼
      ┌──────────────────── pending ◀────────────────┐
      │ worker: lease 取得(CAS+fencing)               │ reconciler: 0件を30分継続
      ▼ (attempt+1, lease=now+90s, token)             │ かつ attempt<3
attempting_pre_send                                    │
      │ write-ahead: POST 直前に unknown_after_attempt │
      ▼ を書き read-back                               │
unknown_after_attempt ─────────────────────────────────┤
      │ SendGrid POST(custom_args: record_id, idem_key)│
      ├─ 2xx ──────────▶ accepted (PaymentEmailSent=true, ProviderMessageId)
      ├─ 429/5xx/例外 ─▶ failed_retryable ──▶ (worker/reconciler が pending へ)
      └─ 4xx/no_key/no_email ─▶ failed_terminal ──▶ needs_admin(人手)
      │
   [reconciler] unknown_after_attempt の照合:
      hit=1 ─▶ accepted   /   hit>1 ─▶ needs_admin   /   0件×30分 ─▶ pending   /   24h ─▶ needs_admin
                                │
                          accepted
                                │ Event Webhook(署名検証 + custom_args)
                                ▼
                     delivered / bounced / dropped   (deferred は監視のみ)
```

**核心の 2 点**

- `attempting_pre_send`（**POST 前**にロックを取った）と `unknown_after_attempt`（**POST したかもしれない**）を
  別状態に分離する。POST の直前に `unknown_after_attempt` を write-ahead + read-back してから POST する。
  → プロセスが落ちても、残る状態が `attempting_pre_send` なら**確実に未送信＝安全に再送可**、
    `unknown_after_attempt` なら**送信済みかもしれない＝Activity 照合前は再送禁止**。
- **`unknown_after_attempt` からの無条件自動再送は禁止**。reconciler が Activity API で
  `unique_args["idempotency_key"]` を照合し、0 件が所定時間継続したときだけ `pending` へ戻す。

### 「0 件」の定義（厳守）

Activity 照合は **HTTP 200 かつ `messages: []` のときだけ「0 件」**と扱う。
**4xx / 5xx / timeout / parse error は「不明」**であり 0 件に数えない（試行回数も消費しない）。

---

## S1: Airtable Customers に追加する Field（ユーザーが Airtable UI で追加）

**既存レコードには何も書かない。空のまま = 旧世界 = worker の対象外**（allowlist 方式・一括 backfill しない）。

- [ ] `PaymentEmailStatus` — **Single select**。選択肢を下記 10 個（順序自由）で作成
      `pending` / `attempting_pre_send` / `unknown_after_attempt` / `accepted` / `delivered` /
      `bounced` / `dropped` / `failed_retryable` / `failed_terminal` / `needs_admin`
- [ ] `PaymentEmailIdempotencyKey` — Single line text
- [ ] `PaymentEmailProviderMessageId` — Single line text
- [ ] `PaymentEmailAttemptedAt` — Date（**Include time** ON / GMT 推奨）
- [ ] `PaymentEmailAcceptedAt` — Date（Include time）
- [ ] `PaymentEmailDeliveredAt` — Date（Include time）
- [ ] `PaymentEmailAttemptCount` — Number（Integer, precision 0）
- [ ] `PaymentEmailLeaseUntil` — Date（Include time）
- [ ] `PaymentEmailAttemptToken` — Single line text
- [ ] `PaymentEmailFailureStage` — Single line text
- [ ] `PaymentEmailLastError` — Long text（**API キー・Authorization・メール本文は絶対に書かない**）
- [ ] `PromotedBy` — Single line text（手動昇格の操作者）
- [ ] `PromotionReason` — Single line text（手動昇格の理由）
- [ ] `PromotedAt` — Date（Include time）

> `PaymentEmailSent`（既存 checkbox）は**残す**。`accepted` 到達時だけ true を書く互換出力へ格下げ。
> **新ロジックは判断材料として一切読まない**（guard テストで強制）。

---

## S2: Upstash Redis + env（gate 5 個）

| env | 値 | 責務 |
|---|---|---|
| `PAYMENT_EMAIL_FLOW_VERSION` | `legacy` / `v2` | confirm の昇格方式 |
| `PAYMENT_EMAIL_WORKER_SEND_ENABLED` | `true` / `false` | worker の送信許可 |
| `PAYMENT_EMAIL_RECONCILER_WRITE_ENABLED` | `true` / `false` | reconciler の書込許可（false=dry-run） |
| `PAYMENT_EMAIL_GLOBAL_PAUSE` | `true` / `false` | 緊急停止（旧経路へ自動復帰させない） |
| `PAYMENT_EMAIL_A2_DISABLED_CONFIRMED` | `true` / `false` | **A2 を OFF にしたという運用宣言**（自己申告値・証拠ではない） |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | — | 外部ロック |

**有効な構成**（`validateEmailGates` がこれ以外を fail closed で拒否）:

| mode | flow | worker | reconciler | pause | a2_disabled |
|---|---|---|---|---|---|
| legacy | legacy | false | false | false | 任意 |
| paused | 任意 | false | false | **true** | 任意 |
| v2-dry-run | v2 | false | false | false | **true** |
| v2-active | v2 | **true** | **true** | false | **true** |

**禁止**: `flow=v2 && !a2_disabled` / `flow=legacy && worker` / `worker && flow≠v2` /
`reconciler && flow≠v2` / `pause && (worker or reconciler)`。

---

## cutover（D1）

S1 Field → S2 Upstash/env → **S3 コード deploy（production は legacy のまま・旧 admin 無効化）** →
S4 非本番検証（分離 Airtable）→ S5 preflight → **S6: 入口停止 → 未処理0確認 → A2 OFF（UI 目視）→
v2 deploy（worker=false / reconciler=false）→ 新 deploy 到達確認 → カナリア専用 Function で1件** →
S7 worker=true（入口再開可）→ S8 reconciler write=true + Scheduled 有効化 → S9 Event Webhook → S10 文書。

- **絶対条件**: A2(ON) と新 worker(送信可) を同時に成立させない。
- 「60 秒待てば旧インスタンスが消えた」とは言わない。**本当の防御は入口停止**。
- rollback 第一選択は「A2 を ON に戻す」ではなく**新規受付だけ停止して既存状態を確定させる**。

---

## 別課題（本設計と分離・未解決）

- **送信元不一致**: `email-config.js` の `FROM_EMAIL='noreply@keiba.link'` だが AK 正式送信元は
  `support@keiba.link`（env `SENDGRID_FROM_EMAIL` も support）。11 Function に波及するため別タスク。
- **`/admin/send-payment-confirmation` + `send-payment-confirmation.js` は未使用だが到達可能**。
  誤操作すると A2 と合わせて 2 通。cutover 前に 410/redirect で無効化。`paypal-webhook.js` も同型。

## 実装ファイル

| 目的 | ファイル | 状態 |
|---|---|---|
| 状態機械（純粋関数・単一源） | `src/lib/payments/paymentEmailState.js` | S3 で実装 |
| 同テスト | `src/lib/payments/paymentEmailState.test.mjs` | S3 で実装 |
| confirm v2（pending 同梱） | `netlify/functions/confirm-bank-payment.js` | S3 で改修 |
| 送信 worker | `netlify/functions/payment-email-worker.js`（新規） | S3 |
| カナリア専用 | `netlify/functions/admin-canary-payment-email.js`（新規） | S3 |
| reconciler（Scheduled） | `netlify/functions/payment-email-reconciler.js`（新規） | S3 |
| 手動昇格 | `netlify/functions/admin-promote-customer.js`（新規） | S3 |
| Event Webhook | `netlify/functions/sendgrid-webhook.js`（拡張・署名検証） | S9 |
