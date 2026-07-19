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

- **作業ツリー上の未コミット変更（38 ファイル）**: メイン checkout `/Users/user/Projects/analytics-keiba` が
  ブランチ `fix/premium-plus-admin-secret-normalize`（HEAD `08edc5a`、`origin/main` から **33 commits behind / 0 ahead**）
  の上に未コミットのまま置かれている。内容は決済メール v2 / entitlements / contact autofill / 各予想ページの横断修正など。
  **本 PR の対象外であり、一切触れていない。**
- 未追跡の新規実装: `astro-site/src/lib/entitlements/`（`resolveEntitlements.js` + テスト）、
  `astro-site/src/lib/payments/paymentEmailDeps.canary{,.guard}.test.mjs`、
  `astro-site/scripts/prune-ssr-function-data.mjs`
- **未マージの open PR（3 件、2026-07-20 時点）**
  - #130 PR-A: 有料セッション共通ライブラリ（署名 Cookie）とテスト — `session-lib-pr-a`
  - #128 認証脆弱性の修正 + 問い合わせフォームの氏名/メール自動入力 — `worktree-secure-auth-and-contact-autofill`
  - #25 premium 本命/対抗/単穴に過去走表示を追加 — `feat/premium-jra-recent-races`（2026-05-26 起票、長期滞留）

## Remaining

- 入金確認メール v2 の cutover（D1 手順：入口停止 → Automation A2 OFF 目視 → v2 deploy → カナリア1件 → 段階有効化）。**高リスク・未実行**
- `paypal-webhook.js` / `send-payment-confirmation.js` の二重送信リスク修正（現在は両経路未使用のため実害なしと記録されている）
- `docs/dark-horse-picks-stability-plan.md` の Phase 3 以降（穴馬抽出ロジック改善・表示改善）。同文書は「実装未着手」のまま
- `check:prediction-integrity`（検査対象 0 件で失敗する既存問題）の原因調査 →
  `check:jra-nankan-parity` とあわせて `safety-check.yml` へ組込（`CLAUDE.md` PR-K・低優先度）
- `nankan-analytics.keiba.link → analytics.keiba.link` の 301 切替完了確認（`README.md` は「移行中」表記のまま）
- 滞留ブランチ（ローカル 80+ / remote 多数）の棚卸し
- `verify-project.sh` が前身プロジェクト `nankan-analytics` の期待値のままである点の是正または明示的な廃止

## Next Actions

新しいセッションが最初に行うべき順序。

1. `docs/spec.md` → 本書 → `docs/decisions.md` → `CLAUDE.md` を読む。
2. `cd /Users/user/Projects/analytics-keiba && git status --short && git log --oneline -10` で現在地を確認する。
   ブランチが `fix/premium-plus-admin-secret-normalize` のままで 38 ファイルが未コミットなら、
   **ユーザーの作業中変更として扱い、勝手に commit / stash / reset しない**。
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

1. **メイン checkout の未コミット 38 ファイルをどう扱うか。** ブランチ `fix/premium-plus-admin-secret-normalize` は
   `origin/main` から 33 commits behind で、変更内容はブランチ名（premium-plus admin secret 正規化）を大きく超えて
   決済メール v2 / entitlements / contact autofill / 予想ページ横断修正に及ぶ。分割コミット方針・rebase 要否とも未確定。
   **本 docs PR のスコープ外。**
2. 入金確認メール v2 は現在どこまで本番有効か。状態機械コア・IO 側・カナリア分離までは main にあるが、
   cutover（D1）実行の記録は見当たらない。証拠未確認。
3. open PR #25（2026-05-26 起票）は生かすのか閉じるのか。長期滞留の判断記録が無い。
4. `nankan-stripe-integration/` は本番で稼働しているのか休止中なのか。証拠未確認。
5. `nankan-analytics.keiba.link` からの 301 切替は完了しているのか。「移行中」表記が更新されていない。
6. `CLAUDE.md` §移行タスク（初期セットアップ）7 項目の最新完了状況（`NEXT_SESSION.md` は 2026-04-14 で更新停止）。

## High-risk Operations Not Yet Executed

本 PR では以下を **一切実行していない**。

- production deploy / Netlify 本番ビルド起動 / Build Hook 実行
- production 環境変数・secret の設定・変更・削除
- 本番メール（SendGrid）・LINE・通知の送信
- 本番 Airtable / Upstash Redis / Netlify Blobs / 外部 API への書込み
- `workflow_dispatch` を含む GitHub Actions の手動実行
- PR merge / データ削除 / rollback 困難な migration
- force push / reset / stash / rebase / amend / checkout of existing branches / revert / 履歴改変
- npm publish / registry 公開
- メイン checkout（`/Users/user/Projects/analytics-keiba`）への一切の書込み

## Repository State

- **Repository**: `analytics-keiba`（作業は分離 worktree で実施。メイン checkout は `/Users/user/Projects/analytics-keiba`）
- **Branch**: `docs/autonomous-project-workflow`（`origin/main` から分岐）
- **HEAD**: `1aed7df98b2b2ffa2d32ac29c7e34a42f57d9fab`（= `origin/main`。`Daily auto-import: 2026-07-20 prediction [scheduled 23:00 JST]`）
- **Origin**: `https://github.com/apol0510/analytics-keiba.git`
- **Working tree**: 本ブランチは `docs/spec.md` / `docs/progress.md` / `docs/decisions.md` / `CLAUDE.md` の 4 ファイルのみ変更。
  メイン checkout はブランチ `fix/premium-plus-admin-secret-normalize`（HEAD `08edc5a` / origin/main から 33 behind・0 ahead）に
  38 ファイルの未コミット変更あり — **本 PR は未接触**。
- **Last verified**: 2026-07-20
