# Architecture and Operational Decisions

本書は `analytics-keiba` の **設計判断の正本（canonical）** である。
記録する判断は **git 履歴・既存ドキュメント・コードから証拠が取れるものに限る**。
理由が記録されていない判断には、推測した理由を書かず「履歴上は採用済みだが理由は未確認」と記す。

新しい順に記載する。

---

## 2026-07-20 — 自律完遂運用のための正本ドキュメント基盤を採用

### Status

Accepted

### Context

本リポジトリには `CLAUDE.md`（913 行）、`README.md`、`NEXT_SESSION.md`、`DAILY_UPDATE_PROCEDURES.md`、
`docs/*.md`、`astro-site/docs/*.md` と多数の文書があるが、
「仕様 / 進捗 / 設計判断」を一意に指す正本が定義されていなかった。
`NEXT_SESSION.md` は文書内の「最終更新」表記が 2026-04-14 のままで、現在地の引き継ぎ文書として機能していない。
一方 main では日次データ取込と機能 PR が継続し、未マージの open PR と作業中変更が並行していた（2026-07-20 観測）。

### Decision

`docs/spec.md`（仕様）/ `docs/progress.md`（進捗）/ `docs/decisions.md`（設計判断）/ `CLAUDE.md`（運用ルール）の
4 文書を正本とし、`CLAUDE.md` に「Autonomous Delivery Workflow」節を追記する。
既存文書は削除・置換せず、正本の役割分担を `docs/spec.md` 冒頭に明示して参照関係を張る。
`CLAUDE.md` と本書群の記述が重複する箇所は **`CLAUDE.md` の既存記述を優先**する。

### Rationale

- 既存の恒久ルール（指数 raw−1 / 全頭分類 / KI 風混入禁止 等）は `CLAUDE.md` に集約済みで実績があり、
  これを別文書へ移すと単一源が割れる。
- 欠けていたのは「今どこまで進んでいて次に何をするか」の正本であり、そこだけを新設すれば足りる。

### Alternatives Considered

- `NEXT_SESSION.md` を更新して引き継ぎ正本にする案 — 仕様・判断・進捗が 1 ファイルに混在し、
  実際に更新が止まった実績があるため不採用。
- `CLAUDE.md` にすべて追記する案 — 既に 913 行あり、進捗のような高頻度更新情報を混ぜると
  恒久ルールの可読性が落ちるため不採用。

### Consequences

- 作業開始時に読むべきファイルが 4 つに固定される。
- `docs/progress.md` は各 Phase 完了時に更新する運用コストが発生する。
- ソースコードの挙動は変わらない（本 PR は文書のみ）。

### Revisit Conditions

- 正本 4 文書のいずれかが 3 ヶ月以上更新されず実態と乖離したとき。
- `CLAUDE.md` と `docs/spec.md` の記述が矛盾し、優先ルールでは解消できなくなったとき。

### Evidence

- 本 PR #143（branch `docs/autonomous-project-workflow`、分岐時の base `origin/main` = `1aed7df`）
- `NEXT_SESSION.md`（文書内の「最終更新」表記が 2026-04-14）
- `CLAUDE.md` 既存構成（913 行 / 2026-07-20 確認）

---

## 2026-07-16 — 入金確認メール v2 の cutover 方式・カナリア分離・二重送信対策を確定

### Status

Accepted

### Context

legacy 実装は昇格 PATCH に `PaymentEmailSent=true` を **送信前**に書き、送信失敗を `.catch` で握りつぶしていた。
そのため「メール 0 通なのに `PaymentEmailSent=true`」が発生（2026-07-14 発生、修正 `33ca21d` を本番投入後
`f3172dd` で緊急 revert）。1 bit では pending / attempting / accepted / failed / delivered を区別できない。

### Decision

- cutover は **D1**（入口停止 → Automation A2 OFF 目視 → v2 deploy → カナリア 1 件 → 段階有効化）
- 非本番カナリアは **テスト用 Airtable Base / テーブルを分離**し production Customers に触れない
- 二重送信対策に **Upstash Redis + fencing token** を採用（**exactly-once は保証しない**）
- `PaymentEmailSent` 1 bit を明示的な状態機械（pending / attempting_pre_send / unknown_after_attempt /
  accepted / failed_retryable / failed_terminal / needs_admin / delivered）へ置換

### Rationale

`astro-site/docs/PAYMENT_EMAIL_V2.md` に記載の 10 個の不変条件（昇格 PATCH 成功前に送らない、
provider 受理後は受理事実を永続化する、受理と実配信を混同しない、fail closed 等）を
1 bit では満たせないため。`attempting_pre_send`（POST 前にロック取得）と
`unknown_after_attempt`（POST したかもしれない）を区別することが核心。

### Alternatives Considered

`astro-site/docs/PAYMENT_EMAIL_V2.md` に「exactly-once」を目標としない旨が明示されているが、
検討された代替案の一覧は同文書からは読み取れない。**証拠未確認**。

### Consequences

- 本番 Customers を汚さずにカナリア検証できる（`924a9d0` で Base/Table 分離、`e1e730c` で専用 PAT へ完全分離、
  `4133afd` で secret-first 化＝未認証は body を parse しない、`da29521` で allowlist exactly-one 強制 + recordId 非エコー）
- Upstash Redis が新たな外部依存として追加される
- cutover は本番メール送信を伴う高リスク操作であり、実行時は事前承認が必要

### Revisit Conditions

- fencing token 方式でも二重送信が観測されたとき
- Upstash Redis の可用性が入金確認フローの単一障害点になったとき

### Evidence

- `astro-site/docs/PAYMENT_EMAIL_V2.md`（「確定した方針（2026-07-16 承認）」）
- commits `3a31df4`（状態機械コア + S1 設計書）、`7860796`（IO 側）、`924a9d0`、`4133afd`、`da29521`、`e1e730c`

---

## 2026-07-15 — Premium Plus 実績を Netlify Blobs 化し、表示数値を自動集計のみに限定

### Status

Accepted

### Context

旧方式は実績画像を `public/upsell-images/upsell-YYYYMMDD.png` としてページにハードコードし sed で書き換えていた。
更新が止まり **3 ヶ月古い日付が本番に残った**。
また実績数値「的中率78% / 平均配当¥281,340 / 満足度4.9 / 継続率94%」は根拠のない手書き固定値だった。

### Decision

- 実績画像は Netlify Blobs に置き、`/admin/premium-plus-images` または `npm run upload:premium-plus` で
  毎日アップロードする。git には置かない（ビルド不要・即反映）
- ページに出る数値は `src/lib/premiumPlusShowcase.js` の `computeStats()` の戻り値のみとする
- 的中率・回収率は `legacy` を除く直近 30 鞍から自動集計し、**10 鞍未満なら非表示**
- 刷新前の 30 枚は的中日しか保存されていないため `legacy=true` とする
- **不的中の日も必ずアップロードする**

### Rationale

- ハードコード方式は更新漏れが本番に直結する（実際に 3 ヶ月放置された）
- 手書き固定値は根拠が無く、legacy を母数に入れると「的中率100%」という虚偽表示になる

### Alternatives Considered

`public/upsell-images/` へのハードコード継続 — 上記の実害があるため禁止・復活不可と明記。
（`public/upsell-images/` 自体は `withdrawal-upsell.astro` が参照しているため残置）

### Consequences

- 実績更新が git commit / Netlify ビルドから切り離され即反映される
- 運用者が不的中日のアップロードを怠ると的中率が実態より高く出るリスクは残る（運用ルールで担保）
- 検証は `npm run test:premium-plus`（`check:safety` に組込済み）

### Revisit Conditions

- Netlify Blobs の consistency 問題で表示が安定しなくなったとき
- サンプル 30 鞍という母数が商品仕様の変更で不適切になったとき

### Evidence

- `CLAUDE.md` §💠 Premium Plus（1日1鞍・単品商品 / 2026-07-15 刷新）
- `astro-site/docs/PREMIUM_PLUS.md` / `PREMIUM_PLUS_STORAGE_DESIGN.md`

---

## 2026-07-10 — 銀行振込の入金確認を「PaymentConfirmed 1 アクション」へ再設計

### Status

Accepted（本番反映済み）

### Context

申込フォーム送信時に有料権限が付与される・有効期限を手入力する運用は、
未入金での昇格や期限の入力ミスを招く。
また確認メール用 Airtable Automation が `When a record matches conditions`（フィールド監視なし）で
**レコード更新全般に発火**しており、`RequestedAmount` 更新等でも誤送信されていた。

### Decision

- 入金確認は Airtable で `PaymentConfirmed` にチェックを入れる **1 アクションのみ**。有効期限は手入力しない
- 申込時は `氏名` / `PaymentMethod` / `Requested*` / `PaymentConfirmed=false` のみ書き、
  `プラン` / `PlanType` / `有効期限` / `Status='active'` は書かない
- 昇格は Automation → `confirm-bank-payment.js` が 1 回の PATCH で確定（有効期限 = 入金確認日 JST + 1 年）
- 判定の単一源を `astro-site/src/lib/payments/bankPaymentFlow.js`（純粋関数・Airtable 非依存）に置く
- 確認メール Automation の監視 Fields を **`Status` のみ**へ縮小する

### Rationale

- 「申込 = 入金」ではないため、申込時点で権限を与えると未入金者が有料コンテンツを閲覧できる
- 日付計算は **JST の暦日**で行う。`toISOString()` の UTC 基準では JST 深夜 0〜9 時に 1 日ズレる
- Automation のフィールド監視を空欄にすると全フィールド監視となり誤送信する

### Alternatives Considered

証拠未確認（代替案の検討記録は `CLAUDE.md` にも `docs/PAYMENT_SYSTEM.md` にも見当たらない）。

### Consequences

- 冪等性: 承認時に `Requested*` をクリアするため、再チェックしても再昇格・期限再延長が起きない
- 二重メール防止: confirm が `PaymentEmailSent=true` を立てるため自動送信側でスキップされる
- **再送手順が変わった**: `PaymentEmailSent` を空に戻すだけでは再送されず、`Status` を pending → active に切り替える必要がある
- 既知の未修正リスク: `paypal-webhook.js` / `send-payment-confirmation.js` は
  `Status='active'` を書くが `PaymentEmailSent=true` を立てないため、復活させると確認メールが 2 通届く
- Airtable Customers に `Amount` / `ProductName` フィールドが無く、振込金額は `RequestedAmount`（承認時クリア）と
  管理者宛メールにしか残らない

### Revisit Conditions

- Stripe 等のオンライン決済を主導線に戻すとき
- 年額以外（月額・買い切り）の商品比率が上がり `addOneYearJst()` 前提が崩れるとき

### Evidence

- `CLAUDE.md` §🏦 銀行振込 入金確認フロー（2026-07-10 再設計 / 本番反映済み）
- `astro-site/src/lib/payments/bankPaymentFlow.js` / `bankPaymentFlow.test.mjs`
- `docs/PAYMENT_SYSTEM.md`

---

## 2026-07-11 — `confirm-bank-payment` に `x-confirm-secret` ヘッダ認証を追加（env 投入のみで有効化）

### Status

Accepted（本番検証済み）

### Context

`confirm-bank-payment` は公開 URL であり、認可は Airtable の `PaymentConfirmed=true` 再読込検証のみだった。

### Decision

`PAYMENT_CONFIRM_SECRET` を Netlify production context に設定し、`x-confirm-secret` ヘッダ認証を有効化する。
gating は `if (process.env.PAYMENT_CONFIRM_SECRET)` として既にデプロイ済みのため **追加のコード変更は不要**。
適用順序は **Airtable Automation にヘッダ追加 → その後 env 設定**を厳守する。

### Rationale

逆順にすると env 有効化後にヘッダ無し Automation が全て 403 となり昇格が止まる。
env 未設定の間はヘッダを送っても Function 側が無視するため（`if(CONFIRM_SECRET)` が false）無害。

### Alternatives Considered

証拠未確認。

### Consequences

- secret なし / 不一致 → `403 Forbidden`（認可段で停止・レコード非破壊）を本番確認済み
- 正しい secret による Premium 昇格一式（プラン / PlanType / Status / 有効期限 JST+1年 / `PaymentEmailSent=true` /
  `Requested*` クリア / 確認メール 1 通）を本番確認済み
- rollback: `netlify env:unset PAYMENT_CONFIRM_SECRET --context production` → 正規 production build で
  コード変更なしに従来の認可のみへ即復帰
- **secret 値そのものはドキュメント・ログ・commit に記載しない**

### Revisit Conditions

- secret のローテーション運用が必要になったとき
- Airtable Automation 以外の呼び出し元が増えたとき

### Evidence

- `CLAUDE.md` §🔐 PAYMENT_CONFIRM_SECRET（設定・本番検証済み / 2026-07-11）

---

## 2026-07-09 — メインレース買い目を一方向馬単「本命→相手5頭」= 最大5点へ統一

### Status

Accepted

### Context

旧仕様は双方向馬単「本命↔相手5頭」= 10 点（表裏両取り）だった。

### Decision

- メインレースの買い目は **全プラン共通で最大 5 点**、一方向馬単 `→` で保存・表示・的中判定する
- 裏目（相手1着・本命2着）は **不的中**
- 過去 archive は **再判定しない**（旧 `↔` エントリは双方向のまま据置）
- 通常レース（メイン以外）は現状維持（双方向 `↔` 2 段構成）
- 上位プランへの導線は「買い目数の増加」ではなく「**閲覧できるレース数の増加**」で作る

### Rationale

「点数が多い」「裏目まで買うのは不自然」との判断。ユーザーは点数の多い買い目を嫌うため、
上位プランでもメインレースは 5 点を超えない。

### Alternatives Considered

証拠未確認（`CLAUDE.md` は旧仕様からの変更理由のみ記録し、他案の比較は記録していない）。

### Consequences

- `checkUmatanHit`（`importResults*.js`）が区切り記号で方向を切り替える実装になった
  （`→` = 一方向 / `↔` `⇔` `-` = 双方向）
- 新旧フォーマットが archive 内に混在する
- 実績ショーケースの「裏目的中の畳み込み表示（`⇄`）」は旧データ専用の後方互換として残る

### Revisit Conditions

- 5 点固定が的中率・回収率の訴求を著しく損なうと判断されたとき

### Evidence

- `CLAUDE.md` §🎯 メインレース5点ロジック（一方向馬単 / 2026-07-09〜）
- `astro-site/src/utils/mainRaceBetting.js`

---

## 2026-07-09 — 有料実績ショーケースを「既存 archiveResults の最新日だけを読む」方式で実装

### Status

Accepted

### Context

無料ユーザーへ「有料版で実際に配信したメインレース買い目と結果」を毎日公開し、有料への導線にするページが必要だった。

### Decision

- 新データを作らず、`src/data/archiveResults{,Jra}.json` の **最新日 = index 0** だけを読む
- 単一源は `src/lib/resultsShowcase.js`（純粋・Node/SSR 安全）
- 公開範囲はメインレースのみ買い目公開（本命→相手5頭 = 5 点、抑えは伏せる）、
  メイン以外は全レース ✅/✗ のみ

### Rationale

「毎日上書きの別 JSON 生成」案は **単一源が割れる**ため不採用。
既存の `importResults*.js` 自動取込 + Netlify 自動ビルドにそのまま乗せれば、
データ二重管理なしで毎日自動反映される。抑えを伏せることで有料の付加価値を一段残す。

### Alternatives Considered

- 毎日上書きの別 JSON を生成する案 — 単一源が割れるため不採用（`CLAUDE.md` に明記）

### Consequences

- 既存アーカイブ（`archive/{jra,nankan}` 月別）は意図的に買い目非公開、本ページは意図的にメイン 5 点公開という
  **意図的な非対称**が生まれる。混同して buy 目を消してはいけない
- JRA は平日開催が無いため、南関と最新日がズレるのは正常

### Revisit Conditions

- 買い目公開が有料転換率をむしろ下げると判断されたとき

### Evidence

- `CLAUDE.md` §💎 有料実績ショーケース（無料→有料導線 / 2026-07-09 集約）
- `astro-site/src/lib/resultsShowcase.js`

---

## 2026-05-29 — 本番 URL を `https://analytics.keiba.link/` に一本化し、推測 URL を禁止

### Status

Accepted

### Context

`analytics.keiba.jp`（存在しない誤記）や Netlify サブドメインが本番案内に混入する余地があった。

### Decision

本番 URL は `https://analytics.keiba.link/` のみ。`analytics.keiba.jp` の使用禁止。
`*.netlify.app` は Deploy Preview 専用で本番案内・目視確認 URL に使わない。
本番確認 URL を推測で生成せず、不明な場合はユーザー確認を取る。

### Rationale

履歴上は採用済みだが理由は未確認（誤記・存在しないドメインである旨は記載されているが、
混入が実際に発生した事象の記録は見当たらない）。

### Alternatives Considered

証拠未確認。

### Consequences

PR description の本番リンク / 本番反映確認案内 / 目視確認指示 / 外部ドキュメント生成時の URL すべてに適用される。

### Revisit Conditions

- 本番ドメインを変更するとき

### Evidence

- `CLAUDE.md` §🌐 本番 URL ルール（運用厳守 / 2026-05-29 集約）

---

## 2026-05-24 — 表示・ロジック修正は「4 領域横断確認」を必須とする

### Status

Accepted（UI 修正については後に 6 経路へ拡張）

### Context

JRA 有料版の `総合評価★` を廃止して `AI総合指数` に移行した際、**無料版 JRA に同じ `総合評価★` ブロックが残り続け、
ユーザー指摘で初めて発覚**した（2026-05-24）。

### Decision

表示・ロジック・データ反映・UI・文言・不具合修正は、原則として
JRA 無料 / JRA 有料 / NANKAN 無料 / NANKAN 有料の **4 領域すべて**を対象確認範囲に含める。
特定領域のみを対象とする場合は、対象範囲・対象外範囲・対象外にした理由・影響可能性を必ず明記する。
明記なしで一領域だけ修正して push することは禁止。

### Rationale

片側だけ直って他方が旧仕様のまま残る事故、無料版だけ直って有料版が壊れる事故、
中央と南関で意図しない仕様差が生じる事故を防ぐため。

### Alternatives Considered

証拠未確認。

### Consequences

- パリティ検証 `npm run check:jra-nankan-parity` と単一源（`osaeClassification.js` / `shared-prediction-logic.js`）が整備された
- 後に UI 修正については light を含む **6 経路**（JRA/南関 × free/light/premium）へ拡張された
  （`docs/ui-cross-plan-regression-policy.md`。同文書に日付の記載は無く、拡張時期は証拠未確認）

### Revisit Conditions

- プラン構成が変わり領域数が変化したとき

### Evidence

- `CLAUDE.md` §🧭 修正対象範囲ルール（4領域横断確認 / 2026-05-24 集約）
- `docs/ui-cross-plan-regression-policy.md`

---

## 2026-05-24 — `/premium-prediction/jra/` の旧 keiba-intelligence 風ブロック再混入を CI で恒久禁止

### Status

Accepted

### Context

`/premium-prediction/jra/` は keiba-intelligence (KI) からの fork 経緯で、
旧 KI 風の演出（Ensemble Neural Network / XGBoost×LSTM / Multi-Dimensional 等）を含んでいた。

### Decision

該当表現の再混入を grep 検査（`check:ki-relics:jra` / `check:ki-relics:free-jra-date` / `check:ki-relics:free-jra`）で
検知し、`safety-check.yml` で CI 強制する。構造パリティ検証も併用する。

### Rationale

履歴上は採用済みだが理由は未確認（fork 由来の演出を除去する方針であることは明記されているが、
除去を決めた理由 — 表現上の問題か著作権上の懸念か — の記録は見当たらない）。

### Alternatives Considered

証拠未確認。

### Consequences

- 対象領域は「触ってはいけない領域」として固定された
- 関連する guard 強化系 PR の一部は保留・禁止扱いになっている（`CLAUDE.md` §🔒 保留・禁止事項 / 2026-05-29 集約）

### Revisit Conditions

- premium JRA ページを全面刷新するとき

### Evidence

- `CLAUDE.md` §🛡️ JRA premium 恒久ルール（KI 風ブロック再混入防止 / 2026-05-24 集約）
- `astro-site/scripts/check-no-ki-relics-*.mjs` / `.github/workflows/safety-check.yml`

---

## 2026-05-23 — `keiba-intelligence` と独立運用し、ロジックの同期義務を廃止

### Status

Accepted

### Context

2026-05-22 以前は両 repo で同じ判定式・同じ買い目生成ロジックを使う前提で、
メインレース判定や 10 点ロジックの変更は両 repo 同時に行うルールだった。

### Decision

`analytics-keiba` と `keiba-intelligence` は **別サービスとして独立運用**する。
両方とも稼働を続け、それぞれ独自の顧客に予想を提供する。
admin（`keiba-data-shared-admin`）からの dispatch / データ供給は当面維持する。
`analytics-keiba` 側のロジック修正を `keiba-intelligence` へ **自動的に横展開しない**。
`keiba-intelligence` 側は必要な場合のみ個別に修正する。

### Rationale

履歴上は採用済みだが理由は未確認（同期義務を取りやめた判断の背景 — 事業判断か運用コストか — の記録は
`CLAUDE.md` にも見当たらない）。

### Alternatives Considered

証拠未確認。

### Consequences

- 予想ロジックは意図的に差別化された
  （AK: `analyticsScore = computerIndex×0.5 + featureScore×0.3 + markScore×0.2` のデータ主導 / KI: 印ベース）
- 差別化の維持を CI で検証する（`npm run check:differentiation`）
- **過去の経緯を理由に同期作業を再開してはいけない**

### Revisit Conditions

- どちらかのサービスを終了・統合するとき

### Evidence

- `CLAUDE.md` §keiba-intelligence との関係（独立運用、2026-05-23〜）
- `CLAUDE.md` §🧠 予想ロジック（スコア・役割決定）
- `astro-site/src/utils/adjustPrediction.differentiation.test.js`

---

## 2026-05-23 — 前日データ混入に対する「二段防御」（入力側ペア揃いガード + 取込側 中身 date 検証）

### Status

Accepted

### Context

`prediction-updated` dispatch の取込で **前日データが当日 prediction に混入**する事故が発生した
（2026-05-24 案件: 36 レース中 24 レースが 23 日と完全同一）。

### Decision

- **Step 1（入力側）**: `keiba-data-shared-admin/netlify/lib/pair-guard.mjs` が
  `racebook` JSON と `computer` JSON の両方が揃ったときだけ dispatch を発火（どちらが先でも後勝ちで 1 回）
- **Step 2（取込側）**: `astro-site/scripts/importPredictionJra.js` の `fetchRacebookData` 内で
  **中身の `date` が指定日と一致するもののみ採用**
- ±1日マージロジック自体は維持する

### Rationale

入力側ガードをすり抜けた場合の追加防御が必要なため、入力側と取込側の **両方で 1 セット**とする。
±1日マージは「ファイル名は前日付だが中身は当日」運用の救済機能（2026-05-15 案件）であり削除できない。

### Alternatives Considered

証拠未確認。

### Consequences

- ±1日マージロジックの削除、中身 date 検証ガードの無効化、片方だけの無効化はいずれも禁止
- 検知ログ: 入力側 `⏸️ [PairGuard] dispatch保留: ...`（Netlify Functions ログ）/
  取込側 `⏭️ [RACEBOOK-GUARD] ... スキップ（中身 date=... ≠ 指定日 ...）`（GitHub Actions ログ）
- 入力側ガードは別リポジトリ（`keiba-data-shared-admin`）にあるため、本リポジトリ単独では完結しない

### Revisit Conditions

- 共有データの命名規約が変わり、ファイル名日付と中身 date の乖離が構造的に解消されたとき

### Evidence

- `CLAUDE.md` §🛡️ 二段防御: ペア揃いガード + 中身 date 検証（2026-05-23 集約）
- `astro-site/scripts/importPredictionJra.js`

---

## 2026-05-21 — 抑え / 不要馬の判定を `osaeClassification.js` に単一源化

### Status

Accepted

### Context

メインレース 5 点買い目の「抑え」表示と、予想ページ上の「表示の抑え（isOsaeCandidate）」が
別ロジックだと構造的に食い違う。

### Decision

抑え（補欠/抑え かつ racebook 系コンピ指数 ≥ 45）を通常レースと同じ単一源
`selectOsaeNumbers`（`astro-site/src/utils/osaeClassification.js`）で選出し、
メインレース買い目には `(抑え...)` として **本線 5 点に含めない情報表示**で付与する。

### Rationale

「表示の抑え」と「買い目の抑え」を構造的に一致させるため。

### Alternatives Considered

証拠未確認。

### Consequences

- 全頭分類（本命 / 対抗 / 単穴 / 連下 / 抑え / 不要馬）の合計 == 出走頭数 が CI で強制される
- 実績ショーケースの抑え除去も同一正規表現（`stripOsae`）を使う

### Revisit Conditions

- コンピ指数 45 という閾値の妥当性が疑われたとき

### Evidence

- `CLAUDE.md` §🧩 抑え/不要馬 判定の単一源（2026-05-21 集約）
- `astro-site/src/utils/osaeClassification.js`

---

## 日付未確定 — 表示用コンピ指数は必ず raw − 1（著作権・表示安全対策）

### Status

Accepted

### Context

`CLAUDE.md` §🔢 指数表示ルール に「著作権・表示安全対策」と記載されている。

### Decision

`horse.computerIndex` / `horse.sourceComputerIndex` を JSX に直接埋めるのは禁止。
必ず `getDisplayComputerIndex` / `formatDisplayComputerIndex`（`src/lib/shared-prediction-logic.js`）経由で
raw − 1 を表示する。CI（`check:no-raw-index` / `check:display-index`）で強制する。

### Rationale

履歴上は採用済みだが理由は未確認（「著作権・表示安全対策」という見出し以上の説明は記録されていない）。

### Alternatives Considered

証拠未確認。

### Consequences

- 一時的な検証無効化は禁止
- CI 失敗条件に「検証対象スコープなのに対象ファイル 0 件（素通り防止）」「対象ファイルがあるのに馬数 0 件（スキーマ破損）」を含む

### Revisit Conditions

- 指数の出典・ライセンス条件が変わったとき

### Evidence

- `CLAUDE.md` §🔢 指数表示ルール / §🛡️ CI Safety Check
- `astro-site/scripts/check-display-computer-index.mjs` / `check-no-raw-computer-index-display.mjs`

---

## 日付未確定（2026-07-17 前後） — SSR Function から重い `src/data` を postbuild で除去

### Status

Accepted

### Context

Netlify SSR Function のバンドルが 250MB 上限を超過してデプロイに失敗した。

### Decision

`excluded_files` ではなく `included_files` の `"!"` 否定グロブへ修正したうえで、
最終的に postbuild スクリプト `astro-site/scripts/prune-ssr-function-data.mjs` で
SSR 関数から重い `src/data` 群を削除する。`npm run build` に組み込む。

### Rationale

commit メッセージ以上の詳細な理由記録は無い。250MB 上限超過の解消が目的である点のみ確認できる。

### Alternatives Considered

- `excluded_files` による除外（`d75e7bf`）→ `included_files` の否定グロブへ修正（`d4a079b`）→
  postbuild 削除方式（`77fbd58`）と段階的に置き換えられた。前 2 案が不十分だった理由の記録は **証拠未確認**

### Consequences

- `npm run build` は `validate:archive` → `astro build` → `prune-ssr-function-data.mjs` の 3 段になった
- SSR で `src/data` を直接読む実装を追加すると本番で壊れる可能性がある

### Revisit Conditions

- `src/data` のサイズが更に増え postbuild 削除でも上限を超えるとき

### Evidence

- commits `d75e7bf` / `d4a079b` / `77fbd58`
- `astro-site/package.json` の `build` スクリプト

## 2026-07-20 — 決済メールの送信元を `senderIdentity.js` に単一源化し、不一致は送信前 fail closed

### 背景

入金確認メール v2 の S4 カナリア実行前 preflight で、SendGrid payload の `from` が
`email-config.js` の `FROM_EMAIL` = `noreply@keiba.link` であることを検知した。
AK の正式送信元は `support@keiba.link`（env `SENDGRID_FROM_EMAIL` も同値）であり不一致。
送信元不一致時は送信停止が既定方針のため、カナリアを実行せず停止した。

### 決定

- 決済メール経路の送信元は **`src/lib/payments/senderIdentity.js` を単一源**とする。
- env `SENDGRID_FROM_EMAIL` が正式値 `support@keiba.link` と一致する場合のみ送信可
  （正規化は repo 既存方針の `trim()` + `toLowerCase()`）。
- **未設定 / 空 / 不一致は送信前に fail closed**（SendGrid へ POST しない）。
- **`noreply@keiba.link` への fallback を持たない**。決済メール経路では `FROM_EMAIL` を import しない。
- **カナリアと通常 worker は同一契約**を使う（カナリア専用の送信元 env は作らない）。
- 送信元不一致は `failed_terminal`（構成不備は再試行で直らないため retryable にしない）。
- 判定結果・ログ・エラーに env の値を含めない（reason コードのみ）。

### 対象外（意図的に変更しない）

- `confirm-bank-payment.js` / `send-payment-confirmation-auto.js` の legacy 送信（依然 noreply）。
  **稼働中の本番経路**であり、fail closed 化は env drift 時に本番メールを止める副作用を持つため、
  スコープを分けて別途判断する。
- ニュースレター / マジックリンク等 11 Function（従来どおり別タスク）。

### 検証

`senderIdentity.test.mjs`（一致 / 正規化 / noreply / 他ブランド / 未設定 / 空 / 非文字列 / 値非漏洩）と
`paymentEmailSender.guard.test.mjs`（配線固定: FROM_EMAIL 非 import / noreply 直書き禁止 /
両 deps が同一契約 / terminal 扱い）。`test:bank-payment` → `check:safety` で CI 強制。

### 関連

- `astro-site/docs/PAYMENT_EMAIL_V2.md` §送信元契約（単一源 / 2026-07-20 追加）
- `docs/progress.md` §決済メール v2 / S4 カナリア準備

## 2026-07-20 — 送信前 schema preflight と provider 受理後の state write 失敗処理を必須化

### 背景

S4 カナリアで、テスト Base に provider 後に書くフィールドが無く、**SendGrid 送信後**の結果 PATCH が
422 で失敗した。メールは実際に届いたが受理を記録できず `unknown_after_attempt` に滞留した。
「設定漏れが、メールを送った後に顕在化する」という最悪の順序であり、本番で起きれば
顧客にメールが届いたのに `PaymentEmailSent=false` のまま滞留する。

### 決定

1. **provider 後に書くフィールドの存在を、送信前に検証する**（`REQUIRED_PROVIDER_RESULT_FIELDS`）。
   欠落・判定不能なら**レコードを変更せず・送信もせず** fail closed。
2. 判定は **read-only プローブ**（List Records の `fields[]` に不明フィールドがあると 422 になる性質）。
   - **Meta API に依存しない**（canary PAT は data scope のみで 403）
   - **本番レコードへの試験書込みをしない**（no-op PATCH 方式は不採用）
   - **カナリアと通常 worker で同一契約**
3. **provider 受理後の PATCH 失敗は `STATE_WRITE_FAILED`** として扱い、`unknown_after_attempt` を維持。
   自動再送せず、`providerAccepted` を返して受理事実を保持し、reconciler の対象として識別可能にする。
4. worker のログから `recordId` を削除する。

### 却下した代替案

- **Meta API でスキーマ取得**: canary PAT が 403。権限追加は PAT の権限拡大を招くため不採用
- **no-op PATCH でフィールド存在を確認**: 本番レコードへ試験書込みすることになるため不採用
- **失敗時に pending へ戻す**: 送信済みメールの再送につながるため**明確に禁止**

### 関連

- `astro-site/docs/PAYMENT_EMAIL_V2.md` §送信前 schema preflight
- `docs/progress.md` §決済メール v2 / S4 カナリア実行と事故

## 2026-07-21 — pending 送信は Netlify Scheduled dispatcher 方式（Airtable Automation に依存しない）

### 背景

v2 では confirm-bank-payment が pending を書くだけで送信しない（worker へ委譲）。しかし worker を
起動する配線が無く、reconciler も Scheduled 化されていなかった。cutover の env フリップだけでは
確認メールが 1 通も送られない状態だった（D1 前提の未実装 2 件）。

### 決定

- **B1: pending → 送信のトリガーは Netlify Scheduled Function（dispatcher）**。Airtable Automation を
  新たな必須依存にしない。理由:
  - A2 の ON/OFF と新 Automation の切替を同時管理すると運用事故が増える
  - repo 内コード・テスト・deploy で配線を管理でき、gate/pause/A2 確認をコードで fail-closed にできる
  - pending 限定取得・件数制限・順次処理・部分失敗の停止を明示できる
- **HTTP で自分の worker Function を呼ばず、worker コアを同一プロセスで実行**（信頼性・単一プロセス lock）。
- **B2: reconciler は既存手動 POST を壊さず、別ファイル `cron-payment-email-reconciler.js` で Scheduled 化**。
- **schedule**: dispatcher `*/5`、reconciler `*/15`（安全側）。docs に明記。
- **重複起動防止**: dispatcher / reconciler それぞれ dispatch/reconcile 単位の Upstash ロック。
  record 単位 lock/fencing と二重防御。
- **fail-closed の単一源は `validateEmailGates()`**。v2-worker/v2-full 以外では dispatcher は 0 送信、
  reconciler は 0 書込み（legacy 現行本番では常に 0）。

### 却下した代替案

- **Airtable Automation を worker POST へ作り替える**: A2 との二重管理・運用事故増のため却下（B1 で不採用）。
- **dispatcher が worker Function を HTTP で呼ぶ**: プロセス跨ぎで lock/信頼性が下がるため却下（core 直接実行）。

### 関連

- `astro-site/docs/PAYMENT_EMAIL_V2.md` §B1 dispatcher / B2 reconciler schedule
- `docs/progress.md` §D1 前提実装 B1・B2

## 2026-07-21 — Scheduled 呼出契約と 30 秒上限への適合（B1/B2 補正）

Netlify 公式仕様（一次情報）を確認: **Scheduled Functions は公開 URL から直接呼び出せない**
（"You can't invoke scheduled functions directly with a URL."）／手動は UI「Run now」／**実行 30 秒上限**。

### 決定

- dispatcher を **Scheduled 専用**に単純化し、URL POST 用の認証分岐（`x-worker-secret`）を**削除**。
  D1 に手動 dispatcher API は不要（単一レコード検証は canary、手動実行は UI「Run now」）。
- **reconciler の明示認証つき手動 API は既存の通常 Function** `payment-email-reconciler.js` に残す
  （Scheduled 版 `cron-payment-email-reconciler.js` とは別ファイルで分離）。
- **30 秒上限**: dispatcher 上限を 10→**3 件**へ引き下げ、**deadline guard（25 秒）**を追加。
  reconciler も **10 件上限 + deadline guard**。時間切れ前に新規レコード処理を開始せず、残りは次回へ。
  処理途中で強制終了しても record 単位 lock/fencing/state machine が二重送信を防ぐ。
- dispatch lock TTL は 90 秒（`SET NX EX 90`）で、実行上限 30 秒 < TTL 90 秒 < schedule 間隔 300 秒 の
  関係により、stale lock は次回実行前に必ず失効し、同一実行内の重複も防ぐ。

### 関連

- `astro-site/docs/PAYMENT_EMAIL_V2.md` §B1/B2（Scheduled 専用・30 秒・deadline guard）
