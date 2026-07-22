# Project Progress

本書は `analytics-keiba` の **進捗の正本（canonical）** である。仕様は `docs/spec.md`、運用ルールは `CLAUDE.md`、設計判断は `docs/decisions.md` を参照。

> **本書の初版は 2026-07-20 に作成された。** 本書作成時点で完了しているのは **ドキュメント基盤の整備のみ**であり、
> コード実装の完了記録ではない。過去のコード作業の完了状況は git 履歴・`docs/MAINTENANCE_HISTORY.md`・
> `CLAUDE.md` を一次証拠とすること。

## Final Goal

南関競馬 + 中央競馬（JRA）統合 AI 予想プラットフォーム `https://analytics.keiba.link/` を、
**無料 → light → premium → Premium Sanrenpuku / Premium Plus** の会員導線とともに
安定稼働させ、予想データ取込から本番反映までを自動で完遂し続けること。

その前提として、本 4 文書（`docs/spec.md` / `docs/progress.md` / `docs/decisions.md` / `CLAUDE.md`）を
正本として維持し、新しいセッションが履歴とコードだけを根拠に作業を再開できる状態を保つ。

## Current Phase

**Phase（2026-07-22 現在）: 入金確認メール v2 は cutover 完了・gate=v2-full で本番稼働中。
次 Phase 候補は Event Webhook（S9・別 Phase・未着手）**

- 入金確認メール v2 は 2026-07-21 に D1 cutover 完了。2026-07-22 に実顧客 1 件の本番通過と、
  PAT / secret ローテーション後のカナリア再検証を完了（詳細は §In Progress の日付別記録）。
- 初版（2026-07-20）の Phase は「ドキュメント基盤整備」であり、その PR
  （`docs/autonomous-project-workflow`）は **文書のみ**でソースコードの挙動を変更していない。
- 本体の開発は main 上で日次データ取込コミットと機能 PR が継続中。

## Completed

**このドキュメント基盤 PR で完了したこと（これのみ）**

- `docs/spec.md` 新規作成（仕様の正本。既存 `CLAUDE.md` / `astro-site/docs/*.md` を置き換えず、正本の役割分担を明示）
- `docs/progress.md` 新規作成（本書）
- `docs/decisions.md` 新規作成（git 履歴・既存文書から証拠のある判断のみを記録）
- `CLAUDE.md` に「Autonomous Delivery Workflow」節を追記（既存ルールは削除・弱体化なし）

**参考：main 上で既に完了していると git 履歴・既存文書から確認できる主要事項**（本 PR の成果ではない）

- 銀行振込 入金確認フロー 2026-07-10 再設計（本番反映済み・`CLAUDE.md` §銀行振込）
- `PAYMENT_CONFIRM_SECRET` による `confirm-bank-payment` ヘッダ認証（production 設定・本番検証済み / 2026-07-11）
- 入金確認メール v2 の状態機械コア（純粋関数）と IO 側 worker / reconciler / admin-promote / canary（`3a31df4` / `7860796`）
- カナリアの専用 Airtable Base/Table 分離 → secret-first 化 → 専用 PAT 完全分離（`924a9d0` / `4133afd` / `da29521` / `e1e730c`）
- Premium Plus の admin write 本番 hard block と Blobs eventual consistency 対応（`3b8c908` ほか）
- SSR Function 250MB 上限対策（`prune-ssr-function-data.mjs` を build に組込 / `77fbd58`）
- 三連複 entitlement resolver の最小配線（PR #141 / `7d48bb2`）
- Premium 期限切れ時の「契約期間終了」カード + 再契約導線（PR #142 / `4112ea3`）
- 買い切り三連複（`lifetimeSanrenpuku`）を馬単 Premium 期限切れ後も維持（`99c6946`）
- 問い合わせフォームの氏名・メール自動入力（`4c13275` / `74a59b7` / `c6844b5`）

## In Progress

> 以下はいずれも **観測時点（各見出しの日付）のスナップショット**であり、恒久仕様ではない。作業前に必ず現物を再確認すること。
> **本節の各記録は時系列で追記されており、後の日付の記録が前の記録を上書きする。**
> 特に「cutover 未実施」「カナリア未送信」等の記述は **2026-07-20〜21 時点のもの**で、
> **2026-07-21 の §D1 cutover 完了（v2-full 稼働）以降は該当しない**。現在地は §Current Phase を参照。

- **未マージの open PR（本 PR #143 を除き 3 件 / 2026-07-20 観測）**
  - #130 PR-A: 有料セッション共通ライブラリ（署名 Cookie）とテスト — `session-lib-pr-a`
  - #128 認証脆弱性の修正 + 問い合わせフォームの氏名/メール自動入力 — `worktree-secure-auth-and-contact-autofill`
  - #25 premium 本命/対抗/単穴に過去走表示を追加 — `feat/premium-jra-recent-races`（2026-05-26 起票、長期滞留）
- **ユーザーのメイン checkout に作業中の未コミット変更あり（2026-07-20 観測）**: 内容は決済メール v2 /
  entitlements / contact autofill / 予想ページ横断修正など。**本 PR の対象外であり一切触れていない。**
  件数・ブランチ名・HEAD はその時々で変わるため本書には固定記載しない — `git status` で都度確認すること。

### 決済メール v2 / S4 カナリア準備（2026-07-20・branch `ops/payment-email-v2-canary-pat`）

**確定した事実（証拠付き）**

- カナリア専用 Airtable PAT `PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY` を Netlify production / Functions scope に投入。
  Production のみ非空・他 4 context は空・scope は functions のみ（API で確認。値は非表示）。
- env 伝播のため Build Hook で production redeploy を 1 回実行 → published deploy `6a5d8a26fd3503000809b850`
  （commit `e3f562b` / ready / 2026-07-20T02:39:43Z）。コード差分ゼロの env 伝播専用ビルド。
- 専用 PAT でカナリア専用 Base/Table/Record へ **read-only GET 1 回 → HTTP 200（ACCESS_CONFIRMED）**。
  本番 Base とは別 Base であることを事前照合済み。
- **カナリア preflight で送信元不一致を検知**: 送信元が `noreply@keiba.link`（`email-config.js` の `FROM_EMAIL`）で、
  AK 正式送信元 `support@keiba.link` と不一致。→ **カナリアを実行せず停止**し、送信元契約を実装
  （`senderIdentity.js` / 詳細は `astro-site/docs/PAYMENT_EMAIL_V2.md` §送信元契約）。
- **カナリアメールは未送信 / 本番 cutover は未実施**（gate mode は `legacy` のまま・通常 worker は 403 で送信不可）。
- **`PaymentEmailIdempotencyKey` 空を検知**: テスト Record に冪等キーが無く、worker は生成しない実装のため、
  この状態で送ると `custom_args.idempotency_key` が空になり **reconciler の Activity 照合が成立しない**。
  → 送信前にテスト Record へ決定論的キーを PATCH する手順を実行承認に含める（未実行）。
- **A2 の扱い**: 本番 Base の Automation A2 は **カナリア専用テスト Base へ構造的に到達しない**（Automation は Base 単位）。
  ただし**テスト Base 内の Automation 有無は API で確定できない**ため、実送信直前に Airtable の
  Automations 画面を目視確認する境界として残す。

**次の実行承認に含める内容（すべて未実行）**

1. テスト Record 1 件へ `PaymentEmailIdempotencyKey` を事前 PATCH（テスト Base 限定書込み）+ read-back
2. `admin-canary-payment-email` を POST 1 回（対象 1 件 / 想定メール 1 通 / SendGrid API 送信 1 回）
3. 送信後 read-only 確認（Record 状態 `accepted` / ProviderMessageId 非空 / 受信箱で送信元が support@keiba.link）
4. テスト Record を初期状態（`pending` / AttemptCount 0 / 他クリア）へ戻す cleanup PATCH

### 決済メール v2 / S4 カナリア実行と事故（2026-07-20・branch `fix/payment-email-schema-preflight`）

**カナリアは実行され、メールは実際に届いた。** 一方で結果を記録できず、恒久対策を実装した。

**経緯（証拠付き）**

- 送信元不一致（noreply）を検知 → `senderIdentity.js` を実装し PR #144 を merge（`f7485d9`）・本番反映済み
- `PAYMENT_CANARY_SECRET` は `is_secret=true` のため API/CLI から平文取得不可 → **ローテーションし
  ユーザーが UI 入力**（`2026-07-20T09:27:29Z`）→ Build Hook で redeploy（`cf8eefa`）
- カナリア Function を 1 回実行 → **HTTP 500 `Airtable PATCH 422`**
- **メール 1 通が実受信された**（本文「ご入金を確認いたしました。ご利用を開始いただけます。」）
  → **送信元 support@keiba.link への統一が本番で機能していることの実証**でもある
- レコードは `unknown_after_attempt` / AttemptCount=1 / ProviderMessageId 空 / AcceptedAt 未設定 /
  PaymentEmailSent=false のまま滞留（**送信済み・結果永続化失敗**）
- 原因: テスト Base に **provider 後に書くフィールドが不足**（`FIELD_MISSING`）。
  Meta API は canary PAT では 403 のため、欠落フィールド名は未確定（UI 目視が必要）

**恒久対策（本ブランチで実装）**

1. **送信前 schema preflight** — `REQUIRED_PROVIDER_RESULT_FIELDS` の存在を lock/PATCH/送信より前に
   read-only プローブ（List Records の `fields[]` 422 判定）で検証。欠落・判定不能は fail closed。
   Meta API 権限に依存せず、本番レコードへ試験書込みもしない。カナリアと通常 worker で同一契約
2. **provider 受理後の state write 失敗処理** — 結果 PATCH 失敗時に `unknown_after_attempt` を維持し、
   `providerAccepted` / `autoResend:false` / `needsReconcile:true` を返す。自動再送しない。
   ログから `recordId` を削除

**当時（2026-07-20）の未実施項目 → いずれも解消済み**

- **テスト Record の cleanup**（推奨は案 A: 監査保存 = accepted / Sent=true / AcceptedAt=実行時刻 /
  FailureStage=state_write_failed / token・lease クリア / IdempotencyKey 保持）。
  **単純な pending 戻しは再送リスクのため不可** → **方針どおり accepted 監査終端で運用中**
  （2026-07-21 境界B / 2026-07-22 カナリア再検証）
- テスト Base への不足フィールド追加（S1 の 14 フィールドとの突合）→ **完了**。
  2026-07-22 の read-only プローブで、provider 結果 6 / lease・fencing 4 / reconciler 参照ぶんを含む
  **契約フィールド全 13 個の存在を確認**（送信後 PATCH 422 は再発していない）
- 本 PR の merge / production deploy → **完了**

### 決済メール v2 / D1 前提実装 B1・B2（2026-07-21・branch `feat/payment-email-v2-dispatch-schedule`）

cutover の env フリップだけでは「顧客に確認メールが届く」状態に到達できない（worker トリガー未配線・
reconciler schedule 未配線）ため、その 2 件を実装。**production 未反映・env 変更 0・実顧客送信 0**。

- **B1 dispatcher**: Netlify Scheduled Function（5 分）+ 認証済み手動 POST。pending を限定取得し
  worker コアへ同一プロセスで渡す。gate が v2-worker/v2-full 以外は 0 送信（legacy/dry-run/A2 未確認で送らない）。
  dispatch ロック + record 単位 lock/fencing の二重防御。1 実行 10 件上限。PII 非出力。
- **B2 reconciler schedule**: `cron-payment-email-reconciler.js`（15 分）を追加。既存手動 POST は不変更。
  v2-full のときだけ write、それ以外 dry-run。reconcile ロックで重複起動防止。
- Airtable Automation を新依存にしない方針（A2 と新 Automation の同時管理を避ける）。
- **Scheduled 呼出契約を Netlify 公式仕様に整合**（2026-07-21 補正）: 公開 URL 不可 → dispatcher を
  Scheduled 専用化し URL POST 認証分岐を削除、手動は UI「Run now」。**30 秒上限**対応で dispatcher
  上限 10→**3 件** + **deadline guard 25 秒**、reconciler も 10 件上限 + deadline guard。
- guard/unit test 追加・更新。`test:bank-payment` 200 pass / `check:safety` exit 0 / build 成功。

**次工程**: D1 cutover 本体（境界 A→D）。**高リスク・要承認**（A2 OFF / gate 変更 / worker 有効化 / 実顧客送信）。

### D1 境界A 完了（2026-07-21・v2-dry-run 移行）

- 入口停止（A1 OFF）→ pending 0 確認 → A2 OFF（MK 目視）→ env 5 本を v2-dry-run 構成へ
  （Production/Functions のみ）→ Build Hook 1 回で redeploy（published `6a5ec2b9` / commit `cdf69b9`）。
- gate mode = **v2-dry-run**（worker 送信不可・reconciler 書込み不可）。**実顧客送信 0 / Airtable 書込み 0**。
- Scheduled は no-op（dispatcher=not_sending_mode 先行 return / reconciler=dryRun）。
- rollback: FLOW_VERSION=legacy + redeploy。A2 は再 ON しない。
- **次工程は境界B**（新 IdempotencyKey カナリア 1 件・要承認）。cutover 未完了。

### D1 cutover 完了（2026-07-21・v2-full 稼働）

境界 A→B→C→A1 再開→D を実施し、入金確認メール v2 を **v2-full で本番稼働**。

- **PR #147 merged**（`2d501ed`）。境界B カナリア成功（実受信 1 通・support@keiba.link）。
- 境界C: worker 有効化（gate=v2-worker）→ A1 再開（A2 OFF 維持）→ 境界D: reconciler write 有効化。
- **最終 gate=v2-full** / published `6a5f0de0`（commit `2d501ed`）/ A1 ON / A2 OFF /
  dispatcher `*/5`（3 件・deadline 25s）/ reconciler `*/15`（10 件・deadline 25s）/ 送信元 support@keiba.link。
- 本番 pending/unknown/attempting **0**。**実顧客誤送信 0 / 二重送信 0 / 本番 Customers 破損 0**。
- **Event Webhook（S9）は別 Phase・未実施**（SendGrid 署名検証キー + 管理画面設定が必要）。
- **legacy noreply 経路**（confirm legacy 分岐 / send-payment-confirmation-auto）は残課題（別タスク）。
- rollback（未実施・有効）: GLOBAL_PAUSE=true → redeploy、または FLOW_VERSION=legacy。

**D1 cutover は完了。次 Phase 候補: Event Webhook（delivered/bounce 反映）。**

### Webhook fail closed 化（Phase 0）+ legacy noreply 整理（2026-07-21・branch `feat/sendgrid-webhook-fail-closed`）

次 Phase の依存関係を read-only 調査した結果、**S9 Event Webhook は現行運用上は不要**と判定
（状態機械は `accepted` で終端し `decideWebhookEvent()` は実装済み・本番 pending/unknown/attempting は 0・
新規 secret と SendGrid 管理画面操作にブロックされる）。一方、S9 が触る `sendgrid-webhook.js` に
**Payment Email v2 とは無関係の既存欠陥**を検知したため、これを先に処理した。

- **検知**: `sendgrid-webhook.js` が**署名検証・認証なしで公開稼働**。第三者が 1 回 POST するだけで
  任意アドレスを `EmailBlacklist`（`newsletter-preview.js` が配信除外に使う実運用 suppression list）へ
  HARD_BOUNCE 登録でき、**任意顧客をメルマガ配信対象から恒久除外**できた。
  併せて formula injection（未エスケープ入力の `SEARCH()` 直挿し）と PII ログ出力も検知。
- **対処（コードのみ・env 追加なし）**: 署名検証の単一源 `src/lib/webhooks/sendgridSignature.js` を新設し、
  Function を fail closed 化（**鍵未設定も含め検証失敗は全て 403** / 検証成功後にのみ body を parse /
  検証前に Airtable へ到達しない / `airtableFormula.js` 経由で injection 遮断 / ログから email 除去）。
- **legacy noreply 整理**: `confirm-bank-payment.js` legacy 分岐と `send-payment-confirmation-auto.js` を
  `senderIdentity.js` へ移行。**gate=legacy へ rollback しても送信元は support@keiba.link**。
- **テスト**: `npm run test:webhooks` 新設（30 テスト）＋ sender guard に legacy 経路 5 テスト追加。
  `check:safety` へ組込み、`safety-check.yml` に個別 step として `test:webhooks` / `test:bank-payment` を追加。
- **検証結果**: `npm run check:safety` 全 21 ステップ green（最終 469 tests / fail 0）・`npm run build` 成功。
- **本番影響**: **2026-07-22 に read-only で確定**。`GET /v3/user/webhooks/event/settings/all` = HTTP 200 /
  **登録済み Event Webhook 0 本**（`max_allowed=2`）、Netlify の `SENDGRID_WEBHOOK_VERIFICATION_KEY` も**未設定**。
  → 本変更を本番へ入れても **機能損失ゼロ**（届いていないものを 403 にするだけ）で、**env 投入は前提ではない**。
  間接証拠（`EmailBlacklist` の webhook 由来レコードが 2025-09-21〜23 の 7 件のみで以降 10 ヶ月間 0 件）とも整合。
  当初「未登録／無効をユーザー確認済み」と記載 → 2026-07-22 の監査で一度撤回（未確認だったため）→
  **同日 API で確認し直して確定**、という経緯。
- **監査で追加した是正（2026-07-22）**: ① timestamp 許容窓 10分→24時間（SendGrid のリトライを取りこぼさない・
  env `SENDGRID_WEBHOOK_MAX_SKEW_SEC` で調整可）② Email 照合を `LOWER(TRIM())` 正規化へ（重複レコード防止）
  ③ 既存レコード検索の失敗を「未登録」と混同しない fail closed（一時障害での重複作成を防ぐ）。
- **本 branch では Function 呼出・メール送信・Airtable 書込み・production deploy を一切行っていない。**

### 初の実顧客通過（2026-07-22・v2-full の本番実証）

cutover 後、**初めて実顧客 1 件が v2 経路を端から端まで通過**した（カナリアではなく本番 Customers・実メール）。

- ケース: 既存 Light 会員（Monthly / active / 有効期限は経過済み）が銀行振込で **Premium Annual** へ乗り換え。
- **MK の手動操作は `PaymentConfirmed` チェック 1 回のみ**。以降は A1 → confirm（v2 分岐）→ dispatcher（`*/5`）
  → worker が自律実行し、**メール 1 通**（`support@keiba.link`）で `PaymentEmailStatus=accepted` に終端。
- **実証された不変条件**: 単一送信経路（A2 OFF のため旧設計なら 2 通だった経路で 1 通）/ 冪等性
  （`Requested*` クリアにより再チェックで二重延長しない）/ **legacy の `PaymentEmailSent=true` が残っていても
  v2 は影響を受けない**（dispatcher は `PaymentEmailStatus` のみで対象選択）/ 送信元契約。
- 記録は **read-only の Airtable GET のみ**で作成（書込み 0 / Function 直接呼出 0 / 手動メール送信 0 / deploy 0）。
  顧客の Email / 氏名 / recordId は記録しない。
- 詳細と運用メモ（同種問い合わせへの回答・やってはいけない操作）は
  `astro-site/docs/PAYMENT_EMAIL_V2.md` §初の実顧客通過記録 が単一源。

### カナリア再検証（2026-07-22・PAT / secret ローテーション後）

カナリア経路の認証情報を 2 つとも更新したため、**新しい認証情報で経路が通ること**を再検証した。
**コード変更 0 / gate env 変更 0 / 本番 Customers 非接触 / 実顧客送信 0。**

- **ローテーション**: カナリア専用 Airtable PAT を **Regenerate**（旧値失効）、`PAYMENT_CANARY_SECRET` を
  **ローテーション**。いずれも Netlify **Production / Functions** のみへ差し替え。値は MK のみが保持し、
  会話・ログ・git・docs に残さない（検証は presence / context / scope / `updated_at` のみ）。
- **env は deploy 後にしか runtime へ反映されない**ため、毎回
  **env の `updated_at` < published deploy の `published_at`** を確認して機械的に判定した。
  Build Hook（`analytics-keiba-auto-deploy` / branch=main）は **反映対象ごとに 1 回だけ**実行。
  いずれも commit `238db1c` の**コード差分ゼロ deploy**（60 functions / env キー総数 35 は前後不変）。
  最終 published deploy = **`6a6076887f64ee0008a1cac0` / `238db1c` / ready**。
- **認証失敗 403 は送信処理に到達しない**ことを実測で確認（secret-first fail closed）。
  旧 runtime への 2 回の POST は 403 で終わり、Record は `pending` / `AttemptCount=0` / lease・token 空のまま
  **完全に不変**。試行回数も IdempotencyKey も消費していない。
- **最終カナリアは exactly once で成功**。専用 Base / Table / Record 1 件（allowlist exactly-one・テスト Base の
  Automation ON=0 件を UI 目視）に新 IdempotencyKey で `pending` 初期化 → 応答
  `ok=true / status=accepted / providerAccepted=true` → **メール 1 通を実受信**
  （`support@keiba.link` / `238db1c`＝PR #151 のログイン導線付き本文）。
- **cleanup は `PaymentEmailLeaseUntil` / `PaymentEmailAttemptToken` の 2 項目のみ**（PATCH 1 回）。
  worker は Upstash ロックしか解放しないためこの 2 つが残るのは仕様どおり。
  **`pending` へは戻さず accepted 監査終端を維持**（status / AttemptCount / Sent / ProviderMessageId /
  AcceptedAt / IdempotencyKey は read-back で不変を確認）。
- **二重送信なし / 送信後 PATCH 422（2026-07-20 事故）の再発なし / 本番 Customers 書込み 0。**
- **PR #149 は Draft 維持**。凍結理由だった「SendGrid 側の Event Webhook 登録状況・署名検証キーが未確認」は
  **2026-07-22 の read-only 調査で解消**（登録 0 本 / 鍵未設定を確認）。以降は
  §Webhook fail closed 化（Phase 0）の deploy 順序に従う。Event Webhook の作成・有効化は
  **別 Phase・別承認境界**であり、本作業の承認に混ぜない。
- 詳細は `astro-site/docs/PAYMENT_EMAIL_V2.md` §カナリア再検証（2026-07-22）が単一源。

### S9 Phase 0 本番反映 + Event Webhook 有効化（2026-07-22 完了・organic event 実証待ち）

**署名検証なしの公開受信窓を閉じ、Event Webhook を有効化した。実顧客メール送信 0 / 手動 Airtable 書込み 0 /
本番 Customers 接続 0。**

- **PR #149 を squash merge**（merge commit **`137a348`**）→ production 反映
  （published **`6a609fe22791d800080c2ff0`** / ready）。CI safety-check success。
- 実施順序は「**コードを先に本番へ → その後 SendGrid 側を作成・有効化**」を厳守
  （逆順にすると署名検証を持たない受信窓が晒される）。
- SendGrid「AK Event Webhook」= **enabled=true / signed=true** / Post URL 一致 /
  対象は **bounce・dropped・spam_report・unsubscribe のみ**（`delivered` ほかは false。S9 本体が
  未実装のため意図的に選ばない）。
- `SENDGRID_WEBHOOK_VERIFICATION_KEY` = **Secret=true / Functions scope / Production のみ**・
  **runtime 反映済み**（env の `updated_at` < deploy の `published_at` で機械的に判定）。値は残さない。
- **Test Integration は実施しない方針**。テスト payload が署名検証を通ると本番 `EmailBlacklist` に
  ダミーが作られうる（`EmailBlacklist` は `newsletter-preview.js` が使う実運用 suppression list）。
  → **organic event（実バウンス）で実証**する。実バウンスの記録は汚染ではなく復旧目的そのもの。
- **鍵一致の E2E 実証は未完了**。到達 0 件。env は Secret 化済みで値の再照合は不可、
  署名の自作も不可（SendGrid 側の秘密鍵が必要）。未署名 403 は鍵の正しさを証明しない。
- **baseline（判定基準 / read-only 取得）**: Function 到達 **0 件（24h）** /
  `EmailBlacklist` **11 件**（HARD_BOUNCE 4 / SOFT_BOUNCE 7 / `BounceCount` 合計 **16** /
  2026 年の新規 **0**）。
- **異常時**: `signature_mismatch` / `verification_key_invalid` が**継続**したら
  **SendGrid 側で Enable endpoint を直ちに OFF**（最大 24h のリトライを止める）。
  fail closed のため誤書込みは発生しない。Netlify 側の変更は不要。
- **次回確認は read-only 比較のみ**: `netlify logs --source functions --function sendgrid-webhook --since 24h`
  ＋ `EmailBlacklist` の 総件数 / Status 内訳 / `BounceCount` 合計（メールアドレス・recordId は出力しない）。
- **S9 本体（`accepted` → `delivered` 反映）は未実装・別 Phase**。本 Function は `EmailBlacklist` のみを扱い、
  Payment Email の状態は 1 バイトも書かない。
- 詳細は `astro-site/docs/SENDGRID_WEBHOOK.md` §Phase 0 本番反映・Webhook 有効化 完了記録 が単一源。

## Remaining

- ~~入金確認メール v2 の cutover（D1）~~ → **2026-07-21 に完了・gate=v2-full で本番稼働中**
  （§D1 cutover 完了 / §初の実顧客通過 / §カナリア再検証）。**Remaining ではない。**
- **S9 Event Webhook 本体**（`custom_args` 照合による `accepted` → `delivered`/`bounced`/`dropped` 反映・
  イベント冪等・out-of-order）。**未実装**。Phase 0（署名検証 fail closed）は完了しており、
  署名検証の単一源・検証鍵・Webhook 有効化まで済んでいるため**新規 secret も新規モジュールも増えない**。
  実装時は `delivered` イベントの選択追加（現在は false）と、`decideWebhookEvent()` の配線が必要
- ~~Webhook fail closed 化（Phase 0）の本番反映~~ → **2026-07-22 完了**（PR #149 merge `137a348` /
  published `6a609fe22791d800080c2ff0`）。**Remaining ではない**
- **Phase 0 の鍵一致 E2E 実証**: organic event（実バウンス等）の到達待ち。**到達 0 件**。
  次回確認は Function ログと `EmailBlacklist` 件数の read-only 比較のみ（baseline は §S9 Phase 0 記載）
- ~~入金確認メール v2 の legacy noreply 経路の是正~~ → **2026-07-22 完了**（PR #149 で
  `confirm-bank-payment.js` legacy 分岐 / `send-payment-confirmation-auto.js` を `senderIdentity.js` へ移行・
  main 反映済み）。gate を legacy へ rollback しても送信元は `support@keiba.link`
- `/admin/send-payment-confirmation`（+ `send-payment-confirmation.js`）と `paypal-webhook.js` の
  **410 Gone / redirect 化**。**未実施**。両経路とも運用上未使用のため実害は無いが到達可能で、
  誤操作すると自前送信が走る（`PaymentEmailSent` を立てないため、A2 を再 ON した場合は 2 通になる）。
  両者に残る `FROM_EMAIL`（noreply）も、410 化と**同時に**処理する（送信元だけ差し替える半端な修正はしない）
- `docs/dark-horse-picks-stability-plan.md` の Phase 3 以降（穴馬抽出ロジック改善・表示改善）。同文書は「実装未着手」のまま
- `check:prediction-integrity`（検査対象 0 件で失敗する既存問題）の原因調査 →
  `check:jra-nankan-parity` とあわせて `safety-check.yml` へ組込（`CLAUDE.md` PR-K・低優先度）
- 旧ドメインから `analytics.keiba.link` への 301 切替の完了確認（`README.md` は「移行中」表記のまま / 未確認）
- 滞留ブランチの棚卸し（正確な本数は 未確認。作業時に `git branch -a` で数えること）
- `verify-project.sh` が旧プロジェクト由来の期待値（旧パス・旧 remote）のままである点の是正または明示的な廃止

## Next Actions

新しいセッションが最初に行うべき順序。

1. `docs/spec.md` → 本書 → `docs/decisions.md` → `CLAUDE.md` を読む。
2. `git status --short && git log --oneline -10` で現在地を確認する。
   メイン checkout に未コミット変更が残っていた場合は、**ユーザーの作業中変更として扱い、
   勝手に commit / stash / reset しない**。
3. 作業対象を決める前に `gh pr list --state open` で滞留 PR を確認する。
4. コードを触る場合は `cd astro-site && npm ci` の要否を確認し、`npm run check:safety` をベースラインとして先に実行する
   （既存失敗を「今回の退行」と誤認しないため）。
5. 予想表示・馬分類に関わる修正は `docs/spec.md` §8 の完成条件（4 領域 / UI は 6 経路）を満たすまで完了扱いにしない。
6. 各 Phase 完了時に本書を更新する。

## Blockers

- 現時点で本ドキュメント基盤 PR に対する blocker はない。
- ~~コード側の実質的 blocker: 入金確認メール v2 の cutover~~ → **2026-07-21 に完了**（v2-full 稼働・解消済み）。
- S9 Event Webhook 本体の**有効化**は SendGrid 管理画面での Event Webhook 登録 + Verification Key 発行 +
  Netlify env 投入（いずれも**ユーザー操作の高リスク境界**）を要するため、明示承認なしに実行できない。
  ただし **Phase 0（署名検証 fail closed）はコードのみで完了済み**（PR #149・main 未反映）であり、
  S9 実装自体はブロックされない。
- 併せて、本番メール送信・本番 Airtable 書込み・production deploy・env 変更は引き続き
  **ユーザーの明示承認なしに実行しない**（`CLAUDE.md` §High-risk approval boundary）。

## Open Questions

1. **ユーザーのメイン checkout に残る作業中変更をどう扱うか**（2026-07-20 観測）。変更内容が作業ブランチ名の
   範囲を大きく超えており、分割コミット方針・rebase 要否とも未確定。**本 docs PR のスコープ外。**
2. ~~入金確認メール v2 は現在どこまで本番有効か~~ → **解決済み**。**2026-07-21 に D1 cutover 完了・gate=v2-full 稼働**
   （A1 ON / A2 OFF / dispatcher `*/5` / reconciler `*/15` / 送信元 support@keiba.link）。
   2026-07-22 に**実顧客 1 件の本番通過**と、**PAT / secret ローテーション後のカナリア再検証**も完了。
   未着手として残るのは **Event Webhook（S9）と legacy noreply 経路**のみ（§Remaining）。
   > 参考（当時の記録・現在は該当しない）: 2026-07-20 時点の gate は `legacy` で、confirm は legacy 経路、
   > 通常 worker / reconciler は無効、カナリアも未送信だった。コードは deploy 済みだが gate で止まっていた。
3. open PR #25（2026-05-26 起票）は生かすのか閉じるのか。長期滞留の判断記録が無い。
4. `nankan-stripe-integration/` は本番で稼働しているのか休止中なのか。証拠未確認。
5. 旧ドメインからの 301 切替は完了しているのか。`README.md` の「移行中」表記が更新されていない。
6. `CLAUDE.md` §移行タスク（初期セットアップ）7 項目の最新完了状況。
   （`NEXT_SESSION.md` は文書内の「最終更新」表記が 2026-04-14 のまま。以降の内容更新は 未確認）
7. `astro-site/astro-site/package-lock.json` の入れ子 lockfile が追跡下にある理由。意図的な残置か事故かは
   証拠未確認。3 つとも npm 形式のため形式矛盾は無いが、**独断で削除しない**（`CLAUDE.md` §Package manager）。
8. `verify-project.sh` は旧プロジェクト由来の期待値（旧パス・旧 remote）を検証しており、本リポジトリでは
   常に失敗する。意図的な残置か放置かは証拠未確認。

## High-risk Operations

高リスク操作の一覧は **`CLAUDE.md` §High-risk approval boundary が単一源**（本書では重複記載しない）。

- **ドキュメント基盤 PR #143（2026-07-20）**: 高リスク操作を **一つも実行していない**。ユーザーのメイン
  checkout へも書込まず（作業は分離 worktree）、変更は文書 4 ファイルのみ。
- **2026-07-21〜22 の入金確認メール v2 作業**: cutover・env 変更・production deploy（Build Hook）・
  実顧客へのメール送信は、**いずれもユーザーの明示承認を都度取得したうえで実施**した
  （§D1 cutover 完了 / §カナリア再検証）。本 PR（#150）の変更自体は **docs のみ**で、
  コード・env・workflow・lockfile は未変更。

## Repository State

- **Repository**: `analytics-keiba` / **Origin**: `https://github.com/apol0510/analytics-keiba.git`
- **Branch（初版時）**: `docs/autonomous-project-workflow`（`origin/main` から分岐 / PR #143）。
  変更範囲は `CLAUDE.md` / `docs/spec.md` / `docs/progress.md` / `docs/decisions.md` の 4 ファイルのみ。
- **Branch（PR #150 / merged 2026-07-22）**: `docs/payment-email-v2-first-production-case`。
  変更範囲は `astro-site/docs/PAYMENT_EMAIL_V2.md` / `docs/progress.md` の **docs 2 ファイルのみ**。
- **Branch（本更新時 / PR #149・Draft）**: `feat/sendgrid-webhook-fail-closed`。
  変更範囲は `astro-site/src/lib/webhooks/**`（新規）/ `astro-site/netlify/functions/sendgrid-webhook.js` /
  `confirm-bank-payment.js` / `send-payment-confirmation-auto.js` / `paymentEmailSender.guard.test.mjs` /
  `astro-site/package.json`（script 追加のみ）/ `.github/workflows/safety-check.yml` / docs。
  **lockfile は未変更。** 2026-07-22 に `origin/main` を通常 merge して docs 2 ファイルの競合を解消。
- 作業はいずれも**分離 worktree** で実施（ユーザーのメイン checkout へは書込まない。
  未コミット変更はユーザーの作業中変更として保全）。
- メイン checkout の状態は §In Progress を参照（point-in-time 観測。本書に固定記載しない）。
- **Last verified**: 2026-07-22
