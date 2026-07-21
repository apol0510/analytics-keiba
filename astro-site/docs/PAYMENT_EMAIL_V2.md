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

## カナリア Base/Table 分離（契約 / S4 非本番検証）

非本番カナリア（`admin-canary-payment-email`）は **テスト専用 Airtable Base/Table + 専用 PAT のみ**を使い、
**本番 Customers / 本番キーに構造的に触れない**。判定は単一源 `paymentEmailDeps.js` の `canaryTarget()` /
`makeCanaryWorkerDeps()`。

| env | 責務 |
|---|---|
| `PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY` | **カナリア専用 Airtable PAT**（テスト Base だけに read/write 権限）。本番 `AIRTABLE_API_KEY` は使わない |
| `PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID` | カナリア専用 Base ID（テスト用のみ） |
| `PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID` | カナリア専用 Table ID（テスト用のみ） |
| `PAYMENT_EMAIL_CANARY_RECORD_IDS` | 許可レコード allowlist（カンマ区切り。**ちょうど 1 件をコードで強制**） |
| `PAYMENT_CANARY_SECRET` | `x-canary-secret` ヘッダ認証 |

**契約（不変条件）**:

- **テスト用 Base/Table + 専用 PAT のみ**。`admin-canary` は `makeCanaryWorkerDeps()` を使い、本番 `makeWorkerDeps()`
  （＝ `AIRTABLE_API_KEY` + `AIRTABLE_BASE_ID` + `Customers`）は使わない。
- **カナリア認証キーは `PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY` のみ**。`canaryTarget()` は本番
  `AIRTABLE_API_KEY` を一切参照せず、**本番キーへの fallback を禁止**。専用キー未設定なら throw → Function は 503。
  - 専用 PAT は **テスト Base だけに read/write 権限**を持たせ、**本番 Base を PAT の resource に含めない**
    （本番 `AIRTABLE_API_KEY` にテスト Base 権限を足す運用は採らない。理由: 本番キーがテスト Base 403 だった件の恒久分離）。
  - 専用キー / Base ID / Table ID / recordId / メールを例外メッセージ・ログへ出さない。
- **本番 Customers / 本番キーへの fallback は禁止**。カナリア env（key / Base / Table）いずれか未設定なら
  `canaryTarget()` が throw し、Function は **503（fail closed）** を返す。本番 Base/キーを代わりに使うことは一切しない。
- **認証・allowlist 検証を body parse より先に行う（secret-first fail closed）**。単一源 `canaryAuth.js`
  を 2 段に分割: `authorizeCanaryAccess`（secret + allowlist・**body に非依存**）→ 認証通過後にのみ
  body を parse → `matchCanaryRecordId`（recordId 完全一致）。**未認証リクエストの body は parse しない**。
  - 評価順: ① secret 未設定 → 503 / ② secret 不一致 → 403 / ③ allowlist が「ちょうど 1 件」でない
    （0 件・2 件以上）→ 403 / ④ ここで初めて body parse（不正 JSON → 400）/ ⑤ recordId 未指定 → 400 /
    ⑥ recordId が唯一の許可 ID と不一致 → 403。
  - **未認証入力の構文エラーを外部へ区別して返さない**: 未認証（①②）や allowlist 不正（③）のときは
    不正 JSON でも 400 ではなく認証段の 503/403 を返す。**不正 JSON が 400 になるのは「認証成功 +
    allowlist exactly-one」を満たしたときだけ**。
- **allowlist は運用規約ではなくコードで「ちょうど 1 件」を強制**。`PAYMENT_EMAIL_CANARY_RECORD_IDS` を
  trim + 空要素除去した結果が **0 件でも 2 件以上でも 403**。`includes` による複数許容は廃止。
- **拒否時に識別子を応答・ログへ出さない**。403 応答に呼び出し入力の recordId をエコーせず、
  拒否理由文字列にも recordId / secret / Base ID / Table ID を含めない。
- **本番 Customers への fallback は禁止**（再掲）。カナリア env 未設定なら `canaryTarget()` が throw、
  Function は **503**。本番 Base を代わりに使わない。
- **通常 worker / reconciler / confirm-bank-payment は本番 Customers env を維持**（分離の影響を受けない）。
- **ログ禁止値**: Base ID / Table ID / メールアドレス / secret / recordId は例外メッセージ・ログに出さない。
- **実行前に明示承認が必須**、実行後は**テストレコードの後片付けが必須**（本番送信・本番 Airtable 変更は行わない）。
- guard/test: `canaryAuth.test.mjs`（2 段認可・secret-first の body 非 parse・exactly-one・完全一致・
  recordId 非エコー）/ `paymentEmailDeps.canary.test.mjs`（fail closed・本番 fallback しない・URL が
  カナリア Base を指す）/ `paymentEmailDeps.canary.guard.test.mjs`（配線・順序固定）。
  `test:bank-payment`→`check:safety` で CI 強制。

---

## 送信元契約（単一源 / 2026-07-20 追加）

AK の正式送信元は **`support@keiba.link`**。決済メール経路（カナリア / 通常 worker）は
**`src/lib/payments/senderIdentity.js` を単一源**として送信元を決定する。

| 判定 | 挙動 |
|---|---|
| env `SENDGRID_FROM_EMAIL` が `support@keiba.link` と一致（trim + toLowerCase 後） | 送信可。payload の `from` は正規化済み正式値 |
| 未設定 / 空 / 不一致（`noreply@keiba.link` を含む） | **送信前に fail closed**（SendGrid へ POST しない） |

- **`noreply@keiba.link` への fallback は禁止**。`email-config.js` の `FROM_EMAIL`
  （= noreply・ニュースレター等の別経路用）は決済メール経路で **import しない**。
- **カナリアと通常 worker は同一契約**。カナリア専用の送信元 env は作らない。
- 送信元不一致は `failure_stage=sender_unverified` → **`failed_terminal`**（retryable にしない。
  構成不備は再試行で直らないため）。
- 判定結果・ログ・エラーに **env の値を含めない**（reason コードのみ）。

検証: `senderIdentity.test.mjs` / `paymentEmailSender.guard.test.mjs`（`test:bank-payment` → `check:safety`）

> **経緯（2026-07-20）**: S4 カナリア実行前 preflight で、送信元が `noreply@keiba.link`
> （`email-config.js` の `FROM_EMAIL` 定数）であることを検知。AK 正式送信元と不一致のため
> **カナリアを実行せず停止**し、本契約を実装した。**カナリアメールは未送信**。

---

## 送信前 schema preflight（2026-07-20 カナリア事故の恒久対策）

**事故**: S4 カナリアで、テスト Base に provider 後に書くフィールドが無く、**SendGrid 送信後**の
結果 PATCH が 422 で失敗した。**メールは実際に届いたのに受理を記録できず** `unknown_after_attempt`
で滞留した（不変条件 3「provider 受理後は最終的に受理事実を永続状態へ残す」が schema 不備では
守れないことが実証された）。

### 対策 1: 送信前に必須フィールドの存在を検証する

`REQUIRED_PROVIDER_RESULT_FIELDS`（`paymentEmailState.js`）= provider 後に書く 6 フィールド
（`PaymentEmailStatus` / `AcceptedAt` / `ProviderMessageId` / `FailureStage` / `LastError` / `Sent`）を、
**ロック取得・PATCH・SendGrid POST のいずれよりも前**に検証する。欠落なら
`stage='schema'` / `reason='schema_incomplete'` を返し、**レコードを一切変更せず・送信もしない**。

判定方法は **read-only プローブ**（`deps.verifyWritableFields`）:

- Airtable の List Records は `fields[]` に**存在しないフィールド名**が含まれると 422 を返す。
  この性質で存在を判定する（**1 件も書かない**）
- **Meta API（`schema.bases:read`）に依存しない**。カナリア PAT は data scope のみで Meta は 403
- **本番レコードへの試験書込みをしない**（no-op PATCH 方式は採らない）
- 判定不能（非 200 / 非 422 / 例外）は **fail closed**
- **カナリアと通常 worker で同一契約**（カナリアだけ検証を省かない）

### 対策 2: provider 受理後の state write 失敗を STATE_WRITE_FAILED として扱う

結果 PATCH を try/catch で保護し、失敗時は:

- レコードは write-ahead 済みの **`unknown_after_attempt` を維持**（`pending` へ戻さない＝**自動再送しない**）
- 戻り値に `providerAccepted`（**受理事実を失わない**）/ `autoResend: false` / `needsReconcile: true`
- reconciler が `unknown_after_attempt` を拾い、`idempotency_key` で Activity 照合して確定する
- 例外オブジェクトは捕捉せず、**Airtable 応答本文を戻り値・ログへ出さない**
- worker のログから **`recordId` を削除**（識別子を外部ログに残さない）

検証: `paymentEmailWorker.test.mjs`（preflight 4 件 / state write 失敗 3 件）/
`paymentEmailSchemaPreflight.guard.test.mjs`（配線固定 8 件）

---

## B1 dispatcher / B2 reconciler schedule（2026-07-21・D1 前提実装）

cutover 前提として、pending の自動送信（B1）と unknown_after_attempt の定期照合（B2）を配線する。
**Airtable Automation を新たな必須依存にせず、Netlify Scheduled Function 方式**を採用した
（理由は decisions.md 参照: A2 と新 Automation の同時管理を避け、gate/pause/A2 確認をコード側で
fail-closed にでき、件数制限・順次処理・部分失敗をコードで明示できる）。

### B1: `payment-email-dispatcher.js`（Netlify Scheduled Function 専用・5 分毎）

- **`*/5 * * * *`**。`PaymentEmailStatus='pending'` を **filterByFormula + maxRecords で限定取得**し
  （必要フィールドのみ・Email/氏名は取らない）、**1 実行最大 3 件**を worker コア（`runWorkerOnce`）へ
  **HTTP を介さず同一プロセスで**渡す。超過分は次回へ（silent 打ち切りにしない）。
- **Netlify Scheduled Functions は公開 URL から直接呼び出せない**（プラットフォームが遮断）。
  よって Function は Scheduled 専用で **URL POST 用の認証分岐を持たない**。**手動確認は Netlify UI の
  Functions 画面 →「Run now」**（Deploy Preview / branch deploy でのテスト用）。
- **30 秒実行上限**への対応: 1 件の最悪経路は Airtable GET/PATCH/read-back + schema preflight +
  Upstash lock + SendGrid POST + 結果 PATCH + lock 解放 で ~8 往復。**3 件でも安全マージン内**。
  加えて **deadline guard（開始から 25 秒）**で、時間切れ前に新規レコードの処理開始を止める
  （残りは次回スケジュールへ）。Function 自体が 30 秒で強制終了しても、record 単位 lock/fencing/
  state machine が二重送信を防ぐ（lease 期限切れ / unknown_after_attempt は reconciler が確定）。
- **fail-closed**: `validateEmailGates()` の mode が **v2-worker / v2-full 以外なら送信を一切開始しない**。
  このモードは構造的に `flow=v2 ∧ workerSend ∧ pause=false ∧ a2DisabledConfirmed=true` を含むため、
  **legacy / paused / v2-dry-run / A2 未確認では 0 件**。各レコードの送信可否（送信元契約・SENDGRID・
  schema preflight・IdempotencyKey・eligible・lock+fencing）は `runWorkerOnce` が個別に fail-closed 判定。
- **重複起動防止**: dispatch 単位ロック（Upstash `payemail:dispatch`）+ 各レコードの record 単位
  lock+fencing の二重防御。**1 件失敗で他件を止めない**（例外は集計へ回して継続）。
- **対象は pending のみ**。accepted / delivered / unknown_after_attempt / failed_terminal は
  `runWorkerOnce` の lease 判定で弾かれる（dispatcher は再送を判断しない）。
- 手動 POST は `x-worker-secret` 一致必須。Scheduled 起動（ヘッダ無し）は許可するが、送信の唯一の
  防御は上記 gate（legacy では誰が叩いても 0 件）。
- **PII 非出力**: 応答・ログは `listed/processed/byOutcome/errors` の件数のみ。recordId/Email/secret を出さない。

### B2: `cron-payment-email-reconciler.js`（Scheduled 15 分毎）

- **`*/15 * * * *`**。既存の手動 POST `payment-email-reconciler.js` は**変更せず**、Scheduled を
  別ファイル `cron-payment-email-reconciler.js` へ分離。同じコア `reconcileUnknownBatch` を同一プロセスで呼ぶ。
- Scheduled 版は**公開 URL から呼べない**（手動確認は Netlify UI「Run now」）。**明示認証つき手動 API が
  必要な場合は既存の通常 Function `payment-email-reconciler.js`**（`x-worker-secret` 認証・URL POST 可）を使う。
- **30 秒上限**対応: **1 実行最大 10 件**（Activity GET(+PATCH) が 1 件 ~2 往復）+ **deadline guard（25 秒）**。
  timeout 接近時は新規レコードの照合を開始しない。書込み前に落ちれば状態は変わらない＝**再送されない**。
- **書込みは mode=v2-full のときだけ**（それ以外は dryRun=true = no-op で「何を書くか」だけ算出）。
  legacy / v2-dry-run / v2-worker では **write 0**。
- 0 件判定は Activity が **HTTP 200 かつ messages=[]** のときのみ（4xx/5xx/timeout/parse 失敗は
  unknown 維持）。判定は state machine（`classifyActivityResult`/`decideReconcile`）に集約。
  idempotency_key 空は自動処理しない。
- **重複起動防止**: reconcile 単位ロック（Upstash `payemail:reconcile`）。
- **dispatcher（pending）と reconciler（unknown_after_attempt）は対象 status が異なり**、同一レコードを
  競合処理しない。応答・ログは `count/byAction/dryRun` のみ（per-record id を返さない）。

### schedule / 件数 / lock / retry / partial failure / rollback

| 項目 | 値 |
|---|---|
| dispatcher schedule | `*/5 * * * *`（5 分） |
| reconciler schedule | `*/15 * * * *`（15 分） |
| Scheduled 実行上限 | **30 秒**（Netlify 公式仕様。超過は強制終了） |
| dispatcher 1 実行上限 | **3 件**（30 秒に安全に収める・超過は次回） |
| reconciler 1 実行上限 | **10 件** |
| deadline guard | 開始から **25 秒**で新規レコード処理を開始しない（残りは次回） |
| 呼出契約 | Scheduled のみ。**公開 URL 不可**。手動は Netlify UI「Run now」（reconciler の明示認証手動は既存 `payment-email-reconciler.js`） |
| dispatcher lock | `payemail:dispatch`（+ record 単位 lock/fencing） |
| reconciler lock | `payemail:reconcile` |
| retry 禁止 | unknown_after_attempt は dispatcher が再送しない（reconciler の Activity 照合のみ） |
| partial failure | 1 件失敗で残件継続・集計へ計上 |
| rollback | env のみで即時無効化（gate を非送信モードへ戻す／`GLOBAL_PAUSE=true`）。コード常駐でも 0 件動作 |
| observability | 非機密の件数集計のみ（PII/secret 非出力） |

---

## cutover（D1）

S1 Field → S2 Upstash/env → **S3 コード deploy（production は legacy のまま・旧 admin 無効化）** →
S4 非本番検証（分離 Airtable）→ S5 preflight → **S6: 入口停止 → 未処理0確認 → A2 OFF（UI 目視）→
v2 deploy（worker=false / reconciler=false）→ 新 deploy 到達確認 → カナリア専用 Function で1件** →
S7 worker=true（入口再開可）→ S8 reconciler write=true + Scheduled 有効化 → S9 Event Webhook → S10 文書。

**承認境界（env フリップをまとめ、細かな停止を避ける）**:

- **境界A**: 入口停止 → pending 0 確認 → A2 OFF 目視 → `A2_DISABLED_CONFIRMED=true` → **v2-dry-run**（flow=v2 / worker=false / reconciler=false）→ redeploy → read-only 確認。この時点で dispatcher/reconciler は **0 送信・0 書込み**（gate が dry-run）。
- **境界B**: 新規カナリア 1 件（新 IdempotencyKey・テスト Base）→ dispatcher/reconciler が no-op であることを確認 → cleanup。
- **境界C**: **worker=true**（v2-worker）→ dispatcher が pending を実顧客へ送信開始 → 最小監視 → rollback 判断。
- **境界D**: **reconciler write=true**（v2-full）→ Scheduled 有効化済み → 最小監視。

- **絶対条件**: A2(ON) と新 worker(送信可) を同時に成立させない。
- 「60 秒待てば旧インスタンスが消えた」とは言わない。**本当の防御は入口停止**。
- rollback 第一選択は「A2 を ON に戻す」ではなく**新規受付だけ停止して既存状態を確定させる**。

---

## D1 境界A 実施記録（2026-07-21・v2-dry-run 移行完了）

**実顧客メールは未送信。** 旧 A2 と新 worker の二重送信可能性を構造的に排除し、v2-dry-run へ移行した。

| 項目 | 実施内容 |
|---|---|
| 実施日時 | 2026-07-21（env 更新 00:50 UTC / redeploy 00:53 UTC published） |
| 入口停止 | Airtable Automation **A1「入金確認 → 有料プラン昇格」を OFF**（MK が UI で実施・可逆） |
| pending 0 確認 | 入口停止後の本番 Customers: pending=0 / unknown_after_attempt=0 / attempting_pre_send=0（read-only 件数のみ） |
| A2 OFF | Airtable Automation **A2「入金確認メール自動送信」を OFF**（MK が UI で実施・目視確認済み） |
| env 変更 | `FLOW_VERSION=v2` / `WORKER_SEND_ENABLED=false` / `RECONCILER_WRITE_ENABLED=false` / `GLOBAL_PAUSE=false` / `A2_DISABLED_CONFIRMED=true`（Production / Functions scope のみ） |
| published deploy | `6a5ec2b98f23960008abcde2`（commit `cdf69b9` / ready / created 00:52 = env 更新後） |
| gate mode | **v2-dry-run**（ok=true / violations=[]） |
| worker 送信 | **不可**（v2-worker/v2-full でない） |
| reconciler 書込み | **不可**（v2-full でない → dryRun=true） |
| 実顧客送信 | **0** |
| Scheduled no-op | dispatcher は gate 判定で `not_sending_mode` を先に返し Airtable/送信へ到達しない。reconciler cron は dryRun=true で書込み 0（unknown 0 件） |

**rollback（境界A）**: env を `FLOW_VERSION=legacy` へ戻す（+ redeploy）→ gate=legacy へ即復帰。
**A2 は再 ON しない**（入口停止を維持したまま既存状態を確定させる方針）。

**次工程**: 境界B（新 IdempotencyKey でカナリア 1 件 → dispatcher/reconciler の no-op 確認 → cleanup）。
**cutover は未完了**（実顧客への worker 送信は境界C＝worker=true 以降）。

---

## legacy 管理経路の無効化（設計・cutover 時に実施）

`/admin/send-payment-confirmation`（+ `send-payment-confirmation.js`）と `paypal-webhook.js` は
運用上未使用だが到達可能で、**誤操作すると自前送信 + A2 で 2 通**届く（`PaymentEmailSent` を立てないため）。

- **即時（コード変更前）**: 使用禁止を運用で明文化。`admin-promote-customer` 完成まで触らない。
- **cutover 時（S3〜S6 のどこか・本タスクでは未実施）**:
  - 推奨: 管理画面を新 `admin-promote-customer` 画面へ **redirect**、旧 Function は **410 Gone** を返す。
  - **feature flag に依存した 403 だけでは legacy 期間中に誤操作可能**なので不十分（恒久 410 にする）。
  - `paypal-webhook.js` は未使用を**コードコメント + 運用文書に明記**し、v2 対応完了まで有効化禁止。
- 本タスクでは**旧 Function の挙動は変更しない**（cutover 時のアクションのため）。

## 別課題（本設計と分離・未解決）

- **送信元不一致（決済メール経路は 2026-07-20 に解決済み）**: `email-config.js` の
  `FROM_EMAIL='noreply@keiba.link'` は残るが、**決済メール v2 経路は `senderIdentity.js` へ移行済み**
  （上記「送信元契約」参照）。**未対応で残るのは legacy 経路**:
  `confirm-bank-payment.js`（L59）/ `send-payment-confirmation-auto.js`（L342）は依然 `FROM_EMAIL`
  = noreply で送信する。稼働中の本番経路のため本タスクでは変更していない（別タスク）。
  ニュースレター / マジックリンク等の 11 Function も従来どおり別タスク。
- **`/admin/send-payment-confirmation` + `send-payment-confirmation.js` は未使用だが到達可能**。
  誤操作すると A2 と合わせて 2 通。cutover 前に 410/redirect で無効化。`paypal-webhook.js` も同型。

## 実装ファイル

| 目的 | ファイル | 状態 |
|---|---|---|
| 状態機械（純粋関数・単一源） | `src/lib/payments/paymentEmailState.js` | S3 で実装 |
| **送信元契約（単一源）** | `src/lib/payments/senderIdentity.js` | **2026-07-20 実装** |
| **送信前 schema preflight / state write 失敗処理** | `paymentEmailState.js`（`REQUIRED_PROVIDER_RESULT_FIELDS`）/ `paymentEmailWorker.js` / `paymentEmailDeps.js`（`verifyWritableFieldsFrom`） | **2026-07-20 実装** |
| **B1 dispatcher コア** | `src/lib/payments/paymentEmailDispatcher.js` | **2026-07-21 実装** |
| **B1 dispatcher Function（Scheduled+手動）** | `netlify/functions/payment-email-dispatcher.js` | **2026-07-21 実装** |
| **B2 reconciler Scheduled 配線** | `netlify/functions/cron-payment-email-reconciler.js` | **2026-07-21 実装** |
| **dispatcher/lock deps** | `paymentEmailDeps.js`（`listPending`/`makeDispatcherDeps`/`makeSchedulerLockDeps`） | **2026-07-21 実装** |
| 同テスト | `src/lib/payments/paymentEmailState.test.mjs` | S3 で実装 |
| confirm v2（pending 同梱） | `netlify/functions/confirm-bank-payment.js` | S3 で改修 |
| 送信 worker | `netlify/functions/payment-email-worker.js`（新規） | S3 |
| カナリア専用 | `netlify/functions/admin-canary-payment-email.js`（新規） | S3 |
| カナリア deps（Base/Table 分離・単一源） | `src/lib/payments/paymentEmailDeps.js`（`canaryTarget`/`makeCanaryWorkerDeps`） | S4 |
| カナリア分離テスト | `src/lib/payments/paymentEmailDeps.canary{,.guard}.test.mjs` | S4 |
| reconciler（Scheduled） | `netlify/functions/payment-email-reconciler.js`（新規） | S3 |
| 手動昇格 | `netlify/functions/admin-promote-customer.js`（新規） | S3 |
| Event Webhook | `netlify/functions/sendgrid-webhook.js`（拡張・署名検証） | S9 |
