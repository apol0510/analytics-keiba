# 自律完遂運用（Autonomous Delivery Workflow）

> CLAUDE.md から集約（2026-08-13）。**運用の正本はこのファイル**。


Claudeは本プロジェクトにおいて、単なる調査担当や途中監査担当ではなく、完成条件まで進める実装担当として行動する。

本節は既存ルールを**置き換えない**。本節と既存節の記述が競合する場合は、
**既存節（🚨 AI作業ルール / 🧭 修正対象範囲ルール / 🛡️ CI Safety Check / 🌐 本番 URL ルール ほか）の記述を優先**する。

### Canonical documents

作業開始時に必ず次を読む。

- `docs/spec.md` — 仕様の正本
- `docs/progress.md` — 進捗の正本
- `docs/decisions.md` — 設計判断の正本
- `CLAUDE.md`（本ファイル） — 運用ルールの正本

各ドメインの詳細仕様は従来どおり `astro-site/docs/*.md`（`PREDICTION_LOGIC.md` / `BET_POINT_LOGIC.md` /
`AUTH_LOGIN.md` / `PAYMENT_EMAIL_V2.md` / `PREMIUM_PLUS.md` / `SAFETY_CHECKS.md` 等）と
`docs/*.md`（`ui-cross-plan-regression-policy.md` / `MEMBER_TIERS.md` / `PAYMENT_SYSTEM.md` 等）が正本である。
`docs/spec.md` はそれらを置き換えず、責務境界と全体像のみを定義する。

仕様・進捗・設計判断が競合する場合は、勝手に推測せず、git履歴と実装証拠を調査して整合させる。
整合できない矛盾は `docs/progress.md` の Open Questions に記録する。

### Continuous execution

次の低・中リスク工程は、重大停止条件がない限り、中間承認なしで連続実行する。

- read-only調査 / 設計 / 実装
- unit test / integration test / lint / typecheck / 非本番build
- 文書更新 / 通常commit / 通常push / Draft PR作成
- PR差分の自己監査 / 可逆的な修正 / テスト失敗の原因修正

コード、git履歴、既存文書、テストから判断できる内容を、ユーザーへ質問しない。小さな判断や軽微な不明点ごとに停止しない。
「一旦停止します」「承認をください」を繰り返さない。同一HEAD・同一差分・同一テスト結果を理由なく何度も再監査しない。

ただし §🚨 AI作業ルール の「作業開始時に必ず明示（目的 / 変更対象ファイル / 完了条件）」と
§🧭 修正対象範囲ルール の対象範囲明記義務は、連続実行中も省略しない。

**連続実行の範囲限定（本節は無制限の権限を与えるものではない）**

- 「通常push」は本タスクの作業branchへの push のみを指す。`main` / `master` への直接 push を許可するものではない。
- 「テスト失敗の修正」は、本タスクの範囲内で原因が明確に特定でき、かつ後方互換性を壊さない場合に限る。
  原因不明・範囲外・互換性に影響する場合は停止する。
- 「Draft PR 作成まで自律実行」は、PR merge および本番反映の事前承認を意味しない。
- 作業中に本タスクの範囲外の不具合（着手前から存在する失敗テスト・既存バグを含む）を発見しても、
  勝手に修正しない。`docs/progress.md` へ記録して報告し、修正可否はユーザー判断を仰ぐ。
  範囲外の既存不具合を自分の変更による regression として扱わない。

### High-risk approval boundary

次の操作は、直前でのみ停止し、実施内容・対象・影響・rollback手順・検証結果を一括報告する。

- production deploy / production環境変数またはsecret変更
- 本番メール・LINE・通知の送信
- 本番DB・Airtable・Redis・Blob・外部APIへの書込み
- 共通データリポジトリへの本番PUT / workflow dispatch
- package公開・registry公開（npm publish等）
- production reader・transport・モデル・artifact・champion・datastoreの切替
- PR merge / データ削除 / rollback困難なmigration
- force push / reset / rebase / amend / 履歴改変
- 課金・契約・会員権限への本番変更

高リスク操作に到達する前の安全な工程は完了させる。

本リポジトリでの具体例: 入金確認メール v2 の cutover、`PAYMENT_CONFIRM_SECRET` 等の env 投入・解除、
Netlify Build Hook 実行、Airtable Automation の変更、Netlify Blobs への本番アップロード、
`import-*` workflow の手動 dispatch。

### Immediate stop conditions

次の場合は即時停止する。

- secret・token・認証値が出力される可能性（§🔐 PAYMENT_CONFIRM_SECRET の「値を絶対に記載しない」を含む）
- 対象外リポジトリまたは対象外ファイルへの予期しない変更
- 本番データ破損の可能性 / 二重送信または重複実行の可能性 / rollback不能
- 現行API・schema・consumer contractの破壊（旧フォーマット復活、±1日マージ削除、中身date検証ガード無効化を含む）
- origin・branch・HEAD・対象日・会場・件数等の前提不一致
- 未知の既存変更との競合 / merge conflict
- test・lint・typecheck・buildの失敗を安全に解消できない（safety check の一時無効化は §🛡️ CI Safety Check により禁止）
- 別リポジトリの仕様を誤って適用する可能性（特に `keiba-intelligence` / `keiba-data-shared-admin`）

### Repository isolation

複数プロジェクトを扱う場合も、各リポジトリを独立して扱う。変更前に必ず次を確認する。

```
pwd
git rev-parse --show-toplevel
git remote get-url origin   # 本リポジトリは https://github.com/apol0510/analytics-keiba.git
git branch --show-current
git rev-parse HEAD
git status --short
```

別リポジトリの変更が必要な場合は、現在のリポジトリから勝手に移動して同時変更せず、
依存変更として `docs/progress.md` へ記録する。
横断変更が明示的に承認されたタスクでは、リポジトリごとに独立したbranch・commit・Draft PRを作成する。

これは §keiba-intelligence との関係（独立運用、2026-05-23〜）の「自動的に横展開しない」方針と同一の考え方である。

### Package manager

- package manager は各リポジトリの正本に従う。全リポジトリ一律の npm / pnpm 強制はしない。
- 正本の優先順位:
  1. `package.json` の `packageManager` フィールド
  2. lockfile
  3. CI / workflow / deploy 設定
  4. 既存の明示的なプロジェクト固有ルール
- `package-lock.json` のみ → npm / `pnpm-lock.yaml` のみ → pnpm / `yarn.lock` のみ → yarn。
- 複数 lockfile が併存する場合、または文書と実装・CI・lockfile が矛盾する場合は、
  **依存変更を停止**し `docs/progress.md` へ記録する。どちらか一方を勝手に削除・変換しない。
- lockfile を無断で別形式へ変換しない。
- `npm install` / `pnpm install` 等を一律禁止も一律許可もしない。上記正本に従って判断する。

本リポジトリの現状（2026-07-20 確認）: `packageManager` フィールドは未設定。追跡下の lockfile は
`astro-site/package-lock.json` / `nankan-stripe-integration/package-lock.json` /
`astro-site/astro-site/package-lock.json` の 3 つで **いずれも npm 形式**。CI（`.github/workflows/*.yml`）は
`npm ci`、`netlify.toml` は `npm run build`。したがって本リポジトリの正本は **npm** であり、
pnpm / yarn を要求する既存ルールは存在しない（形式の矛盾なし＝依存変更の停止条件には該当しない）。
ただし `astro-site/astro-site/` の入れ子 lockfile は意図不明のため `docs/progress.md` の
Open Questions に記録する。**独断で削除しない。**

### Progress maintenance

- 作業開始時と各Phase完了時に `docs/progress.md` を更新する。
- 重要な設計判断を行った場合は `docs/decisions.md` を更新する。
- 仕様変更が承認された場合のみ `docs/spec.md` を更新する。
- 予想ロジック・購入点数などの詳細仕様を変更した場合は、従来どおり
  **コードと対応する `astro-site/docs/*.md` を必ず両方更新**する。

### Completion report

最終報告の書式は §完了報告の簡潔化 を primary とする。**重複して別書式で書き直さない。**
同節の必須項目（判定 / 実施内容 / 変更ファイル / テスト結果 / Git状態 / 異常・未確定事項 / 次工程案）に加えて、
自律完遂運用では次の3点を必ず含める。

1. 未実施の高リスク操作
2. 次に必要な承認
3. `docs/progress.md` の現在地

「Git状態」には branch / commit / Draft PR URL を含める。「異常・未確定事項」には blocker を含める。
