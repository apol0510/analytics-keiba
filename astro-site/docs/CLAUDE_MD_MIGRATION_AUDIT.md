# CLAUDE.md 再編（2026-08-13）— 全セクション対応表

旧 CLAUDE.md（1,374 行 / 86KB）を **索引 + 破ってはいけない約束**へ再編し、
詳細を `astro-site/docs/` の正本へ移した記録。

**この表は監査用**。あとから「あの規則はどこへ行った？」を追えるように残す。

区分:

| 区分 | 意味 |
|---|---|
| **① 残置** | 新 CLAUDE.md に残した（言い換えを含む） |
| **② 原文移動** | 新規 doc へ**逐語**で移した |
| **③ 既存正本へ委譲** | 既に doc に正本があったので CLAUDE.md 側の重複を落とし、索引だけ残した |
| **④ 削除** | 意図的に削除（理由を明記） |

---

## 対応表（旧 CLAUDE.md の全 29 セクション）

| 旧行 | セクション | 区分 | 移動先 / 備考 |
|---|---|---|---|
| L3-14 | プロジェクト識別 | ① 残置 | 「（移行後）」「旧URL」を削除（移行完了済み） |
| L15-34 | 本番 URL ルール | ① 残置 | 表 + 禁止 4 項目を保持。文言のみ圧縮 |
| L35-53 | 最重要：AI作業ルール | ① 残置 | 禁止 6 項目を保持。**7・8 を追加**（検証の無効化禁止 / 詳細の書き戻し禁止） |
| L54-109 | 修正対象範囲ルール（4領域） | ① 残置（要約） | 4 領域表・横断確認対象・例外運用・過去事例を保持。**「目的」3 行を削除**（説明文であり規則ではない） |
| L110-169 | データフロー | ② 原文移動 | [`DATA_FLOW.md`](./DATA_FLOW.md) |
| L170-180 | 旧フォーマット禁止 | ① 残置 | 表を保持。**`sanrenpukuHit` 行を一度落として復元済み** |
| L181-186 | 購入点数ロジック | ③ 委譲 | [`BET_POINT_LOGIC.md`](./BET_POINT_LOGIC.md)。⚠️ 旧 CLAUDE.md は「**3 段階**」と書いていたが正本は「**4 段階**」。誤記だったため CLAUDE.md 側の数値を復活させない |
| L187-335 | メインレース5点ロジック / 通常レース2段 / 抑え判定 | ② 原文移動 | [`MAIN_RACE_BETTING.md`](./MAIN_RACE_BETTING.md) |
| L336-357 | keiba-intelligence との関係（独立運用） | ② 原文移動 | [`KI_INDEPENDENCE.md`](./KI_INDEPENDENCE.md)。**初回の再編で取りこぼし、監査で検出して復元** |
| L358-407 | 有料実績ショーケース | ② 原文移動 | [`RESULTS_SHOWCASE.md`](./RESULTS_SHOWCASE.md) |
| L408-522 | Premium Plus | ③ 委譲 | [`PREMIUM_PLUS.md`](./PREMIUM_PLUS.md) / [`PREMIUM_PLUS_STAGED_RELEASE.md`](./PREMIUM_PLUS_STAGED_RELEASE.md)。不変条件 5 件は CLAUDE.md に残置 |
| L523-615 | AK 顧客販売・マーケティング管理 | ③ 委譲 | [`CUSTOMER_MARKETING.md`](./CUSTOMER_MARKETING.md)（901 行）。禁止 4 件は CLAUDE.md に残置 |
| L616-645 | カムバック施策 | ③ 委譲 | [`COMEBACK_GRANTS.md`](./COMEBACK_GRANTS.md)（728 行）。`grant ≠ paid contract` / `offer ≠ entitlement` は CLAUDE.md に残置 |
| L646-666 | 販売導線の制御（UpsellTarget） | ③ 委譲 | [`UPSELL_TARGET.md`](./UPSELL_TARGET.md)（223 行） |
| L667-673 | 予想ロジック | ③ 委譲 | [`PREDICTION_LOGIC.md`](./PREDICTION_LOGIC.md)。「コードと MD を両方更新」は CLAUDE.md に**一般規則として統合** |
| L674-753 | 指数表示ルール | ② 原文移動 | [`DISPLAY_INDEX_RULES.md`](./DISPLAY_INDEX_RULES.md)。禁止 3 件は CLAUDE.md に残置 |
| L754-774 | SendGrid Event Webhook | ③ 委譲 | [`SENDGRID_WEBHOOK.md`](./SENDGRID_WEBHOOK.md) |
| L775-781 | ログイン（マジックリンク） | ③ 委譲 | [`AUTH_LOGIN.md`](./AUTH_LOGIN.md) |
| L782-888 | 銀行振込 入金確認フロー | ② 原文移動 | [`BANK_TRANSFER_FLOW.md`](./BANK_TRANSFER_FLOW.md) |
| L889-913 | 開発コマンド | ① 残置（要約） | 主要 7 コマンドを残置。個別の `check:*` / `test:*` 列挙は `package.json` が正本 |
| L914-957 | CI Safety Check | ③ 委譲 | [`SAFETY_CHECKS.md`](./SAFETY_CHECKS.md)。**ルール 3〜5（モザイク / KI relics / 全件走査）が正本側に無かったため追記**。CLAUDE.md は 5 行の要約 |
| L958-1087 | JRA premium 恒久ルール（KI 風） | ② 原文移動 | [`KI_RELIC_GUARDS.md`](./KI_RELIC_GUARDS.md)。**相対リンク 2 行のみ書き換え**（下記） |
| L1088-1096 | 技術スタック | ① 残置 | 1 段落へ圧縮。Upstash Redis を追記（実態に合わせた） |
| L1097-1175 | GitHub Actions Workflows | ② 原文移動 | [`ARCHIVE_SYNC_MONITORING.md`](./ARCHIVE_SYNC_MONITORING.md)。Concurrency Group は CLAUDE.md に残置 |
| L1176-1182 | 特徴量システム | ① 残置 | 1 行へ圧縮（項目名はすべて保持） |
| L1183-1197 | Netlify 環境変数 | ① 残置 | 必須 env をすべて保持。「機能別ゲート env は各正本」を追記 |
| L1198-1207 | 移行タスク（初期セットアップ） | **④ 削除** | **理由**: 2026-05 に完了済み（本番稼働中）。GitHub repo 作成 / Netlify サイト作成 / DNS / 301 リダイレクト等、すべて実施済みの一度きりの手順。必要なら本 PR の diff から復元可 |
| L1208-1215 | 関連プロジェクト | ① 残置 | KI に「独立運用・触らない」を明記して強化 |
| L1216-1232 | 完了報告の簡潔化 | ① 残置 | 7 項目・省略禁止をすべて保持 |
| L1233-1374 | Autonomous Delivery Workflow | ② 原文移動 | [`AUTONOMOUS_DELIVERY.md`](./AUTONOMOUS_DELIVERY.md) |

---

## 「逐語コピー」と実際が一致しない箇所（全件）

**8 ファイル中 7 ファイルは原文と完全一致**（追記した先頭ヘッダを除く）。

| ファイル | 差異 | 内容 |
|---|---|---|
| [`KI_RELIC_GUARDS.md`](./KI_RELIC_GUARDS.md) | **2 行** | 相対リンクのパスのみ。`./astro-site/docs/PREMIUM_JRA_RULES.md` → `./PREMIUM_JRA_RULES.md`（`docs/` 配下では前者が壊れるため）。**規則の内容は不変** |

全ファイルに共通して、先頭に 3〜4 行の「どこから来たか / 正本はここ」ヘッダを追記している。

---

## 監査で検出して修正した欠落

初回の再編で失われ、**この監査で検出して復元**したもの:

| # | 失われていた規則 | 復元先 |
|---|---|---|
| 1 | **無料版のモザイクは「描画されて」初めてマスク**（gradient 文字の中では子の `blur()` が効かない / `stat-value-masked` / `check:free-mask`）。2026-07-31 の本番不具合が根拠の **CI 強制ルール**で、旧 `SAFETY_CHECKS.md` にも無かった | [`SAFETY_CHECKS.md`](./SAFETY_CHECKS.md) ルール 3 + CLAUDE.md の CI 要約 |
| 2 | **keiba-intelligence 独立運用の詳細**（dispatch 供給は当面維持 / computer-manager = 予想本体 / race-data-importer = 補完 / KI 側は必要時のみ個別修正 / 顧客表示の汚染は KI の方針で別途最小修正 / 過去の経緯） | [`KI_INDEPENDENCE.md`](./KI_INDEPENDENCE.md)（原文）+ CLAUDE.md に要点 4 行 |
| 3 | 旧フォーマット禁止表の `sanrenpukuHit` 行 | CLAUDE.md |
| 4 | 「CI を通さずに指数表示や馬分類を変更してはいけない」 | CLAUDE.md の CI 節 |
| 5 | 「重み・閾値を変えたらコードと MD を両方更新」（予想ロジック / 購入点数の 2 箇所にあった） | CLAUDE.md に一般規則として統合 |

`SAFETY_CHECKS.md` にはルール 4（KI relics）・ルール 5（全件走査）も追記した
（CI では既に強制されていたのに正本へ書かれていなかった）。

---

## 再編後の規約

- **CLAUDE.md へ仕様の詳細を書き戻さない**（CLAUDE.md の「文書の置き場所」節が規則）
- **新規 doc は必ず CLAUDE.md の「ドキュメント索引」へ 1 行追加する**（到達不能な doc を作らない）
- 同じ規則を CLAUDE.md と doc の**両方に詳細まで**書かない。正本は 1 つ
