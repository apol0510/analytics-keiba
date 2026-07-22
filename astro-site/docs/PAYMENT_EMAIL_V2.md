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

> ⚠️ 上記の「未完了」は **境界A 実施直後（2026-07-21）時点の記述**である。
> **cutover はこの後、同日中に境界 B→C→D まで完了**した（次節 §D1 cutover 完了記録）。

---

## D1 cutover 完了記録（2026-07-21・v2-full 稼働）

**入金確認メール v2 の cutover を完了。gate=v2-full 稼働。実顧客への誤送信・二重送信 0。**

| 境界 | 実施 | 結果 |
|---|---|---|
| A2 OFF | Airtable Automation A2「入金確認メール自動送信」OFF（MK・維持） | 二重送信源を構造的に排除 |
| 境界A | 入口停止（A1 OFF）→ pending 0 → A2 OFF → env v2-dry-run → redeploy | gate=v2-dry-run |
| 境界B | 新 IdempotencyKey でカナリア 1 件（テスト Base・テスト宛先） | HTTP 200 / accepted / providerAccepted / **実受信 1 通**（support@keiba.link）。test record は accepted 監査終端 |
| 境界C | `WORKER_SEND_ENABLED=true` → redeploy | gate=v2-worker / worker 送信 YES / reconciler write NO。pending 0 で dispatcher no-op |
| A1 再開 | Airtable Automation A1「入金確認 → 有料プラン昇格」ON（A2 は OFF 維持） | 単一送信経路確立（confirm=pending 生成→dispatcher→worker 1 通。A2 OFF で二重送信なし） |
| 境界D | `RECONCILER_WRITE_ENABLED=true` → redeploy | **gate=v2-full**（worker YES / reconciler write YES） |

**最終状態（2026-07-21）**: published `6a5f0de0`（commit `2d501ed` = origin/main）/ gate=**v2-full** /
A1 ON / A2 **OFF** / dispatcher schedule `*/5`（最大 3 件・deadline 25s）/ reconciler schedule `*/15`
（最大 10 件・deadline 25s）/ 送信元 support@keiba.link / schema preflight 有効 / 本番 pending・unknown・
attempting **0**。organic traffic が無い間は dispatcher/reconciler とも 0 件 no-op。

**単一送信の保証**: confirm（v2 分岐）は `Status=active`+`pending` を書くが `PaymentEmailSent` を書かず送信もしない。
A2 OFF のため Status→active の自動メールは発火しない。送信するのは dispatcher→worker の 1 経路のみ。

**rollback**（cutover 後も有効・追加承認不要）:
1. `PAYMENT_EMAIL_GLOBAL_PAUSE=true` → redeploy（新規送信を即停止・A2 は再 ON しない）
2. 必要なら `FLOW_VERSION=legacy` / `WORKER_SEND=false` / `RECONCILER_WRITE=false` → redeploy で legacy へ

## 初の実顧客通過記録（2026-07-22・v2-full）

D1 cutover 後、**初めて実顧客 1 件が v2 経路を端から端まで通過**した。カナリア（テスト Base）ではなく
**本番 Customers・実顧客・実メール**で不変条件が守られたことの確認。

| 項目 | 実測 |
|---|---|
| ケース | 既存 Light 会員（Monthly / Status=active / 有効期限は経過済み）が銀行振込で **Premium Annual** へ乗り換え |
| MK の手動操作 | **`PaymentConfirmed` にチェック 1 回のみ**（他フィールドは一切手動編集していない） |
| confirm（v2 分岐）の PATCH | `プラン=Premium` / `PlanType=Annual` / `Status=active` / `有効期限=入金確認日 JST +1年` / `PaidAt` / **`PaymentEmailStatus=pending`** / `Requested*` クリア |
| confirm の送信 | **なし**（`PaymentEmailSent` も書かない） |
| 送信 | dispatcher（`*/5`）が pending を取得 → worker が **1 通だけ**送信（`support@keiba.link`） |
| 終端 | `PaymentEmailStatus=accepted` / `PaymentEmailSent=true`（worker が互換出力として記録） |
| 二重送信 | **なし**（A2 OFF のため Status→active で旧 Automation は発火しない） |
| 所要 | チェック → `accepted` まで数分（dispatcher の 5 分周期内） |

### この事例で実証された不変条件

- **単一送信経路**: confirm は pending を作るだけ。送信は dispatcher→worker の 1 経路のみ。
  旧設計（A2 ON）なら `Status→active` で A2 も発火し **2 通**届いていた経路である。
- **冪等性**: 承認時に `Requested*` がクリアされ、`PaymentConfirmed` を再チェックしても
  `buildV2ConfirmationFields` が `null`（fail closed）を返し**有効期限が二重延長されない**。
- **legacy フラグの無害化**: 当該レコードには Light 購入時の **`PaymentEmailSent=true` が残っていた**が、
  v2 の dispatcher は `PaymentEmailStatus='pending'` のみで対象を選ぶため**影響しなかった**
  （「新ロジックは `PaymentEmailSent` を判断材料として一切読まない」が実運用で確認された）。
- **送信元契約**: `support@keiba.link` で送信（noreply へ戻っていない）。

### 運用メモ（同種の問い合わせへの回答）

「自動化したのに何も起きない」という問い合わせの大半は、**`PaymentConfirmed` が未チェック**であることが原因。
申込フォームは `Requested*` に退避するだけで権限を付与しない（未入金で昇格させないための fail closed）ため、
**チェックが自動化の起点**である。以下は事故になるので行わない:

- `プラン` / `PlanType` / `Status` / `有効期限` の手動編集（confirm が上書き前提で組み立てている）
- `Status` を pending→active に手で変えてメールを起こそうとする（**A2 は OFF なので送信されない**）
- `PaymentEmailStatus` の手動書き換え（二重送信防止の状態機械を壊す）
- `pending` が数分続くことを異常と見なして `PaymentConfirmed` を外して入れ直す（再送されず、昇格もしない）

`pending` のまま **10 分以上**動かない場合のみ異常。**自動再送を試さず**、gate 構成（`v2-full`）と
Scheduled Function の稼働を read-only で確認する。

> 本記録は read-only の Airtable GET のみで作成した（**書込み 0 / Function 直接呼出 0 / 手動メール送信 0 /
> deploy 0**）。実際の昇格・送信はすべて本番の A1 → confirm → dispatcher → worker が自律実行した。
> **顧客の Email / 氏名 / recordId は記録しない。**

### 続報: 同じ事例からメール本文の欠陥が判明（2026-07-22 中に修正・本番反映済み）

**状態機械としては完璧に動作したが、顧客体験は失敗していた。**
この顧客は `accepted` 到達後に「ログインできない」と問い合わせてきた。原因は
**入金確認メールにログイン導線が無かった**こと（本文が 1 行だけだった）。
結果としてログインリンクを 9 回発行して迷わせている。

**教訓**: 「不変条件がすべて守られた」ことと「顧客が使い始められた」ことは別問題である。
送信成功を終端と見なさず、**受け取った人が次に何をするか**まで含めて設計する。

恒久対策は §入金確認メールの本文契約（2026-07-22・ログイン導線の必須化）を参照
（`238db1c` で本番反映済み）。

---

## カナリア再検証（2026-07-22・PAT / secret ローテーション後の実効性確認）

カナリア経路の認証情報を 2 つとも更新したため、**新しい認証情報で経路が端から端まで動くこと**を
再検証した。コード変更 0 / gate env 変更 0 / 本番 Customers 非接触。

### 1. 何を・なぜローテーションしたか

| 対象 | 操作 | 理由 |
|---|---|---|
| `PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY`（カナリア専用 Airtable PAT） | **Regenerate**（旧値失効）→ Netlify **Production / Functions** へ差し替え | 旧値の無効化。**本番 `AIRTABLE_API_KEY` とは別系統**である分離を維持したまま更新する |
| `PAYMENT_CANARY_SECRET`（`x-canary-secret`） | **ローテーション** → Netlify **Production / Functions** へ差し替え | 同上。`is_secret=true` のため **API/CLI から平文取得できず、値は MK のみが保持**する |

いずれも **値は会話・ログ・git・本書に残さない**。検証はすべて presence / context / scope / `updated_at` の
メタデータのみで行った。

### 2. env 反映は deploy 後にのみ runtime へ届く（判定方法を恒久化）

Netlify の env は **値を変更しただけでは動作中の Function に反映されない**。反映は次の deploy 以降になる。
そのため本作業では毎回、次の**時刻の前後関係**で機械的に判定した（推測しない）。

```
env の updated_at  <  published deploy の published_at   →  runtime は新しい値
```

| 反映対象 | env `updated_at` | Build Hook 実行 | published deploy | `published_at` | 判定 |
|---|---|---|---|---|---|
| カナリア専用 PAT | 2026-07-22T06:30:05Z | **1 回のみ** | `6a60680038d39a00083ff5d6` | 2026-07-22T06:50:46Z | ✅ 反映 |
| `PAYMENT_CANARY_SECRET` | 2026-07-22T07:46:31Z | **1 回のみ** | **`6a6076887f64ee0008a1cac0`** | 2026-07-22T07:52:44Z | ✅ 反映 |

- Build Hook は既存の `analytics-keiba-auto-deploy`（branch=main）を**各 1 回だけ**実行。**Hook URL は出力しない**。
- どちらも **commit `238db1c`（= その時点の origin/main）でコード差分ゼロの env 伝播専用ビルド**。
  60 functions deployed / deploy_time 67〜69 秒 / env キー総数 35 は前後で不変。
- 最終 published deploy: **`6a6076887f64ee0008a1cac0` / commit `238db1c` / state=ready**。

### 3. 認証失敗（403）は送信処理へ進まない — 実測で確認

secret 差し替え前に旧 runtime へ投げた 2 回の POST は、いずれも **403** で終わった
（1 回は zsh の `read -p` 非対応で secret が空のまま送信されたもの。zsh では `read -rs "VAR?prompt"` を使う）。

`admin-canary-payment-email` は **secret-first fail closed**（認証・allowlist 検証を **body parse より前**に実行）
のため、403 は `makeCanaryWorkerDeps()` / `runWorkerOnce()` に到達しない。実測でも **Record は完全に不変**だった:

- `PaymentEmailStatus=pending` / `AttemptCount=0` / `Sent=false` を維持
- `AttemptedAt` / `LeaseUntil` / `AttemptToken` すべて空 = **lease すら取得していない**
- 試行回数を消費せず、`PaymentEmailIdempotencyKey`（新キー）は**未使用のまま有効**

→ **認証段の 403 は「送信試行」ではない**。再実行にあたって IdempotencyKey を作り直す必要はない。

### 4. 最終カナリア（exactly once）

| 項目 | 実測 |
|---|---|
| 対象 | **カナリア専用 Base / Table / Record 1 件のみ**（allowlist **exactly-one** をコードで強制） |
| テスト Base の Automation | **ON = 0 件**（MK が Airtable UI で目視確認。本番 A2 OFF は別 Base の話であり証明にならないため必須） |
| 事前準備 | 新しい一意な `PaymentEmailIdempotencyKey` を採番して `pending` 初期化（PATCH 1 回 + read-back）。**過去キーは再利用しない** |
| 実行 | `admin-canary-payment-email` を **exactly once**（応答 `canary=true` / `ok=true` / `status=accepted` / `providerAccepted=true`） |
| メール | **1 通を実受信**（送信元 `support@keiba.link` / 本文は `238db1c`＝PR #151 のログイン導線付き版） |
| 送信後 Record | `accepted` / `AttemptCount=1` / `Sent=true` / `ProviderMessageId` 記録あり / `AcceptedAt` 記録あり / 新キー保持 / `FailureStage`・`LastError`・`DeliveredAt` 空 |

`DeliveredAt` が空なのは正常（Event Webhook は未実施のため `accepted` が正しい終端）。

### 5. cleanup は lease / fencing の 2 項目だけ

送信後、**`PaymentEmailLeaseUntil` と `PaymentEmailAttemptToken` だけが残る**ことを実測で確認した。
これは仕様どおりの挙動で、worker の `finally` は **Upstash ロックのみ解放**し、Airtable 側の lease / fencing
フィールドは `decideAfterProvider` の書込み対象外だからである。

- cleanup PATCH は **1 回**、対象は **`PaymentEmailLeaseUntil` / `PaymentEmailAttemptToken` のみ**。
- `PaymentEmailStatus` / `AttemptCount` / `Sent` / `ProviderMessageId` / `AcceptedAt` / `IdempotencyKey` は
  **read-back で PATCH 前と同一であることを確認**（同値 PATCH もしない）。
- **`pending` へは戻さない**。accepted 監査終端をそのまま維持する（pending 戻しは再送リスク）。

**再送されないことの根拠（3 重）**:

1. `accepted` ∈ `NO_AUTO_RESEND_STATUSES` → `decideLeaseAcquire` が `ineligible_state:accepted` を返し、
   PATCH も SendGrid POST も発生しない
2. reconciler は `unknown_after_attempt` 以外を即 skip する
3. dispatcher は **本番 Base の pending しか列挙しない**（カナリア Record は別 Base で構造的に到達不能）

### 6. 影響範囲（実測）

| 項目 | 実測 |
|---|---|
| 本番 Customers | **接続 0 / 読取 0 / 書込み 0** |
| メール | **1 通のみ**（MK 本人宛のテスト送信。追加送信 0） |
| 二重送信 | **なし** |
| 送信後 PATCH 422（2026-07-20 事故） | **再発なし**（送信前 schema preflight が有効に機能） |
| gate env / Automation / SendGrid 設定 | **変更なし**（gate は `v2-full` のまま。カナリアは gate を参照しない独立経路） |
| Airtable 書込み | カナリア専用 Base に **初期化 1 回 + cleanup 1 回**のみ |

### 7. 運用上の注意（次回の再検証で繰り返さないために）

- **env を変えたら必ず deploy**。値だけ差し替えて POST すると、旧値の runtime に対して投げることになり 403 になる。
- **反映確認は `updated_at` < `published_at`** で行う。「たぶん反映された」と判断しない。
- `PAYMENT_CANARY_SECRET` は `is_secret=true` で**取得できない**。POST は **MK 自身のターミナルで実行**し、
  secret と recordId が画面へ出ない形（非エコー入力 + env からの取得）で叩く。応答 JSON には
  recordId も ProviderMessageId も含まれないため、そのまま共有できる。
- カナリア Base の Automation は **毎回 UI で目視**する（API で確定できない）。

## Event Webhook（S9）— 別 Phase・未実施

SendGrid Event Webhook（`accepted` → `delivered`/`bounced`/`dropped` 反映）は **D1 cutover とは別 Phase** とし、
本 cutover では未実施。理由:
- **SendGrid 署名検証キー（新規 secret）の provision と SendGrid 管理画面の Event Webhook 設定**（ユーザー操作）が必要
- spoof 拒否 / 二重イベント冪等性 / out-of-order / 署名検証 の新規実装 + テストを要する
- 状態機械は `accepted`（provider 受理）と `delivered`（実配信）を**既に別状態として区別**しており、
  webhook 無しでもレコードは `accepted` で正しく終端する（confirmation メール目的には十分）。
  D1 完成条件に Event Webhook は含まれない。

→ 次 Phase で `sendgrid-webhook.js` 拡張（署名検証・custom_args 照合・冪等・PII 非出力）+ テスト +
   SendGrid 側設定を実施する。それまで `PaymentEmailDeliveredAt` / `delivered` 系は未使用。

### S9 本体（2026-07-23 実装）— `accepted` → `delivered` / `bounced` / `dropped`

**単一源**: 判定は `paymentEmailState.js` の `decideWebhookTransition()`、適用は
`src/lib/payments/paymentEmailWebhook.js`。Function（`sendgrid-webhook.js`）は**配線のみ**で
判定を再実装しない（guard で固定）。

#### 対象イベントの選別

worker は送信時に `custom_args: { record_id, idempotency_key, purpose: 'payment_confirmation_v2' }`
を載せている。SendGrid はこれを各イベントの**トップレベル項目**として返すため、
**`purpose` が一致するイベントだけ**を Payment Email 経路へ入れる。
メルマガ等の bounce は従来どおり **suppression（`EmailBlacklist`）側だけ**が扱う（両者は独立）。

#### 状態遷移の規則（順序非依存・重複耐性）

SendGrid は exactly-once でも順序保証でもない。そこで:

| 現在の状態 | delivered | bounce / dropped |
|---|---|---|
| `accepted` / `unknown_after_attempt` | → `delivered`（+ `PaymentEmailDeliveredAt`） | → `bounced` / `dropped` |
| `delivered` | **no-op**（`already_delivered`） | **上書きする**（失敗の方が運用上有用） |
| `bounced` / `dropped` | **不変**（吸収状態） | **不変**（吸収状態） |
| `pending` / `attempting_pre_send` / `failed_*` / `needs_admin` / 空 | **触らない**（`unexpected_state:*`・fail closed） | 同左 |

- **失敗は吸収状態・delivered は暫定**という 2 規則により、`delivered` と `bounce` が
  **どちらの順で届いても最終状態は `bounced`** に収束する（順序非依存）。
- 重複イベントは**同じ値の代入**になるため無害。よって **`sg_event_id` の保持が不要**＝
  **Airtable の新規フィールドを増やさない**。
- **限界**: `bounce` と `dropped` の相互順序は保存されない（先に届いた方が残る）。
  どちらも失敗終端で運用判断は変わらないため許容する。

#### fail closed の約束

1. 署名検証を通ったイベントだけを渡す（検証の単一源は `sendgridSignature.js`）
2. `record_id` / `idempotency_key` が欠けていたら **`getRecord` すら呼ばない**
3. レコードの `PaymentEmailIdempotencyKey` と**完全一致**しなければ**書かない**
   （再送で採番し直した後に古いイベントが届いても、過去の送信結果で上書きしない）
4. Payment Email 反映が失敗しても **suppression 側を巻き添えにしない**（try/catch で隔離）
5. **応答・ログは件数と reason のみ**（recordId / メールアドレス / 冪等キーを出さない）

検証: `paymentEmailWebhook.test.mjs`（19 件）/ `sendgridWebhook.guard.test.mjs` の S9 配線 5 件
（`test:bank-payment` / `test:webhooks` → `check:safety` で CI 強制）

#### 有効化の状況（2026-07-22 完了）

- コード: **本番反映済み**（PR #154 / `cd04d89`）
- SendGrid 設定: **`Delivered` を追加済み**（他のイベント選択・URL・署名設定は無変更）。
  対象は **bounce / delivered / dropped / spam_report / unsubscribe**
- **本番動作を実証済み**: マジックリンク 1 通の `delivered` が届き、
  `paymentEmail: { targeted: 0, applied: 0, skipped: 0, errors: 0 }` を確認。
  `custom_args.purpose` を持たないメールを**正しく対象外にした**（＝選別が効いている）。
  同時に suppression 側も `processed: 0`（`delivered` は対象外）で、**Airtable 書込みは 0 件**。
- **未実証として残るのは 1 点**: 決済確認メール（`purpose='payment_confirmation_v2'`）の `delivered` で
  `applied: 1` になること。**次の実入金時に自然に確認できる**（read-only 確認のみで足りる）。

> `delivered` を全メールで受けるため**受信量は増える**が、`purpose` 不一致は `getRecord` にも到達せず
> 即スキップするため **Airtable 書込みは増えない**。

### S9 前提工事（Phase 0）は 2026-07-21 に実施済み

S9 の前提調査で、**`sendgrid-webhook.js` が署名検証・認証なしで公開稼働**しており、
第三者が任意アドレスを `EmailBlacklist` へ HARD_BOUNCE 登録できる（= メルマガ配信対象から
恒久除外できる）状態を検知した。S9 が触る対象ファイル・署名検証モジュールと同一のため、
**先に fail closed 化を実施**した（署名検証単一源 / 鍵未設定は 403 / 検証前に body を parse しない /
formula injection 遮断 / PII 非出力）。

契約と本番反映順序は **`astro-site/docs/SENDGRID_WEBHOOK.md`** が単一源。
S9 本体（`custom_args` 照合による Payment Email 状態への反映）は**引き続き未実装**。

この Phase 0 は **PR #149（`feat/sendgrid-webhook-fail-closed`）** で実装され、
**2026-07-22 に squash merge（`137a348`）→ production 反映まで完了**した。
凍結理由だった「SendGrid 側の登録状況が未確認」は同日 read-only で解消（下記）。
カナリア再検証・env 反映 deploy とは**別の承認境界**として扱い、同じ承認に混ぜていない。

#### Phase 0 の本番反映・Webhook 有効化（2026-07-22 完了）

| 項目 | 状態 |
|---|---|
| コード | `137a348` を production 反映。published **`6a609fe22791d800080c2ff0` / ready** |
| 受信側 | `sendgrid-webhook.js` は**署名検証必須の fail closed**（鍵未設定でも 403・省略分岐なし） |
| 検証鍵 | `SENDGRID_WEBHOOK_VERIFICATION_KEY` = **Secret / Functions scope / Production のみ**・**runtime 反映済み**（env の `updated_at` < deploy の `published_at` で判定） |
| SendGrid | 「AK Event Webhook」= **enabled=true / signed=true** / Post URL 一致 |
| 対象イベント | **bounce / delivered / dropped / spam_report / unsubscribe**（`delivered` は S9 本体の実装後、2026-07-22 に追加）。processed / deferred / open / click / group_* は false |
| Test Integration | **実施しない方針**。本番 `EmailBlacklist` にダミーが作られる可能性があるため、**organic event で実証**した |
| 鍵一致の E2E 実証 | ✅ **完了（2026-07-22）**。マジックリンク 1 通の `delivered` が届き `📨 処理完了 { received: 1, ... errors: 0 }`＝**署名検証を通過**。詳細は `SENDGRID_WEBHOOK.md` §完了: 鍵一致の E2E 実証 |
| 異常時 | `signature_mismatch` / `verification_key_invalid` が**継続**したら **SendGrid 側で Enable endpoint を直ちに OFF**（fail closed のため誤書込みは発生しない） |

実証時の副作用: **なし**。`EmailBlacklist` は **11 件 / `BounceCount` 合計 16 / HARD 4・SOFT 7** で
baseline から変化なし、Customers への書込みも 0 件（`paymentEmail.targeted: 0`）。
詳細と次回確認手順は **`astro-site/docs/SENDGRID_WEBHOOK.md` §Phase 0 本番反映・Webhook 有効化 完了記録** が単一源。

#### SendGrid 側の登録状況（2026-07-22・read-only で確定）

`GET /v3/user/webhooks/event/settings/all` = **HTTP 200 / 登録済み Event Webhook 0 本**
（`max_allowed=2`）。Netlify の `SENDGRID_WEBHOOK_VERIFICATION_KEY` も**未設定**。

- `SENDGRID_WEBHOOK.md` §本番反映の順序 で「未確認・推定」としていた前提が**確定**した
  （`EmailBlacklist` の webhook 由来レコードが 2025-09 以降 0 件である間接証拠とも整合）。
- したがって Phase 0 を本番へ入れても **機能損失ゼロ**（届いていないものを 403 にするだけ）。
  **鍵の provision も enabled 化も、この deploy の前提ではない**。
- 反映順序は変わらず「**コード（fail closed）を先に本番へ → その後に SendGrid 側を作成 / 有効化**」。
  逆順にすると、署名検証を持たない現行コードが公開受信窓のまま晒される。

## legacy noreply 経路（2026-07-21 解消済み）

`confirm-bank-payment.js` の **legacy 分岐**（`shouldConfirmUseV2=false` のとき）と
`send-payment-confirmation-auto.js` は `email-config.js` の `FROM_EMAIL`=`noreply@keiba.link` で
送信しており、**gate を legacy へ rollback すると noreply 送信に戻る**残課題だった。

2026-07-21 に両ファイルを **`senderIdentity.js`（単一源）へ移行**し解消:

- `FROM_EMAIL` の import を削除（guard テストで再混入を禁止）
- `resolveVerifiedSender(process.env)` を **SendGrid へ POST する前**に呼び、
  不一致 / 未設定なら `sender_unverified: <reason>` を throw して **fail closed**（理由コードのみ・env の値は含めない）
- `send-payment-confirmation-auto.js` は fail closed が **Step 4 の PATCH より前**に起きるため、
  送信できなかったのに `PaymentEmailSent=true` になるズレを作らない（順序も guard で固定）

→ **gate=legacy へ rollback しても送信元は `support@keiba.link`**。本番 env
`SENDGRID_FROM_EMAIL` が正式値であることは境界B カナリアの実受信で実証済み。

> ~~**未対応（別タスク）**: `send-payment-confirmation.js` と `paypal-webhook.js` は依然
> `FROM_EMAIL`（noreply）を使う~~ → **2026-07-22 に両者を 410 Gone 化して解消**。
> 送信元だけ差し替える半端な修正ではなく、**経路そのものを無効化**した
> （§legacy 管理経路の無効化）。両ファイルから SendGrid / Airtable / `fetch` を完全に除去済み。

---

## legacy 管理経路の無効化（2026-07-22 実施済み・恒久 410）

`/admin/send-payment-confirmation`（+ `send-payment-confirmation.js`）と `paypal-webhook.js` は
運用上未使用だが到達可能で、**誤操作すると自前送信 + A2 で 2 通**届いた（`PaymentEmailSent` を
立てないため）。**feature flag に依存した 403 では legacy 期間中の誤操作を防げない**ため、
設計方針どおり**恒久 410 Gone** で無効化した。

### 実施内容

| 対象 | 変更後 |
|---|---|
| `netlify/functions/send-payment-confirmation.js` | **常に 410**（`{error:'Gone', reason:'legacy_route_removed'}`）。SendGrid / Airtable / fetch を**コードから完全に除去** |
| `netlify/functions/paypal-webhook.js` | **常に 410**。Airtable SDK・SendGrid 送信・`Status='active'` 直書きを**除去** |
| `src/pages/admin/send-payment-confirmation.astro` | 操作 UI を持たない**廃止案内ページ**（`noindex` / フォーム・fetch なし）。現行手順（`PaymentConfirmed` にチェック）とやってはいけない操作を明示 |

- **redirect ではなく案内ページ**にした理由: 代替となる `admin-promote-customer` の**画面は存在しない**
  （Function のみ）。存在しない URL へ redirect するより、現行手順を示す方が運用事故を減らせる。
- 手動昇格が必要な場合は `netlify/functions/admin-promote-customer.js`（状態機械に沿って
  `PaymentEmailStatus='pending'` を作る）を使う。**自前送信 + `Status` 直書きの経路は復活させない。**
- `paypal-webhook.js` を将来復活させる場合の必須条件（署名検証 / 昇格は単一源経由 /
  送信は状態機械へ委譲）はファイル冒頭のコメントに明記した。

### guard

`src/lib/payments/legacyPaymentRoutes.guard.test.mjs`（`test:bank-payment` → `check:safety` で CI 強制）:
410 を返すこと / 成功ステータスの経路が無いこと / SendGrid・Airtable・`fetch` を持たないこと /
`Status='active'`・`有効期限`・`PaymentEmailSent` を書かないこと / 旧 admin 画面が
廃止済み Function を呼ばず、フォーム・fetch を持たないこと。

## 別課題（本設計と分離・未解決）

- **送信元不一致（決済メール経路は解決済み）**: `email-config.js` の
  `FROM_EMAIL='noreply@keiba.link'` は残るが、**決済メール経路は v2（2026-07-20）・legacy（2026-07-21）
  とも `senderIdentity.js` へ移行済み**（上記「送信元契約」/「legacy noreply 経路」参照）。
  ~~**未対応で残るのは未使用の 2 経路**: `send-payment-confirmation.js` / `paypal-webhook.js`~~
  → **2026-07-22 に両者を 410 Gone 化して解消**（§legacy 管理経路の無効化）。
  ニュースレター / マジックリンク等の 11 Function は従来どおり別タスク。
- ~~**`/admin/send-payment-confirmation` + `send-payment-confirmation.js` は未使用だが到達可能**~~
  → **解消済み**。Function は常に 410、admin 画面は操作 UI を持たない廃止案内ページ。
  `paypal-webhook.js` も同様に 410 化済み。

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

---

## 入金確認メールの本文契約（2026-07-22・ログイン導線の必須化）

**事故**: v2 の本文は `<p>ご入金を確認いたしました。ご利用を開始いただけます。</p>` の 1 行だけで、
**ログインへの導線が無かった**。入金直後の実顧客が「利用開始できます」と案内されながら入口が分からず、
15 分で失効するログインリンクを **9 回連続で発行**して迷った（うち 2 回はログイン成功。残り 7 回は
未使用のまま失効）。加えて、有料会員がマジックリンク方式であることが本文で説明されておらず、
**入金確認メールの中にログインリンクを探して詰まる**構造だった。

### 単一源

本文は `src/lib/payments/paymentConfirmationEmail.js` の
`buildPaymentConfirmationEmail()` が唯一の生成元。`paymentEmailDeps.js` の `sendMail` は
**subject / html / text をこの戻り値からのみ取る**（Function 側で文字列を組み立てない・guard で固定）。

### 本文に必ず含めるもの（guard テストで強制）

| 要素 | 理由 |
|---|---|
| **ログインボタン + 生 URL の両方** | HTML が崩れる環境でも入口に到達できる |
| **マジックリンク方式の説明**（別便で届く / 件名 `【KEIBA Analytics】ログインリンク` / 15 分で失効 / 迷惑メール確認） | 書かないと入金確認メール内にリンクを探して詰まる |
| **「このメールにログインリンクは含まれていません」の明記** | 上記の探索を止める最短の一文 |
| ウェルカム文言・契約内容（プラン / 期間） | 支払い直後の体験。事務連絡だけにしない |
| サポート窓口 `support@keiba.link` | 詰まったときの出口 |

### 実装上の制約

- **差し込み値は必ず `escapeHtml()` を通す**（氏名 / プランは Airtable 由来の外部入力）。
- **氏名は 600 件中 51 件しか埋まっていない**。空でも自然に読める文面にし、`お客様` を機械的に埋めない。
- サイト URL は **env `MAGIC_LINK_BASE_URL`** から渡す（未設定時のみ `https://analytics.keiba.link`）。
  `analytics.keiba.jp`（存在しない）/ Netlify サブドメインは本文へ書かない。
- パーソナライズ値は **worker が取得済みの record から渡すだけ**（Airtable の追加読み取りをしない）。
- **氏名 / プランをログへ出さない**（guard で固定）。
- `text/plain` と `text/html` の両方を送る（プレーンテキスト環境でも導線が残る）。

検証: `npm run test:bank-payment`（`paymentConfirmationEmail.test.mjs` 15 件 /
`paymentConfirmationEmail.guard.test.mjs` 8 件）

### 併せて修正した UI（同 PR）

- `/login` と `/dashboard` の送信後メッセージが**エラーに読める**文言だった（実際は `showSuccess`）。
  「✉️ ログインリンクを送信しました。件名 … を 15分以内 に / 最新の1通 / 迷惑メール」へ変更し**両画面で同一文言**に統一。
- `/auth/verify` の失敗画面（期限切れ / 使用済み）に「**最新の1通を使う**」案内と
  **「ログインリンクを再送する」ボタン**を追加。

### 未対応（別タスク）

有料セッションは **20 分（絶対上限 12 時間）**で失効するため、再ログインが頻発する構造は残っている。
**PR-B2（refresh）** が本質的な解（既存バックログ）。本 PR はメール導線と文言のみを直している。
