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

**Phase: ドキュメント基盤整備（初版） / 並行して決済メール v2 と entitlements 系が in-flight**

- 本 PR（`docs/autonomous-project-workflow`）は **文書のみ**。ソースコードの挙動は一切変更していない。
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

> 以下はいずれも **2026-07-20 時点の観測**であり、恒久仕様ではない。作業前に必ず現物を再確認すること。

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

**未実施（承認待ち）**

- **テスト Record の cleanup**（推奨は案 A: 監査保存 = accepted / Sent=true / AcceptedAt=実行時刻 /
  FailureStage=state_write_failed / token・lease クリア / IdempotencyKey 保持）。
  **単純な pending 戻しは再送リスクのため不可**
- テスト Base への不足フィールド追加（S1 の 14 フィールドとの突合）
- 本 PR の merge / production deploy

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

## Remaining

- 入金確認メール v2 の cutover（D1 手順：入口停止 → Automation A2 OFF 目視 → v2 deploy → カナリア1件 → 段階有効化）。**高リスク・未実行**
- `paypal-webhook.js` / `send-payment-confirmation.js` の二重送信リスク修正（現在は両経路未使用のため実害なしと記録されている）
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
- コード側の実質的 blocker: 入金確認メール v2 の cutover は **本番メール送信・本番 Airtable 書込みを伴う高リスク操作**であり、
  ユーザーの明示承認なしに実行できない。

## Open Questions

1. **ユーザーのメイン checkout に残る作業中変更をどう扱うか**（2026-07-20 観測）。変更内容が作業ブランチ名の
   範囲を大きく超えており、分割コミット方針・rebase 要否とも未確定。**本 docs PR のスコープ外。**
2. ~~入金確認メール v2 は現在どこまで本番有効か~~ → **2026-07-21 に v2-full 稼働（D1 cutover 完了）**。旧記録: 2026-07-20 時点は `legacy`
   （`validateEmailGates` violations=0）。confirm は legacy 経路、通常 worker / reconciler は無効。
   **cutover（D1）は未実施・カナリアも未送信**。コード（状態機械 / worker / reconciler / canary / 送信元契約）は
   deploy 済みだが、gate により本番送信経路としては動作していない。
3. open PR #25（2026-05-26 起票）は生かすのか閉じるのか。長期滞留の判断記録が無い。
4. `nankan-stripe-integration/` は本番で稼働しているのか休止中なのか。証拠未確認。
5. 旧ドメインからの 301 切替は完了しているのか。`README.md` の「移行中」表記が更新されていない。
6. `CLAUDE.md` §移行タスク（初期セットアップ）7 項目の最新完了状況。
   （`NEXT_SESSION.md` は文書内の「最終更新」表記が 2026-04-14 のまま。以降の内容更新は 未確認）
7. `astro-site/astro-site/package-lock.json` の入れ子 lockfile が追跡下にある理由。意図的な残置か事故かは
   証拠未確認。3 つとも npm 形式のため形式矛盾は無いが、**独断で削除しない**（`CLAUDE.md` §Package manager）。
8. `verify-project.sh` は旧プロジェクト由来の期待値（旧パス・旧 remote）を検証しており、本リポジトリでは
   常に失敗する。意図的な残置か放置かは証拠未確認。

## High-risk Operations Not Yet Executed

本 PR は **`CLAUDE.md` §High-risk approval boundary に列挙された高リスク操作を一つも実行していない**
（一覧は同節が単一源。本書では重複記載しない）。加えて、ユーザーのメイン checkout へは一切書込んでいない
（作業は分離 worktree で実施）。変更は文書 4 ファイルのみで、ソースコード・workflow・lockfile は未変更。

## Repository State

- **Repository**: `analytics-keiba` / **Origin**: `https://github.com/apol0510/analytics-keiba.git`
- **Branch**: `docs/autonomous-project-workflow`（`origin/main` から分岐 / PR #143）。作業は分離 worktree で実施。
- **本ブランチの変更範囲**: `CLAUDE.md` / `docs/spec.md` / `docs/progress.md` / `docs/decisions.md` の 4 ファイルのみ。
  ソースコード・workflow・lockfile は未変更。
- メイン checkout の状態は §In Progress を参照（point-in-time 観測。本書に固定記載しない）。
- **Last verified**: 2026-07-20
