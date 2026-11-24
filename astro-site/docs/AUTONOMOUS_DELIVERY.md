# 自律完遂運用（Autonomous Delivery Workflow）

> CLAUDE.md から集約（2026-08-13）。2026-11-25 MK 指示で、共通規則の写しを削除し AK 固有の事項だけを残した。

共通の運用は ~/.claude/CLAUDE.md（冒頭の行動原則・§3・§13・§14・§35）と KAO の docs/fleet-policy.md に従う。本ファイルには本 repo 固有の事実・MK の決定・contract だけを書く。

## 既定のフロー（AK）

```text
調査 → 同種問題をまとめて修正 → test / verify → 必要な正本 docs 更新
 → commit → 通常 push → PR → CI green 確認 → 最新 origin/main 取り直し（CLAUDE.md「merge 直前」）→ merge の経路（下記）
 → 本番反映・実運用確認 → cleanup → progress 更新
```

- 同一原因・同種の軽微な不整合（stale docs の整合・関連テスト修正を含む）はまとめて解消する。
  無関係な既存不具合は同じ差分に混ぜず、別 PR にするか `docs/progress.md` に記録する。
- 過去の**歴史記録**と**現況記録**は混同しない（`superseded` / `deprecated` / `historical` を明示する）。
- Git: rebase / reset / force push / cherry-pick / `main` への直接 push は禁止。push は作業 branch だけ。

## merge の経路（KAO `config/fleet.yml`・2026-11-25 確認）

Claude（対話セッション）は自分が author の PR を merge しない。無人 merge の経路は KAO の MEDIUM handoff
（`fleet-medium-handoff`・KAO D-143）。AK の設定は `allow: ["agent_policy","package_scripts"]`・**`contentAllowed: true`**。

| 変更の種類 | merge する主体 |
|---|---|
| `CLAUDE.md` 等の agent_policy・`src/` / `scripts/` / `netlify/` / `docs/` 等の content | KAO scheduler（verifier の全条件 true のとき自動）|
| **billing の path**（ファイル名に stripe / billing / invoice / payment / checkout / subscription / sendgrid / mailer 等を含む）| **人（MK）**。verifier が常に拒否する（KAO D-147・MK の決定）|

- 運用: PR 作成 → `fleet-medium-handoff` で渡す → billing で拒否されたものだけ merge を MK へ 1 操作で依頼し、
  merge 後の本番確認・cleanup は Claude が続ける。CI・secret / PII・conflict・post-check（本番 200）の条件はそのまま効く。
- Claude は経路を広げない（widening は owner だけ）。

## AK 固有の停止条件

- 現行 API・schema・consumer contract の破壊（旧フォーマット復活、±1日マージ削除、中身 date 検証ガード無効化を含む）
- 別 repo の仕様を誤って適用する可能性（特に `keiba-intelligence` / `keiba-data-shared-admin`）
- safety check の一時無効化（CLAUDE.md「CI で強制していること」により禁止）

## keiba-intelligence との関係

AK の作業として KI を変更しない。KI の作業は KI の正本で別 PR（MK の独立運用の決定・[`KI_INDEPENDENCE.md`](./KI_INDEPENDENCE.md)）。

## 前提確認の具体例（AK）

入金確認メール v2 の cutover、`PAYMENT_CONFIRM_SECRET` 等の env 投入・解除、Netlify Build Hook 実行、
Airtable Automation の変更、Netlify Blobs への本番アップロード、`import-*` workflow の手動 dispatch。

## 正本

`docs/spec.md`（仕様）/ `docs/progress.md`（進捗）/ `docs/decisions.md`（設計判断）/ `CLAUDE.md`（運用）。
各ドメインの詳細仕様は `astro-site/docs/*.md` と `docs/*.md` が正本で、`docs/spec.md` は責務境界と全体像だけを定義する。
仕様・進捗・設計判断が食い違う場合は git 履歴と実装を調べて整合させ、整合できない矛盾は `docs/progress.md` の Open Questions に記録する。

## Package manager

npm（`astro-site/package-lock.json` 等・CI は `npm ci`）。`astro-site/astro-site/` の入れ子 lockfile は意図不明のため
`docs/progress.md` の Open Questions に記録済み。独断で削除しない。

## Progress maintenance

- 作業開始時と各 Phase 完了時に `docs/progress.md` を更新する。重要な設計判断は `docs/decisions.md` に記録する。
- MK が決めた仕様変更は `docs/spec.md` に反映する。
- 予想ロジック・購入点数などの詳細仕様を変更したら、コードと対応する `astro-site/docs/*.md` を必ず両方更新する。

報告の形式は `~/.claude/CLAUDE.md` §34。
