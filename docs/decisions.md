# Architecture and Operational Decisions

本書は `analytics-keiba` の **設計判断の正本（canonical）** である。
記録する判断は **git 履歴・既存ドキュメント・コードから証拠が取れるものに限る**。
理由が記録されていない判断には、推測した理由を書かず「履歴上は採用済みだが理由は未確認」と記す。

新しい順に記載する。

---

## 2026-08-01 — Netlify build hook の POST に bounded retry と deploy 重複チェックを導入

### Status

Accepted（実装は branch `fix/netlify-deploy-bounded-retry` / Draft PR。merge は未実施）

### Context

2026-08-01 03:12 UTC の `Import Prediction (Dispatch)` run **30681507056** が
最後の `Trigger Netlify deploy` step だけで失敗した。

- import 自体は成功。commit **`7672c4a`**（`astro-site/src/data/predictions/2026-08-02-funabashi.json` の 1 ファイルのみ）を push 済み。
- 失敗したのは build hook の POST。`curl: (28) Failed to connect to api.netlify.com port 443 after 300706 ms`
  = **TCP 接続すら確立できないまま curl 既定の connect timeout（300 秒）で打ち切られた**。
- 当時の action には `--connect-timeout` / `--max-time` / retry が**一つも無かった**ため、
  1 回の接続失敗がそのまま job 失敗になった。
- 一方 Netlify 側では、同 commit の production deploy **`6a6d640c26d26a0008fe9eaf`** が
  03:12:12Z に作成され 03:13:11Z に published（state `ready`）していた。
  タイトルが commit message（hook 経由なら "Deploy triggered by hook: ..."）であることから、
  **GitHub 連携の push デプロイが別経路で成立していた**。データ反映に欠落は無い。

つまり本番影響は無く、**壊れていたのは通知経路の頑健さだけ**だった。
同時に、hook と GitHub 連携が両方走るため**同一 commit の二重ビルドが常態化している**ことも判明した。

### Decision

`.github/actions/netlify-deploy` を次の方針で最小修正する。

1. **retry は一過性の失敗に限定する。** curl exit 6/7/28/35/52/55/56 と HTTP 429 / 5xx のみ。
   HTTP 4xx（hook URL の誤り・失効などの設定不良）と未知エラーは **retry せず即 FAIL**。
   上限 3 回（1〜5 でクランプ）、backoff 5s→15s→30s。上限到達後は FAIL のままにする（fail-closed を維持）。
2. **timeout を明示する。** `--connect-timeout 30` / `--max-time 90`。curl 既定の 300 秒待ちを排除する。
3. **再送前に deploy の有無を確認する。** `netlify-auth-token` + `site-id` が渡された場合のみ Netlify API を読み、
   対象 commit の deploy（`error` / `rejected` を除く）が既にあれば **POST せず成功扱い**にする。
   今回のように「POST は届いたが応答だけ失った」ケースで二重ビルドを防ぐのが目的。
4. **self-heal は例外**。`check-publish-drift.yml` は同一 commit の再ビルドが目的なので `commit-sha` を渡さない。
5. **秘匿値を出さない。** hook URL・token・response 本文はログに出さず、HTTP status と curl exit code だけ記録する。
   （従来は失敗時に response 本文を `cat` していた。）

### Consequences

- Netlify API を使う重複チェックは **`NETLIFY_AUTH_TOKEN` / `NETLIFY_SITE_ID` secret が未設定のため現時点では無効**。
  未設定なら自動的に「retry のみ」へ縮退し、従来と同じ挙動になる（workflow 側は既に配線済み）。
  有効化には secret 追加＝**production secret 変更（要承認）**が必要。
- `build-hook` 未設定時の no-op（exit 0）は**従来どおり維持**した。`require-hook: true` で FAIL に切り替えられる。
  既定を FAIL にすると secret 未設定の環境で 4 workflow が一斉に落ちるため、既定は変えない。
- 二重ビルド（hook + GitHub 連携）そのものの是非は**本 PR の対象外**。commit-sha を渡す 3 workflow では
  結果的に hook 側が抑止されるが、hook を廃止するかどうかは別途判断する。

---

## 2026-07-31 — JRA import の突合ゲートに stale read 限定の bounded retry を採用

### Status

Accepted

### Context

会場ごとの `prediction-updated` dispatch が短時間に連続すると、GitHub Contents API の結果整合性により
**racebook 側だけが computer 側より遅れて見える**ことがある。この状態では実データが正常でも
`assertInjectionSafe` が偽 FAIL する。

実測（いずれも run ログが一次証拠）:

| 日時 (UTC) | run | racebook 一覧の見え方 | 結果 |
|---|---|---|---|
| 2026-07-31 08:43:10 | `30617261216` | 札幌 1 件のみ | ❌ 未対応ci≥45 **266 件** で FAIL |
| 2026-07-31 08:44:57 | `30617330461` | 中京・新潟・札幌 3 件 | ✅ 未対応 0 件で成功 |

同型の FAIL は再発性がある（`30154336778` = 2026-07-26 分 123 件 / `30080087999` = 2026-07-25 分 121 件 /
`29731809670` = 274 件）。さらに `29638377662`（2026-07-18）は **racebook 3 会場すべてが一覧に出ていた**にも
かかわらず 19 件が未対応で、内訳は 小倉R9 #9-#18・小倉R12 #10-#14・函館R4 #14-#16 と**レース内の末尾馬番**に偏っていた。
現在の shared では同レースの racebook / computer の頭数は一致している（小倉R9 = 18/18 等）。
すなわち staleness は**一覧レベル（会場ファイルが見えない）だけでなく、内容レベル（古い版のファイルが返る）**でも起きる。

いずれのケースも実データは最終的に整合しており、後続 dispatch の run が同じ入力で成功している。

### Decision

`assertInjectionSafe` の判定基準・閾値は**変更しない**。代わりに、
「stale read で説明できる問題」に限って **racebook / computer を再取得して突合を最初からやり直す**
bounded retry を JRA import に入れる。

- 分類は純関数 `classifyInjectionProblems(stats)`（`scripts/lib/computerIndexMatch.mjs`）に切り出す。
  - `uncoveredHighCi` のみ → `staleSuspect = true`（再取得対象）
  - `ambiguous`（同一 computer ファイル内の馬番重複）を含む → `staleSuspect = false`。
    **ファイルは commit 単位で原子的なので再取得しても内容は変わらない**＝実欠陥。retry せず即 FAIL。
- retry 本体は `resolveSharedJsonWithComputerIndex()`（`scripts/importPredictionJra.js`）。
  再取得は **最大 3 回**、待機は **5s → 10s → 20s（累計上限 35s）**。無制限 retry は禁止。
- retry は毎回 racebook と computer を**両方**取り直し、注入と安全条件を最初から再検証する
  （sleep だけで成功扱いにはしない）。一覧レベル・内容レベルどちらの staleness も同じ経路で吸収される。
- **上限に達しても解消しなければ、従来と同一の例外・同一のメッセージで FAIL させる（fail-closed）。**
  後続 dispatch が来ることを前提に成功扱いすることはしない。
- 診断のため、取得内容の key 空間（会場・R・馬番のみ）の 12 桁 digest を再取得ごとにログへ出す。
  raw response / token / Authorization は出さない。

### Consequences

- 一過性の可視性ズレでは import が落ちなくなる。正常時の追加コストは 0（retry 0 回）。
- 真の不整合（馬番が対応しない・馬番重複）は従来どおり FAIL する。閾値も補完も変えていないため、
  真コンピ指数>=45 の馬を黙って不要馬化する経路は増えない。
- 最悪ケースで import が最大 35 秒延びる。
- **「computer は存在するが racebook が 0 件」は FAIL へ変更した**（従来は skip = 成功終了）。
  根拠: `importPredictionJra.js` を起動するのは `import-on-dispatch.yml` だけであり
  （日次 cron `import-prediction-daily.yml` が呼ぶのは南関の `import:prediction`）、
  その起動元は admin の**ペア揃いガードを通過した `prediction-updated`** か手動 `workflow_dispatch` である。
  ペア揃いガードは racebook と computer の両方が shared に存在するときだけ dispatch するため、
  再取得を尽くしてなお computer だけが見える状態は**構造上あり得ない＝異常**。
  ここを成功終了にすると、その日の JRA 予想が緑のまま取り込まれない silent miss になる。
  直近 14 run の実測でも JRA の import が skip 経路に入った例は無い。
- **racebook も computer も無い通常の未投入日は従来どおり skip（成功終了）で据え置く。**
  手動 `workflow_dispatch` の日付誤りや非開催日を赤くしないため。
  computer ディレクトリはあるが対象日ファイルが 0 件の場合も同様に skip。
- 南関 `importPrediction.js` は `assertInjectionSafe` を呼んでいないため対象外（本判断は JRA のみ）。
- keiba-data-shared-admin 側の dispatch 設計は変更していない。AK 側の再取得だけで
  一覧・内容の両 staleness を吸収できることをテストで固定したため。

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

## 2026-07-21 — D1 境界A 実施（v2-dry-run 移行・実顧客送信なし）

入口停止（A1 OFF）+ A2 OFF を先に行い（Airtable UI 手動・API 不可）、pending 0 を確認したうえで
gate env 5 本を v2-dry-run 構成へ変更し redeploy した。**A2 OFF を先、env flip を後**の順序を厳守
（A2 ON と worker 送信可の同時成立を絶対に作らない）。dry-run では worker 送信・reconciler 書込みとも
無効で、実顧客送信 0。rollback は FLOW_VERSION=legacy + redeploy（A2 は再 ON しない）。
worker 有効化（境界C）は実顧客送信を伴うため別承認。

- `astro-site/docs/PAYMENT_EMAIL_V2.md` §D1 境界A 実施記録

## 2026-07-21 — D1 cutover 完了（v2-full 稼働）・Event Webhook は別 Phase

境界 A（v2-dry-run）→ B（カナリア再検証・実受信 1 通）→ C（worker 有効化）→ A1 再開（A2 OFF 維持）→
D（reconciler write 有効化）を順に実施し、入金確認メール v2 を **gate=v2-full** で本番稼働させた。

### 確定事項

- **単一送信の構造保証**: A2 OFF を維持し、confirm（v2 分岐）は pending を書くだけ・送信は dispatcher→worker
  の 1 経路のみ。A2 ON と worker 送信可を同時成立させない原則を cutover 全体で厳守。
- **A1 ON は worker 有効化の後**に実施（pending 生成より先に送信経路を用意）。
- Scheduled は 30 秒上限に合わせ dispatcher 3 件 / reconciler 10 件 + deadline 25s。
- **Event Webhook（S9）は別 Phase**。署名検証キー（新規 secret）+ SendGrid 管理画面設定 + spoof/冪等/
  out-of-order 実装を要し、D1 完成条件に含まれない。accepted と delivered は状態機械で既に区別済みで、
  webhook 無しでも accepted で正しく終端する。
- **legacy noreply 経路は残課題**（別タスク）。gate=v2-full では confirm は v2 分岐（support@keiba.link）を通る。

### rollback（有効・追加承認不要）

GLOBAL_PAUSE=true → redeploy で新規送信即停止（A2 は再 ON しない）。必要なら FLOW_VERSION=legacy。

- `astro-site/docs/PAYMENT_EMAIL_V2.md` §D1 cutover 完了記録 / §Event Webhook（別 Phase）

## 2026-07-21 — SendGrid Event Webhook を「fail closed 化（Phase 0）」から着手し、S9 本体より先行させる

Payment Email v2 の次 Phase 候補（S9 Event Webhook / legacy noreply 整理）の依存関係を read-only 調査した結果、
**S9 は現行運用上は不要**（状態機械は `accepted` で正しく終端し、`decideWebhookEvent()` は実装済み、
本番 pending / unknown / attempting は 0）である一方、S9 が触る予定の `sendgrid-webhook.js` に
**Payment Email v2 とは無関係の既存欠陥**が見つかった。

### 検知した欠陥（既存・v2 が作ったものではない）

- 公開 URL でありながら**署名検証・認証が一切無い**（repo 全体に署名検証コードが 1 件も存在しなかった）
- POST body の `event.email` を信じて `EmailBlacklist` に create / PATCH する。
  `EmailBlacklist` は `newsletter-preview.js` が配信除外に使う**実運用 suppression list**
  → 第三者が 1 回 POST するだけで**任意顧客をメルマガ配信対象から恒久除外**できる
- `filterByFormula=SEARCH("${email}", {Email})` が未エスケープの外部入力を formula へ直挿し（injection）
- 受信メールアドレスを `console.log` に出力（PII）

### 決定

1. **S9 本体より先に fail closed 化（Phase 0）を実施する。** 対象ファイル・必要 secret・
   署名検証モジュールが S9 と完全に同一であり、S9 の前提工事そのものであるため。
2. **検証鍵未設定は「検証省略」ではなく 403。** 「鍵が無いときは素通り」分岐を作らない
   （guard テストで構造的に禁止）。設定不備は 500 ではなく 403 とし、
   「一時障害だから後で届く」という誤解を作らない。
3. **検証成功後にのみ body を parse する。** 未検証入力へ構文エラー（400）を返さず認証段の 403 を返す
   （カナリア認証で確立した secret-first fail closed と同一方針）。
4. **署名検証は単一源** `src/lib/webhooks/sendgridSignature.js` に集約し、Function 側に再実装しない。
5. **SendGrid 側 Event Webhook は未登録／無効**であることをユーザーが確認済みのため、
   本変更の deploy は**機能損失ゼロ**（env 投入・SendGrid 管理画面操作とも不要）。
6. **legacy noreply 整理を同シリーズで実施**（下記）。

### 却下した選択肢

- **S9 を先に実装する**: 新規 secret provision + SendGrid 管理画面設定（ユーザー操作 = 高リスク境界）に
  ブロックされ、かつ現行運用上の課題を解いていない。無認証書込みを放置したまま機能追加することになる。
- **鍵が未設定なら検証をスキップして従来通り受け付ける**: 欠陥をそのまま温存する。却下。
- **Function 内で署名検証を実装する**: 検証ロジックが Function に閉じるとテスト不能・再混入検知不能。却下。

### 関連

- `astro-site/docs/SENDGRID_WEBHOOK.md`（契約・reason コード・本番反映順序の単一源）
- `astro-site/docs/PAYMENT_EMAIL_V2.md` §Event Webhook（S9）

## 2026-07-21 — legacy 決済メール経路も senderIdentity へ寄せる（noreply rollback 経路の解消）

`confirm-bank-payment.js` の legacy 分岐と `send-payment-confirmation-auto.js` は
`email-config.js` の `FROM_EMAIL`=`noreply@keiba.link` で送信しており、
**gate を `FLOW_VERSION=legacy` へ rollback すると送信元が noreply へ戻る**残課題だった。

### 決定

- 両ファイルの `FROM_EMAIL` import を削除し、**`senderIdentity.js`（単一源）へ移行**。
  不一致 / 未設定は **SendGrid へ POST する前に fail closed**（`sender_unverified: <reason>` を throw。
  env の値は含めない）。
- **fail closed で可用性が下がる懸念は成立しない**: 本番 `SENDGRID_FROM_EMAIL` が正式値
  `support@keiba.link` であることは D1 境界B カナリアの実受信で実証済み。
  よって legacy rollback 経路は fail closed 化後も機能する。この前提を guard テストで固定する。
- `send-payment-confirmation-auto.js` の fail closed は **`PaymentEmailSent=true` を書く PATCH より前**に
  起こす（未送信なのに送信済みになるズレを作らない）。順序も guard テストで固定。

### スコープ外（意図的）

`send-payment-confirmation.js` / `paypal-webhook.js` は依然 `FROM_EMAIL`（noreply）を使うが、
両者は「未使用だが到達可能・誤操作で二重送信」であり、**本来の対処は 410 Gone / redirect による無効化**。
送信元だけ差し替える半端な修正は行わない（別タスク）。

### 関連

- `astro-site/docs/PAYMENT_EMAIL_V2.md` §legacy noreply 経路（2026-07-21 解消済み）
- `astro-site/src/lib/payments/paymentEmailSender.guard.test.mjs`（legacy 経路 5 テスト追加）

---

## 2026-08-06 — 外部リストは Customers へ入れず「見込み客プール」で扱い、反応者だけ自動昇格する

### 背景

外部 CSV の 1 万数千件を Airtable Customers へ取り込む方式で進めていたが、
**未反応のアドレスまで顧客台帳に入る**と顧客数・セグメント・集計が薄まり、
「顧客」と「まだ顧客でない人」の区別が消える。配信停止・バウンスの管理対象も無駄に膨らむ。

### 決定

1. **外部 CSV は Customers へ入れない。** Redis の見込み客プール（`ak:prospect:`）で扱う
2. **1 回でも open / click した人だけ**を Customers へ昇格させる（`プラン=Free`）
3. **3 回送って無反応なら登録せず**、以後の配信対象から**永久に**外す
4. 昇格は **10 分ごとの Scheduled Function（`cron-prospect-worker`）が自動**で行う。
   管理画面の「昇格」は**手動の救済・再実行**用途

### 抑止は TTL で消さない（最重要）

除外（bounce / 苦情 / 配信停止）と打ち切り（無反応 3 回）は
`ak:prospect:blocked:<sha256>` に **TTL なし**で残す。**TTL で消すと CSV を入れ直したときに
配信対象として復活する。** 台帳が持つのは `hash` / `kind` / `reason` / `at` / `sends` だけで、
**アドレスは持たない**。生アドレスを持つのは配信中のレコードだけで、抑止後は削除してよい。

### PII の扱いを 1 か所だけ緩める

AK の Redis は原則 PII を保存しないが、**送るには本人のアドレスが要る**一方、
反応前は Customers へ入れない方針なので他に置き場が無い。そこで
**`ak:prospect:` 配下に限って**アドレスの保存を許し、代わりに
キーは `sha256(email)` / 一覧・ログ・集計にアドレスを出さない / 抑止後は削除できる、
という制約を課した。他の名前空間へアドレスを書く禁止は従来どおり。

### 二重登録を防ぐ

- 取り込み時と送信時の**両方**で Customers のアドレス集合と突合（Customers が正）
- 昇格は `promo-lock:<hash>` を **`SET NX`** で 1 つだけ取る（自動と手動が同時でも 1 件）
- **Airtable の CREATE が成功したときだけ** PROMOTED にし、`promotedRecordId` を残す
- 失敗したら **ENGAGED のまま + claim 解放** → 次の tick で再試行

### 走査は Scheduled Function だけが行う

同期 Function で Customers を全件走査すると**約 4,000 件でタイムアウト域**に入り、
15,800 件では確実に失敗する（本番実測 1,678 件で 3.5〜7.6 秒 / 上限 10 秒）。
走査を Scheduled Function へ移し、同期側は Redis の写し（`ak:customer-snapshot:`）を読む。

**公開 URL から走査を起動させない。** scheduled function への HTTP は Netlify が 403 で拒否する。
管理画面の「写しを更新」は**認証済み管理 API が Redis に依頼札を立てるだけ**で、
次の tick が拾う。公開 background function 方式は**採用しない**（誰でも重い走査を起こせるため）。

### 却下した選択肢

| 案 | 却下理由 |
|---|---|
| 全件を Customers へ取り込む | 顧客台帳が薄まる。配信停止・バウンス管理が膨らむ |
| 抑止に TTL を付ける | 消えると CSV 再取り込みで復活する（本件の最重要欠陥） |
| 公開 Background Function で走査 | 公開 URL から誰でも重い走査を起こせる |
| webhook 内で Airtable へ登録 | webhook の応答が遅れ、配信基盤の再送を招く |
| 送信回数を enqueue 前に数える | 失敗した回まで数え、無反応 3 回の打ち切りが早まる |

### 関連

`docs/spec.md`「見込み客プール」/ `docs/progress.md` / PR #241

---

## 2026-08-07 — 管理画面の「強い操作語」は、公開側の最終挙動まで一致していなければ未完成とする

### 背景

管理画面で「販売可」にした会員に Premium Plus の購入 CTA が出ず、
**運用者の違和感から**初めて発覚した。実装・テスト・CI はすべて green だった。
原因は「販売可（eligible）にした＝すぐ買える」という**運用者の理解と実挙動のズレ**で、
段階公開（PHASE 1→4）の待機日数が残っていた。

### 決定

1. **管理画面の文言と本番挙動の意味一致を、機能の完成条件に含める。**
   文言が実挙動と違えば、コードが正しくても**未完成**とする。
2. **「即時販売」「送信」「昇格」「販売可」などの強い操作語**は、
   保存値や画面表示だけでなく **公開側の最終挙動まで一致**していることを **E2E で確認**する。
3. **「即時販売」の定義**: 管理者が確定した時点で、その顧客を**即 PHASE 4 相当**にし、
   **Premium Plus 商品ページ（`/premium-plus/`）へのアクセスと購入を即時可能**にすること。
   **単なる eligible 化や段階公開の開始ではない。**
   ⚠️ **三連複ページ上の teaser / CTA などの販売導線は、既存の段階公開設計を維持する。**
   「今すぐ販売可」を理由に**新しい強い CTA を即時表示する要件は無い**。
4. **管理画面の状態だけで完成判定しない。**
   **管理操作 → 保存値 → 公開判定 → 商品ページの可否 → `purchaseEnabled`** を一連で検証する。
   `showPurchaseCta` は**公開判定の値として確認してよい**が、
   「三連複ページに強い CTA が即座に出ること」を完成条件にはしない。
5. **dry-run / preview は「この操作後に顧客から何が見えるか」を明示できる設計を優先する。**
   保存値の羅列で終わらせない。
6. **実装・テスト・CI が green でも、運用者が通常理解する意味と挙動がズレていれば未完成**と判定する。
7. **恒久的な回帰条件**として次を残す（`src/lib/premiumPlus/premiumPlusImmediateSale.test.mjs`）:
   管理画面で「今すぐ販売可」を確定 → `PremiumPlusReleaseOverride = 'phase4'` →
   公開判定 `phase = 4` → `showProductPage = true` → `purchaseEnabled = true` →
   **本人が `/premium-plus/` で購入できる**
8. **今後は運用者の手動監査を前提にしない。** この種のズレは**自動テストと仕様**で検知する。

### 適用範囲

Premium Plus の販売操作だけでなく、**管理画面から本番の顧客体験を変えるすべての操作**
（メルマガ送信・無料特典付与・会員昇格・販売状態変更）に適用する。

### 関連

`docs/spec.md`「Premium Plus の『即時販売』」/ `premiumPlusImmediateSale.test.mjs` / PR #244

## 2026-08-07 販売CTA は「自動判定の理由」を管理画面で確認でき、上書きは 1 つだけ

**決定**: `UpsellTarget` の運用を次のとおり固定する。

1. **管理画面は「自動判定 CTA」「現在の設定」「実際に顧客へ出る CTA」の 3 つを区別して出す。**
   手動指定中でも「自動なら何が出るか」を並べて見せる。
2. **理由は具体的に書く。** ROUTE B なら「自動（Plus 販売対象）」で終わらせず、
   「Premium加入から30日以上経過（42日）・三連複未購入のため Plus を自動表示」と出す。
3. **経過日数を捏造しない。** `PaidAt` は 2026-07-10 の入金確認フロー刷新以降しか
   書かれておらず旧会員は構造的に空。取れないときは「加入日（PaidAt）が未記録」と明示し、
   「30 日未達」と混同させない。
4. **「自動」の判定ルール（優先順位と 2 商品同時表示なし）を管理画面に常設する。**
5. **手動上書きは 1 つだけ**（自動 / 三連複 / Plus / なし）。
   明示指定でも販売資格・契約状態・blocked 等の fail closed 条件は再評価する。
6. **説明の生成は判定から分離する。** `upsellExplain.js` はしきい値も優先順位も持たず、
   既存 resolver の戻り値を日本語にするだけ（guard テストで再実装を禁止）。

**Why**: 2026-08-07 に「PHASE 4 で開通済みの会員へ『準備しています』が出続けていた」
事故（PR #245）を追う際、管理画面から「今なぜこの表示なのか」を読み取れず、
本番データへ resolver を直接当てて初めて原因が分かった。
[[2026-08-07 管理画面の『強い操作語』は公開側の最終挙動まで一致していなければ未完成とする]]
と同じ根 —— 管理画面が内部状態しか語らず、顧客体験を語っていなかった。

**変更していないもの**: `PREMIUM_30D_DAYS = 30` / ROUTE 判定 / auto の優先順位 /
三連複 CTA と Plus CTA を同時表示しない設計。

### 関連

`docs/spec.md`「販売CTA の自動判定を管理画面で確認する」/ `upsellExplain.test.mjs` / PR #247
