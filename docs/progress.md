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

### 管理画面の実データ確認は Deploy Preview で行う（2026-08-03）

**ローカルの静的サーバー（`python3 -m http.server dist/`）では管理画面の実データ確認はできない。**
`dist/` に `.netlify/functions` は含まれず、`/.netlify/functions/admin-*` は 501/404 になる。
UI の挙動は fetch をスタブして確認できるが、**顧客取得・dry-run は確認できない**。

| 確認したいこと | 手段 |
|---|---|
| UI の挙動（表示・開閉・失効・文言） | ビルド成果物 + fetch スタブ、または `netlify dev` |
| 実データの取得（顧客一覧・dry-run） | **Deploy Preview**、または `netlify dev`（要 env） |

#### Deploy Preview の env（2026-08-03 実測）

- `PREMIUM_PLUS_ADMIN_SECRET` は **production 限定**だったため、preview の
  `admin-marketing` / `admin-comeback-grants` は secret 入力の有無に関わらず
  **HTTP 503 `管理用 secret 未設定（機能無効）`**（本番は secret 無しで 403）
- `AIRTABLE_API_KEY` / `AIRTABLE_BASE_ID` は `contexts=all` で preview にも present
- `MARKETING_CAMPAIGN_ENABLED` / `MARKETING_CAMPAIGN_DISPATCH_ENABLED` /
  `COMEBACK_GRANT_FIELDS_READY` / `COMEBACK_OFFER_TABLE_READY` は **production 限定**。
  つまり **preview からは送信・キュー登録・無料付与が構造的に起きない**（読み取りのみ）

#### env を preview へ足したときの注意

- Netlify Functions は **deploy 時点の env を持つ**。env を追加しても既存 preview には反映されない
- **空コミットでは preview は再ビルドされない**（`Canceled build due to no content change`）。
  内容の変わるコミットが要る
- rollback: `netlify env:unset PREMIUM_PLUS_ADMIN_SECRET --context deploy-preview`
  （production の値には触れない）


**Phase（2026-08-06 現在・最新）: AK 専用メルマガ自動化は Phase A / B / B-2 を Draft PR #237 まで実装し、
永続化層（Redis primitive と Definition 保存・CAS）を本番で canary 実証済み。**
本番送信 0 / 実顧客接触 0 / Airtable read・write 0 / Airtable schema 変更 0 /
`MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` は production 未設定 / scheduler 未登録。
**PR #237 は未 merge・Draft のまま。次は「管理 UI / API の production 導入前監査」。**

### ✅ 導入前監査の blocker を一括修正（2026-08-06・PR #237）

監査で挙げた blocker 6 件と correctness の主要 2 件を修正し、回帰テスト
`src/lib/marketing/automationBlockerFixes.test.mjs`（21 件）で固定した。
詳細は [`docs/marketing-automation-preprod-audit.md` の「修正の記録」](./marketing-automation-preprod-audit.md#修正の記録2026-08-06)。

| # | 対応 |
|---|---|
| A-1 | `enabled` を永続化し、さらに `loadDefinition` が **`status` から導出し直す**（正本は `status`）。ACTIVE 化した Definition が保存後も `due` になる |
| A-2 | `snapshotCount` / `snapshotOccurrenceDate` を永続化。承認済み snapshot が無ければ件数比較へ進まず `snapshot_missing` |
| A-3 | `verifySnapshotBeforeDispatch()` を新設し、**実行直前に指紋・件数・暦日・campaign 版・本文**を照合 |
| A-4 | ACTIVE 中の `update` を `active_locked` で拒否。`update` は承認済み snapshot を破棄 |
| A-5 | `authorizeInvocation()` を新設。**全呼び出しで専用 secret 必須**（`MARKETING_AUTOMATION_CRON_SECRET` + `x-cron-secret`・`timingSafeEqual`）。詐称可能な `x-netlify-event` / `isScheduled` は**認証根拠にしない**。管理画面の secret とも共用しない。**認可はゲート判定・Redis / Airtable 初期化より前**で、ゲート状況すら無認証では返さない |
| A-6 | 自動化専用ゲートを 2 つ要求（`SCHEDULER_ENABLED` + `DISPATCH_ARMED=<当日 JST 日付>`）。**日付一致なので翌日に自動的に閉じる** |
| B-1 | ページ上限で黙って `break` するのをやめ、`customers_truncated`（503）で**失敗させる**。上限も 60 → 300 ページ |
| B-2 | `preview` は**保存済み Definition を基準**にする（preset は保存済みが無いときだけ） |
| C-1 | UI はどの応答でも `writeEnabled` を反映し直し、`write_blocked` で即座に閉じる。`configVersion` の固定値送信を廃止し、設定変更で承認済み指紋を破棄 |

**dry-run・保存・実行が同じ対象集合を使う**ようになった。対象集合の組み立ては
`_computeSnapshot()` の 1 経路に集約し、`activate` は申告値を鵜呑みにせず**再計算して照合**する
（不一致は `snapshot_mismatch`）。

テスト: marketing **970 pass**、payments 246 pass、CRM 246 pass、`check:safety` 519 pass、build 通過。
**production deploy / env 変更 / Redis・Airtable write / メール送信 / merge は未実施。**
新 env `MARKETING_AUTOMATION_DISPATCH_ARMED` も production 未設定。

### 🚧 管理 UI / API の production 導入前監査（2026-08-06・**修正済み**）

read-only 監査を実施。詳細は **[`docs/marketing-automation-preprod-audit.md`](./marketing-automation-preprod-audit.md)**。
**結論: このままでは production へ入れられない。** 送信事故の危険は低い（全経路が fail-closed 側で止まる）が、
**「ACTIVE にしても動かない」「dry-run で確かめた対象と実行対象が一致しない」**という状態の食い違いが残る。

blocker 6 件（うち 2 件は fake Redis で**再現確認済み**）:

| # | 内容 |
|---|---|
| A-1 🔁 | `enabled` が `DEF_FIELDS` に無く保存されない → 保存後は `isDue` が永久に `not_active`。UI は ACTIVE と表示する |
| A-2 🔁 | `snapshotCount` も保存されない → `detectDrift` が**対象が減っても** `snapshot_grew` で常に発火 |
| A-3 | `snapshotFingerprint` を保存しているのに scheduler が照合していない |
| A-4 | ACTIVE のまま `update` でき、`activate` の「snapshot 必須 + drift 検査」を迂回できる |
| A-5 | `cron-marketing-automation` に**認証が無い**（schedule 未登録＝公開 HTTP Function） |
| A-6 | `MARKETING_CAMPAIGN_ENABLED` / `..._DISPATCH_ENABLED` は**既に production で true**（実測）。防御は実質 env 1 枚 |

correctness 4 件のうち **B-1 は進行中の外部取り込み完了で必ず顕在化する**:
Customers 取得が `MAX_PAGES=60`（6,000 件）で**黙って打ち切る**ため、
約 15,800 件になると先頭 6,000 件だけで対象集合を計算し、しかもエラーにならない。

**開放条件**: A-1〜A-3 の修正完了まで `MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` を production へ設定しない。
A-5 の解決まで `MARKETING_AUTOMATION_SCHEDULER_ENABLED` を production へ設定しない。

### ✅ 永続化層の本番 canary — Definition 保存 canary **PASS**（2026-08-06 / PR #239）

**PR #237 が使う Definition 保存・取得・CAS が、本番 Upstash 上で意図どおり動くことを実証した。**
PR #237 の未 merge 差分全体を production へ入れないため、`origin/main` 基点の**最小 canary branch**
（PR #239 `chore/marketing-automation-def-canary`、新規 4 ファイルのみ・既存変更 0）を作って実行し、
**merge せず close** した。canary Function は本番から撤収済み（`main` にこの Function は存在しない）。

#### 実証できたこと

| 対象 | 結果 |
|---|---|
| **CAS Lua**（PR #237 の `automationStore.js` から改変せず抽出。sha256 `e07dc3cf…`） | 新規作成 / version 一致更新 **OK** / **不一致は CONFLICT で上書きされない** |
| Definition のライフサイクル | 作成 → get → CAS 更新 → pause(PAUSED) → cancel(CANCELLED) → index 追加・除去 → 削除 が一連で成立 |
| `index:active`（共有キー） | canary 以外の member は **完全一致**（before 0 → after 0 / added 0 / removed 0） |
| 墓標（`SET NX`） | **cleanup 後も再 run を構造的に拒否**（`409 already_run`・副作用 0） |
| 3 経路の結果復元 | HTTP 応答 / Redis result / Function ログが**完全一致**（件数・順序・name・ok・overallOk） |

run は **exactly 1 / retry 0**、10 チェック全 PASS、`resultSaved=true`、commands 16、latency avg 199ms（max 652ms）。

#### deploy と env（4 回で固定・すべて実施済み）

| # | 内容 | 確認 |
|---|---|---|
| D1 | 固定 SHA + env unset | Function 存在・`preview`/`run` **403** `def_canary_disabled`・Redis 非接触 |
| D2 | 同 SHA + `ENABLED=true` | `preview` 200 → `run` ×1 → 3 経路一致 → cleanup（**墓標維持**） |
| D3 | 同 SHA + env unset | `preview`/`run` **403** → `finalize` → **墓標含め残存 0** |
| D4 | `main` を Build Hook で 1 回 | 公開 SHA `a787c03` / canary Function **404** / トップ 200 |

`MARKETING_AUTOMATION_DEF_CANARY_ENABLED` は実行後に unset 済み。
`MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` は**この canary で参照も追加もしていない**。

#### 先行: Redis primitive canary **PASS**（PR #238・同じく merge せず終了）

専用 prefix 内だけで `SET NX` 排他 / fencing token 単調増加 / CAS Lua / 所有権再検証 /
prefix 外操作の拒否 / fail-closed / 残存 0 を実証済み。Definition canary はその一段上として、
**本番と同じキー空間**（`def:*` と `index:active`）で確かめたもの。

#### 運用上の注意（実測で判明）

- **`netlify logs:function` は live stream 専用**（deprecated）で、実行済み run のログを返さない。
  過去ログは `netlify logs --source functions --function <name> --since <t> --json` で取得し、
  JSON Lines の各行の文字列フィールド内に埋まった 1 行 JSON を走査して抽出する
- Netlify CLI は **git worktree から `base` を解決できない**。deploy は通常 clone から行う

#### まだ実証していないこと

`run:*` / `recipient:*` / `lock:*` / `fence` を**実運用の並行実行で**使う経路（scheduler・enqueue）は
未検証。Airtable への実書き込み・実送信も未実証。**これらは管理 UI / API の導入前監査の対象。**

### 🆕 AK 専用メルマガ自動化 — Phase B-2（管理 UI・管理 API・write ゲート）

**管理画面だけで Definition の作成・編集・保存・有効化・一時停止・取消・履歴確認まで
操作できるコードを完成させた。** ただし production では**ハードゲートで全 write を拒否**し、
Redis / Airtable への接続 0 を維持している。

#### 管理 API（`admin-marketing-automation.js`）

`list` / `get` / `preview` / `runs` / `run-detail` / `status` / `create` / `update` /
`activate` / `pause` / `cancel` の 11 action。判断は `automationAdminApi.js`（I/O 注入）に集約し、
テストは **fake Redis だけ**で全経路を通せる。

**production write のハードゲート**: `create` / `update` / `activate` / `pause` / `cancel` は
`MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED=true` でなければ **Redis store 初期化より前に 403**。
handler を実際に叩いて **Redis 呼び出し 0** を実測している。
**production にこの env は設定していない。**

read 系は Redis 未設定・到達不能のとき**推測データを返さず** `store_unavailable` を明示する。

#### campaign の固定と再承認

campaign は `campaignCatalog.js` が正本で、**自由入力で存在しない ID は保存できない**。
保存時に `campaignId` / `campaignVersion` / `shellVersion` / `contentHash` を固定し、
保存後に版か本文が変わっていたら **ACTIVE 化を拒否**して再 dry-run と再保存を要求する。

> ⚠️ プリセットの campaignId 2 件が実在しないカタログ ID（`comeback` / `light-trial`）を
> 指していた誤りをテストが検出し、実在する `expired-comeback` へ修正した。
> `free-to-light` は**そのまま使える既存キャンペーンが無い**ため既定を未選択にした
> （`comeback-light-30d-granted` は「無料付与済み」前提の文面なので、
> 付与が成功した相手にしか送ってはいけない＝誤送信になる）。

#### pause / cancel

Redis 側の Definition / Run 状態変更まで実装。**Airtable への実取消は次 Phase までハードブロック**。
cancel は計画だけを返す: `PENDING 取消予定` / `SENT 取消不可` / `処理中` /
`rollback 不可（送信済み）`。**SENT を取消対象にしない**。

#### 管理画面

プリセット / 名前 / campaign 選択 / campaignVersion / contentHash / 実行条件 / 除外条件 /
実行日時・繰り返し / timezone（Asia/Tokyo 固定）/ quiet hours / 最大件数 / dry-run /
snapshot 件数・指紋 / 保存 / ACTIVE 化 / 一時停止 / 取消 / 次回実行日時 / 最終実行結果 /
run 履歴 / queued・excluded・failed・blocked / reconciliation を表示。

**未有効時**は入力と dry-run はできるが保存系ボタンは disabled、
「本番自動配信は未有効」を明示し、**API を直接叩かれても 403**（UI で隠すだけにしない）。

#### scheduler は本番登録しない

`netlify.toml` に schedule を**追加していない**（テストで登録が無いことを固定）。
`MARKETING_AUTOMATION_SCHEDULER_ENABLED` はコード上のゲートのみで production env 追加なし。

#### テスト

`src/lib/marketing` **949 pass / 0 fail**（Phase B-2 新規 24）。build 成功。回帰 payments 255 pass。

> ⚠️ Phase A の guard 6 件が Phase B の実装（write 配線・UI 刷新・Upstash の POST）と
> 食い違って落ちた。**性質は変えず**、検査対象と条件を Phase B の実態へ追随させて復旧した
> （Airtable への書き込みだけを見る / 「未配線」を「配線済みだがゲートで塞ぐ」へ など）。

> ⚠️ テストが実バグを 2 件検出した:
> ① preset に既定 campaign が無い場合、管理者が指定した**存在しない campaignId を保存できた**
> ② 固定した `shellVersion` / `contentHash` が保存項目の allow-list に無く**永続化されなかった**。
> どちらも修正済み。

---

### 🆕 AK 専用メルマガ自動化 — Phase B### 🆕 AK 専用メルマガ自動化 — Phase B（永続化・scheduler・enqueue 共通化）

**Phase A（監査・設計・dry-run）に続き、永続化と実行系を実装した。**
production deploy 0 / production Redis write 0 / Airtable write 0 / 実送信 0 / 新規 env 投入 0。

#### Redis キー設計（AK 専用 prefix）と正本の範囲

すべて `ak:marketing-automation:` 配下。**他用途の鍵空間へ触れない**
（`payemail:*` / `customer-import:*` / KMA）。prefix 外は `assertKey` が構造的に拒否する。

| 鍵 | 用途 |
|---|---|
| `ak:marketing-automation:def:<automationId>` | AutomationDefinition |
| `ak:marketing-automation:run:<runId>` | AutomationRun |
| `ak:marketing-automation:lock:<automationId>` | scheduler の claim |
| `ak:marketing-automation:recipient:<runId>:<sha256>` | 受信者 claim |
| `ak:marketing-automation:index:active` | ACTIVE 索引 |
| `ak:marketing-automation:fence` | fencing token |

**正本の範囲を明確化した:**

- **Redis が正本** … 自動化の**設定と進行**（Definition / Run / claim / lock）
- **Airtable が正本** … **送信の事実**（ScheduledEmails / CampaignDeliveries / EmailEvents）

「送ったかどうか」を Redis で判断しない。Redis が消えても送信済みの事実は Airtable に残り、
二重送信の最終防壁は `CampaignDeliveries.DeliveryKey` の冪等 upsert 側にある。

**PII を保存しない。** 受信者は**正規化メールの sha256 だけ**を鍵に使い、値は状態と件数のみ。
許可外の項目は保存前に落ち、許可項目に紛れた PII（文字列中のアドレスを含む）は拒否する。

#### atomic 性・lost-update 対策

- Definition 更新は **`configVersion` 付き CAS**（Lua）。競合したら書かずに例外
- scheduler claim は **`SET NX EX`** + **fencing token**（`INCR`）
- 書き込み直前に `verifyClaim` で所有権を再確認。**stale scheduler は enqueue しない**
- 同一 `automationId` + JST 配信回 → **runId は決定的**（`auto:<id>:<JST 暦日>`）
- 同一 runId の二重開始は **`SET NX` で atomic に拒否**
- recipient claim は `runId + 正規化メール sha256` で一意
- Redis 到達不能 / 応答不明 / CAS 不一致 / lock 状態不明 は**必ず例外にして伝播**（fail-closed）

#### scheduler（`cron-marketing-automation.js`・**production では常時無効**）

**3 ゲートが全て true でなければ Redis にも Airtable にも接続しない**:
`MARKETING_AUTOMATION_SCHEDULER_ENABLED` / `MARKETING_CAMPAIGN_ENABLED` /
`MARKETING_CAMPAIGN_DISPATCH_ENABLED`。
Phase B では**新規 env を production へ設定しない**ので、常に 1 番目で止まる。
ゲート判定は store 初期化より前にあり、実際に叩いても Redis 呼び出し 0 であることをテストで実測。

責務: ACTIVE 取得 → JST/quiet hours 判定 → due だけ claim → snapshot 再評価 →
drift 検知（snapshot 増加 / campaignVersion 変更 / contentHash 変更）→ 安全なら enqueue 候補 →
**1 tick の automation 数（3）と件数（500）に上限**。上限超過は**切り捨てず停止**する。

#### enqueue 共通化

`marketingEnqueueContract.js` を新設し、**管理画面の手動送信と自動配信が同じ関数**で
ScheduledEmails の行を作るようにした。既存 `admin-marketing.js` もこの契約経由へ切り替え済み。

**やっていないこと（禁止事項）**: 内部 HTTP で admin-marketing を呼ぶ / ScheduledEmails を別形式で作る /
dispatcher を直接起動する / 送信 API を直接呼ぶ / 既存と違う deliveryKey を作る。
JobId は既存の `mkt-` 接頭辞を保ち、既存 dispatcher の判定から外れない。
自動化由来のジョブは Notes に `auto:` / `run:` / `op:` / `snap:` を刻む（**アドレスは入れない**）。

> ⚠️ 既存 guard 2 件（書き込み payload 検査・スナップショット保存検査）は payload が
> 契約モジュールへ移ったことで一度落ちた。**性質は変わっていない**ため、検査対象を
> 契約モジュールへ追随させて復旧した（緩めていない）。marketing 全 925 pass で確認済み。

#### 配信直前の再判定

enqueue 時点だけでなく **dispatcher 直前にもう一度**、既存 AK ルールで判定する
（配信停止 / hard・soft bounce / 送信不可 / テストアカウント / 現在のプラン・有効期限 /
キャンペーン不整合 / 既送信 deliveryKey）。外れていたら**送らず除外理由を残す**。

#### 突合（reconciliation）

**Redis Run counters / recipient claims / ScheduledEmails / CampaignDeliveries / EmailEvents** の
5 系統を突合。不一致は `BLOCKED`、失敗残りは `PARTIAL` とし**自動続行しない**。
provider 受理と実配信を混同せず、受理数が queued を超えたら BLOCKED。**送信済みは再送しない**。

#### テスト

`src/lib/marketing` **925 pass / 0 fail**（Phase B 新規 38）。build 成功。回帰: payments 255 pass。

CAS 競合 / scheduler 二重起動 / fencing token / stale scheduler / Redis timeout・応答不明 /
run 二重開始 / recipient 二重 claim / 同一 JST 日 run 重複 / quiet hours 境界 / DST 非依存 /
maxRecipients 超過 / dry-run 後の対象増加 / campaignVersion 変更 / contentHash 変更 /
配信直前の有料化・配信停止・bounce 除外 / SENT 取消拒否 / reconciliation 不一致 /
PII 非保存 / KMA 混入なし / 送信経路 1 本 / **ゲート未設定時の Redis 接続 0**。

#### Phase B で配線していないもの

実 enqueue（契約は用意済み・呼び出しは未配線）/ scheduler の本番有効化 /
設定 UI の保存操作。**新規 env は production へ 1 つも設定していない。**

---

### 🆕 AK 専用メルマガ自動化 — Phase A### 🆕 AK 専用メルマガ自動化 — Phase A（2026-08-06・Draft PR）

**KMA を AK へ統合しない。** tenant / 顧客 / キャンペーン / 送信元 / 配信停止 / 台帳 / env /
Redis / Airtable / 料金 / UI は**一切持ち込まない**。KMA から参考にしたのは
**状態機械・冪等性・quiet hours・再試行・取消・監査という一般設計だけ**で、
実装・データ・設定の正本は**すべて AK 内**。guard テストで KMA 由来の識別子混入を固定している。

#### read-only 監査でわかった既存基盤（再利用する）

| 役割 | 既存の正本 |
|---|---|
| ジョブ正本 | `ScheduledEmails` |
| 1 通ごとの正本 | `CampaignDeliveries` |
| 受信者単位の冪等キー | `newsletter/delivery-key.js`（`extraKey` を持つ） |
| 配信可否（配信停止・バウンス・停止・テスト） | `marketing/customerMarketingAudience.js` |
| キャンペーン固有条件 | `marketing/campaignAudienceRules.js` |
| 文面・version・contentHash | `marketing/campaignCatalog.js` |
| enqueue（送信はしない） | `netlify/functions/admin-marketing.js` |
| 実送信ゲート | `MARKETING_CAMPAIGN_DISPATCH_ENABLED`（既存メール経路と独立） |

**新しい配信基盤は作らない。** 自動化は「いつ・誰に・どのキャンペーンを」を決めるだけで、
enqueue と送信は上記の既存経路にそのまま乗る。**送信経路は 1 本のまま**。

#### 追加したもの（すべて新規ファイル）

| 目的 | ファイル |
|---|---|
| プリセット定義（**全て初期 OFF**） | `src/lib/marketing/automationCatalog.js` |
| 状態機械・quiet hours・冪等キー | `src/lib/marketing/automationModel.js` |
| 対象判定・snapshot 指紋 | `src/lib/marketing/automationEligibility.js` |
| 管理 API（list / preview=dry-run / status） | `netlify/functions/admin-marketing-automation.js` |
| 管理画面「自動配信（下見のみ）」 | `src/pages/admin/premium-plus-eligibility.astro` |

#### プリセット 7 件（すべて初期 OFF）

`expiry-d7` / `expiry-d0` / `comeback-d7` / `comeback-d30` /
`free-to-light` / `light-to-premium` / `manual-condition`

**誕生日トリガーは実装していない。** `Customers` に生年月日フィールドが無く、
現行 schema では安全に判定できないため **設計候補（`DEFERRED_TRIGGERS`）として分離**した
（実装には Airtable schema 変更が必要）。未入金フォローも同様に分離している。

#### 状態機械

`DRAFT` / `ACTIVE` / `PAUSED` / `RUNNING` / `COMPLETED` / `FAILED` / `CANCELLED`。
遷移は allow-list で固定し、`ACTIVE` 以外へ移ると `enabled` が落ちる。
終端（COMPLETED / FAILED / CANCELLED）は自動実行しない。

実行単位は `AutomationDefinition` → `AutomationRun` → **既存 `ScheduledEmails`** → `EmailEvent`。

#### 冪等性・snapshot

- `automationRunId = auto:<automationId>:<JST 暦日>` … **同一自動化・同一暦日は同じ ID**
  （scheduler が重複起動しても配信回は 1 つ）
- `operationId = <runId>#<試行番号>`
- `recipientKey = <runId>|<正規化メール>` … 既存 `computeDeliveryKey` の `extraKey` へ渡す前提。
  **新しい鍵体系を作らない**
- snapshot 指紋は**正規化アドレスの sha256 を並べて畳む**（アドレスを復元できない）。
  dry-run と本実行で**増えていたら停止**（減っているだけなら安全側として進む）

#### 安全要件の実装状況

- dry-run 必須（`requireDryRun`）／実行前に対象 snapshot を固定
- 本番送信ゲートが閉じていれば **fail-closed**（dry-run は送信しないのでゲート非依存）
- quiet hours（既定 21:00-8:00 JST・日をまたぐ帯に対応）／最大送信件数超過で停止
- 取消は**未送信だけ**。`SENT` は取消も再送もしない。成功した登録を失敗へ巻き戻さない
- 除外は**既存 AK ルールをそのまま通す**（自動化側で再実装しない）
- **会員昇格・PaymentConfirmed・Status・PlanType・有効期限・特典を書く経路が無い**
  （Airtable へ GET しか出さない。guard で固定）

#### Phase A で配線していないもの

`enable` / `run` / `cancel` / `pause` は **501**（`not_wired_phase_a`）。
設定の永続化先（AK 専用 prefix の Redis を想定）と実行の配線は **Phase B**。

#### テスト

`src/lib/marketing` **887 pass / 0 fail**（新規 61 = flow 38 + guard 23）。build 成功。

同一 run 二重開始 / scheduler 重複起動 / 同一 recipient 二重登録 / dispatcher 再実行 /
配信前の有料化 / 配信停止 / バウンス / quiet hours / 最大件数超過 / dry-run と本実行の snapshot 差 /
一部登録失敗 / 取消と SENT / 会員状態を変えない / **KMA 混入 guard** / 送信経路が 1 つだけ。

**Phase（2026-08-05 現在・最新）: 外部リストの本番取り込みが 3 バッチ完了（10 + 100 + 100 = 210 件・
Customers 1,676）。write ゲートは再閉鎖済み（`CUSTOMER_IMPORT_WRITE_ENABLED` unset + deploy 済み・
`run` は 403 `write_disabled` を実測）。残り CREATE 候補 14,284 件。**

**（土台）実 CSV 3 ファイルに合わせた取り込み規則の確定と本番 write path
（**PR #233 merged `7de7e74`・production deploy `6a71e6a531d919000874b180` = state ready・公開中**）。**

- **目的**: 実データに合わせて規則を確定し、**安全な本番 write path** を Draft PR まで作る。
  初回は **CREATE のみ**・**最大 100 件**・**既存 1,158 件は更新しない**。
- **🔴 発見した不具合（本 PR で修正）**: `admin-customer-import.js` の
  「現役の有料会員を取り込まない」判定が**一度も動いていなかった**。
  `resolveCustomerMarketing()` が返すのは `plan` なのに `mk.planGroup` を見ており、
  `undefined` 比較で条件が常に false だった。8/4 の下見で `paid_member: 0` と出たのは
  「有料会員が居なかった」のではなく**判定が動いていなかった**という意味。
  → 純粋モジュール `importAkFacts.js` へ切り出し、契約（plan×contract）と
  権利（`premiumActive` / `lightActive`）の**両方**で判定。テストで固定。
  修正後の実測は **`paid_member` 12 件**（AK の現役有料 21 名のうち 12 名が CSV に含まれていた）。
- **状態列の実測**: file1 の `状態` は **「配信中」1 種のみ**（6,160 件 / 空欄 0）。
  `エラーカウント数` は 0/1/2（**≥1 が 78 件**）。→ 既知ラベル表を単一源にし、
  **未知ラベルは REVIEW_REQUIRED**（fail closed）。配信失敗歴 ≥1 も REVIEW_REQUIRED。
- **3 ファイル統合規則**: 正本は**統合後の正規化一意メール**（ファイル日時で優先順位を決めない）。
  file2 は file3 に完全包含・file1 のうち file3 に無いのは 109 件。
  氏名は**空欄補完のみ**、**食い違いは自動決定せず REVIEW_REQUIRED**（実測 1 件）。
  電話番号・エラーカウント数は取り込まない。
- **実 CSV 適用結果（read-only / write 0）**:

  | 分類 | 件数 |
  |---|---|
  | 母数（統合後の一意アドレス） | **15,779** |
  | `CREATE_CANDIDATE` | **14,494** |
  | `UPDATE_CANDIDATE`（**更新しない**） | **1,158** |
  | `EXCLUDED` | 33 |
  | `REVIEW_REQUIRED` | 94 |
  | 合計 = 母数 | ✅ `balanced: true` |

  理由別: `delivery_error_history` 78 / `provider_suppressed` 19 / **`paid_member` 12** /
  `role_address` 8 / `duplicate_in_ak` 7 / `soft_bounce` 1 / `test_account` 1 / `name_conflict` 1
- **Airtable 実スキーマにもとづく新規レコード**: `Email` / `プラン=Free` / `ポイント=0` /
  `Source=customer-import:<batchId>` / `氏名`（一意に決まるときだけ）。
  **`登録日` は createdTime（計算フィールド）なので書けない**。
  **`CreatedBy` / `ImportBatchId` / `ImportedAt` は Customers に存在しない**ため、
  列があるときだけ書き、無ければ `Source` に出所とバッチを埋め込む（rollback の隔離キー）。
- **二重ゲート**: `CUSTOMER_IMPORT_WRITE_ENABLED=true` ＋ 確認文字列 `IMPORT <batchId> <件数>`。
  片方でも欠ければ書き込み 0。初回は 100 件上限（101 以上は `over_limit`）。
- **運用判断（2026-08-05 / ユーザー決定）**:
  - `エラーカウント数 ≥1` の **78 件は REVIEW_REQUIRED のまま維持**（CREATE に含めない）
  - Airtable に `CreatedBy` / `ImportBatchId` / `ImportedAt` 列は**今回は追加しない**
  - 初回のバッチ追跡は **`Source = customer-import:<batchId>`** を使う

- **merge / deploy 記録**:

  | 項目 | 値 |
  |---|---|
  | PR | #233（squash merge・force push / reset / rebase / amend なし） |
  | merge SHA | `7de7e74`（merged 2026-08-04T13:18:27Z） |
  | merge 前 origin/main | `3e6ae4c`（分岐点 `97cd0b4` から南関の自動取込のみ前進。crm / functions は無変更） |
  | changed files | **14 件**（新規 8 / 変更 6）。lockfile・workflow・package.json は無変更 |
  | production deploy | `6a71e6a531d919000874b180` / commit `7de7e74` / **ready**・published 13:19:31Z / deploy_time 60s |

- **deploy 後の本番 read-only 確認（Airtable write 0 / Customers 作成 0 / メール 0 / 実 CSV 未送信）**:

  | 確認 | 結果 |
  |---|---|
  | `CUSTOMER_IMPORT_WRITE_ENABLED` | **(unset)** |
  | `run`（env 不足） | **403 `write_disabled` / `written: 0`** |
  | `run`（確認文字列なし・101 件指定） | いずれも **403**（ゲートより先へ進まない） |
  | secret 不一致 / GET / 未知 action | 403 / 405 / 400 |
  | 下見側 `action:'run'` | **501**・`writeEnabled: false`（書き込み経路が無いまま） |
  | **Customers 件数（実行前後）** | **1,466 → 1,466（一致＝書き込み 0 を実測）** |
  | `plan`（合成 1 行 CSV） | 200 / `sideEffects: none` / `writeEnabled: false` / 確認文字列 `IMPORT imp-2026-08-04-001 1` を提示 |
  | 書き込む列（本番実測） | `Email` / `氏名` / `プラン` / `ポイント` / `Source` のみ |
  | 監査列 | **「列が無いので書かない」**（判断どおり Airtable schema は未変更） |
  | 管理画面 | 初回方針 6 点を明示・`impRun` は `disabled` + `aria-disabled` / **クリック配線なし** |

  ⚠️ gate 到達の確認には **合成 1 行 CSV**（`example.invalid`）を使い、**実 CSV は本番へ送っていない**。

### ✅ 初回カナリア取り込み 10 件 — 実施完了（2026-08-04・ユーザー承認済み）

**外部リストから AK 本番 Customers へ初めて書き込んだ。** 承認範囲は 10 件のみ。

| 項目 | 値 |
|---|---|
| ImportBatchId | **`imp-2026-08-04-001`** |
| Source（追跡・rollback キー） | **`customer-import:imp-2026-08-04-001`** |
| 確認文字列 | `IMPORT imp-2026-08-04-001 10` |
| run 要求 | **exactly 1 回**（HTTP 200 / 10.8 秒）・**再送なし** |
| created / failed | **10 / 0** |
| skippedExisting / skippedAlreadyDone | 0 / 0 |
| reconciliation | `planned 10 = created 10`・**`balanced: true`**・`withinPlan: true` |
| Customers 総数 | **1,466 → 1,476**（+10） |
| Source 一致件数 | **10** |

**作成内容の検証（read-only・全 10 件）**: `プラン=Free` / `ポイント=0` / `Email` あり /
`氏名` は 9 件（一意に決まったもののみ）。
**`Status` / `PlanType` / `有効期限` / `PaidAt` / `PaymentConfirmed` / `LightGrantUntil` /
`PremiumGrantUntil` / `LifetimeSanrenpuku` / `UnsubscribedAnalyticsKeiba` / `Phone` /
`AudienceType` / `Brand` は全件空**。`登録日` は Airtable が createdTime で自動付与。
**同一メール重複の組数は 10 組のまま（実行前と同数）＝今回作成分に重複なし。**

**ゲート運用**:

| 段階 | 操作 | 結果 |
|---|---|---|
| 事前 | read-only plan + 13 項目の gate | 全通過（writeEnabled=false のまま） |
| 開放 | `CUSTOMER_IMPORT_WRITE_ENABLED=true`（production）+ **deploy 1 回**（Build Hook / `6a71ebac28df11000803947b`） | writeEnabled=true を実測 |
| 実行 | `action:'run'` × 1 | created 10 |
| 閉鎖 | **env unset** + **deploy 1 回**（`6a71ec6c2d46640008d9da38`） | **env unset / run は 403 `write_disabled` / `written: 0`** を実測 |

- **UPDATE_CANDIDATE 1,158 件は 1 件も更新していない**（PATCH 経路が存在しない）
- **EXCLUDED 33 / REVIEW_REQUIRED 94 も書き込み対象外**
- **メール送信 0**（実行 Function に送信経路なし）／**Airtable schema 変更 0**／**削除 0**
- 実行中の per-row 再試行は 429/5xx 用の設計だが、**今回は全件 1 回で成功**（再試行の発生なし）

### 2 回目（100 件）の準備 — まとめ書き実装（**PR #234 merged `9f9e0e9`・production deploy `6a71f76577a80500085f4d0c` = ready・公開中**）

**2 回目の実行前 gate で「100 件はタイムアウトする」ことを実測で検知し、実行前に停止した。**

| 実測 | 値 |
|---|---|
| `plan`（CSV 送信 + Customers 全件取得 + 停止リスト取得の固定コスト） | 8,053ms |
| 1 件あたりの作成（初回 10 件 = 10,787ms から逆算） | 約 273ms |
| 100 件の見積り | **約 35 秒** |
| Netlify 同期 Function の上限 | 26 秒（Pro 最大。`netlify.toml` に timeout 指定なし） |

途中で切れると**作成済みだけ残って結果が返らない**ため、env に触れる前に停止した（書き込み 0）。

→ **Airtable のまとめ書き（1 リクエスト 10 件）に対応**。100 件が 10 リクエスト（見積り約 11 秒）になる。
安全性は据え置き: 適格判定（冪等キー・直前再判定・上限・許可列）は**書き込みより前に全件通し**、
**チャンクが失敗したら 1 件ずつ書き直して原因を切り分ける**（1 件の不備で 10 件を曖昧にしない）。
許可外の列があれば**1 件も書かない**。テスト 42（うち bulk 8）／CRM 全体 246 pass。

2 回目の実行前 gate は**この項目以外すべて通過済み**:
初回 10 件は健全（Source 一致 10 / 全件 Free・ポイント 0 / 課金・特典・Status 空 / 重複なし）/
Customers 1,476 / 新バッチ `imp-2026-08-04-002`（同一 Source の既存 0）/ 3 ファイル hash 一致 /
**CREATE_CANDIDATE 残数 14,484**（初回 10 件が UPDATE 側 1,168 へ移動）。

**deploy 後の read-only 検証（2026-08-04 / 書き込み 0・実 CSV 未送信）**:
`CUSTOMER_IMPORT_WRITE_ENABLED`=unset / `plan` の `writeEnabled`=false /
`run`=**403 `write_disabled`・`written: 0`** / Customers **1,476**（初回カナリアのみ）/
初回 Source 一致 **10** / 新 Source（`…-002`）**0 件**。gate 確認は合成 1 行 CSV で実施。

### ✅ 2 回目 取り込み 100 件 — 実施完了（2026-08-05・ユーザー承認済み）

**まとめ書き（PR #234）で 100 件を 1 回の run で完了した。** 承認範囲は 100 件のみ。

| 項目 | 値 |
|---|---|
| ImportBatchId | **`imp-2026-08-04-002`** |
| Source（追跡・rollback キー） | **`customer-import:imp-2026-08-04-002`** |
| 確認文字列 | `IMPORT imp-2026-08-04-002 100` |
| run 要求 | **exactly 1 回**（HTTP 200 / **9.7 秒**）・**再送 0（retry 0）** |
| created / failed | **100 / 0** |
| skippedExisting / skippedAlreadyDone | 0 / 0 |
| bulkRequests / singleRequests | **10 / 0**（まとめ書きのみ・1 件ずつの切り分けは発生せず） |
| reconciliation | `planned 100 = created 100`・**`balanced: true`**・`withinPlan: true` |
| Customers 総数 | **1,476 → 1,576**（+100） |
| Source 一致件数 | **100**（初回 `…-001` の 10 件は不変） |

**まとめ書きの効果**: 見積り約 35 秒（1 件ずつ）→ **実測 9.7 秒**。26 秒の同期 Function 上限に対し
十分な余裕を確認。**タイムアウトによる「作成済みだけ残る」事象は発生していない。**

**作成内容の検証（read-only・全 100 件）**: `プラン=Free` / `ポイント=0` / `Email` 全件非空 /
`Source` は全件今回バッチ。**allow-list 外の列は 1 つも書かれていない**（実測で列名を全数走査）。
`PlanType` / `Status` / `有効期限` / `PaidAt` / `PaymentConfirmed` / `LightGrantUntil` /
`PremiumGrantUntil` / `LifetimeSanrenpuku` / `UnsubscribedAnalyticsKeiba` / `Phone` /
`ForceLogout` / `AccessEnabled` / `WithdrawalRequested` は**全件未設定**。
**同一メール重複の組数は 10 組のまま（実行前と同数）＝今回作成分に重複なし。**
**今回 100 件に有料プラン 0 件・退会フラグ 0 件**（現有料会員 90 件は不変）。

**ゲート運用（初回と同じ二重ゲート）**:

| 段階 | 操作 | 結果 |
|---|---|---|
| 事前 | read-only gate **17 項目** | 全通過（`writeEnabled=false` のまま・書き込み 0） |
| 開放 | `CUSTOMER_IMPORT_WRITE_ENABLED=true`（production）+ **deploy 1 回**（Build Hook / `6a729f10a351570007eb9ae0`） | `writeEnabled=true` を実測 |
| 実行 | `action:'run'` × **1**（`count=100` / 再送なし） | created 100 |
| 閉鎖 | **env unset** + **deploy 1 回**（`6a729fceba3570000895b2be`） | **run は 403 `write_disabled` / `written: 0`** を実測 |

- **UPDATE_CANDIDATE 1,168 件は 1 件も更新していない**（PATCH 経路が存在しない）
- **EXCLUDED 33 / REVIEW_REQUIRED 94 も書き込み対象外**
- **メール送信 0**（実行 Function に送信経路なし。**SendGrid Activity API で直近 1 時間の送信 0 件を実測**）
- **Airtable schema 変更 0** / **削除 0** / **rollback 未実施**
- 公開 deploy は `7a82589`（= PR #234 `9f9e0e9` の子孫。差分は予想データと docs のみで
  **取り込みコードは byte 同一**であることを git 差分で確認してから実行した）

**🔴 実行前 gate で見つけた運用スクリプトの不具合（修正済み）**:
実行スクリプトが `action:'run'` に **`batchId` を渡していなかった**。Function 側は
`req.batchId` が無いと **UTC 日付から `imp-YYYY-MM-DD-001` を導出**するため、
日付をまたいだ 2026-08-05 の実行では確認文字列と食い違い、
**`confirmation_mismatch`（409）で 0 件のまま弾かれる**ところだった（fail closed なので
事故ではないが、deploy 1 往復を無駄にする）。run 呼び出しでも `batchId` を明示するよう修正。

- **現在地**: **取り込み由来 110 件が本番に存在**（初回 10 + 2 回目 100）。
  **write ゲートは再閉鎖済み（env unset + deploy 済み・403 `write_disabled` 実測）**
- **閉鎖後の read-only 実測**: `plan` は `writeEnabled=false` /
  **CREATE 候補 14,384**・更新しない既存 **1,268**（= 1,168 + 今回 100 が UPDATE 側へ移動）/
  除外 33 / 要確認 94 / 母数 15,779（**母数と除外・要確認は不変**）
- **次の停止境界**: **3 回目以降の取り込み**（残り CREATE 候補 **14,384 件**）。
  実行には再び ① env 投入 + deploy ② 確認文字列 の二重ゲートが要る。
  **rollback（隔離・削除とも）未実施。**

### ✅ 3 回目 取り込み 100 件 — 実施完了（2026-08-05・ユーザー承認済み）

**2 回目と同一手順で 100 件を 1 回の run で完了。** 承認範囲は 100 件のみ。

| 項目 | 値 |
|---|---|
| ImportBatchId | **`imp-2026-08-05-003`** |
| Source（追跡・rollback キー） | **`customer-import:imp-2026-08-05-003`** |
| 確認文字列 | `IMPORT imp-2026-08-05-003 100` |
| run 要求 | **exactly 1 回**（HTTP 200 / **12.4 秒**）・**再送 0（retry 0）** |
| created / failed | **100 / 0** |
| skippedExisting / skippedAlreadyDone | 0 / 0 |
| bulkRequests / singleRequests | **10 / 0**（まとめ書きのみ・1 件ずつの切り分けは発生せず） |
| reconciliation | `planned 100 = created 100`・**`balanced: true`**・`withinPlan: true` |
| Customers 総数 | **1,576 → 1,676**（+100） |
| Source 一致件数 | 今回 **100** / 初回 **10**（不変）/ 2 回目 **100**（不変）＝ 取り込み由来 **210** |

**実行直前 gate（read-only・書き込み 0・env 未変更）: 40 項目中 39 通過 → 1 件は受理**。
唯一の不一致は **公開 SHA が `7a82589`（origin/main は `4a190bc`）** で、原因は 2 回目の
docs コミットの auto-deploy が **`Canceled build due to no content change`** で終わっていたこと。
`7a82589 → 4a190bc` の差分は **`docs/progress.md` 1 ファイルのみ・コード差分 0** で、
公開コードが `9f9e0e9` の子孫かつ byte 同一であることを git 差分で実測したうえで
**ユーザー承認により通過扱い**とした。なお **Build Hook 経由の deploy では `4a190bc` が
実際にビルドされ、公開 SHA と origin/main は一致した**（Build Hook は content 変化なしでもビルドする）。

**作成内容の検証（read-only・全 100 件）**: `プラン=Free` / `ポイント=0` / `Email` 全件非空 /
`Source` は全件今回バッチ。**allow-list 外の列は 1 つも書かれていない**（列名を全数走査）。
`PlanType` / `Status` / `有効期限` / `PaidAt` / `PaymentConfirmed` / `Light*Grant*` /
`Premium*Grant*` / `LifetimeSanrenpuku` / `UnsubscribedAnalyticsKeiba` / `Phone` /
`ForceLogout` / `AccessEnabled` / `WithdrawalRequested` は**全件未設定**。
**同一メール重複の組数は 10 組のまま（増加 0）**。
**今回 100 件に有料プラン 0 件・退会フラグ 0 件**（現有料会員 90 件は実行前後で不変）。

**ゲート運用（2 回目と同一）**:

| 段階 | 操作 | 結果 |
|---|---|---|
| 事前 | read-only gate 40 項目 | 39 通過 + 1 受理（`writeEnabled=false` のまま・書き込み 0） |
| 開放 | `CUSTOMER_IMPORT_WRITE_ENABLED=true`（production）+ **deploy 1 回**（Build Hook / `6a72a571bc45280008b3f7c7`） | `writeEnabled=true` を実測 |
| 実行 | `action:'run'` × **1**（`count=100` / 再送なし） | created 100 |
| 閉鎖 | **env unset** + **deploy 1 回**（`6a72a60a93d8a00007aadc04`） | **run は 403 `write_disabled` / `written: 0`** を実測 |

- **UPDATE_CANDIDATE 1,268 件は 1 件も更新していない**（実行 Function に PATCH 経路が存在しないことを
  ソースで機械確認）
- **EXCLUDED 33 / REVIEW_REQUIRED 94 も書き込み対象外**（実行前後で不変）
- **メール送信 0**（**SendGrid Activity API で直近 1 時間の送信 0 件を実測**）
- **Airtable schema 変更 0** / **削除 0** / **rollback 未実施**
- **閉鎖後の read-only 実測**: `plan` は `writeEnabled=false` /
  **CREATE 候補 14,284**・更新しない既存 **1,368**（= 1,268 + 今回 100 が UPDATE 側へ移動）/
  除外 33 / 要確認 94 / 母数 15,779（**母数・除外・要確認は 3 バッチを通じて不変**）

**取り込みの累計**

| バッチ | 件数 | Customers |
|---|---|---|
| `imp-2026-08-04-001` | 10 | 1,466 → 1,476 |
| `imp-2026-08-04-002` | 100 | 1,476 → 1,576 |
| `imp-2026-08-05-003` | 100 | 1,576 → **1,676** |
| **累計** | **210** | 残り CREATE 候補 **14,284** |

- **現在地**: **取り込み由来 210 件が本番に存在**。
  **write ゲートは再閉鎖済み（env unset + deploy 済み・403 `write_disabled` 実測）**
- **次の停止境界**: **4 回目以降の取り込み**（残り CREATE 候補 **14,284 件**）。
  実行には再び ① env 投入 + deploy ② 確認文字列 の二重ゲートが要る。
  **rollback（隔離・削除とも）未実施。**

**Phase（2026-08-04）: 外部 13,000 件の取り込み基盤（下見まで / 本番 write は未配線）
（**PR #232 merged `46f2ecc`・production deploy `6a71d222360fc900082ef050` = state ready・公開中**）。**

- **目的**: `/admin/premium-plus-eligibility/` から、ユーザーが別途保有する
  **AK 無料ユーザー約 13,000 件**を、個人情報流出・重複登録・誤送信なしで取り込める基盤を作る。
  **この 13,000 件は AK 本番 `Customers`（1,464 件）とは別物**で、まだ AK へ入っていない
- **完成条件**: 実 CSV を渡さなくても 13,000 件規模の下見が fixture で通る /
  管理画面で件数と除外理由を確認できる / PII を画面・API・ログへ出さない /
  本番 write は無効 / 既存機能が非回帰 / tests・build・CI green
- **完了済み**:
  - `src/lib/crm/csvParse.js`（新規）— UTF-8 / BOM / Shift_JIS、CRLF・LF・CR、RFC 4180 の引用符、
    空行無視、列順不同、全角空白・ゼロ幅除去、上限 8MB / 60,000 行 / 64 列。
    **MIME も拡張子も信用せず中身だけで判定**。UTF-16 は受け付けない。復号失敗は止める
  - `src/lib/crm/customerImport.js`（拡張）— 理由コードを追加
    （`hard_bounce` / `soft_bounce` / `suspended` / `test_account` / `ambiguous_match` / `unsupported_row`）。
    正式名 `CREATE_CANDIDATE` / `UPDATE_CANDIDATE` / `EXCLUDED` / `REVIEW_REQUIRED` を追加。
    **#229 の既存の綴り・戻り値は据え置き**（既存テストは無改変で通る）
  - `src/lib/crm/importPreview.js`（新規）— `importPreviewId` / `fileHash` /
    `normalizedHeaderHash`（列順に依存しない）/ `rowCount` / `classificationCounts` /
    `reasonCounts` / `parserVersion` / `ruleVersion` / `createdAt` / `expiresAt`（30 分）/ `summaryHash`。
    ファイル差し替え・列変更・件数の書き換え・版の更新・期限切れを**すべて拒否**
  - `src/lib/crm/importJobPlan.js`（新規）— 親ジョブ + 子バッチ（既定 200 / 100〜500）、
    作成と更新を別バッチ、冪等キー、同時実行禁止、失敗のみ再試行、pause/resume、
    未実行のみ取消、計画超過の検算、`CreatedBy` / `ImportBatchId` / `ImportedAt`、監査ログ、rollback 手順。
    **`CUSTOMER_IMPORT_WRITE_ENABLED`（既定 OFF）で、実行経路自体を未配線**
  - `netlify/functions/admin-customer-import.js`（新規）— `action:'spec'` と `action:'previewCsv'` のみ。
    **書き込みの綴りを 1 つも持たない**（guard で固定）。`action:'run'` は 501
  - 管理画面に「外部顧客リストの取り込み（下見）」を追加。**件数と理由コードだけ**を表示し、
    本番取込ボタンは常に `disabled`（クリック配線も無い）
- **fixture 実測（合成データ・実在アドレスなし / 738KB・13,012 行 / 読み取り 52ms）**:

  | 分類 | 件数 |
  |---|---|
  | `CREATE_CANDIDATE` | 12,680 |
  | `UPDATE_CANDIDATE` | 130 |
  | `EXCLUDED` | 202 |
  | `REVIEW_REQUIRED` | 0 |
  | **合計 = 母数** | **13,012（`balanced: true`）** |

  理由別: `paid_member` 65 / `unsubscribed` 65 / `hard_bounce` 26 /
  `invalid_email` 19 / `no_email` 15 / `duplicate_in_file` 12。
  応答にアドレス・氏名・recordId が含まれないことをテストで固定。
  別 fixture で `suspended` / `test_account` / `ambiguous_match` / `duplicate_in_ak` /
  `unsupported_row` / `role_address` / `provider_suppressed`（fail closed）も検証
- **merge / deploy 記録**:

  | 項目 | 値 |
  |---|---|
  | PR | #232（squash merge・force push / reset / rebase / amend なし） |
  | merge SHA | `46f2ecc`（merged 2026-08-04T11:50:57Z） |
  | merge 前 origin/main | `ef4873b` |
  | production deploy | `6a71d222360fc900082ef050` / context=production / branch=main |
  | deploy の commit | `46f2ecc`（**merge 後の origin/main と一致**） |
  | state / 公開 | `ready`・site の published_deploy と一致 |

- **deploy 後の本番 read-only 確認（CSV 未送信 / 書き込み 0 / メール 0 / env 変更 0）**:

  | 確認 | 結果 |
  |---|---|
  | `admin-customer-import` `action:'spec'` | HTTP 200 / `sideEffects:'none'` / 必須列 `email` / 任意 4 列 / 上限 8MB・60,000 行 / `parserVersion=csv-1` / `ruleVersion=import-rule-1` / TTL 30 分 |
  | `action:'run'`（取り込み実行） | **HTTP 501** / `writeEnabled:false`（書き込み経路が本番に存在しない） |
  | secret 不一致 / GET | **403** / **405**（入口は閉じている） |
  | `CUSTOMER_IMPORT_WRITE_ENABLED` | **(unset)** |
  | 管理画面 | 「外部顧客リストの取り込み（下見）」が配信され、`impRun` は `disabled` + `aria-disabled="true"`。**クリック配線なし**を実配信 HTML で確認 |
  | 画面の inline JS | 構文エラー 0（JS ブロック 2 件） |
  | 既存機能の非回帰 | `mkSegLoad` / `mkRenderMeasurement` / `ledgerDisplay` / `cbDryRun` / `mkRecoverBtn` すべて配信 HTML に存在 |

  ⚠️ **`previewCsv` は本番で実行していない**（実 CSV 未受領のため。合成 CSV も送っていない）。
  下見の実挙動はローカルのスモークテスト（ネットワーク遮断・9 件）で確認済み。

- **現在地**: **本番反映済み。ただし下見は「使える状態にした」だけで、実 CSV は未受領・本番 write は未実施**
- **未完了**: 実 CSV の受領と列の確定 / 本番 preview の保存先決定 /
  write path の配線（Airtable 作成・更新）/ 取り込み後の段階配信
- **次の停止境界**: **実 CSV の受領**。以降 ① 下見の本番実行（read-only）→ ② preview 保存先の決定 →
  ③ write path 配線と `CUSTOMER_IMPORT_WRITE_ENABLED` 投入 → ④ 少数バッチでの実取り込み、
  の順に**個別承認**を取る

**Phase（2026-08-04）: 配信計測の正常化（開封・クリックを AK の台帳へ入れる）
（**PR #230 merged `423c180`・production deploy `6a71a1fc9694db0008a1f99c` = state ready・公開中**）。**

- **merge / deploy 記録**:

  | 項目 | 値 |
  |---|---|
  | PR | #230（squash merge・force push / reset / rebase / amend なし） |
  | merge SHA | `423c180`（merged 2026-08-04T08:25:30Z） |
  | merge 前 origin/main | `b55f264` |
  | production deploy | `6a71a1fc9694db0008a1f99c` / context=production / branch=main |
  | deploy の commit | `423c180`（**merge 後の origin/main と一致**） |
  | state / 公開 | `ready` / published 2026-08-04T08:26:40Z（site の published_deploy と一致）/ deploy_time 66s（実ビルド） |

- **deploy 後の本番 read-only 確認（書き込み 0 / 送信 0 / env 変更 0）**:

  | 確認 | 結果 |
  |---|---|
  | `/admin/premium-plus-eligibility/` 配信 HTML | HTTP 200。新コードが載っている（`ledgerDisplay` / `計測していません` / `計測状態を確認できません` / `計測の状態`） |
  | 旧コード `le.opens ?? 0` / `le.clicks ?? 0` | **0 件**（計測無効時に「0」と断定する経路が本番から消えた） |
  | delivered 等の確定値 | `配信済み` は従来どおり数値（計測状態に左右されない）ことをコードで確認 |
  | inline JS の構文 | JS ブロック 2 件・構文エラー 0（JSON-LD 1 件も妥当）。**ブラウザでの console 実測は未実施**（下記） |
  | `send-magic-link` の click opt-out | deploy 元 `423c180` に `clickTracking: { enable: false, enableText: false }` を確認 |
  | `MARKETING_CLICK_TRACKING_ENABLED` | **(unset)**（production env・read-only 確認） |
  | Event Webhook 設定 | **未変更**（`open=false` / `click=false` のまま） |
  | テストメール | **送っていない** |

  ℹ️ 本記録をコミットした `docs/` だけの push は、Netlify で
  **`Canceled build due to no content change`（state=error 表示）**になる。`docs/` は
  site ディレクトリ（`astro-site`）の外なのでビルド内容が変わらないため。**失敗ではない**。
  公開中の deploy は `423c180` のまま変わらない。

  ⚠️ **未検証**: `admin-marketing` の応答に `measurement` / `ledgerDisplay` が実際に載るかは
  管理シークレットが要るため本番で実行していない。ただし**万一載らなくても画面は
  「—（計測状態を確認できません）」を出す**（`0` にはならない）ため、この Phase の目的は満たす。
  ブラウザでの console error 実測も未実施（/admin は Basic 認証のモーダルが自動操作を止めるため）。

- **開封計測の有効化と着弾確認 — 完了（2026-08-04）**:

  | 段階 | 結果 |
  |---|---|
  | Event Webhook の `open` を有効化 | **MK が実施**。`open=true` / `click=false` / `updated_date=2026-08-04`。webhook は 1 件のみ（`AK Event Webhook` id `aca90150-…`）で、他フラグ・通知先 URL(64 文字)・署名用公開鍵(124 文字) は**変更なし**を read-only 確認 |
  | 計測判定 | `npm run check:measurement` → **開封=計測中** / クリック=計測していません（意図どおり） |
  | 台帳への着弾 | **実顧客の開封で確認**（カナリア不要だった）。`comeback-light-30d-granted` v2 の開封が `EmailEvents` へ `EventType=open` / **`ResolutionStatus=resolved`** / `CustomerRecordId`・`CampaignDeliveryRecordId` 設定済み / `VerificationStatus=verified` / `CreatedBy=sendgrid-webhook` で記録。**遅延 9 秒**（EventAt 09:27:59Z → ReceivedAt 09:28:08Z） |
  | 管理画面 API | `action:'customerDetail'`（read-only）で `measurement.open="enabled"` / `ledgerDisplay.opens={value:1,text:"1 回",measured:true}` / `ledgerDisplay.clicks={value:null,text:"—（計測していません）"}` を確認。**前回「未検証」と記録した項目はこれで解消** |

  fixture テスト（`emailEventOpenClick.fixture.test.mjs`）が固定した形と実データが一致した。

- **カナリア（PR #231）は close・未 merge**: `marketing-canary` を v2→v3 へ版上げする PR を用意したが、
  **送信前に実配信で着弾が確認できた**ため merge・deploy・送信のいずれも行わずに close（`mergedAt=null`）。
  版上げが必要だった理由: `DeliveryKey` は `campaignId × version × 受信者`（**日付非依存**）で、
  唯一のテスト受信者は v1（7/30）・v2（8/2）とも受信済み → v2 のままでは `already_delivered` で
  正しく拒否される。**再度カナリアを送る必要が出たら、同じ版上げをやり直せばよい**
  （`campaignCatalog.js` の version ＋ `campaignCatalog.test.mjs` の LOCKED を更新。本文を変えなければ hash は不変）。

- **次の停止境界（別承認が要る）**:
  1. **click 計測（別工程）**: アカウント全体の click tracking は**有効化しない**。
     `MARKETING_CLICK_TRACKING_ENABLED=true`（production env）＋再デプロイ → カナリア（要 version 上げ）で
     本文リンクを押して `UrlCategory` が入り、`UrlPath` にクエリが**入らない**ことを確認。
     現状は unset のままで、画面は「—（計測していません）」を出す
  2. **外部 13,000 件の取り込み基盤**: 実 CSV の受領・下見 API・承認・少数バッチ。
     判定モジュール `customerImport.js` は #229 で実装済み。**実行系は未実装**
  手順・確認方法・rollback は `astro-site/docs/DELIVERY_MEASUREMENT.md`。

- **目的**: 「開封 0」が**未開封なのか計測していないのか**を区別できない状態を終わらせる。
  2026-08-04 の配信は台帳では開封 0 だったが、provider 側では **15 名が開封**していた
- **本番 read-only 実測（2026-08-04）**:

  | ジョブ | 宛先 | CampaignDeliveries | EmailEvents（台帳） | provider 実測（参考値・保持 3 日） |
  |---|---|---|---|---|
  | `…-d9678b3d-1`（8/3 22:41Z） | 28 | 28 行すべて `sent` | delivered 28 / open **0 行** | 開封 **10 名** |
  | `…-0f57abd4-1`（8/4 07:33Z＝JST 16:33） | 36 | 36 行すべて `sent` | delivered 36 / open **0 行** | 開封 **5 名** |
  | 合計 | 64 | — | delivered 64 / bounce 0 | 開封 15 名 / 21 イベント / **クリック 0** |

  計測設定: open tracking 有効 / **click tracking 無効** /
  Event Webhook 有効・`delivered,bounce,dropped,spam_report,unsubscribe=true`・**`open=false, click=false`**
- **原因**: Event Webhook が `open` を AK へ送らない設定。click は tracking 自体が無効。
  取込側（`emailEventLedger.js`）は open/click を**既に完全に扱える**ので取込コードの変更は不要
- **本 PR でやったこと**（設定変更・送信は**していない**）:
  - 顧客カルテ ⑥-2 が `le.opens ?? 0` で「開封 0 回」と**断定していた**のを修正。
    計測が有効なときだけ数値、無効なら「—（計測していません）」/ 不明なら別文言。
    delivered / bounce / 配信停止 / 迷惑報告は**確定値なので隠さない**
  - カルテ API（`handleCustomerDetail`）が計測状態を返すようにした（下見と同じ単一源）
  - **アカウント全体の click tracking を使わない設計に確定**。マーケ配信の per-message
    `tracking_settings` ＋ env ゲート `MARKETING_CLICK_TRACKING_ENABLED`（既定 OFF）に閉じ込め、
    `send-magic-link` には明示的な opt-out を入れた（後述の理由）
  - 手順書 `astro-site/docs/DELIVERY_MEASUREMENT.md`（変更前の記録・順序・rollback・確認方法）
  - read-only 確認スクリプト `npm run check:measurement`（GET のみ・値は出さない）
  - fixture テスト（設定変更後に届くはずの open/click の形を先に固定）＋ guard 2 種。
    **CRM テストが `check:safety` に入っていなかった**ため `test:crm` を新設して組み込み
- **なぜアカウント全体の click tracking を有効化しないか**: per-message で opt-out していない
  送信経路すべての本文リンクが書き換わる。実測でその中に `send-magic-link`（**15 分・単回使用の
  ログイントークン**）が含まれ、リンク検査ボットの先読みだけでトークンが消費されて
  **本人がログインできなくなる**
- **未実施（停止境界）**: 外部サービス設定変更（Webhook の open/click）／production env 変更
  （`MARKETING_CLICK_TRACKING_ENABLED`）／テストメールの実送信／PR merge／deploy
- **注意**: `netlify dev:exec` が返す secret 系 env は**マスクされる**（`****…==`）。
  取得値をローカル検証してはいけない（署名鍵を「壊れている」と誤判定した前例あり・本番は正常）

**Phase（2026-08-04）: AK 専用 CRM の基盤（大規模セグメント + 計測状態 + 大規模配信の設計）
（branch `feat/crm-segment-foundation` / **PR #229 merged `b55f264`・production deploy 済み**）。**

- **目的**: 既存の小規模フローを壊さずに、大規模配信の土台を作る。
  母集団は 3 つ ―― ① AK 登録済み 1,464 件（無料 1,374）／
  **② 外部保有の無料ユーザーリスト 約 13,000 件（AK 未取り込み）**／③ 取り込み後の統合母集団。
  **約 13,000 件は AK 本番の件数ではない。将来 AK へ安全に取り込む対象**
- **完成条件**: 大規模セグメントを read-only で集計できる / 13,000 件を DOM へ描画しない /
  PII・recordId を画面へ出さない / open・click の「0 件」と「計測無効」を区別する /
  snapshot・分割配信・段階配信の設計が固定される / **本番送信機能は未実装のまま**
- **完了済み**:
  - 新モジュール 5 本（`src/lib/crm/`）: セグメント集計 / snapshot / 分割・段階配信 /
    計測状態 / 成果追跡。すべて純粋（I/O なし）
  - read-only API `action:'segments'`（件数・除外理由・条件ハッシュ・匿名サンプルのみ）
  - 管理画面に「セグメントの下見（大規模）」を追加（個別選択と明確に分離）
  - 計測状態の表示（0 と未計測を混同しない）
  - **外部リスト取り込みの事前検査**（`customerImport.js`）: 必須列・列名ゆらぎ・文字コード・
    メール正規化・重複判定・AK 既存/配信停止/bounce/spam/有料会員との照合・
    4 区分（新規/更新/除外/要確認）・batchId・冪等キー・実行境界・rollback 手順
  - テスト 3091 pass / 0 fail（新規 100）。check:safety・build とも exit 0。360px / 820px 確認済み
- **本番 read-only 実測**: Customers 1,464 件（一意 1,454）／無料 1,374 ／
  **無料セグメント: 母数 1,374 → 送信候補 1,296 / 除外 78**
  （停止リスト 39 / 重複 18 / テスト 6 / 直近送信 6 / soft 6 / hard 2 / 配信停止 1）
- **現在地**: **PR #229 merged（`b55f264`）・production 反映済み**
- **未完了**: **外部 13,000 件の実 CSV 受領・本番取り込み・顧客レコード作成（別承認まで行わない）** /
  snapshot の本番作成 / 親ジョブ・子バッチの実行系 / 成果集計の実データ配線 /
  ~~Event Webhook の open 有効化~~ → **2026-08-04 に有効化・着弾確認まで完了**（次 Phase 参照）。
  **`click` は未実施のまま**（別工程）
- **36 名ジョブは 2026-08-04 16:33 JST（07:33Z）に送信済み**（read-only で確定。
  ScheduledEmails `mkt-comeback-light-30d-granted-v2-0f57abd4-1` = `SENT` / RecipientCount 36 /
  CampaignDeliveries 36 行すべて `sent` / EmailEvents delivered 36・bounce 0 /
  SendGrid Activity でも 64 通すべて delivered）。
  管理画面の表示（結果: 送信しました / 送信 36 通 / 失敗 0 / 除外 0 / 再送不可）と一致する。

  > **訂正**: 本書の旧記述「36 名ジョブは PENDING のまま＝1 通も送られていない」は**古い**。
  > 当時は送信ボタンがキュー登録だけで終わる不具合（判定 B）で PENDING に留まっており、
  > `b55f264` で 1 操作（キュー登録 → 送信 → 結果表示）に修正したあと、実際に送信された。
  > 修正内容自体は従来どおり: ジョブごとに 確認 → 実送信（jobId + 確認人数つき）を通すので
  > 二重送信・取り違えは防ぐ。失敗時は理由と再実行手段を表示する。
- **この Phase で未実施だったもの**: SendGrid 設定変更 / env 変更（→ 次 Phase「配信計測の正常化」へ引き継ぎ）

**Phase（2026-08-04）: 管理画面の初期化が bridge 未読込で止まる不具合を直す
（branch `fix/admin-bridge-init-order`・Draft PR・merge 前・production 未反映）。**

- **本番の実挙動で発見**（PR #227 デプロイ後のコンソール）:
  `TypeError: Cannot read properties of undefined (reading 'loadHandoff')`
- 原因は**script の実行順**。この画面は
  `<script>`（ES module・**defer**）が `window.__*` bridge を張り、
  `<script is:inline>`（classic・**解析時に即実行**）が UI 本体を動かす。
  inline の初期化末尾から `window.__cbHandoff` を**同期で**触っており、必ず undefined だった
- 影響（**#227 以前から存在**）: 例外で初期化の残りが止まり、
  ① **再読み込み時の引き継ぎ復元が動かない** ② #227 で足した**引き継ぎ復旧バーが表示されない**
- 修正: 初期化を `DOMContentLoaded` 後（module 実行後）へ回す `mkAfterBridgesReady` を追加。
  あわせて `handoffApi()` を null 許容にし、bridge が無くても**例外で画面を止めない**
- 再発防止 guard 3 件を追加。**事故を注入すると落ちることを確認済み**（空振りしていない）
- テスト 2993 pass / 0 fail。check:safety・build とも exit 0
- **未実施**: PR merge / production deploy / 付与 / キュー登録 / 送信

**Phase（2026-08-04）: 付与成功者を自動で案内メール工程へ引き継ぐ
（branch `feat/comeback-auto-handoff`・Draft PR・merge 前・production 未反映）。**

- **現象**: 36 名へ付与したあとマーケティング画面の対象が 0 名。運用者が
  「操作 ID から引き継ぎ直す」を開き、内部 ID を探して手入力する必要があった
- 付与が 1 名以上成功したら**応答の引き継ぎ票を自動採用 → タブ自動遷移 → 対象・
  キャンペーンを自動セット**。手入力は通常フローから消えた
- 引き継ぎを失った場合（別タブ・ブラウザを閉じた・付与だけ先に実施）は
  **「🎁 直近の付与成功者を引き継ぐ」1 クリック**で復元。新 read-only API
  `handoffLatest` は**入力を受け取らず**、実データから最新の 1 操作を特定する
  （新純粋関数 `pickLatestGrantOperation`）
- 手動 operationId 導線は「うまくいかないとき」へ格下げ（2 つ以上前の操作用）
- **`operationId` を画面に出さない**（`describeHandoff` から削除）。URL・localStorage にも載せない。
  票に入るのは人数と offerId だけで、対象の正本は毎回サーバーが再導出する
- production read-only 確認: 付与操作は 3 つ（36 名 / 28 名 / 1 名）あり、
  **直近の 36 名操作を一意に特定**できた。案内キャンペーンは
  `comeback-light-30d-granted:v2` が自動選択され、施策の宣言と一致
- テスト 2988 pass / 0 fail（新規 22 + guard 8）。check:safety・build とも exit 0。360px / 820px 確認済み
- **未実施**: PR merge / production deploy / 本番付与 / キュー登録 / 送信 / Airtable write

**Phase（2026-08-04）: Step 2 → Step 3 の循環（行き止まり）を解消する
（branch `fix/comeback-step2-selectable`・Draft PR・merge 前・production 未反映）。**

- **現象**: Step 2 は特典 未選択なのに、一覧判定が既定の「Light 永久無料」を基準にしていた。
  退会・課金停止 37 名が全員「この特典では対象外」→ 付与可能者 0 名 →
  「表示中の付与可能者を全選択」が効かず、顧客を選べないので **Step 3 へ進めない**
- **判定を 2 軸に分離**（単一源は維持。`checkGrantable` が `checkSelectable` を内部で呼ぶ）:
  `checkSelectable`（Step 2・**絶対除外だけ**）/ `checkGrantable`（Step 3 以降・特典依存）
- `WithdrawalRequested` **だけ**を理由に Step 2 で選択不可にしない。
  絶対除外は 重複メール / `ForceLogout` / 停止・テスト / メール不正 の 4 つ
- **既定で特典を選ばない**（旧: Light 永久無料が既定＝暗黙の判定基準）。
  未選択のうちは `grantEvaluated=false` で「Step 3 で特典を選ぶと判定します」と表示し、
  追従バーも「特典: 未選択」
- Step 3 で特典を決めた時点で選択済みを再判定し、対象外を**件数と理由付きで**外す
  （`cbPruneSelectionForOffer`）。Step 4 dry-run・実行直前も同じ関数を通る
- production read-only 実測: 退会・課金停止 37 → **Step 2 選択可能 36 / 選択不可 1（重複アドレスのみ）**、
  **Step 3 で Light 30日無料 → 36 名維持**、退会者非対応の Light 永久無料 → 0 名（36 名が理由付きで対象外）、
  Step 4 dry-run 36（一致）
- テスト 2958 pass / 0 fail。check:safety・build とも exit 0。360px / 820px 確認済み
- **未実施**: PR merge / production deploy / 36 名への付与 / キュー登録 / 送信 / Airtable write

**Phase（2026-08-04）: カムバック施策を**特典カタログの宣言**で回せるようにする
（branch `feat/comeback-policy-catalog`・Draft PR・merge 前・production 未反映）。**

- **従来コード修正が必要だった理由**: 退会者へ配れるかを `offerId === 'light-30d-free'` の
  例外で判定していた。施策を 1 つ増やすたびにコード修正 → PR → merge → deploy が要る
- 判定材料を **`offer.comeback` の宣言**へ移し、単一源を
  `src/lib/entitlements/comebackPolicy.js`（施策名を 1 つも知らない）に置き換えた。
  `comebackWithdrawnPolicy.js` は削除。**新施策は カタログに `comeback: {...}` を書くだけ**
- 宣言項目: audienceSegments / allowWithdrawn / grantTier / durationDays /
  campaignId / campaignVersion / requiresSuccessfulGrant / restoresPaidContract /
  preserveWithdrawalRequested / allowedEntitlements / forbiddenEntitlements。
  `restoresPaidContract` は false 以外、`preserveWithdrawalRequested` は true 以外を受け付けない
- 案内キャンペーンの対応表（`GRANT_CAMPAIGN_BY_OFFER`）も**宣言から自動生成**（手書きを廃止）
- **報告された不整合を解消**: 対象区分「退会」で全行が「付与不可：退会・強制ログアウト」・
  「付与可能者を全選択」0 名なのに手動チェックは通る、という食い違い。原因は
  一覧（Step 1〜2）が施策を知らなかったこと。特典を選び直したら一覧を取り直すようにし、
  **一覧・全選択・dry-run・実行がすべて `checkGrantable` を通る**ようにした
- **退会と強制ログアウトを別の理由コードへ分離**（`withdrawal_blocked` /
  `force_logout_blocked`）。`ForceLogout` は宣言でも緩められない
- 重複メールも `checkGrantable` で弾くようにし、一覧でも選択不可にした
- 管理画面: 区分名を「退会・課金停止」へ、配信停止と別だと常設表示、
  選んだ特典の可否を自動表示、対象人数／付与予定人数／送信予定人数を分けて表示、
  除外理由を件数付きで全部表示。360px / 820px 確認済み
- production read-only 再判定: 残り 37 → **一覧 36 = dry-run 36 = 送信 36**（一致）。
  除外は重複アドレス 1 名のみ。既存 28 名との重複 0
- テスト 2953 pass / 0 fail（新規 21 + guard 6）。check:safety・build とも exit 0
- **未実施**: PR merge / production deploy / 36 名への付与 / キュー登録 / 送信 / Airtable write

**Phase（2026-08-04）: 退会した元会員をカムバック施策の対象にできるようにする
（branch `feat/comeback-withdrawn-grant`・Draft PR・merge 前・production 未反映）。**

- **誤っていた判定**: `docs/spec.md` は「退会済み＝カムバック対象・付与できる・送れる」と
  定めているのに、実装は 3 か所で退会者を締め出していた
  （`checkGrantable` が弾く / `memberResolution` が特典より先に退会を評価 /
  `resolveEntitlements` が `canLogin=false` で特典を無効化）。
  実害として、元の対象者 65 名のうち**期限切れ 28 名だけ**が Light 30 日無料と
  `comeback-light-30d-granted:v2` を受け取り、**退会済み 37 名は 1 人も対象にできなかった**
- 判定の単一源 `src/lib/entitlements/comebackWithdrawnPolicy.js`（純粋）を追加。
  **付与側（どの特典なら退会者へ出せるか）と権限側（その特典をログインで認めるか）を
  同じ 1 ファイル**が決める。片方だけ直すと「付与できたのに使えない」が再発するため
- 開けるのは `light-30d-free`（＝キャンペーン `comeback-light-30d-granted`）**だけ**。
  Light・期間限定・30 日以内に限り、`WithdrawalRequested` は書き換えない。
  Premium・三連複買い切り・購入資格は戻さず、期間が終われば自動的に無料会員へ戻る
- **通常の無料付与は不変**（`checkGrantable` の既定は従来どおり退会者を弾く）
- `ForceLogout` / 停止 / テスト / メール不正 / 配信停止 / suppression / blacklist は
  この施策でも**緩めない**（`ForceLogout` は課金状態ではなく安全措置なので退会と同列にしない）
- **同一メールアドレスの重複レコードは付与しない**。`auth/customerLookup` が重複を
  CONFLICT として fail closed でログイン拒否するため、付与しても本人が使えないから。
  `buildComebackPlan` が Customers 全体の重複アドレスを `duplicate_email` で除外する
- production を read-only で再判定した実数（**書き込み 0 / GET のみ**）:
  残り 37 名 → 付与可能 **36 名**（重複アドレス 1 名を除外）→ 送信可能 **36 名** →
  付与後にログインで Light になる **36 名**。既存 28 名との重複 **0**
- テスト 31 件追加（`comebackWithdrawnPolicy.test.mjs` 11 / `comebackWithdrawnGrant.test.mjs` 20）。
  `check:safety` exit 0 / `npm run build` exit 0 / lib テスト 2939 pass・0 fail
- **未実施**: PR merge / production deploy / 36 名への付与 / キュー登録 / 送信 /
  Airtable write / `WithdrawalRequested` の変更

**Phase（2026-08-03）: 無料付与の「いま」と「これまで」を分ける
（branch `feat/free-grant-status`・Draft PR・merge 前）。**

- 曖昧だった「現在の特典」フィルターを廃止し、**現在の無料付与** と **無料付与履歴** の 2 つへ分離。
  これで「いまは付与なしだが過去に配った人」を 1 回の検索で作れる
- 判定の単一源 `src/lib/entitlements/freeGrantStatus.js`（純粋）を追加。
  UI・検索・集計がすべて同じ関数を通るため、表示と検索結果が食い違わない
- **Airtable の schema 変更は無し**。既存の `*GrantLifetime` / `*GrantUntil` /
  `*GrantedAt` / `*GrantedBy` / `*GrantOp` / `*GrantRevokedAt` / `*GrantRevokeReason` /
  `ComebackGrantSource` だけで判定した
- **判定できないことを明示**: Customers はティアごとに最新 1 回分しか持たないため、
  付与回数・2 回目以前の内容・フィールド運用開始前の付与は証明できない。
  よって記録が無い状態は「付与していない」ではなく **「付与の記録なし」** と表示する
- 不整合（取消後に値が残る / 永久無料と期限の同時設定 / 期限が読めない）は
  **自動修復せず**「要確認」と理由を一覧に出す（fail closed 維持）
- 一覧は 1 セルに「現在」「履歴」「付与元」「不整合理由」を文言で出す（色だけに頼らない）
- 「特典」という語を、フィルター・チップ・条件要約・追従バー・一覧・顧客カルテから外した


**Phase（2026-08-03 現在・最新）: 送信ごとのキャンペーン文面編集
（branch `feat/campaign-content-editor`・Draft PR・merge 前）。**

- **保存方式は「既存フィールドのみ」**。調査の結果、キュー登録は既に
  `ScheduledEmails.Subject` / `Content` へ描画済みスナップショットを保存し、
  dispatcher はそれを読んで送っていた（カタログから作り直していない）。
  そこへ内容 hash を既存 `Notes` に追記するだけで要件を満たせるため、
  **Airtable の新規テーブル・フィールドは作っていない**（schema 変更ゼロ）
- Step 3 に件名（48px・1 行・文字数）と本文（最低 320px・拡大モーダル）の編集欄を追加。
  既定文面はテンプレートから読み込み、**編集は今回送る分だけ**に効く
- 検証は `campaignContentDraft.js`（純粋）が単一源。空件名 / 改行入り件名 / 空本文 /
  未定義の差し込み / `{{` 閉じ忘れ / HTML / 生 URL は**すべてエラー**（空文字へ黙って置換しない）
- 差し込みは `{{salutation}}` のみ（カタログと一致）。ボタンでカーソル位置へ挿入
- dry-run が `contentHash` を返し、**件名・本文を変えると確認結果が失効**して送信操作が止まる。
  `planFingerprint` の種にも hash を含め、Function 側は受け取った hash を再計算して照合（不一致は 409）
- キュー登録後に画面で編集しても**登録済みジョブの内容は変わらない**（dispatcher はスナップショットで送る）
- 最終確認に件名全文・本文プレビュー・内容 hash・人数・取消不可の注意を出し、
  **「表示されている件名・本文を、この対象者へ送信します」のチェックまで送信不可**
- 送信状況に「実際に送った件名 / 内容 hash / 実行者 / 作成・送信日時」を表示
- **結果パネルの単一源化**（本番で確認された混乱の是正）: 施策パネルからキャンペーンを外し
  （Step 4 と二重に出ていた）、連打・多重リクエストで結果が積み上がる問題を実行世代で解消。
  特典側の除外は `skippedPreview`（人物単位）を読むよう修正し、
  「除外 31 件に対し明細 0 件 → 誰が対象か確定できません」が常時出る状態を解消


**Phase（2026-08-02 現在・最新）: カムバック特典タブを Step 1〜5 の UI へ再設計
（branch `feat/comeback-console-steps`・merge 前）。**

- 「契約状態: 有効」がカムバック対象に見える問題を解消。選択肢を**カムバックの言葉**へ変え、
  「現在有効な会員（通常は選択しない）」を区切り線の下・警告色に置いた
- **Step 1〜5**（探す → 選ぶ → 決める → 確認する → 付与する）をカード化し、
  未到達の段階は薄く・操作不可。判定は `comebackConsoleFlow.js`（純粋）が単一源
- Step 2 は取得前に一覧を出さず案内のみ。現有効会員・状態不明は**選択不可**で行内に理由を出す
- Step 3 は選択後に有効化し、特典内容を**平文**で要約（内部用語をやめた）
- Step 4 は「付与内容を確認」。人数・区分・除外理由・現有効会員の混入・変更しない項目を同じ場所に出す。
  **現有効会員が 1 名でもいれば Step 5 へ進めない**
- Step 5 は人数入力つき二段階確認。実行は dry-run と同じ operationId（冪等）で、
  結果（付与 / 除外 / 失敗 / operationId / 実行日時）を画面に残す
- カムバック専用の追従バー（候補・選択・特典・確認状態・**次の操作 1 つ**）
- **配色とボタンの視認性**も同時に改善: 色の意味を CSS 変数へ固定（青=取得 / 緑=確定 /
  黄=現在の操作 / オレンジ=強い注意 / 赤=本番データが変わる / 紫=上位 / 灰=未到達）。
  主要ボタンは 50px・16px・アイコンつき、危険操作は赤系 + ⚠️ + aria-disabled。
  Step ナビは丸番号 + 補足の 72px カード、追従バーは段階別の色で次の操作 1 つだけを大きく出す。
  通知は 5 種（成功/情報/注意/強い注意/エラー）。**色だけに頼らず文言・アイコン・枠でも区別**する


**Phase（2026-08-02 現在・最新）: 管理画面の実用性を修復（branch `feat/admin-send-now` / PR #212・merge 前）。
**dry-run が押せない不具合**を直し、42 名一覧のコンパクト化、カムバックの対象限定を入れた。**

### 不具合: 「送信対象を確認（dry-run）」が押せない（本番・PR #211 由来）

- **原因**: キャンペーンを選択欄へ**プログラムから**入れたのに状態へ反映していなかった。
  `change` は自動選択では発火しないため「キャンペーン未選択」と判定され、ボタンが常時 disabled だった
- **同時に**: 顧客取得の状態更新が誤った関数に入っており、取得件数が常に 0 のままだった
- **修正**: 選択反映を `mkApplyCampaignSelection()` に集約し、自動選択でも必ず状態へ入れる。
  顧客取得は `mkApplyCustomersLoaded()` で反映。押下時は必ず「確認中…」→ 結果 / 0 名 / 失敗を表示する
- **再発防止**: 状態遷移を `marketingConsoleState.js`（純粋）へ切り出し、DOM なしで 25 件の検証を追加
- **もう 1 件**: 一覧の関数が重複定義され、`mkVisibleRows` が自分自身を呼ぶ（無限再帰）状態だったのを解消

### 42 名を短いスクロールで確認できる一覧

25 / 50 / 100 件の切替、ページ送り、「42 件中 1〜25 件」表示、該当 / 送信可能 / 送信不可 / 選択の要約、
選択者のみ・送信可能のみの絞り込み、行を詰めた表示、選択列と顧客列の固定、上下の「表示中を全選択」。
一覧の表示が変われば **dry-run は失効**する。

### カムバック特典の対象限定

`comebackAudience.js`（純粋）で 期限切れ / 退会 / 休眠 / **現有効会員** / 状態不明 を判定し、
**現有効会員は既定で対象外**。混ざっていれば実行を 409 で止め、
「現有効会員を含める」を明示 ON にして人数を入力したときだけ通す（画面の既定は OFF・警告つき）。


**Phase（2026-08-02 現在・最新）: 管理画面だけで「最終確認 → 今すぐ送信」まで完結する実装を
branch `feat/admin-send-now` で用意（merge 前）。送信経路は増やさず、既存 dispatcher を再利用。**

- UI 改善（PR #211 `4ad3c70`）は本番反映済み。Step 1〜6・追従バー・dry-run 失効が稼働
- 今回: **「今すぐ送信」** を追加。到達条件は `marketingSendNow.js` が単一源で、
  dry-run 実施済み・失効なし・キュー登録済み・dispatcher `dryRun:true` 成功・
  **送信待ちジョブが 1 件に特定できる**・対象 ≥ 1・gate 有効・未送信、をすべて満たす場合のみ押せる
- **送信直前に再度 `dryRun:true` を取り、同じ jobId・同じ内容であることを検証**してから実送信。
  変わっていれば中止（409 相当）
- 実送信は確認したジョブ 1 件に限定（dispatcher の jobId 指定）。二重クリックは 1 回だけ実行
- 結果は画面内に sent（provider 受理）/ skipped / failed / 状態 / 除外理由 / 完了時刻 /
  取消不可を表示。**部分成功は巻き戻さず、再送ボタンを自動表示しない**
- dispatcher の**ハンドラを起動する煙試験**を追加（gate 閉鎖で 503・dryRun 既定 true・
  PENDING 限定・マーケ以外を除外・jobId 限定・suppression 取得失敗で中止・無認証 403・PII なし）


**Phase（2026-08-02 現在・最新）: 顧客マーケティング管理画面を**操作順が分かる UI**へ改善
（branch `feat/admin-marketing-console-ux`・merge 前）。機能追加ではなく、
**押せる順にしか進めない**構造と、確認結果の失効を入れた。**

- Step 1〜6（絞り込み → 選択 → キャンペーン → dry-run → 登録・送信 → 状況）を画面に明示
- **押せる／押せないの根拠**を単一源 `marketingConsoleFlow.js` に集約（画面は判定を呼ぶだけ）
- **dry-run の失効**: 選択・条件・キャンペーンが変わると確認結果を破棄し、再確認を必須にする
- フィルターを常時 4 条件＋詳細条件（折りたたみ）に整理し、適用中件数・クリア・取得件数・選択件数を表示
- 送信不可の顧客は選択不可＋**その場で理由**、「表示中を全選択」を主操作、全顧客選択は控えめに
- キャンペーンは**通常配信と運用テスト専用を分離**し、カードに version・対象条件・実績・再送可否
- dry-run 結果を主要パネルへ集約（人数・除外理由・gate・二重送信防止・確認 ID・実行すると何が起きるか）
- 最終送信は**二段階確認**（内容 ＋ 送信予定人数の入力）。送信後は直前確認を破棄して再送ボタンを閉じる
- 追従バーに現在地と次の操作。通知は内容別で、エラー時は次の行動まで書く
- 送信経路は**増やしていない**（既存 admin-marketing / campaignSend / dispatcher の再利用）


**Phase（2026-08-02 現在・最新）: admin マーケティング送信の通常運用機能が本番稼働
（`c2f8a3f` / deploy `6a6ec3771ccbd800086d3fb8`）。送信ゲートは両方 UNSET＝実メール 0。**

### 追加した運用機能（PR #208 `1e5f814`）

対象選択 → dry-run → キュー登録 → **送信状況の確認** → **PENDING の取消** まで管理画面で完結する。

| 機能 | 実装 |
|---|---|
| 送信状況（予定 / 送信済 / 失敗 / スキップ / 取消） | admin API `jobs`（read-only）+ 画面「送信状況・取消」|
| dispatcher 失敗の可視化 | 配信行の `ErrorMessage` を理由別に集計（アドレスは持たない）|
| PENDING の取消 | admin API `cancelJob`（`operationId` 必須・冪等・二段階確認）|
| SENT は取消不可 | 画面に理由付きで明示。**`sent` の配信行には触れない** |
| gate 閉鎖時の挙動 | どの env が未設定かを表示し、送信ボタンを無効化 |
| 自動送信されない | dispatcher は定期実行に未登録（guard で固定）|
| 台帳状態の確認 | カルテ ⑥-2 に未確定（unresolved / conflict）の全体件数 |

判定の単一源は `src/lib/marketing/marketingJobs.js`。運用手順は `docs/spec.md` の
「マーケティング配信の運用（admin）」章。

### 事故と是正: `jobs` が本番 500（2026-08-02・**当日中に解消**）

**事象**: PR #208 の本番反映直後、`jobs`（送信状況）が **HTTP 500**。
**原因**: `jobs` / `cancelJob` が `isMarketingJob` を使っているのに **import していなかった**
（ReferenceError）。

**影響範囲（実測）**

| 項目 | 実測 |
|---|---|
| 影響 | 「送信状況・取消」画面が開けないだけ（**read-only 経路**）|
| Airtable への書き込み | **0**（EmailEvents 5 / Customers 1454 / CampaignDeliveries 72 / ScheduledEmails 28 が不変）|
| メール送信 | **0**（送信ゲートは両方 UNSET）|
| 他の action | `customerDetail` 等は正常（カルテ ⑥-2 は本番で表示を確認）|

**なぜ CI と guard を通り抜けたか**

既存 guard は**ソース文字列の検査**で「何が書かれているか」しか見ておらず、
**実行して初めて落ちる欠陥**（import 漏れ・引数不一致）を構造的に検知できなかった。
`check:safety` も build もソースの静的検査で、ハンドラを起動していなかった。

**是正（PR #209 `c2f8a3f`）**

- `isMarketingJob` を import（1 行）
- **ハンドラを実際に起動する煙試験**を追加（`adminMarketingHandler.smoke.test.mjs`）。
  `fetch` を差し替えてネットワークなしで実行し、
  `jobs` が 200 / 応答にアドレスを載せない / `cancelJob` は operationId 無しで 400（**書き込みに到達しない**）/
  SENT を 409 で拒否し **PATCH を 1 回も出さない** / PENDING は queued の配信行とジョブだけ PATCH・
  Customers 不変 / 無認証は 403 / admin が SendGrid を叩いたら落ちる、を固定
- **回帰検知を実証**: import を外すと 3 件が落ち、戻すと 6 件すべて通ることを実測

**教訓（次に同じ形で落ちないために）**

Function に新しい action を足すときは、ソース検査の guard だけでなく
**ハンドラを起動する煙試験を必ず 1 本足す**。静的検査は「書いてある」ことしか保証しない。

**本番検証（`c2f8a3f` 反映後・read-only）**

`jobs` = **HTTP 200** / gate は `sendEnabled:false` `dispatchEnabled:false` と理由を表示 /
ジョブ 5 件（`marketing-canary` v1・v2、`comeback-offer` v2 ×3）がすべて **SENT・取消不可
（`already_sent`）** / 応答にアドレスなし / 各テーブル件数は不変。



**Phase（2026-08-02 現在・最新）: Phase 2 実施完了。刻印付きカナリア 1 通の本番送信で
「送信 → イベント → resolved → admin カルテ」が実証された。送信 gate は再閉鎖済み（実効確認済み）。**

### 実施内容と実測（2026-08-02 / production）

| 段階 | 実測 |
|---|---|
| 送信 | `marketing-canary` **v2** を**テスト専用受信者 1 名**へ **exactly-one** で送信 |
| dispatcher（live） | **jobs 1 / verified 1 / sent 1 / skipped 0 / failed 0** |
| `ScheduledEmails` | 当該ジョブ PENDING → **SENT**（SentCount 1 / FailedCount 0）|
| `CampaignDeliveries` | queued → **sent**（`marketing-canary:v2` 1 行 / SentAt 11:34:38 JST）|
| **台帳** | 新規 `delivered` が **custom_args 3 点完全一致で `resolved`**（`DeliveryKey` / `CampaignDeliveryRecordId` / `CustomerRecordId` すべて配信台帳と一致・`CampaignId=marketing-canary` / v2）|
| **admin カルテ ⑥-2** | **「配信済み 1」を本番表示**（`ledgerSource.available=true` / rows 1 / `unattributed`・`conflicts` は scoped のため null）|
| PII | **禁止列 0**（Email / IP / UserAgent / RawUrl / RawPayload なし）。`EmailHash`（32 桁）のみ保持 |

### 件数（送信後）

| テーブル | 値 |
|---|---|
| `EmailEvents` | **3**（うち 1 件が resolved。既存 2 件は `unresolved/no_custom_args` のまま**不変**）|
| `CampaignDeliveries` | **72** |
| `ScheduledEmails` | **28** |
| `Customers` | **1454（不変）** |

### open / click が未検証な理由（**AK 側の実装起因ではない**）

SendGrid 側の設定を read-only で実測した結果:

| 設定 | 実測 |
|---|---|
| Event Webhook `enabled` | true（`delivered` / `bounce` / `dropped` / `spam_report` / `unsubscribe` = true）|
| Event Webhook **`open`** | **false** ← 開封イベントが AK へ送られてこない |
| Event Webhook **`click`** | **false** |
| Tracking: Open | enabled: true（計測はしている）|
| Tracking: **Click** | **enabled: false** ← クリックは計測自体が無効 |

→ **open / click の検証は SendGrid 全体（決済メール等すべての送信）に影響する設定変更を伴うため、別判断とする。**
実施する場合は ① Click Tracking を ON（**全メールの URL が書き換わる**）② Event Webhook に open/click を追加
③ `marketing-canary` を **v3** へ版上げ（v2 は `already_delivered` で再送されない）が必要。

### 事前確認スクリプトの段階判定を修正（2026-08-02）

`preflight:phase2-canary` は段階に関係なく「両 gate が未設定であること」を要求していたため、
**手順どおり 1 つ目の gate を開けた直後に ❌** となり、正常な進行と異常が区別できなかった。
gate の状態から `pre` / `enqueue` / `send` を自動判定し、その段階で成り立つべきことだけを検査する
（`PHASE2_STAGE` で上書き可）。`enqueue` 段階では**実送信 gate が閉じていること**を必須にし、
どの段階でも exactly-one の上限（配信行・PENDING）は検査し続ける。
併せて直接実行時だけ main を走らせる形にし、段階判定を単体テストできるようにした。

### gate の再閉鎖（実効確認済み）

- `MARKETING_CAMPAIGN_ENABLED` / `MARKETING_CAMPAIGN_DISPATCH_ENABLED` を **UNSET へ戻し redeploy**
- **deploy ID `6a6eaf288672bf97c3b9c1be`** / state ready / **published commit `a596f4b`**
- 実効確認: dispatcher を `dryRun:false` で叩いても **503（`MARKETING_CAMPAIGN_DISPATCH_ENABLED` 未設定）/ sideEffects: none**
- 変更していない env: `EMAIL_EVENT_LEDGER_ENABLED`=true（台帳は稼働継続）/ `NEWSLETTER_AUTOMATION_ENABLED`=false


**Phase（2026-08-02 現在・最新）: Phase 1（1a〜1d）完了・本番稼働（`4bd4856` / deploy `6a6ea27f3e8b850008c31d5a`）。
Phase 2（刻印付きカナリア 1 通の実地確認）の**準備のみ**完了。送信 gate は閉じたままで実メール 0。**

- 事前確認スクリプト `npm run preflight:phase2-canary`（**read-only**）を追加。本番データに対して
  **16 項目すべて ✅**（キャンペーンが testOnly / allowlist ちょうど 1 名 / Customers 該当 1 件 /
  同一 DeliveryKey 0 件 / `marketing-canary:v2` の配信行 0 件 / PENDING 0 件 /
  EmailEvents 2 件・resolved 0 件 / 両 gate 未設定）
- exactly-one は 4 つの独立した仕組みで担保（allowlist fail closed / 対象 1 名 / DeliveryKey 冪等 /
  送信経路 1 系統＝共有 executor は env 非依存で常時 skip）
- 実行手順・期待増分・rollback は `astro-site/docs/EMAIL_EVENT_LEDGER.md` §5-2
- **未実行**: env 変更 / gate 有効化 / 実メール送信 / Airtable write（すべてユーザー承認待ち）
- **検証条件は件数ではなく「観測できた各イベントが `resolved` になること」**。EmailEvents の増分は
  provider の挙動と受信者の操作（開封・クリック）に依存するため固定しない
- **rollback に台帳行の削除を含めない**。送信後は gate を unset → redeploy で追加送信を止め、
  `EmailEvents` は append-only のまま保持する（本番行の削除は別の高リスク承認境界）


**Phase（2026-08-02 現在・最新）: Phase 1c まで本番反映済み（`b5946d4`）。
Phase 1d（受信側の resolved 判定）を branch `feat/ledger-resolve-phase1d` で実装。
**既存の EmailEvents 行は書き換えない**・本番挙動の変化は `resolved` が付き始めることだけ。**

- **1c 反映済み**: PR #202（`8bd07b7`）/ #203（`b5946d4`）merge・production deploy ready。
  PR #200 は #202 を代替として close 済み
- **1d 実装**: `emailEventDeliveryIndex.js`（read-only・I/O 注入）で `CampaignDeliveries` を
  必要な鍵だけ GET し、`delivery_key` / `campaign_delivery_id` / `customer_record_id` の
  **3 点完全一致**のときだけ `resolved`。不一致・複数候補は `conflict`、欠落・未発見は `unresolved`
- **メールアドレスによる推測紐付けは 1d 以降も禁止**（同一アドレスの重複 Customers が実在）
- 顧客カルテ用の集約は `summarizeCustomerEventsFromLedger()` が**台帳を正本**として計算
  （`unresolved` は `unattributed` として別枠。0 件と混同しない）。admin 画面への配線は未着手
- gate OFF のときは索引も引かない（外部 I/O ゼロ）。索引が引けなくても受信は止めない


**Phase（2026-08-02 現在・最新）: 台帳 Phase 1b は本番稼働（実イベント 2 件を保存済み・PII なし）。
Phase 1c（送信側の custom_args 刻印）を branch `feat/marketing-custom-args-phase1c` で実装。
マーケ送信 gate は OFF のままで、merge・deploy しても本番の送信挙動は変わらない。**

- **1b 完了**: production deploy `6a6e950eabbd67bec878b321`（published commit `394fae2` / ready）。
  `EMAIL_EVENT_LEDGER_ENABLED` は production / functions scope で **PRESENT**
- **本番実測（2026-08-02 10:03 / 10:07 JST）**: 自然発生の `delivered` **2 件**が `EmailEvents` へ保存された。
  `VerificationStatus=verified` / `Provider=sendgrid` / `CreatedBy=sendgrid-webhook` /
  `EmailHash` 32 桁 / **禁止列なし**（Email / IP / UserAgent / RawUrl / RawPayload）/
  `ResolutionStatus=unresolved`・`ResolutionReason=no_custom_args`（**1c 前なので正常**）
- 他テーブルは不変（`CampaignDeliveries` 71 / `ScheduledEmails` 27 / `EmailBlacklist` 15 /
  `PromotionalOffers` 74）。`Customers` は 1453 → 1454（**自然な新規登録**。台帳とは無関係）
- **1c 実装**: `campaignCustomArgs.js`（純粋）+ dispatcher 配線。権威データ
  （`CampaignDeliveries`）から読むだけで **DeliveryKey を送信側で再生成しない**。
  解決できない相手には**送らない**（fail closed）。契約と理由コードは
  `astro-site/docs/EMAIL_EVENT_LEDGER.md` §3-3
- **PR #200 の整理**: #201 で `sendgrid-webhook.js` 側は是正済み。#200 は競合を抱えた stale 状態のため、
  `emailEventLedger.js` の 1 行だけを `origin/main` から作り直した **PR #202** を代替として作成
  （#200 は close せず判断待ち）

**Phase（2026-08-02 現在・最新）: 台帳 Phase 1b の Airtable テーブル作成は完了・検証済み。
本番有効化の前に、書き込みの耐障害修正（バッチ化 + bounded retry + 失敗集計）を
branch `fix/email-event-ledger-write-resilience` で実装。**既定 OFF・write 0 のまま**。**

- **1a**: PR #199 merged（`8a493ce`）→ production published deploy `6a6dea8f3e8b850008a9ea74`（state ready）
- **1b（テーブル）**: Airtable `EmailEvents` を作成・read-only 検証済み。
  table id `tblWkaxu7p0MRuUwL` / **21 列一致** / primary field `EventKey`（singleLineText）/
  `EventAt`・`ReceivedAt` は dateTime / 禁止列なし / **0 行（ベースライン）**
- **1b（env）**: `EMAIL_EVENT_LEDGER_ENABLED` は **production UNSET のまま**（write 0）。
  投入と redeploy は**未実施**（ユーザー承認待ち）
- **本セッションの修正**: 初版の書き込みは「1 行 1 リクエストを逐次 PATCH し、
  `res.ok` でなければ黙って捨てる」実装だった。台帳は復元不能なので、
  ① 10 件/リクエストのバッチ upsert ② 429/5xx/timeout/transport への bounded retry
  （403/404/422 は再試行しない）③ `attempted / written / failed / failureReasons` の
  明示集計、へ作り直した。詳細は `astro-site/docs/EMAIL_EVENT_LEDGER.md` §3-2
- **PR #200（comment-only / Phase 番号是正）は merge せず維持**。両者の関係:
  - #200 は `emailEventLedger.js` と `sendgrid-webhook.js` の**コメント 2 箇所**を 1b → 1c へ是正
  - 本 PR は `sendgrid-webhook.js` 側の**同じ箇所を含む形で書き直している**（是正済み）。
    `emailEventLedger.js` のコメントは**本 PR では触っていない**ため、#200 固有の価値として残る
  - したがって **#200 を先に merge → 本 PR を merge**（`sendgrid-webhook.js` の 1 hunk が
    競合するので本 PR 側で解消）か、**本 PR を先に merge → #200 を `emailEventLedger.js` のみへ縮小**
    のどちらか。**どちらでも本番挙動は不変**（コメントのみ）

**Phase（2026-08-01 現在・最新）: メール配信反応の恒久台帳（`EmailEvents`）の Phase 1a を
PR #199 で実装完了。既定 OFF・本番 write 0 のまま Ready for review。merge は未承認で停止中。**

- 配信基盤の履歴は保持期間が短く（実測 3 日）、それ以前の開封・クリックは取得不能。
  AK 側に残していないため「**反応が無かった**」と「**記録が消えた**」を永久に区別できない。
  届いた Event Webhook を append-only の台帳へ残す土台を入れた。
- 実装は **既定 OFF**。`EMAIL_EVENT_LEDGER_ENABLED !== 'true'`（または Airtable 認証情報が無い）なら
  **1 バイトも書かない**（受信件数と rejected 理由を数えるだけ）。**production env は未設定＝write 0**。
- Airtable `EmailEvents` テーブルは**未作成**。作成前に有効化しても upsert が非 ok を返すだけで
  既存の suppression / 決済メール v2 の処理は巻き添えにしない（台帳呼び出しは try/catch で分離）。
- 現状マーケ配信は `custom_args` を刻んでいないため、届くイベントは `email` しか手掛かりが無く
  **すべて `unresolved`**（顧客へ結び付けない）。紐付けには送信側の刻印が別途必要。
- 設計・列定義・有効化手順は `astro-site/docs/EMAIL_EVENT_LEDGER.md` が単一源。

**Phase（2026-07-30 現在）: マーケティング基盤の end-to-end 検証は完了。
送信 gate はクローズ済み。`withdrawn` 判定の業務定義修正を PR で待機中。**

- カナリア実送信まで完了（テスト受信者 1 名へ 1 通・delivered）。その後
  `MARKETING_CAMPAIGN_ENABLED` / `MARKETING_CAMPAIGN_DISPATCH_ENABLED` を **unset**（gate クローズ）
- production env: 両 gate 未設定 / `NEWSLETTER_AUTOMATION_ENABLED=false`
- **`withdrawn` は課金停止であってメール拒否ではない**という業務定義に合わせ、
  マーケティング除外から分離（branch `fix/marketing-withdrawn-sendable`）。
  根拠は `process-withdrawal.js` の退会受付メール文面（「メルマガは引き続き配信されます」）と、
  退会処理が `UnsubscribedAnalyticsKeiba` を書かないこと。
  本番実測で **37 名**が「除外: withdrawn」→「送信可能」へ（重複除外 0 名）。


**Phase（2026-07-30 現在・最新）: マーケティング配信の本番検証が enqueue まで完了。
実メール送信の直前で、共有 executor への依存を恒久修正中（branch `fix/marketing-dedicated-dispatcher-only`）。**

- production main `b383621`（PR #172 / #173 merge 済み・deploy ready）
- production env: `MARKETING_CAMPAIGN_ENABLED=true` / `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true` /
  **`NEWSLETTER_AUTOMATION_ENABLED=false`**（未変更）
- `marketing-canary` をテスト受信者 1 名へ **enqueue 済み**
  （`ScheduledEmails` PENDING 1 / `CampaignDeliveries` queued 1 / **実メール 0**）
- dispatcher `dryRun:true` = jobs 1 / verified 1 / willSend 1 / **skipped 0**
- **未実施**: `marketing-campaign-dispatch` の `dryRun:false`（＝最初の実メール 1 通）

### 発見: 共有 executor への依存（本 branch で恒久修正）

`MARKETING_CAMPAIGN_DISPATCH_ENABLED=true` にしたことで、共有
`execute-scheduled-emails-background` 側のマーケ用ガードも通る構造になっていた。
`cron-email-scheduler` は Netlify scheduled（`*/15 * * * *`）で動いており、
`NEWSLETTER_AUTOMATION_ENABLED=true` になった瞬間に**再検証なしでキャンペーンが飛ぶ**
（共有 executor は固定宛先に対する per-recipient 再検証を持たない）。

→ `canSharedExecutorSend(fields)` を **env 非依存・常時 skip** へ変更し、引数から env を除去。
marketing job の唯一の実送信経路を `marketing-campaign-dispatch` に固定した。


**Phase（2026-07-30 現在・最新）: PR #172 は merge / production deploy 済み（`9ba1cf6`）。
送信 gate は OFF のまま。次は運用テスト専用キャンペーン `marketing-canary` の PR。**

- PR #172 merge commit **`9ba1cf6`** / Netlify production deploy **ready** / main CI **success**
- production env は未変更: `MARKETING_CAMPAIGN_ENABLED` 未設定 /
  `MARKETING_CAMPAIGN_DISPATCH_ENABLED` 未設定 / `NEWSLETTER_AUTOMATION_ENABLED=false`
- deploy 後の実測: `ScheduledEmails` PENDING **0** / `CampaignDeliveries` **0** /
  Customers の権限・決済・Plus 系カウンタ全一致（実送信 0・write 0）
- **本番化前の最終 gate 確認で 1 項目が不成立だった**: 専用テスト受信者
  （`NEWSLETTER_TEST_RECIPIENTS` の 1 件・Customers に実在・全 suppression 非該当）は
  契約 active / プラン premium のため、使用可能な 4 キャンペーンの対象条件にどれも合致せず
  dry-run が 1/1/0 にならなかった（enforce ルールが設計どおり機能した結果）。
  → **案 B: 運用テスト専用キャンペーン `marketing-canary` を新設**（既存キャンペーンの
  `audienceRule` はテスト都合で緩めない）。branch `feat/marketing-canary`。


**Phase（2026-07-30 現在）: AK 顧客販売・マーケティング管理 Draft 実装。
実送信は未有効（env 未設定・fail closed）で、production 操作は未実施。**

- ブランチ `fix/premium-plus-admin-review-candidates`（`origin/main` = `ba0dbc4` から分岐）。
  **未 deploy**。production への push / deploy / env 変更 / Customers write / 実送信は**すべて未実施**。
- 2 段階で進めた:
  1. Premium Plus 管理画面の**表示漏れ修正**（`a39fc1a`）— 公開条件と管理画面の表示条件を分離
  2. **顧客マーケティング管理の Draft 実装** — 契約状態を横断した顧客選択・キャンペーン・
     preview・dry-run・送信キュー登録まで（実送信は env で閉じたまま）
- 次の判断は「実送信を有効にするか」。有効化には §Blockers の承認が必要。

> 前 Phase（2026-07-22 時点）: 入金確認メール v2 は cutover 完了・gate=v2-full で本番稼働中。
> 次 Phase 候補は Event Webhook（S9・別 Phase・未着手）。この状態は現在も継続。

- 入金確認メール v2 は 2026-07-21 に D1 cutover 完了。2026-07-22 に実顧客 1 件の本番通過と、
  PAT / secret ローテーション後のカナリア再検証を完了（詳細は §In Progress の日付別記録）。
- 初版（2026-07-20）の Phase は「ドキュメント基盤整備」であり、その PR
  （`docs/autonomous-project-workflow`）は **文書のみ**でソースコードの挙動を変更していない。
- 本体の開発は main 上で日次データ取込コミットと機能 PR が継続中。

## 2026-08-03 — 送信待ちジョブをカードから安全に送れるようにする（branch `feat/job-card-send` / Draft PR・未 merge）

**きっかけ**: 実送信は Step 5（顧客を選ぶ → キャンペーンを選ぶ → dry-run → キュー登録 → 送信）
の一本道にしか無く、**すでにキュー登録済みのジョブ**を送るのに顧客の再選択と dry-run の
やり直しが要った。選び直した母集団がキュー登録時と違えばそもそも送れず、画面の選択状態に
依存するため別の日・別の人が引き継げない。

**入れたもの**

- `src/lib/marketing/marketingJobSend.js`（新規・純粋）
  確認結果の 1 件特定 / 押下可否 / 人数照合 / 結果まとめ。理由コードは固定
- 送信状況モーダルの **PENDING カードに「配信内容を確認」→「今すぐ送信」** を追加
  - 対象は**カードの jobId だけ**。顧客選択・絞り込み・キャンペーン選択を一切見ない
  - 確認結果に queued / 実送信予定 / 除外 / 除外理由 / campaignId:v / shellVersion /
    contentHash / suppression 照合可否 を表示
- **API 側でも job 単位の冪等性**を保証
  - このジョブの配信行が既に `sent` の相手は送信対象から外す（`already_sent_in_job`）
    → 通信 retry・二重クリック・途中で落ちた再実行で二度送らない
  - live は `jobId` **必須**（省略時の全件送信を禁止）
  - live は `expectedWillSend` **必須**。確認時と人数が違えば **409**（書き込みゼロ）
- 送信直前にもう一度 dry-run を取り、jobId / 人数 / contentHash / shellVersion が
  確認時と同じであることを照合（違えば送らない）
- 送信済み・失敗・取消済みのジョブは押せない。実行中は無効化、完了後は再送不可
- 取消ボタンは従来どおり独立
- 360px でボタンが縦積み・全幅（実描画で確認）

**変えていないもの**: 認証方式（既存の `x-admin-secret`。新しい secret 依存を作らない）/
suppression・配信停止・退会・頻度の送信直前再判定 / provider suppression の fail closed /
Step 5 の既存フロー / 他キャンペーンの契約。

**この作業では 28 名へ送っていない**（dispatcher 実行・キュー取消・再登録・Airtable write なし）。

## 2026-08-03 — キャンペーンメールを AK ブランドの HTML メールへ（branch `feat/marketing-html-email-templates` / Draft PR・未 merge）

**きっかけ**: 送っているメールが `<div>` に段落を並べて青いボタンを 1 つ置いただけで、
特典の価値が伝わらない。参考として旧 NANKAN Analytics の HTML メールを提示された
（構造だけ採用し、ブランド・URL・レース情報・旧配信変数は持ち込まない）。

**入れたもの**

- `src/lib/marketing/marketingEmailShell.js`（新規・純粋）
  600px table / inline CSS / プリヘッダー / ブランドヘッダー / バッジ / 特典カード /
  CTA / 補足 / フッター / 配信停止。**HTML と text/plain を同時生成**する
- campaign に見た目の固定値を後方互換で追加:
  `preheader` / `badge` / `headline` / `benefitTitle` / `benefitItems` / `ctaNote` /
  `footerNote` / `templateVariant` / `showGrantExpiry` / `grantDurationDays`
- `comeback-light-30d-granted` を **v1 → v2**（HTML 構造が変わるため）。
  件名を「Lightプラン30日無料のご案内」に、特典カード 3 項目と終了日表示を追加
- 配信停止を**シェルの一部**にし、`{{unsubscribeUrl}}` を送信直前に差し替える。
  **差し替えられない本文は 1 通も送らない**（fail closed）
- SendGrid へ **text/plain と text/html の 2 パート**を送る（従来は HTML のみ）
- 無料期間の終了日は `{{grantExpiry}}` を受信者ごとに差し替え。**実際の
  `LightGrantUntil` が正本**で、読めなければ「付与日から30日間」、それも無ければ何も言わない
- 管理画面の完成プレビューを **デスクトップ / モバイル幅 / テキスト版** の切替に。
  サンプル宛名とサンプル配信停止 URL で表示し、実顧客の情報は使わない

**版管理の扱い（2 軸）**

届くメールは **campaign の version（文面）× シェルの版（組み立て方）** で決まる。
当初シェルの版が hash に入っておらず、
「dry-run で確認 → deploy でシェル変更 → 同じ hash のままキュー登録」で
**確認したものと違うメールが積まれる**状態だったため、以下を入れた。

- `MARKETING_EMAIL_SHELL_VERSION`（現在 **1**）を `marketingEmailShell.js` に定義
- `computeCampaignContentHash` の種に必ず含める（**全キャンペーンの hash が変わる**）
- dry-run が `shellVersion` を返し、**送信時に一致を要求**（不一致は 409 / 未指定は 400）
- 文面 hash も送信時は**必須**にした（従来は任意で、省けば検査を素通りできた）
- ジョブの `Notes` に `shell:v<N>` を残し、**dispatcher が照合**。
  版が違う / 印が無いジョブは **1 通も送らない**（`blocked: shell_version_mismatch`）。
  送るには dry-run からやり直して積み直す

DeliveryKey は `campaignId × version × 受信者`のままなので、
**シェルの版を上げても既存キャンペーンが一斉再送可能になることはない**。

**ルール（今後）**

| 変えたもの | すること |
|---|---|
| 件名・本文・CTA・見た目の固定値 | campaign の `version` を上げ、`LOCKED` を更新 |
| シェルのマークアップ・配色・差し替え印・text の組み立て | `MARKETING_EMAIL_SHELL_VERSION` を上げ、`LOCKED` と snapshot を更新。campaign の version は据え置きでよい |

**`comeback-light-30d-granted` は v2 のままでよいか（再判定）**: **v2 のままでよい**。
v2 はまだ 1 通も送っておらず（`CampaignDeliveries` に v2 の行が無い）、
v3 へ上げても受け取る人にとっての違いは生まれない。シェルの版は別軸で管理する。

**次の Phase: テンプレート展開**（すべて同じ文面へまとめない）

| テンプレート | 状態 |
|---|---|
| Light 30日無料 付与済み | **本 PR で完成**（`comeback-light-30d-granted` v2）|
| Light 永久無料 付与済み | 未作成（「30日間」と書けない）|
| Premium 期間限定 付与済み | 未作成（閲覧範囲が Light と違う）|
| Premium 永久無料 付与済み | 未作成 |
| Light / Premium 両方 付与済み | 未作成（併記が要る）|
| 付与なしの一般カムバック | 既存 `expired-comeback` v2（シェルへ載る）|
| Premium 再契約 | 既存 `premium-renewal` v2 |
| Premium Plus 案内 | 既存 `premium-plus-offer` v2 |
| 成績レポート | 未着手 |
| 開催前リマインド | 未着手 |
| 無料会員 活性化 | 未着手 |
| 休眠 再活性化 | 既存 `dormant-reactivation` v2 |

追加時は `templateVariant` と `benefitItems` で内容を分け、
`GRANT_CAMPAIGN_BY_OFFER`（`comebackGrantCampaign.js`）へ 1 対 1 で登録する。

**28 名への送信は未実施**（キュー登録・送信・付与・Airtable write なし）。

## 2026-08-03 — Light 無料付与済み案内の文面・CTA・引き継ぎを整える（branch `fix/comeback-light-grant-email` / Draft PR・未 merge）

**きっかけ**: 28 名へ無料付与したあと案内メールを作ろうとして、本番画面で 5 つの不整合が出た。

| # | 症状 | 原因 |
|---|---|---|
| 1 | 今回に合う文面が無い | 既存はすべて「これから勧める」文面。**配り終えた後**の通知が無かった |
| 2 | 本文に URL を書けないのに CTA が見えない | `listCampaigns` は `ctaLabel`/`ctaUrl` を返していたが**画面に出していなかった** |
| 3 | dry-run で 28 名全員が「送信済み」除外 | 過去に送った別キャンペーンと同じ campaignId×version を選んでいた（DeliveryKey が同じ）|
| 4 | 下見が「対象を選択してください」 | `mkActionDry` が `mkSelected` しか見ておらず引き継ぎを知らない |
| 5 | 引き継ぎ帯が読めない | **未定義の CSS 変数**（`--ok-bg` 等）のフォールバックで明るい緑背景 + 明るい文字になっていた |

**入れた変更**

- `comeback-light-30d-granted` **v1** を追加（「Light 30日無料付与済み案内」）。
  申込・支払い不要であることを明言する文面。**本文に URL を書かない**。
  CTA = 「KEIBA Analyticsにログイン」→ `/dashboard/`（コード側の固定値）
- 既定選択を `pickInitialCampaign()` へ委譲。**運用テスト専用カナリアは絶対に既定にしない**。
  引き継ぎ中は配った特典に対応する文面を自動選択し、対応が無ければ
  「対応テンプレート未設定」と出して手動選択を求める（近い文面を当てにいかない）
- 引き継ぎ票に `grantOffers`（offerId だけ・PII なし）を載せ、文面の自動選択に使う
- Step 3 に CTA のラベルとリンク先を read-only 表示。専用 URL キャンペーンは実 URL を出さない
- dry-run 画面に `campaignId : vN` と「DeliveryKey は キャンペーン×版×受信者」を表示
- 「特典・オファーの下見」を引き継ぎ対応に。`admin-comeback-grants` の **dry-run だけ**
  `grantOperationId` を受け付け、`collectGrantedRecipients` で再導出（**live は従来どおり recordIds のみ**）
- 引き継ぎ帯を実在トークン（`--action-green` / `--text-main`）へ。モバイル折り返しも追加
- 引き継ぎ中は「取得 0 名 / 選択 0 名」を補助表示へ下げ、「引き継ぎ対象 N 名・再選択不要」を主表示に

**✅ 決着: operationId は付与内容を表さない（本番実測 2026-08-03）**

依頼では「Light 30日無料」、示された operationId は `cb-`**`light-lifetime-free`**`-2026-08-03-d1b34296`。
本番 Customers を **read-only（GET のみ・15 リクエスト・1460 件走査・write 0）** で集計した結果:

| 項目 | 値 |
|---|---|
| `LightGrantOp` 一致 | **28 件** |
| `LightGrantLifetime` = true | **0 件** |
| `LightGrantUntil` あり | **28 件**（全員 2026-09-02）|
| `LightGrantRevokedAt` あり | **0 件** |
| `LightGrantedAt` | 全員 2026-08-03T09:25:10.633Z |
| Premium 側 | 0 件 |

→ **判定 B: 28 名すべて Light 30日無料**（8/3 付与 → 9/2 期限 = 30 日）。永久無料ではない。

**原因**: `operationId` は**最初の dry-run 時の選択で命名**され、`cbLastOperationId` として
その後の選択変更後も引き継がれる（冪等な再開のための仕様）。
先に `light-lifetime-free` で dry-run → 選択を `light-30d-free` に変えて実行、の順序で
ID だけが古い名前のまま残った。**operationId を付与内容の根拠にしてはいけない。**
付与内容の正本は Customers の `*GrantLifetime` / `*GrantUntil` / `*GrantedAt`。

そのため再引き継ぎでは offerId を ID から読まず、**実データの期間から逆引き**する
（`inferGrantOfferId`）。逆引きできない日数（31 日など）は `null` を返して自動選択しない。

**引き継ぎの有効期限を 2 時間 → 24 時間へ**

2 時間では、付与後に案内文面を用意して確認する間に失効した（実際に本件で失効）。
24 時間なら「今日配って今日中に案内を出す」運用に収まる。期限を延ばしても
対象は毎回サーバー再導出・使い切り・DeliveryKey による二重送信防止が効くため安全性は変わらない。

**operationId からの再引き継ぎ（read-only）**

`action: 'handoffLookup'` を追加。operationId を渡すと付与成功者を読み直し、
**件数・付与種別・付与日時だけ**返す（PII / recordId は返さない）。
GET しか投げず、再付与も取り消しもしない。存在しない ID / 0 件 / 期限切れは fail closed（400/409/410）。
画面は 📣 顧客マーケティングタブ Step 2 の「🔁 操作 ID から引き継ぎ直す」から使う。

**別 PR 候補: 案内テンプレートの拡張（雑に 1 文面へまとめない）**

| 付与内容 | 文面 | 状態 |
|---|---|---|
| Light 30日無料 付与済み | `comeback-light-30d-granted` v1 | **本 PR で完成** |
| Light 永久無料 付与済み | 未作成 | 「30日間」と書けないので別文面が必要 |
| Premium 期間限定 付与済み | 未作成 | 見られる範囲が Light と違う |
| Premium 永久無料 付与済み | 未作成 | 同上 |
| Light / Premium 両方 付与済み | 未作成 | 併記が要る |
| 付与なしの一般カムバック | `expired-comeback` v2 ほか | 既存 |
| Premium 再契約割引 | `premium-renewal` v2 | 既存 |
| Premium Plus 案内 | `premium-plus-offer` v2 | 既存 |
| 元プラン別の自動分岐 | 未着手 | 上記が揃ってから |

追加するときは `GRANT_CAMPAIGN_BY_OFFER`（`comebackGrantCampaign.js`）へ 1 対 1 で登録する。
登録しない限り自動選択されない（誤った文面を当てにいかない fail closed）。

## 2026-08-03 — カムバック特典の「確認へ進む」と「本番付与」を分離（branch `fix/comeback-grant-action-clarity` / PR #218 merged `1c3de46`）

**きっかけ**: カムバック特典タブに、本番付与に見えるボタンが 3 つ並んでいて区別できない、という指摘。

**調査で判明した実態（指摘の前提とは違っていた）**

| ボタン | 見た目 | 実際 |
|---|---|---|
| Step 5 本体「⚠️ 🎁 無料特典を付与する」 | 赤 | モーダルを開かず **直接 apply を呼ぶ**。ただし `planFingerprint` を送らないため **Function 側で 400** |
| 追従バー「🚀 無料特典を付与」 | 赤 | **クリックハンドラが無く、押しても何も起きない** |
| 確認モーダル「実行する（付与 N 名 / オファー M 名）」 | — | マーケティングタブ用の `campaign` / `ackBox` を参照しており **ReferenceError で apply に到達しない** |

つまり **3 つとも本番付与に到達しない**状態だった（本番で grant を一度も実行していないため露見せず）。
確認モーダルは dry-run 完了時に自動で開いており、「確認」と「実行」の段階も 1 対 1 になっていなかった。

**入れた変更**

- **本番 write の入口を 1 つに固定**。apply を呼ぶのは `cbRunApply()` だけで、
  呼び出せるのは確認モーダルの最終ボタンのみ（guard テストで固定）
- Step 5 本体と追従バーは **同じ文言・同じアイコン（📋 付与内容の最終確認へ）で、同じ確認画面を開くだけ**
- 追従バーにクリックハンドラを付け、Step 5 以外では該当カードへスクロール（スクロール補助であることを title / aria-label にも明記）
- dry-run は確認モーダルを自動で開かない（結果は Step 4 のパネルに出す）
- 最終ボタンは「実行する」をやめ、**「28 名に Light 30日無料 を付与する」**のように内容を名乗る
  （`comebackApplyAction.js` が文言の単一源。30日 / 永久 / Premium / 両方 / オファーのみ / 0 名を網羅）
- 最終ボタン周辺に、選択人数・付与予定・除外・現有効会員の混入・対象区分・特典・オファー件数・
  変更しないもの・メール非送信・付与後の引き継ぎ導線を 1 画面で表示
- 赤（danger）は確認モーダルの最終ボタンだけに残し、Step 5 カードと追従バーは赤をやめた
- `planFingerprint` を必ず送るようにし、`operationId` は dry-run のものを使う（冪等性は変えない）
- 実行中は無効化して「付与中…」、完了後は同じ確認から再実行不可
- モーダルを開いたら見出しへフォーカス、閉じたら開いたボタンへ戻す

**変えていないもの**: 対象判定 / 付与ロジック / 特典内容 / `admin-comeback-grants` の write 契約 /
`operationId` の冪等性 / 付与成功者の handoff / メール送信経路 / Airtable schema / production env。

**注意**: この PR で **本番付与が実際に成立するようになる**（これまでは 400 / ReferenceError で到達しなかった）。
本番での付与は未実施。Deploy Preview でも Airtable write は行っていない。

## 2026-08-03 — カムバック無料付与の成功者を案内メール工程へ引き継ぐ（branch `feat/comeback-email-handoff` / PR #217 merged `9d82b13`）

**目的**: 無料付与のあと案内メールを送るには、マーケティングタブで同じ人を探して選び直す
必要があった。数十名の再選択は現実的でなく、付与に失敗した人を混ぜる / 付与できた人を
取りこぼす / Email 文字列で別レコードに当てる、が起きる。かといって「付与したら自動で
メールも送る」にすると、2 つの副作用を 1 トランザクション扱いする事故を生む。

**採った方式**: `operationId` を鍵にし、**対象は毎回サーバーが Customers から再導出する**。

付与が成功すると Customers の `LightGrantOp` / `PremiumGrantOp` に操作 ID が書かれる。
つまり**付与成功そのものが既に台帳**であり、成功者リストを別に保存する必要がない。
引き継ぐのは operationId と件数だけ（PII なし・recordId なし・URL にも載せない）。
Airtable のスキーマ変更も新しい保管場所も不要。

| 案 | 判定 |
|---|---|
| sessionStorage に recordId 配列 | ✗ 任意注入できる・期限を持てない |
| 新規 handoff token 台帳（Airtable / Blobs）| ✗ 保管場所とスキーマが増える |
| **operationId ＋ サーバー再導出** | **✓ 採用**（最小かつ恒久的）|

**満たした条件**

- 付与とメールは内部処理として分離したまま（`admin-comeback-grants` は 1 通も送らない）
- 全件成功 → 全員 / 一部成功 → 成功者だけ / 全件失敗 → 進めない（409・副作用なし）
- 502 の途中終了でも「書き込めた分」は引き継げる（**巻き戻さない**）
- recordId 改ざん耐性（引き継ぎ時はクライアントの `recordIds` を一切読まない）
- 期限 2 時間（付与時刻基準・サーバー判定）/ 使い切り / 別タブでは引き継がない
- suppression / 配信停止 / バウンス / 既送信 / キャンペーン固有条件は**従来と同じ経路**
- 「案内文面プレビュー」を「送信予定文面の例」に改め、次工程へ接続（閲覧専用で終わらせない）

**残課題 / 別 PR 候補**

- **元プラン別のメール文面自動分岐**（Light / Premium / Premium Sanrenpuku で文面を出し分ける）。
  本 PR の範囲外。現状は 1 つのキャンペーン文面を管理者が編集して送る。
  着手する場合は `campaignCatalog.js` の版管理と `campaignContentDraft.js` の編集権限境界
  （campaignId / version / audienceRule / CTA URL は編集不可）を壊さないこと。
- 引き継ぎの TTL（2 時間）は運用実績が無い。短すぎる／長すぎるは実運用で見直す。
- Deploy Preview での確認は **UI 導線と失効挙動まで**。本番顧客への付与・送信は未実施。

## 2026-08-01 — メール配信反応の恒久台帳 `EmailEvents` / Phase 1a（branch `feat/email-event-ledger` / PR #199・未 merge）

**目的**: 配信基盤の Activity 保持は実測 3 日。AK 側にイベントを残していないため、
過去の開封・クリックについて「反応が無かった」と「記録が消えた」を区別できない。
署名検証つきで既に稼働している Event Webhook（Phase 0 / 2026-07-22）で届いたイベントを
append-only の台帳へ残す土台を入れる。

**調査で判明した前提（推測せず実測）**

| 項目 | 実測 |
|---|---|
| Event Webhook | 署名検証つきで**既に本番稼働**（鍵未設定なら 403・write 0）|
| 受信後の処理 | bounce/blocked/dropped/spamreport/unsubscribe → `EmailBlacklist`。**open/click は捨てていた** |
| 決済メール v2 | `custom_args`（record_id / idempotency_key / purpose）を刻んでおり 1 通へ結び付く |
| **マーケ配信** | **`custom_args` を刻んでいない**（`marketing-campaign-dispatch.js` の送信ペイロードに無い）|
| 送信時の message id | **記録していない**（`CampaignDeliveries` に列が無い）|

→ いま届くマーケ関連イベントは `email` しか手掛かりが無い。同一アドレスの重複 Customers が
実在するため、**メール単独で顧客へ結び付けない**（`unresolved` として保存はするが結び付けない）。

**採用 schema**: C（append-only 台帳 `EmailEvents` ＋ 集約の併用）。Phase 1 は台帳のみ。
集約列（`CampaignDeliveries` 側）は台帳が動いてから。列定義・保存しない項目・rollback は
`astro-site/docs/EMAIL_EVENT_LEDGER.md` が単一源。

**変更ファイル（6 / base `origin/main`）**

| ファイル | 内容 |
|---|---|
| `src/lib/webhooks/emailEventLedger.js` | 新規・純粋モジュール（正規化 / `EventKey` / 紐付け / PII 最小化 / 集計 / env gate）|
| `src/lib/webhooks/emailEventLedger.test.mjs` | 新規 22 件 |
| `src/lib/webhooks/sendgridWebhook.guard.test.mjs` | guard 4 件追加（env gate / 単一源経由 / upsert キー / PII を渡さない）|
| `netlify/functions/sendgrid-webhook.js` | 受信側の配線（I/O のみ）。応答・ログへ `ledger`（件数と理由コードのみ）を追加 |
| `astro-site/docs/EMAIL_EVENT_LEDGER.md` | 新規・設計と有効化手順 |
| `astro-site/docs/CUSTOMER_MARKETING.md` | 「別タスク」記述を本設計へのリンクに差し替え |

**検証（2026-08-01 / 分離 worktree `analytics-keiba-events`）**

| 項目 | 結果 |
|---|---|
| `node --test src/lib/webhooks/*.test.mjs` | **70 pass / 0 fail** |
| `npm run check:safety` | **EXIT=0**（519 pass / 0 fail）|
| `npm run build` | **EXIT=0**（SSR 関数 prune 後 65.0MB / 250MB 上限）|
| secret scan（PR 差分） | 検出 **0** |
| `package.json` / lockfile / 依存 | **変更 0** |
| CI（PR #199） | safety-check **pass** / Netlify deploy preview **pass** |
| `origin/main` との競合 | 無し（`mergeable=MERGEABLE` / `mergeStateStatus=CLEAN`）|

**本番影響**: merge しても **0**。`EMAIL_EVENT_LEDGER_ENABLED` は production 未設定で、
gate を通らない限り台帳へ 1 バイトも書かない。既存 suppression / 決済メール v2 の分岐と
Webhook の HTTP ステータス契約（200 / 403 / 500）は変更していない（応答 JSON にキーが 1 つ増えるのみ）。

**注意（要判断・本 PR では未修正）**: コード内コメント
（`emailEventLedger.js` 冒頭 / `sendgrid-webhook.js` の `applyEmailEventLedger`）は
送信側の `custom_args` 刻印を「Phase 1b」と書いているが、`EMAIL_EVENT_LEDGER.md` の段取り表では
**1b = Airtable テーブル作成 + env 投入 / 1c = 送信側の刻印**。番号の食い違いはコメント側にある。
指示範囲外のためコードは変更していない（**挙動には影響しない**）。

## 2026-08-01 — Netlify build hook の接続 timeout を bounded retry で吸収（branch `fix/netlify-deploy-bounded-retry` / Draft PR・未 merge）

**事象**: `Import Prediction (Dispatch)` run **30681507056**（2026-08-01 03:11 UTC / repository_dispatch / nankan）が
最終 step `Trigger Netlify deploy` のみで失敗。`curl: (28) ... after 300706 ms` = api.netlify.com:443 への接続 timeout。

**データ反映は成功していた**（read-only 確認・再実行なし）:

| 確認項目 | 実測 |
|---|---|
| import step | 成功。`2026-08-02` nankan（source: racebook・FUN 1 会場 12R / 110 頭） |
| import commit | **`7672c4a`** — `astro-site/src/data/predictions/2026-08-02-funabashi.json` **1 ファイルのみ**（+8098 行） |
| Netlify deploy | **`6a6d640c26d26a0008fe9eaf`** / commit `7672c4a` / state `ready` / created 03:12:12Z / published 03:13:11Z |
| deploy の起動元 | title が commit message ＝ **GitHub 連携の push デプロイ**。同時間帯に hook 由来 deploy（"Deploy triggered by hook: ..."）は無し |
| 現在の published deploy | `6a6d6901c341510008b91ec7` / `b31df9c`（`7672c4a` を祖先に含む） |

→ **build hook の再送は不要**と判定し、**再送していない**（重複 build を起こしていない）。
timeout の発生位置は「build hook POST の TCP 接続確立」であり、import・commit・push・deploy のいずれでもない。

**恒久対策（実装済み・未 merge）**: `.github/actions/netlify-deploy` を最小修正。

- `trigger-netlify-deploy.sh` を新設し、bounded retry（上限 3 回・backoff 5s→15s→30s）を実装。
  retry 対象は **curl exit 6/7/28/35/52/55/56 と HTTP 429 / 5xx のみ**。**4xx と未知エラーは retry せず即 FAIL**、
  **retry 上限到達後も FAIL**（fail-closed 維持）。
- `--connect-timeout 30` / `--max-time 90` を明示（従来は無指定＝ curl 既定の 300 秒待ち）。
- 再送前に Netlify API で対象 commit の deploy 有無を確認し、既にあれば **POST せず成功扱い**（重複 build 防止）。
  `NETLIFY_AUTH_TOKEN` / `NETLIFY_SITE_ID` が未設定なら自動的に無効化され、retry のみの従来動作に縮退する。
- hook URL / token / response 本文をログに出さない（従来は失敗時に response 本文を `cat` していた）。
- `check-publish-drift.yml` の self-heal だけは `commit-sha` を渡さない（同一 commit の再ビルドが目的のため）。

**検証**: `npm run test:netlify-deploy`（`.github/actions/netlify-deploy/tests/run-tests.sh`）= **14 ケース / 33 assertion すべて pass**。
実ネットワークへは出ない（curl をスタブへ差し替え）。workflow YAML 18 本の parse OK。

**未実施（停止境界）**: PR merge / production deploy / secret 追加（`NETLIFY_AUTH_TOKEN` / `NETLIFY_SITE_ID`）/
build hook URL の変更 / 対象 commit 以外の deploy 起動。

**残（本タスク範囲外・記録のみ）**: build hook と GitHub 連携の**二重ビルドが常態化**している
（例: 03:07:56 に同一 commit `1da3f4b` の hook 由来 deploy と push 由来 deploy が両方作成されている）。
hook を廃止するか維持するかは別途判断。

---

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

### 2026-07-31: JRA import の stale read 偽 FAIL 恒久対策（Draft PR）

**ブランチ**: `fix/jra-import-stale-read-retry`（`origin/main` = `aa3ac39` から分岐・未 merge / 未 deploy）

- **事象**: 2026-08-01 の JRA prediction import が run `30617261216` で FAIL
  （`真コンピ指数>=45 の racebook 未対応 266 件`）。1 分 47 秒後の run `30617330461` は
  同じ入力で成功（3 会場 36R・`sourceComputerIndex` 欠落 0・不要馬 0）。
  **データ側は正常で、2026-08-01 の再保存・再 import は行っていない。**
- **原因**: 会場ごとの dispatch 連続時に GitHub Contents API の結果整合性で racebook 側だけが遅れて見える。
  失敗 run の racebook 一覧は札幌 1 件のみ、直後に読んだ computer には中京/新潟が既に存在した。
- **対策**: `classifyInjectionProblems()` で stale 由来（`uncoveredHighCi` のみ）と実欠陥（`ambiguous`）を分離し、
  stale 由来だけ **最大 3 回 / 累計 35 秒**の再取得＋再判定で吸収。上限到達後は従来と同一メッセージで FAIL。
  詳細は `docs/decisions.md` の 2026-07-31 エントリ。
- **追加判断（2026-07-31）**: 「computer は存在するが racebook 0 件」が再取得を尽くしても解消しない場合は
  **skip（成功終了）ではなく FAIL** へ変更した。`importPredictionJra.js` の起動元は
  `import-on-dispatch.yml`（ペア揃いガード通過後の `prediction-updated` / 手動 `workflow_dispatch`）だけで、
  日次 cron `import-prediction-daily.yml` は南関の `import:prediction` を呼ぶ。よってこの状態は構造上あり得ず、
  成功終了にすると当日の JRA 予想が緑のまま未取込になる。
  racebook も computer も無い通常の未投入日は従来どおり skip で据え置き。
- **検証**: `check:jra-stale-retry`（新設・13 件）と `check:jra-join`（17 件へ拡張）を `check:safety` に配線。
  `check:safety` exit 0 / `npm run build` exit 0。
- **未実施（停止境界）**: PR merge / `workflow_dispatch` / production deploy / shared PUT。
- **付随して判明した既存の不備（本タスクでは修正しない）**:
  - `npm run lint` は `eslint.config.*` が存在せず ESLint v9 で実行不能（origin/main 由来）。
  - `npm run typecheck`（`astro check`）は `@astrojs/check` が依存に無く対話インストールを要求する。

### 2026-07-30: Premium Plus 管理画面の表示漏れ修正 → 顧客マーケティング管理 Draft

**ブランチ**: `fix/premium-plus-admin-review-candidates`（`origin/main` = `ba0dbc4` から分岐・未 deploy）

#### 1. 表示漏れの原因と修正（`a39fc1a`）

- **事象**: Airtable ビューでは `PremiumPlusEligibility` 未設定の通常 Premium 会員が 11 名見えるのに、
  管理画面 `/admin/premium-plus-eligibility/` の候補は 3 名だけだった。
- **原因**: list API が顧客向け公開判定 `resolvePremiumPlusRelease()` の `route === none` を
  **そのまま一覧の表示条件に流用**していた。ROUTE B は `PaidAt` を必須とするが、`PaidAt` は
  2026-07-10 の入金確認フロー刷新（`126b6a7`）以降しか書かれず、実測 **13/1441 件**しか埋まっていない。
- **read-only 実測（2026-07-30 / PII 非出力）**:
  - 11 名の内訳: `PaidAt` あり 30 日未満 **7 名** / `PaidAt` 空の旧会員 **4 名**
  - 三連複なしの有効 Premium で `PaidAt ≥ 30 日` は **全 1441 件中 0 件**
    （＝ **ROUTE B は本番で一度も成立していない**）
  - `SanrenpukuPaidAt` も **0/1441 件**
- **修正**: 表示条件を専用の単一源 `premiumPlusAdminAudience.js` へ分離。
  一覧 3 行 → 14 行（+11、ビューと一致）。新規表示分が顧客側へ公開された件数は **0**。

#### 2. 顧客マーケティング管理 Draft（本セッション）

- `/admin/premium-plus-eligibility/` をタブ化し「顧客マーケティング」を追加（AK 独自・**KMA と非統合**）
- 追加: `src/lib/marketing/{customerMarketingAudience,campaignCatalog,campaignSend}.js` /
  `netlify/functions/admin-marketing.js` / `astro-site/docs/CUSTOMER_MARKETING.md`
- 期限切れ・Free・Light・legacy(`unknown`) を横断して segment 表示し、checkbox で複数選択 →
  キャンペーン選択 → preview → dry-run（対象・除外理由・件数の確定）→ 最終確認 → 送信
- 送信は **ScheduledEmails(PENDING) + CampaignDeliveries(queued) を作るだけ**。
  SendGrid を直接呼ぶコードを持たない（guard テストで固定）
- **Airtable schema 変更なし**（既存 `CampaignDeliveries` の `EmailType='campaign'` を使用）
- 実送信は `MARKETING_CAMPAIGN_ENABLED`（未設定 = 503）と
  `NEWSLETTER_AUTOMATION_ENABLED`（production = `false`）の二重 gate で閉じたまま

#### 3. 本番化前の最終監査と是正（2026-07-30 / PR #172 に追加）

read-only 監査で **2 つの本番リスク**を検出し、同一 branch で是正した。

**(1) SendGrid suppression と AK の乖離（誤送信リスク）**

| | 件数 |
|---|---|
| SendGrid suppression（bounces 58 / blocks 4） | **61** |
| AK `EmailBlacklist` 全行 | 12（HARD_BOUNCE 4 / SOFT_BOUNCE 8） |
| AK が実際に送信除外していた数 | **4** |
| AK 判定では送信可能だが SendGrid が suppress 済み | **43 名**（＋ソフトバウンス 4 名 = 計 47 名） |

AK の台帳は Event Webhook 稼働以降のイベントしか持たず、過去分は同期されない
（Webhook 自体は SendGrid 側で enabled・署名検証あり＝メモの「未登録」記述は古い）。
→ `providerSuppression.js` を追加し、dry-run / send / dispatch のたびに SendGrid へ
**GET で照合**。取得失敗時は **503 で中止**（確認できないまま送らない）。
共有 executor は固定宛先ジョブを再チェックしないため、専用 dispatcher で
**1 通ごとの送信直前再検証**も追加。

**(2) `NEWSLETTER_AUTOMATION_ENABLED` の影響範囲**

同フラグを参照する Function は **16**（cron-email-scheduler / send-newsletter 系 /
expiry 通知 / retry-failed-emails / step メール ほか）。マーケティングのために ON にすると
既存経路まで解禁される。
※ 観測時点の `ScheduledEmails` は全 23 件で **PENDING 0 件**（SENT 21 / FAILED 2）。
即時の滞留爆発は無いが、構造的リスクは残る。
→ 専用ゲート **`MARKETING_CAMPAIGN_DISPATCH_ENABLED`** を導入し 2 方向の独立性を確保:
マーケ解禁で既存経路は動かず、既存経路解禁でマーケは送られない（guard テストで固定）。

**Netlify 設定の確定**: `production branch=main` / `allowed_branches=["main"]` /
`stop_builds=false` / ignore コマンド無し
→ **PR #172 の merge = main への push = production deploy 自動発火**。
merge と deploy を別承認にするには `stop_builds` か `ignore` の設定変更が必要（production 設定変更＝未実施）。

#### 4. キャンペーン本文・件名・CTA の本番化前レビューと是正（2026-07-30）

read-only レビューで 6 キャンペーンを点検し、同一 branch で是正した。

| campaignId | v | 状態 | 是正内容 |
|---|---|---|---|
| `expired-comeback` | 2 | ✅ | 宛名のみ修正（CTA 200 で維持） |
| `premium-renewal` | 2 | ✅ | 期限切れ/期限間近どちらにも自然な中立表現へ。三連複買い切り権が失効したと読まれない注記を追加 |
| `sanrenpuku-offer` | 2 | ⛔ 停止 | **三連複を説明・販売する公開ページが無い**（`/pricing/` に記載 0 件・購入導線は dashboard のモーダルのみ）。推測 URL を作らず `ctaUrl:''` で停止 |
| `premium-plus-offer` | 2 | ✅ | `eligible` かつ PHASE 3 以上のみへ限定（CTA 先は PHASE 3 未満で 404）。**対象 11 名 → 2 名** |
| `dormant-reactivation` | 2 | ✅ | 契約 none/expired へ enforce。課金継続中を機械的に除外。「長期」の根拠が無いため名称を「休眠・無料会員 再アプローチ」へ |
| `general-announcement` | 1 | ⛔ 停止 | 本文が初期テンプレートのまま。`template_not_configured` で dry-run 自体を拒否 |

**共通の是正**

- **二重敬称の解消**: 差し込みを `{{salutation}}`（完成した宛名）へ変更。氏名あり `山田 様` /
  氏名なし `お客様`。テンプレート側での敬称後付けを guard テストで禁止
- **キャンペーン横断の頻度ガード（24 時間）**: DeliveryKey は同一 campaign/version の重複しか
  防がないため、別キャンペーンの連続送信を止める。dry-run / send / dispatch 直前の 3 箇所で判定。
  対象は `EmailType='campaign'` のみ（取引メールは含めない）
- **version ロック**: 内容ハッシュをテストで固定し、version 据え置きの本文変更を検知

#### 5. 運用テスト専用キャンペーン `marketing-canary`（2026-07-30 / branch `feat/marketing-canary`）

配信基盤を安全に検証するための専用キャンペーン。**一般顧客には構造的に送れない。**

- 対象は env **`NEWSLETTER_TEST_RECIPIENTS`** 一致者のみ（正本）。env 未設定なら **0 名**
- 判定は `campaignAudienceRules.js` の `marketing_canary_recipient` に閉じ込め、
  判定モジュールは純粋のまま（env は Function 層が `parseTestRecipientsEnv()` で正規化して
  `context` で渡す）。`customerMarketingAudience.js` にテストロジックを混ぜない
- **既存キャンペーンの `audienceRule` は一切変更していない**
- テスト用でも guard をバイパスしない（suppression / blacklist / 配信停止 / 退会 / 停止 /
  test / 不正メール / 重複 / 24h 頻度 / DeliveryKey / planFingerprint / dispatch 直前再検証）
- dispatcher 側も送信直前に固有条件を再判定（キャンペーン不明なら送らない）
- 管理画面は選択肢・説明・確認画面の 3 箇所に 🧪「運用テスト専用」を表示

**本番データ read-only 実測**: テスト受信者 1 名のみ → **1/1/0** /
一般顧客 50 名 → **willSend 0** / 両方同時 → **1 名のみ** / env 空 → **0 名**。

#### 実施していない操作（重要）

production deploy / merge / env 変更 / Airtable schema 変更 / Customers write /
campaign history write（CampaignDeliveries・ScheduledEmails への production write）/
実メール送信 / 通知 / 権限変更 / force push・reset・rebase・amend — **すべて未実施**。
Airtable・SendGrid への通信は **GET のみ**（SendGrid は suppression の読み取りのみ）。
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

### legacy 管理経路の 410 化（2026-07-22 完了）

**誤操作で確認メールが 2 通届く経路を、恒久 410 で塞いだ。** コードのみの変更で env / SendGrid /
Airtable / Automation は無変更。実顧客への送信 0 / Airtable 書込み 0。

- 対象は運用上未使用だが**到達可能**だった 3 つ:
  `netlify/functions/send-payment-confirmation.js` / `netlify/functions/paypal-webhook.js` /
  `src/pages/admin/send-payment-confirmation.astro`。
- いずれも「自前で SendGrid を叩く + `Status='active'` を書く」が **`PaymentEmailSent` を立てない**ため、
  Automation A2 が ON のとき **2 通**届いた。v2 の状態機械も経由しないため二重送信防止が効かない。
- **feature flag による 403 では legacy 期間中の誤操作を防げない**ので、設計方針どおり**恒久 410 Gone**。
  両 Function から **SendGrid / Airtable / `fetch` をコードごと除去**した（フラグで止めるのではなく経路を消す）。
- 旧 admin 画面は **redirect ではなく廃止案内ページ**に置換（代替の `admin-promote-customer` は
  Function のみで**画面が存在しない**ため）。現行手順（`PaymentConfirmed` にチェック）と
  やってはいけない操作を明示し、`noindex` / フォーム・fetch なし。
- guard `src/lib/payments/legacyPaymentRoutes.guard.test.mjs`（8 テスト）を追加し
  `test:bank-payment` → `check:safety` で CI 強制（**`package.json` は既存 glob で拾うため未変更**）。
- 検証: `test:bank-payment` **236 pass / 0 fail** / `check:safety` **exit 0（469 tests・fail 0）** / `build` 成功。

### S9 本体の実装（2026-07-23・`delivered` 有効化は未実施）

**`accepted` → `delivered` / `bounced` / `dropped` の反映を実装した。** コードのみの変更で
env / SendGrid 設定 / Automation は無変更。実顧客への送信 0 / 手動 Airtable 書込み 0。

- **単一源**: 判定 `paymentEmailState.js#decideWebhookTransition()` / 適用
  `src/lib/payments/paymentEmailWebhook.js`。Function は配線のみ（guard で固定）。
- **対象選別**: worker が載せた `custom_args.purpose === 'payment_confirmation_v2'` のイベントだけ。
  メルマガ等の bounce は従来どおり suppression（`EmailBlacklist`）側だけが扱う（両者独立・巻き添えなし）。
- **順序非依存の設計**: 失敗（bounced/dropped）は**吸収状態**、`delivered` は**暫定**で失敗に上書きされる。
  → `delivered` と `bounce` がどちらの順で届いても最終状態は `bounced` に収束。重複イベントは
  同じ値の代入で無害なため **`sg_event_id` の保持が不要＝Airtable の新規フィールドを増やさない**。
- **fail closed**: 識別子欠落は `getRecord` すら呼ばない / レコードの `PaymentEmailIdempotencyKey` と
  完全一致しなければ書かない / `pending`・`attempting_pre_send`・`failed_*`・`needs_admin`・空は上書きしない /
  ログと応答は件数と reason のみ（recordId・メール・キーを出さない）。
- 検証: `test:bank-payment` **255 pass**（+19）/ `test:webhooks` **44 pass**（+5）/
  `check:safety` **exit 0（469 tests・fail 0）** / `build` 成功。
- **注意（本番反映時の挙動）**: `delivered` は SendGrid 側で**未選択のため届かない**が、
  **`bounce` / `dropped` は選択済み**なので、決済メールがバウンスすると本番 Customers の
  `PaymentEmailStatus` が更新される（S9 の目的どおり）。`delivered` の反映には
  SendGrid 設定で **Delivered を追加**する必要がある（**別承認**）。

### S9 E2E 実証（2026-07-22・Phase 0 完了）

**署名付き実イベントが本番エンドポイントで検証を通過し、正常処理された。鍵一致の実証が完了。**

- 実証方法は **organic event**。Test Integration は本番 `EmailBlacklist` にダミーを作りうるため不採用。
  `Delivered` を対象イベントへ追加したうえで、**マジックリンクを 1 通送信**して自然発生させた（承認済み・1 通のみ）。
- 20:52:18Z 送信 → **20:52:43Z** に `sendgrid-webhook` が
  `📨 処理完了: { received: 1, processed: 0, failed: 0, paymentEmail: { targeted: 0, applied: 0, skipped: 0, errors: 0 } }`
  （Duration 104ms）。**`🚫 署名検証 NG` は 0 件**。
- **同時に S9 の選別も実証**: `custom_args.purpose` を持たないマジックリンクを正しく対象外にし
  （`targeted: 0`）、suppression 側も `delivered` を対象外（`processed: 0`）。
- **副作用ゼロ**: `EmailBlacklist` は 11 件 / `BounceCount` 合計 16 / HARD 4・SOFT 7 で baseline のまま。
  Customers への書込みも 0 件。env / deploy / SendGrid のその他設定は無変更。
- **未実証は 1 点のみ**: 決済確認メールの `delivered` で `applied: 1` になること（次の実入金時に自然確認）。
- 詳細は `astro-site/docs/SENDGRID_WEBHOOK.md` §完了: 鍵一致の E2E 実証 が単一源。

## Remaining

- ~~入金確認メール v2 の cutover（D1）~~ → **2026-07-21 に完了・gate=v2-full で本番稼働中**
  （§D1 cutover 完了 / §初の実顧客通過 / §カナリア再検証）。**Remaining ではない。**
- ~~**S9 Event Webhook 本体**~~ → **2026-07-22 実装・本番反映完了**（PR #154 / `cd04d89`・§S9 本体の実装）。
  SendGrid の `Delivered` イベント追加も**完了**。**Remaining ではない**
- ~~Webhook fail closed 化（Phase 0）の本番反映~~ → **2026-07-22 完了**（PR #149 merge `137a348` /
  published `6a609fe22791d800080c2ff0`）。**Remaining ではない**
- ~~**Phase 0 の鍵一致 E2E 実証**~~ → **2026-07-22 完了**（§S9 E2E 実証）。署名付き実イベントが
  検証を通過し `📨 処理完了` を確認。**Remaining ではない**
- **S9 の実データ確認（最後の 1 点）**: 決済確認メール（`purpose='payment_confirmation_v2'`）の
  `delivered` で `paymentEmail.applied: 1` になること。**次の実入金時に read-only 確認するだけ**でよく、
  こちらから起こす作業は無い
- **Function ログへのメールアドレス平文出力**（**低優先度・着手条件つきで据え置き / 2026-07-22 判断**）。
  - **規模（実測 / origin/main）**: メールアドレスの値をログへ出しているのは **17 Function・約 61 箇所**。
    多い順に `send-newsletter.js`(13) / `bank-transfer-application.js`(11) /
    `send-payment-confirmation-auto.js`(4) / `send-magic-link.js`(4) / `expiry-*.js`(各4) /
    `domain-protection.js`(4) / `auth-user.js`(3) / `login-rate-limiter.js`(3) ほか。
    **決済メール v2 経路（`payment-email-worker` / `dispatcher` / `sendgrid-webhook`）は 0 箇所**
    ＝ v2 以前からのリポジトリ全体の慣習であり、v2 が作った欠陥ではない。
  - **1 ファイルだけ直しても意味がない**（16 本が残る）。逆に全 17 本の一括削除は差分が大きく、
    ログは「あの顧客にメールが届いたか」の調査で実際に使っている運用資産のため、調査能力を落とす。
  - **リスク評価（低）**: 露出先は Netlify の Function ログのみで閲覧者は実質 MK のみ。
    トークンは `tokenPrefix`（8 桁）だけでフル値は出ておらず乗っ取りには使えない。
    **log drain（ログの外部転送）の有無は Netlify API から確認できない** → 設定していれば
    露出範囲が変わるため、**Netlify UI で一度確認する**こと（未確認事項）。
  - **採る方針（着手時）**: 共通の `maskEmail()`（`a***@yahoo.co.jp` 形式）を 1 つ作り、
    **認証・決済系の高感度な数本にだけ適用**する（`send-magic-link` / `verify-magic-link` /
    `auth-user` / `login-rate-limiter` / `confirm-bank-payment` / `send-payment-confirmation-auto`）。
    デバッグ性を保ったまま全文露出を止める。メルマガ系は対象外のまま残す。
  - **着手条件（どれかを満たしたら実施）**:
    ① 認証・決済まわりのコードを触る作業が発生したとき（ついでに実施）
    ② **ログを他人と共有する必要が出たとき**（チーム招待 / サポート連携 / log drain 設定）← 実質的なトリガ
    ③ 顧客データの取り扱いについて外部要件（監査・規約変更）が生じたとき
  - 上記のいずれも無い間は**着手しない**。単独で急ぐ理由は無い。
- ~~入金確認メール v2 の legacy noreply 経路の是正~~ → **2026-07-22 完了**（PR #149 で
  `confirm-bank-payment.js` legacy 分岐 / `send-payment-confirmation-auto.js` を `senderIdentity.js` へ移行・
  main 反映済み）。gate を legacy へ rollback しても送信元は `support@keiba.link`
- ~~`/admin/send-payment-confirmation`（+ `send-payment-confirmation.js`）と `paypal-webhook.js` の
  **410 Gone / redirect 化**~~ → **2026-07-22 完了**（§legacy 管理経路の 410 化）。**Remaining ではない**
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

### メール配信反応の恒久台帳 `EmailEvents` の有効化（2026-08-01 / 未承認）

Phase 1a（コード・テスト・docs）は PR #199 で完了。以降は**すべてユーザー操作**で、
順序を守ること。**1b より前は 1 バイトも書かない。**

| Phase | 内容 | 実行者 | リスク |
|---|---|---|---|
| **1a** | 純粋モジュール・テスト・受信側の配線（既定 OFF）・docs | **完了**（PR #199 merged `8a493ce` / production deploy ready）| なし（write 0）|
| **1a-2** | 書き込みのバッチ化・bounded retry・失敗集計 | 実装済み（branch `fix/email-event-ledger-write-resilience`・**merge 未承認**）| なし（write 0）|
| **1b（テーブル）** | Airtable `EmailEvents` 作成 | **完了**（2026-08-02 / `tblWkaxu7p0MRuUwL` / 21 列 / primary=EventKey / 0 行）| なし（env 未投入なので書かれない）|
| **1b（env）** | `EMAIL_EVENT_LEDGER_ENABLED=true`（小文字 true / Functions scope / Production context）を投入 → **redeploy** | **ユーザー・未実施** | 台帳への write 開始 |
| **1c** | 送信側で `custom_args` を刻む（`campaignCustomArgs.js` + dispatcher 配線）| **実装済み**（branch `feat/marketing-custom-args-phase1c`・**merge 未承認**）| 送信経路の変更（送信 gate は OFF のまま）|
| **1d** | 受信側へ配信索引を渡し `resolved` を有効化。集約列を追加 | 別 PR | 表示の変更 |

- **1b を飛ばして 1c を先に入れない**（刻んでも保存先が無い）。
- **env 投入は 1a-2（耐障害修正）の merge + deploy を先に済ませてから**。初版の書き込みは
  失敗を沈黙させるため、有効化しても欠測に気付けない。
- **有効化後の最初の確認は `accepted` と `written` の一致**（差＝欠測）。`failureReasons` に
  `forbidden` / `not_found` / `unprocessable` が出たら設定不備なので即 unset して直す。
- 台帳を止めるときは `EMAIL_EVENT_LEDGER_ENABLED` を unset → redeploy。
  受信は継続し、書き込みだけ止まる（コード変更不要）。
- **台帳運用開始前のイベントは復元できない**。admin 表示では「未開封」と「取得不能」を必ず区別する。

### 顧客マーケティングの実送信有効化（2026-07-30 / 未承認）

Draft 実装は完了しているが、実送信は次の承認と操作が揃うまで**構造的に不可能**。順序を守ること。

1. ~~キャンペーン本文・件名・CTA の最終確認~~ → **2026-07-30 完了**（4 本が使用可能・2 本は使用停止）
2. **PR #172 の merge**（＝ main への push ＝ **production deploy が自動発火する**）
3. `MARKETING_CAMPAIGN_ENABLED=true` を Netlify production へ設定（**キュー登録**の解禁）
4. 専用テスト受信者だけで dry-run → 送信し、`ScheduledEmails` / `CampaignDeliveries` を目視確認
5. `marketing-campaign-dispatch` を `dryRun:true` で叩き、送信直前再検証の結果を確認
6. `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true`（**実送信**の解禁）
7. `marketing-campaign-dispatch` を `dryRun:false` で実行

**`NEWSLETTER_AUTOMATION_ENABLED` は触らない。** マーケティングの有効化に不要で、
ON にすると既存メール経路（メルマガ・期限通知・再送・step）まで同時に解禁される。

3 と 6 は独立した env で、どちらか片方だけでは実送信されない。
rollback は該当 env の unset（コード変更不要）。

- **`SanrenpukuPaidAt` / `PaidAt` が空な会員の扱いは未決**。Premium Plus の販売対象にするには
  Airtable の `PaidAt` を実際の入金確認日で補正する（Customers write）必要があり、未承認。
  **推測で日付を作らない**方針は維持する。
- **三連複の案内先 URL が未確定**（`sanrenpuku-offer` は使用停止のまま）。
  三連複を説明・販売する公開ページを用意するか、既存導線（dashboard のモーダル）を
  CTA 先として許容するかの判断が必要。決まったら `ctaUrl` を設定し version を上げる。
- **`general-announcement` の本文が未設定**（使用停止のまま）。用途が決まった時点で
  本文を書き version を上げる。用途ごとに個別キャンペーンを追加する方が安全。

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
- **Branch（本更新時 / PR #199・未 merge）**: `feat/email-event-ledger`（worktree
  `/Users/user/Projects/analytics-keiba-events`）。base `main` / 検証時の `origin/main` は `1e04d91`。
  変更範囲は `astro-site/src/lib/webhooks/emailEventLedger*.{js,test.mjs}`（新規）/
  `sendgridWebhook.guard.test.mjs` / `astro-site/netlify/functions/sendgrid-webhook.js` /
  `astro-site/docs/{EMAIL_EVENT_LEDGER,CUSTOMER_MARKETING}.md` / `docs/progress.md`。
  **`package.json` / lockfile / workflow は未変更。** 競合なし（`MERGEABLE` / `CLEAN`）。
- 作業はいずれも**分離 worktree** で実施（ユーザーのメイン checkout へは書込まない。
  未コミット変更はユーザーの作業中変更として保全）。
- メイン checkout の状態は §In Progress を参照（point-in-time 観測。本書に固定記載しない）。
- **Branch（本更新時 / **PR #230 merged `423c180`・production 反映済み**）**: `feat/crm-measurement-normalize`
  （worktree `/Users/user/Projects/analytics-keiba-measure`）。base `main` / 分岐時の `origin/main` は `b55f264`。
  変更範囲は `astro-site/src/lib/crm/**` / `astro-site/src/lib/marketing/marketingDispatchGate.js` /
  `astro-site/src/lib/webhooks/emailEventOpenClick.fixture.test.mjs`（新規）/
  `astro-site/netlify/functions/{admin-marketing,marketing-campaign-dispatch,send-magic-link}.js` /
  `astro-site/src/pages/admin/premium-plus-eligibility.astro` /
  `astro-site/scripts/check-measurement-settings.mjs`（新規）/ `astro-site/package.json`（script 追加のみ）/
  `.github/workflows/safety-check.yml`（step 追加のみ）/ docs 3 ファイル。**lockfile は未変更。**
  外部サービス設定変更・production env 変更・メール実送信は**していない**（停止境界）。
- **Branch（**PR #232 merged `46f2ecc`・production 反映済み**）**: `feat/customer-import-preview`（worktree
  `/Users/user/Projects/analytics-keiba-import`）。base `main` / 分岐時の `origin/main` は `ef4873b`。
  変更範囲は `astro-site/src/lib/crm/**`（新規 4 / 拡張 1）/
  `astro-site/netlify/functions/admin-customer-import.js`（新規）/
  `astro-site/src/pages/admin/premium-plus-eligibility.astro` / docs 2 ファイル。
  **`package.json` / lockfile / workflow はいずれも未変更**
  （新テストは既存の `test:crm`（`src/lib/crm/*.test.mjs`）と CI step に自動で乗る）。
  実 CSV 未受領 / 本番 write 未実施 / production 未反映。
- **Branch（closed・未 merge）**: `chore/marketing-canary-v3`（PR #231 / `8ac2204`）。
  カナリア再送のための版上げだったが**送信前に実配信で着弾確認できたため close**。
  branch は remote / local とも削除済み（必要になったら同じ版上げをやり直す）。
- **作業 worktree**: `/Users/user/Projects/analytics-keiba-measure` は本 Phase 完了時に撤去済み。
- **Last verified**: 2026-08-04
