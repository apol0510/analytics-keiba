# 自律完遂運用（Autonomous Delivery Workflow）

> CLAUDE.md から集約（2026-08-13）／共通作業ルールを追加（2026-09-18）。**運用の正本はこのファイル**。

## 共通作業ルール（2026-09-18 MK 既定化 / **ツール非依存・そのまま貼れる正本**）

> **この節が「毎回の途中確認をやめる」ための正本。** Claude / ChatGPT など**どのアシスタントでも
> 同じ文面をそのまま貼って使える**ように、ツール名を含めずに書く。
> 本ファイルの以降の節（2026-08-13 集約）と競合する場合は、**本節が優先**する。
> ⚠️ **2026-09-28**: `~/.claude/CLAUDE.md`（全プロジェクト共通運用「完成まで自律実行」）へ整合。
> 人間承認待ち・GPT 確認待ちでは停止せず、前提確認のうえ merge・本番反映・cleanup まで進める。

### 基本方針

ユーザーへの途中確認を最小化する。停止条件に該当しない作業は、1 工程ごとに確認せず、
**関連作業をまとめて最後まで進める**。

次のような途中確認は**不要**:
「これも直しますか？」「commit しますか？」「push しますか？」「PR を作りますか？」「CI を確認しますか？」

### 自律実行してよい範囲（確認不要）

read-only 調査 / repo 正本・現行コード・git・PR・CI の確認 / 原因調査 / 設計 / 実装・修正 /
**同一原因・同種の軽微な不整合の一括修正** / stale docs の整合 / test・lint・verify /
非本番 build / dry-run / docs 更新 / branch 作成 / commit / 通常 push /
Draft PR の作成・更新 / CI 確認 / 差分確認 / 作業 branch の cleanup

既定のフロー:

```text
調査 → 同種問題をまとめて修正 → test / verify → 必要な正本 docs 更新
 → commit → 通常 push → Draft PR → CI green 確認 → 最新 origin/main 取り直し → **merge**
 → 本番反映・実運用確認 → cleanup → progress 更新
```

### 前提確認してから実行するもの（承認待ちでは停止しない）

直前に対象・環境・件数・前提条件・rollback・検証方法を確認・記録してから実行する。確認できない場合は停止する。

- 本番 deploy
- env / secret の追加・変更・削除
- 実メール・実通知・実課金など**外部への実送信**
- DB / schema migration・schema 変更
- **PR merge**（直前に最新 `origin/main` を取り直す）

### 停止するもの（実異常）

- rollback 不能または復旧困難な操作
- **別 repo への変更が必要になった場合**
- 秘密情報露出の可能性
- 二重送信・二重課金などの危険
- 本番破損の可能性

**上記に該当したときだけ停止する。**

### 禁止

rebase / reset / force push / cherry-pick / `main` への直接 push / 指示なく別 repo を触ること

### スコープ

指定された repo だけを扱う。別 repo の問題を見つけても**変更せず**、最後に未完事項として報告する。

### 正本の優先順位

1. `docs/spec.md`（または `PROJECT_SPEC.md`）
2. `docs/progress.md`（または `PROGRESS.md`）
3. `docs/decisions.md`（または `DECISIONS.md`）
4. `CLAUDE.md`
5. 現行コード・テスト
6. git / PR / CI

ファイル名が違う場合は**実在するもの**を使う。**repo 内の正本を過去チャットより優先**する。
本リポジトリの実在ファイルは `docs/spec.md` / `docs/progress.md` / `docs/decisions.md` / `CLAUDE.md`。

### 作業判断

同一原因から生じている stale 記述・軽微な矛盾・関連テスト修正は、スコープ逸脱にならない限り
**個別確認せずまとめて解消する**。
過去の**歴史記録**と**現況記録**は混同せず、歴史的事実を壊さずに現在の正本との矛盾を解消する
（`superseded` / `deprecated` / `historical` を明示する）。

### 最終報告の型（**これが既定**）

長文の作業実況は書かない。原則として次だけを報告する。

- 実施
- 現状
- 未完
- ユーザーの手動作業
- 次の自動作業（ユーザー操作が不可避な場合のみ最小1操作）
- branch / commit / PR / CI

末尾に「現在地 / 異常 / 残り」の3行を付ける。

### 本節が上書きしたもの（このファイル内）

| 旧記述 | いまどうなるか |
|---|---|
| 「範囲外の不具合は勝手に修正せず、修正可否はユーザー判断を仰ぐ」（§Continuous execution）| **同一原因・同種の軽微な不整合は一括修正してよい**。無関係・大きな範囲外の不具合は従来どおり記録して報告する |
| 最終報告は §完了報告の簡潔化 の 7 項目を primary とする（§Completion report）| **上の 6 項目が既定**。従来の「未実施の高リスク操作 / 次に必要な承認 / progress の現在地」は **「未完」「次の自動作業」「現状」に含めて書く**（別書式で二重に書かない）|

**上書きしないもの**: 停止条件・禁止事項・Repository isolation・Immediate stop conditions・
Package manager・Progress maintenance は本節と矛盾しないため**そのまま有効**。

---



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
- Draft PR 作成では停止しない。正本の完成条件に必要な PR merge・本番反映は、CLAUDE.md「全repo共通運用との関係」の前提確認を満たせば自律実行する。
- 作業中に本タスクの範囲外の不具合（着手前から存在する失敗テスト・既存バグを含む）を発見しても、
  勝手に修正しない。`docs/progress.md` へ記録して報告し、修正可否はユーザー判断を仰ぐ。
  範囲外の既存不具合を自分の変更による regression として扱わない。
  ⚠️ **2026-09-18 で一部緩和**: **同一原因・同種の軽微な不整合（stale docs の整合・関連テスト修正を含む）は
  個別確認せずまとめて解消してよい**（§共通作業ルール）。緩和されるのはここまでで、
  無関係な既存バグ・大きな範囲外の変更は従来どおり記録して報告する。

### High-risk approval boundary

（2026-09-28 改定）以下は承認待ちの停止点ではなく、実行前に前提確認を必須とする操作である。前提が確認できれば自律実行し、確認できない場合のみ停止する（CLAUDE.md「全repo共通運用との関係」参照）。

次の操作は、直前に実施内容・対象・影響・rollback手順・検証方法を確認・記録してから実行する。

- production deploy / production環境変数またはsecret変更
- 本番メール・LINE・通知の送信
- 本番DB・Airtable・Redis・Blob・外部APIへの書込み
- 共通データリポジトリへの本番PUT / workflow dispatch
- package公開・registry公開（npm publish等）
- production reader・transport・モデル・artifact・champion・datastoreの切替
- PR merge / データ削除 / rollback困難なmigration
- force push / reset / rebase / amend / 履歴改変
- 課金・契約・会員権限への本番変更

前提確認を満たした高リスク操作は完成工程として続行する（到達前の工程で止めない）。

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
別リポジトリの変更が完成条件に必要な場合は、そのリポジトリの正本・CLAUDE.md に従い、リポジトリごとに独立した branch・commit・PR で完成させる（`~/.claude/CLAUDE.md` §15）。

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

⚠️ **2026-09-18 更新: 既定は §共通作業ルール の 6 項目**
（実施 / 現状 / 未完 / ユーザーの手動作業 / 次の自動作業 / branch・commit・PR・CI）。
下記の 7 項目書式は、ユーザーがそちらを求めた場合に使う。**二重に書かない。**

最終報告の書式は §完了報告の簡潔化 を primary とする。**重複して別書式で書き直さない。**
同節の必須項目（判定 / 実施内容 / 変更ファイル / テスト結果 / Git状態 / 異常・未確定事項 / 次工程案）に加えて、
自律完遂運用では次の3点を必ず含める。

1. 未実施の前提確認必須操作とその理由（実異常のみ）
2. 次の自動作業（ユーザー操作が不可避な場合のみ最小1操作）
3. `docs/progress.md` の現在地

「Git状態」には branch / commit / PR URL（merge・deploy・本番確認の状態） を含める。「異常・未確定事項」には blocker を含める。
