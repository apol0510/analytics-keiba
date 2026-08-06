# メルマガ自動化 管理 UI / API — production 導入前監査

対象: PR #237 `feat/marketing-automation`（Phase A / B / B-2）。
実施日 2026-08-06。**read-only 監査**（production deploy 0 / env 変更 0 / Redis・Airtable write 0 /
メール送信 0 / merge 0）。永続化層は PR #239 の本番 canary で **PASS** 済み（別記録）。

> **2026-08-06 追記: blocker はすべて修正済み。** 対応内容は末尾
> [「修正の記録」](#修正の記録2026-08-06)を参照。以下の指摘本文は**修正前の状態**の記録として残す。

## 結論（監査時点）

**このままでは production へ入れられない。** 送信事故の危険は低い（全経路が fail-closed 側で止まる）が、
**「ACTIVE にしても動かない」「dry-run で確かめた対象と実行対象が一致しない」**という
状態の食い違いが残っており、開けたときに何が起きるかを説明できない。

blocker 6 件（うち 2 件は fake Redis で再現確認済み）、correctness 4 件、運用 3 件。

---

## A. 本番投入を止めるもの（blocker）

### A-1. `enabled` が保存されず、ACTIVE 化しても scheduler が永久に動かない 🔁再現済み

`transition()` は ACTIVE 化時に `enabled: true` を付けるが、`automationStore.saveDefinition()` は
`pick(definition, DEF_FIELDS)` で保存項目を絞っており **`DEF_FIELDS` に `enabled` が無い**。
保存 → 読み戻しで `enabled` は消える。一方 `automationScheduler.isDue()` は
`definition.status !== 'ACTIVE' || definition.enabled !== true` で弾く。

```
transition が付ける enabled: true
保存後に enabled が残るか: false -> undefined
status: ACTIVE
isDue(保存後の定義): {"due":false,"reason":"not_active"}
isDue(保存前の定義): {"due":true,...}
```

**影響**: 管理 UI と `get` / `status` は **ACTIVE** と表示するのに、scheduler は永久に `not_active`。
送信事故ではなく「動かないのに動いているように見える」二枚舌。ゲートを開けた後に
原因不明の未実行として現れ、切り分けに時間を取られる。

**対応案**: `DEF_FIELDS` に `enabled` を足す、または `isDue` の判定を `status === 'ACTIVE'` 一本にする
（`enabled` は `status` の従属値なので**二重に持たない**方が事故が少ない）。どちらでも回帰テストを足すこと。

### A-2. `snapshotCount` が保存されず、drift 検知が常に発火する 🔁再現済み

`detectDrift({dryRun, current})` は `current.snapshotCount > dryRun.snapshotCount` で
`snapshot_grew` を出すが、`snapshotCount` も **`DEF_FIELDS` に無い**ため保存されない。
`int(undefined) === 0` なので、**対象が減っていても** drift として弾かれる。

```
保存後に snapshotCount が残るか: false -> undefined
detectDrift(dryRun=保存後, current={snapshotCount:40,...}): {"ok":false,"drifts":["snapshot_grew"]}
```

**影響**: fail-closed 側なので誤送信はしないが、**drift 検知が事実上まったく機能していない**。
「増えていたら止める」という統制が「常に止まる」に化けており、統制として検証できていない。

**対応案**: ACTIVE 化時に `snapshotCount` を `snapshotFingerprint` と一緒に永続化する。

### A-3. `snapshotFingerprint` を保存しているのに、実行時に照合していない

`activate` は `snapshotFingerprint` 必須で保存もするが、`automationScheduler` 側に
fingerprint を突き合わせるコードが無い（`detectDrift` は件数と campaign 版・本文だけ見る）。

**影響**: 「dry-run で確認した**その集合**へ送る」ことを実行時に保証していない。
件数さえ増えなければ、中身が入れ替わっていても通る。

**対応案**: 実行直前に `computeAudienceFingerprint` を再計算し、保存値と一致しなければ enqueue しない。

### A-4. ACTIVE のまま `update` でき、dry-run 統制を回避できる

`update` は `status === RUNNING` のときだけ拒否する。**ACTIVE は素通り**で、
`trigger` / `schedule` / `maxRecipients` / `campaignId` を変更できる。
`transition` を通らないので `status` は ACTIVE のまま、`snapshotFingerprint` は**古い値が残る**。

**影響**: `activate` に置いた「snapshot 必須 + campaign drift 検査」を、
**ACTIVE 化した後の update で迂回**できる。対象条件を広げても再 dry-run も再承認も要らない。

**対応案**: ACTIVE 中の `update` は拒否して PAUSED を要求する、または update 時に
`snapshotFingerprint` を破棄し ACTIVE → DRAFT/PAUSED へ落として再承認を必須にする。

### A-5. `cron-marketing-automation` に認証が無い（公開 HTTP Function）

handler に secret 検証が無い。`netlify.toml` に schedule を登録していないため
**Netlify の scheduled function ではなく通常の公開 HTTP Function** として配備される。

- 現在はゲート閉なので `ran:false` を返すだけ（ただし**ゲートの設定状況を無認証で開示**している）
- `MARKETING_AUTOMATION_SCHEDULER_ENABLED` を開けた瞬間、**誰でも tick を起動できる**
  （Redis へ `claim` / `createRun` を書く。将来 enqueue を配線すれば送信につながる）

**対応案**: `x-admin-secret` 検証を足す、または `netlify.toml` に schedule 登録して
HTTP 起動を塞ぐ（Netlify の scheduled function は HTTP から呼べない）。
後者を選ぶ場合は「schedule を登録しない」ことを固定している現行テストの意図と衝突するので、
**どちらを正とするかを先に決める**こと。

### A-6. 防御の深さが実質 1 枚しかない（env 実測）

`cron` は 3 ゲート全開でのみ動く設計だが、**2 つは既に production で開いている**（2026-08-06 実測）。

| env | production |
|---|---|
| `MARKETING_AUTOMATION_SCHEDULER_ENABLED` | **unset** |
| `MARKETING_CAMPAIGN_ENABLED` | **true** |
| `MARKETING_CAMPAIGN_DISPATCH_ENABLED` | **true** |

**影響**: 「3 重ゲート」という設計上の安心は成立していない。merge 後は
**env 1 つで自動配信が生きる**。`MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` も同様に 1 枚。

**対応案**: 段階開放の順序と、各段で何を観測してから次へ進むかを先に決めて文書化する
（A-1〜A-5 を直した後でなければ、開けても観測できない）。

---

## B. 正しさに影響するもの

### B-1. Customers 取得が 6,000 件で黙って打ち切られる ⚠️取り込み完了で顕在化

`admin-marketing-automation.js` の `fetchAllReadOnly` は `pageSize=100` / `MAX_PAGES=60` で、
上限に達すると **`break` して黙って返す**（打ち切りを呼び出し側へ伝えない）。

現在の Customers は約 1,476 件（15 ページ）なので顕在化していない。
しかし**進行中の外部無料ユーザー取り込み**（残り 14,484 件）が完了すると約 15,800 件 = 158 ページとなり、
**先頭 6,000 件だけで対象集合と件数を計算する**。preview の件数・除外理由・snapshot 指紋・
scheduler の再判定がすべて過小になり、しかも**エラーにならない**。

**対応案**: 上限に達したら `truncated: true` を返して **fail-closed で処理を止める**
（黙って続けない）。上限自体も実データ規模に合わせて見直す。

### B-2. `preview` は保存済み Definition ではなく preset を見る

`preview({automationId})` は `getAutomationPreset(automationId)`（カタログ検索）から
Definition を組み立てる。**Redis の保存済み Definition を読まない。**

**影響**: `update` で変更した実設定と dry-run の内容が一致しない。
A-4 と組み合わさると「dry-run では安全に見えるが、保存されている条件は別物」が成立しうる。

**対応案**: 保存済みがあればそれを基に dry-run し、preset は新規作成時のみ使う。

### B-3. `runs` が当日の runId しか見ない

`runs()` は `ids = [today]` 固定。**履歴確認は実質 1 日分**で、
UI の「run 履歴」は昨日以前を表示できない。

**対応案**: 直近 N 日を引く、または run の索引を持つ。

### B-4. 状態変更と索引更新が 2 段で、片方だけ失敗しうる

- `activate`: `saveDefinition` → `markActive`。後者が失敗すると **ACTIVE だが索引に無い**
  （送らない側なので安全）
- `cancel`: `_transitionTo` → `unmarkActive`。後者が失敗すると **CANCELLED なのに索引に残る**
  （`isDue` が status を見るので送信はしないが索引が汚れる）

**対応案**: 索引を状態から導出するか、tick 側で索引と status の不一致を検知して掃除する。

---

## C. 運用・可観測性

### C-1. 管理 UI の write 連動 ※**監査時の記述に誤りがあった**

> ⚠️ **訂正（2026-08-06）**: 当初「`writeEnabled` を参照して有効化するコードが無い」と書いたが、
> これは**誤り**。`autoApplyWriteGate(out.writeEnabled === true)` が `list` の応答で
> 呼ばれており、連動そのものは実装されていた。以下は再調査後の正しい指摘。

実際の弱点は次の 3 点だった。

1. write ゲートの反映が**「自動化一覧を読み込む」を押したときだけ**で、他の応答では更新されない
   （拒否された後も開いた見た目が残る）
2. `activate` / `pause` / `cancel` が **`expectedVersion: '1'` を固定値で送っている**。
   configVersion は更新のたびに増えるので、2 回目以降は必ず `version_conflict` になる
3. dry-run 後に設定を触っても**承認済み指紋がそのまま残る**（古い対象で ACTIVE 化を申請してしまう）

### C-2. `preview` は read だが Customers 全件走査

write ゲートの対象外で、1 回で最大 60 リクエスト。連打すると Airtable のレート制限に触れうる。
**対応案**: 短時間の結果キャッシュ、または preview の連続実行に間隔を設ける。

### C-3. 既存 AK 全体と同様の軽微な事項

- secret 比較が時間非依存でない（`provided !== SECRET`）
- CORS が `Access-Control-Allow-Origin: '*'`（Cookie 認証ではなくヘッダ secret なので実害は限定的）

---

## D. 良好で、変えるべきでない点

- **write ゲートが Redis store 初期化より前**にあり、API 直叩きでも接続 0 で 403（実測済み）
- この Function 群は **SendGrid 送信 API を呼ぶコードを持たない**（guard テストで固定）
- Airtable へは **GET のみ**。Customers / PaymentConfirmed / Status / PlanType / 有効期限 / 特典を書く経路が無い
- Redis 名前空間は `ak:marketing-automation:` に閉じ、PII を保存しない
- 例外の中身を応答へ返さない
- Definition 保存・取得・**CAS は本番 Upstash で実証済み**（PR #239 canary PASS）
- `netlify.toml` に scheduler を登録していない（テストで固定）

---

## 導入前に必要な作業（推奨順）

| 順 | 作業 | 理由 |
|---|---|---|
| 1 | A-1 / A-2 の修正 + 回帰テスト | 直さないと ACTIVE 化しても動かず、drift 統制も検証できない |
| 2 | A-4（ACTIVE 中 update の扱い）と B-2（preview の参照元）を同時に決める | 片方だけ直すと統制の穴が残る |
| 3 | A-3（実行時の fingerprint 照合） | 「dry-run した集合へ送る」保証の本体 |
| 4 | A-5（cron の認証 or schedule 登録）| 開放前に必須。どちらを正とするか要判断 |
| 5 | B-1（ページ打ち切りを fail-closed に）| 取り込み完了で必ず顕在化する |
| 6 | C-1（UI の write 配線）| 開けても操作できないため |
| 7 | B-3 / B-4 / C-2 | 運用品質 |
| 8 | A-6 の段階開放手順を文書化 | 1〜7 の後。何を観測して次へ進むかを先に決める |

**1〜3 が終わるまで `MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` を production へ設定しないこと。**
**4 が終わるまで `MARKETING_AUTOMATION_SCHEDULER_ENABLED` を production へ設定しないこと。**

## 監査で行っていないこと

production deploy / env 変更 / Redis write / Airtable read・write / メール送信 / 実顧客接触 /
PR の merge — **いずれも未実施**。env は `netlify env:get` による**読み取りのみ**。
再現確認は fake Redis のみで、外部 I/O は発生していない。


---

# 修正の記録（2026-08-06）

blocker 6 件と correctness 4 件のうち影響のあるものを一括修正した。
回帰テストは `src/lib/marketing/automationBlockerFixes.test.mjs`（21 件）で、
本書の A-1〜A-6 / B-1〜B-2 / C-1 に 1 対 1 で対応する。

| # | 対応 | 検証 |
|---|---|---|
| A-1 | `DEF_FIELDS` に `enabled` を追加。さらに `loadDefinition` が **`status` から `enabled` を導出し直す**（正本は `status`）。`isDue` は `status` を正、`enabled === false` のときだけ追加で止める | 保存 → 読み戻し後に `isDue` が `due:true`。`status=PAUSED` なのに `enabled:true` で保存しても読み戻しは `false` |
| A-2 | `snapshotCount` と `snapshotOccurrenceDate` を永続化。`detectDrift` は**承認済み snapshot が無ければ件数比較へ進まず** `snapshot_missing` | 対象が 42 → 40 に減っても `snapshot_grew` にならない |
| A-3 | `verifySnapshotBeforeDispatch()` を新設。実行直前に**指紋・件数・暦日・campaign 版・本文**を突き合わせ、1 つでも違えば enqueue しない | 件数が同じでも指紋違いで `snapshot_fingerprint_changed`。承認と違う暦日で `snapshot_stale` |
| A-4 | ACTIVE 中の `update` を `active_locked` で拒否（PAUSED / DRAFT 経由を要求）。`update` は**承認済み snapshot を破棄**する | ACTIVE のまま trigger を変えられない。PAUSED で変更すると `snapshotFingerprint` が `null` になる |
| A-5 | `authorizeInvocation()` を新設。**全呼び出しで専用 secret 必須**（`MARKETING_AUTOMATION_CRON_SECRET` + `x-cron-secret`）。認可は**ゲート判定・Redis / Airtable 初期化より前**で、ゲートの設定状況すら無認証では返さない | 無認証・詐称ヘッダ・管理 secret のいずれも 403 かつ Redis 接続 0。secret 未設定は 503 |
| A-6 | 既存 2 env（本番で既に true）に依存せず、**自動化専用のゲートを 2 つ**要求: `MARKETING_AUTOMATION_SCHEDULER_ENABLED=true` と `MARKETING_AUTOMATION_DISPATCH_ARMED=<当日 JST 日付>`。後者は**日付一致**なので翌日に自動的に閉じる | 既存 2 つが true でも当日武装が無ければ `allOpen:false`。翌日になると閉じる |
| B-1 | ページ上限で `break` するのをやめ、`CustomerFetchTruncatedError` で**失敗させる**（上限も 60 → 300 ページへ）。API は 503 `customers_truncated` を返し `sideEffects: 'none'` | offset が尽きない応答で 503 + `customers_truncated` |
| B-2 | `preview` は**保存済み Definition を基準**にし、preset は保存済みが無いときだけ使う。応答に `基準` / `configVersion` / `status` / `未保存の変更あり` を返す | 保存済みの上限 7 が dry-run に反映される |
| C-1 | UI は**どの応答でも** `writeEnabled` を反映し直し、`write_blocked` を受けたら即座に閉じる。`configVersion` の固定値送信をやめ、dry-run 前の ACTIVE 化を UI 側でも止め、設定変更時に承認済み指紋を破棄する | マークアップ初期値 disabled / `expectedVersion: '1'` の固定値が無いこと |

## dry-run・保存・実行で同じ対象集合を使う

対象集合の組み立てを **`_computeSnapshot()` の 1 経路**に集約した。

1. **dry-run**（`preview`）… 保存済み Definition から `_computeSnapshot` で対象と指紋を出す
2. **保存**（`activate`）… 管理者の申告値を鵜呑みにせず、**同じ `_computeSnapshot` で再計算**して
   一致した場合のみ ACTIVE 化し、**指紋・件数・暦日**を固定する（不一致は `snapshot_mismatch`）
3. **実行**（scheduler）… `verifySnapshotBeforeDispatch` で保存値と再計算値を突き合わせ、
   1 つでも違えば enqueue しない

dry-run 後に対象が増えた状態で承認しようとすると `snapshot_mismatch` で止まることを回帰テストで固定した。

## 残っている項目（blocker ではない）

- **B-3** `runs` が当日の runId しか見ない（履歴は 1 日分）
- **B-4** 状態変更と索引更新が 2 段（`activate` は送らない側 / `cancel` は索引が汚れる）
- **C-2** `preview` の Customers 全件走査（連打でレート制限に触れうる）
- **C-3** secret 比較が時間非依存でない / CORS `*`（既存 AK 全体と同様）

## この修正で行っていないこと

**production deploy / env 変更 / Redis write / Airtable read・write / メール送信 / 実顧客接触 /
merge は未実施。** 新しい env（`MARKETING_AUTOMATION_DISPATCH_ARMED`）も**production へ設定していない**。


## A-5 の再修正（2026-08-06・詐称可能な根拠を排除）

初回修正では **Netlify のスケジュール実行を `x-netlify-event: schedule` / `event.isScheduled`
で判定**していた。これは**外部から自由に付けられるヘッダ**であり、
`curl -H 'x-netlify-event: schedule'` を送るだけで認証を迂回できる。**認証根拠として不適切**だった。

### 変更点

| 項目 | 修正前 | 修正後 |
|---|---|---|
| 認証根拠 | schedule ヘッダ **または** `x-admin-secret` | **専用 secret のみ**（例外経路なし） |
| env | `MARKETING_ADMIN_SECRET` / `PREMIUM_PLUS_ADMIN_SECRET` を流用 | **`MARKETING_AUTOMATION_CRON_SECRET`（専用）** |
| ヘッダ | `x-admin-secret`（管理画面と共用） | **`x-cron-secret`（専用）** |
| 比較 | `!==` | `timingSafeEqual`（長さ違いも一定時間） |
| 未設定時 | 他 secret へフォールバック | **フォールバックしない**。503 `secret_not_configured` |

**鍵を用途ごとに分ける**のが目的。管理画面の secret を知っている人が自動配信の tick まで
起こせる状態を作らない（漏洩時の影響範囲を切る）。

### 回帰テスト（`automationBlockerFixes.test.mjs`）

- **詐称された schedule ヘッダで通らない**: `x-netlify-event: schedule` / 大文字小文字違い /
  `user-agent: Netlify` 併用 / `event.isScheduled: true` / それらと誤った secret の組み合わせ —
  **すべて 403**
- **管理画面の secret では起動できない**: `x-admin-secret: <管理 secret>` も
  `x-cron-secret: <管理 secret>` も通らない
- **専用 env が無ければ他 secret へフォールバックしない**: 503 `secret_not_configured`
- **handler レベル**でも、無認証 / 詐称 / 管理 secret / secret 未設定のいずれでも
  **Redis へのリクエスト 0**（fetch 呼び出し回数を実測）
- **構造 guard**: 認証コードが `x-netlify-event` / `isScheduled` / `PREMIUM_PLUS_ADMIN_SECRET` /
  `MARKETING_ADMIN_SECRET` / `x-admin-secret` を**実コードで参照していない**こと、
  `timingSafeEqual` を使っていることを固定

### 運用上の帰結（要判断・未決）

**この設計では Netlify 内蔵のスケジュール実行から呼べない**（スケジュール起動に任意ヘッダを
付けられないため）。開放時は次のどちらかを選ぶ必要がある。

1. **外部トリガー**（GitHub Actions など）から `x-cron-secret` を付けて叩く
2. `netlify.toml` に schedule 登録し、**Netlify のスケジュール実行専用**にする
   （scheduled function は HTTP から呼べないので、そもそも公開エンドポイントでなくなる）。
   ただし現行テストは「schedule を登録しない」ことを固定しているため、**方針決定が先**

いずれも **production env / `netlify.toml` は未変更**。


## env 全閉鎖時の挙動確認（Deploy Preview / 2026-08-06）

`deploy-preview-237` で実測。**production deploy なし・env 変更なし・書き込みなし。**
自動化系 env は production / deploy-preview の**両方で unset** であることを事前に確認した
（`MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` / `..._CRON_SECRET` / `..._SCHEDULER_ENABLED` /
`..._DISPATCH_ARMED`）。

### cron（`cron-marketing-automation`）

| 呼び方 | 結果 |
|---|---|
| 無認証 | **503** `secret_not_configured` / `接続: {redis:false, airtable:false}` |
| **詐称** `x-netlify-event: schedule` + `isScheduled:true` | **503**（同上・通らない） |
| 当て推量の `x-cron-secret` | **503**（専用 env 未設定なので誰も通らない） |

→ **詐称ヘッダで素通りしないこと**を本番同等のランタイムで確認。応答にゲートの env 名は出ない。

### 管理 API（`admin-marketing-automation`）

| 呼び方 | 結果 |
|---|---|
| secret 無し（`list` / `preview` / `create`） | **403** `Forbidden` |
| secret 有り `list` | **200** / `writeEnabled: false` / プリセット 7 件 / `保存先: store_unavailable` / `保存済み: null` |
| secret 有り `get` | **503** `store_unavailable`（**推測データを返さない**） |
| secret 有り `preview`（dry-run） | **200** / `基準: 'preset'` / `dryRun: true` / `sideEffects: 'none'` / 母数 **1,677** 件・対象 0・除外 1,677 |
| secret 有り **`create`** | **403** `write_blocked` / `接続: {redis:false, airtable:false}` / `sideEffects: 'none'` |
| secret 有り **`activate`** | **403** `write_blocked`（同上） |

### 管理画面

`/admin/premium-plus-eligibility` は **401 Authentication required**（`/admin/*` の Basic-Auth Edge Function）。

### 分かったこと

- **write は env 全閉鎖で確実に止まる**。`create` / `activate` とも Redis / Airtable へ接続する前に 403
- **read は推測しない**。Redis 未設定の preview では `list` の `保存先` と `get` が `store_unavailable`
- **dry-run は動く**。Customers **1,677 件**を最後まで取得できており（17 ページ / 上限 300）、
  B-1 の fail-closed 化は通常運用を壊していない
- Redis が**未設定**のとき `preview` は preset を基準に dry-run し、応答の `基準` にそれを明示する。
  Redis が**設定済みで到達不能**なときは `store_unavailable` で止まる（production は後者に該当）
- ⚠️ `PREMIUM_PLUS_ADMIN_SECRET` は **deploy-preview にも設定済み**だった
  （progress.md の 2026-08-03 の記述「production 限定 → preview は 503」は**現状と異なる**）


## A-5 の再々修正（2026-08-06・Scheduled Function 方式へ）

専用 secret 方式（`MARKETING_AUTOMATION_CRON_SECRET` + `x-cron-secret`）は**撤回**し、
**Netlify Scheduled Function** に変更した。

### なぜ変えたか

secret 方式は「公開 HTTP Function のまま鍵で守る」設計で、鍵の配布・保管・ローテーションが
運用の負債になる。**HTTP 経路そのものを塞げば鍵は要らない。**

### 変更点

| 項目 | secret 方式 | Scheduled Function 方式 |
|---|---|---|
| 配備 | 公開 HTTP Function | **`export const config = { schedule }` で登録 → scheduled function** |
| 外部 HTTP | 到達する（鍵で拒否） | **Netlify が 404**。到達しない |
| 鍵 | `MARKETING_AUTOMATION_CRON_SECRET` / `x-cron-secret` | **廃止**（コードから完全に削除） |
| 起動元 | 外部トリガー（GitHub Actions 等）が必要 | **Netlify のスケジューラ** |
| 二次確認 | timingSafeEqual による鍵照合 | scheduled 実行の形（`next_run` 付き本文）でなければ **404** |

```js
// netlify/functions/cron-marketing-automation.js 末尾
export const config = {
  schedule: '0 1 * * *',
};
```

### schedule 時刻（JST 換算）

cron 式は **UTC**。`0 1 * * *` = **毎日 JST 10:00**（UTC+9）。
自動化の quiet hours は **21:00–08:00 JST** なので、その外側の午前中に置いた。
既存の cron も同じ流儀（`cron-expiry-check` は `0 9 * * *` = JST 18:00）。

> **登録方法（2026-08-06 統一）**: 既存 3 つの cron（`cron-email-scheduler` /
> `cron-expiry-check` / `cron-payment-email-reconciler`）と同じく、
> **コード内の `export const config = { schedule }`** で登録する。
> 一度 `netlify.toml` 側へ書いたが、**登録場所が 2 か所に分かれる**のを避けるため
> 既存の流儀へ統一した。`netlify.toml` には**書かない**（二重登録を避ける）。
> テストが「config に schedule がある」「netlify.toml に無い」の両方を固定している。

### 副作用 0 の多層構造

1. **schedule 未登録** → そもそも起動されない
2. **外部 HTTP** → Netlify が 404（到達しない）／到達しても handler が **404**
3. **env 未開放** → `gates_closed` で `接続 {redis:false, airtable:false}` / `sideEffects:'none'`
   - `MARKETING_AUTOMATION_SCHEDULER_ENABLED=true`
   - `MARKETING_AUTOMATION_DISPATCH_ARMED=<当日の JST 日付>`（**翌日には自動的に閉じる**）
   - 既存の `MARKETING_CAMPAIGN_ENABLED` / `MARKETING_CAMPAIGN_DISPATCH_ENABLED`

### 回帰テスト

- **外部 HTTP 形状では起動できない**: `httpMethod` / `rawUrl` / `rawQuery` /
  `queryStringParameters` のいずれかを持つイベントは拒否。`next_run` を偽装して添えても、
  `x-netlify-event: schedule` を足しても通らない
- **handler は 404 を返し Redis へ接続しない**（ゲート全開の状態でも起動経路で止まる）。
  応答に env 名・ゲート状況を**出さない**
- **schedule 実行でも env 未開放なら副作用 0**（`gates_closed` / 接続 0）
- **構造 guard**: `MARKETING_AUTOMATION_CRON_SECRET` / `x-cron-secret` / `authorizeInvocation` /
  `timingSafeEqual` / 管理 secret / `x-netlify-event` が**実コードに残っていない**こと
- **netlify.toml の登録**と、cron 式の **JST 換算が 10 時**で quiet hours の外であること

### 残るリスク（明示）

`isScheduledInvocation` は Netlify が scheduled 実行で `next_run` を含む本文を渡す前提。
**この前提が崩れると 404 のまま実行されない**（fail-closed で安全側だが、機能は止まる）。
初回に env を開けたときは、**Function ログで実際に起動したかを必ず確認**すること。


## Scheduled Function 方式の Deploy Preview 実測（2026-08-06）

`deploy-preview-237` で確認。**production deploy なし・env 変更なし・書き込みなし。**

### 外部 HTTP から起動できない（実測）

| 呼び方 | 結果 |
|---|---|
| `POST /.netlify/functions/cron-marketing-automation` | **403 / 本文 0 バイト / `content-type: text/plain` / `server: Netlify`** |
| `GET` 同上 | **403**（同上） |
| 詐称 `x-netlify-event: schedule` 付き POST | **403**（同上） |

**これは Netlify のプラットフォーム層の拒否**であり、Function のコードには到達していない
（到達していれば自前の `404 {"error":"Not Found"}` が `application/json` で返る）。
比較用に、schedule 未登録の通常 Function（`admin-marketing-automation`）は
自前の `{"error":"Forbidden"}` を返す。

→ **schedule 登録が効いており、公開 URL からは起動できない**ことを確認。
既存の scheduled function（`cron-payment-email-reconciler`）も同じ 403 の見え方で、挙動が一致している。

### Deploy Preview では schedule 実行されない

- Netlify のスケジューラが実行するのは**公開中の production デプロイ**のみで、Deploy Preview は対象外
- Function ログを照会したところ、**invocation は 0 件**（preview / production とも）

> ⚠️ ただし schedule は `0 1 * * *`（UTC 01:00 = JST 10:00）で、確認時刻は UTC 05:0x。
> **次の発火時刻をまたいでいない**ため、「発火しなかった」ことの積極的な証拠にはならない。
> 依拠しているのは上記の仕様と、preview が公開デプロイでないという事実。
> **production へ入れた後の初回 JST 10:00 に、Function ログで実際の起動を必ず確認すること。**

### 副作用 0 の確認

env は production / deploy-preview の**両方で unset**（`MARKETING_AUTOMATION_SCHEDULER_ENABLED` /
`MARKETING_AUTOMATION_DISPATCH_ARMED`）。仮に起動しても `gates_closed` /
`接続 {redis:false, airtable:false}` / `sideEffects:'none'` で止まる（ローカルテストで実測）。


## 登録方式の統一と、その過程で見つけた落とし穴（2026-08-06）

schedule の登録場所を **既存 cron と同じ `export const config`** に統一した
（`netlify.toml` には書かない = 二重登録を避ける）。

### ⚠️ `export const config` が効くのは Functions **v2** 形式だけ

一度 v1 形式（`export const handler = async (event) => ({ statusCode, body })`）のまま
`export const config = { schedule }` を足したが、**schedule が登録されず、
公開 HTTP Function のまま配備された**。Deploy Preview で実測して判明した。

| 対象 | 形式 | 公開 URL への POST |
|---|---|---|
| `cron-payment-email-reconciler` / `cron-expiry-check` / `cron-email-scheduler` | **v2**（`export default` + `Response`） | **403 / 0 バイト / text-plain** = Netlify の拒否 |
| 本 Function（v1 + config を付けた状態） | v1（`export const handler`） | **404 / 21 バイト / application/json** = **自前の応答が返った**＝未登録 |

**本文の中身で見分けられる**: プラットフォーム拒否は本文 0 バイトの text/plain、
コードに到達していれば自前の JSON。`netlify.toml` 登録時は前者だったので、
**v1 でも netlify.toml なら登録される**が、`export const config` では登録されない。

### 対応

本 Function を既存 cron と同じ **v2 形式**へ書き換えた。

```js
export async function runScheduledTick({ payload, now, env }) { /* 実処理 */ }

export default async function handler(req) {
  let payload = null;
  try { payload = await req.json(); } catch { payload = null; }
  const { statusCode, body } = await runScheduledTick({ payload, now: Date.now(), env: process.env });
  return json(statusCode, body);   // new Response(...)
}

export const config = { schedule: '0 1 * * *' };   // UTC 01:00 = JST 10:00
```

実処理を `runScheduledTick()` に分け、テストは HTTP の器を挟まずここを直接呼ぶ。
`isScheduledInvocation(event)` は **`isScheduledPayload(payload)`** に変わった
（v1 の event 形状を投げ込まれても弾く判定は維持）。

### テストで固定したこと

- `export const config.schedule` があり、**`export const handler`（v1）を持たない**こと
  （持つと schedule が登録されないため）
- v2 の `default` export が **`Response` を返す**こと
- **既存 cron 2 つも v2 + config 方式**であること（前提が変わったら気づけるように）
- `netlify.toml` に二重登録していないこと
- cron 式の JST 換算が 10 時で quiet hours の外であること

### 統一後の Deploy Preview 実測（v2 + `export const config`）

| 対象 | POST | GET | 詐称 `x-netlify-event` 付き |
|---|---|---|---|
| `cron-marketing-automation` | **403 / 0 バイト / text-plain** | **403 / 0 バイト** | **403 / 0 バイト** |
| `cron-payment-email-reconciler`（既存） | 403 / 0 バイト | — | — |

**既存 scheduled function と完全に同じ見え方**になり、`export const config` による
schedule 登録が効いていることを確認した（v1 のときは自前の 404 JSON が返っていた）。

> この確認は **登録の有無を見分ける手順**として再利用できる。
> 公開 URL へ POST し、**本文 0 バイトの text/plain 403** ならプラットフォーム拒否＝登録済み、
> **自前の JSON が返る**なら未登録（通常の公開 Function のまま）。


---

# B-3 / B-4 / C-2 の read-only 監査（2026-08-06・main `ba93eda` 反映後）

blocker ではないと判断して先送りした 3 件を、**本番の実測を交えて**あらためて見た。
**production env 変更 0 / Redis・Airtable write 0 / メール送信 0**（読み取りのみ）。

結論: **C-2 は「運用品質」ではなく、取り込み完了で機能が壊れる期限付きの問題**だった。
B-3 / B-4 は当初の見立てどおり運用品質だが、B-3 には**データはあるのに見えない**という
別の側面があり、B-4 には**表示の食い違い**という副作用がある。付随して 2 件（B-5 / B-6）を新たに検出した。

---

## C-2 ⚠️ 格上げ: Customers 増加で `preview` が**必ずタイムアウトする**

当初は「連打するとレート制限に触れうる」程度に見ていたが、**実測すると時間が問題**だった。

### 本番実測（read-only）

| 呼び出し | 所要 |
|---|---|
| `preview`（dry-run）1 回目 | **7.65 s** |
| `preview` 2 回目（warm） | **3.48 s** |
| `list`（Redis のみ・比較用） | 1.09 s |

このときの Customers は **1,678 件 = 17 ページ**（`pageSize=100` を**逐次**取得）。

### 何が起きるか

Netlify の同期 Function のタイムアウトは既定 **10 秒**。

| Customers | ページ数 | 推定所要 | 判定 |
|---|---|---|---|
| 1,678（現在） | 17 | 3.5〜7.6 s | ぎりぎり通る |
| **約 4,000** | 40 | **約 10 s** | **タイムアウト域** |
| 15,800（取り込み完了後） | 158 | **30〜70 s** | **確実に失敗** |

進行中の外部無料ユーザー取り込み（残り約 14,000 件）が完了すると、
**dry-run が常に失敗し、`activate` も通らなくなる**（`activate` は同じ経路で再計算するため）。
つまり**自動化を一切操作できなくなる**。

- B-1 の修正で「黙って先頭 6,000 件だけ使う」事故は防いだが、**遅さは残っている**
- fail-closed なので誤送信にはならない。**壊れ方は安全側**だが、機能は死ぬ

### 直し方の候補

| 案 | 効果 | 難点 |
|---|---|---|
| Airtable の `filterByFormula` で**サーバ側で絞る** | 取得件数そのものが減る | trigger 条件ごとに式が要る。式の誤りが対象漏れになる |
| ページ取得を**並列化**（5 並列程度） | 3〜5 倍速。158 ページでも 10 s 前後 | Airtable のレート制限（5 req/s/base）に当たる。他機能と競合 |
| 顧客スナップショットを **Redis に短期キャッシュ**（例 5 分） | 2 回目以降が速い。dry-run → activate の連続操作に効く | 初回は遅いまま。キャッシュの鮮度が snapshot の意味を薄める |
| **Background Function 化**（15 分まで） | 件数に依存しない | 非同期になるので UI の作りが変わる |

**推奨**: `filterByFormula` での絞り込みを第一候補、当面の延命として短期キャッシュ。
並列化は既存機能のレート制限を巻き込むので単独では採らない。

### 開放との関係

**取り込み完了前に S2〜S3（保存と ACTIVE 化）を済ませるか、先に C-2 を直す。**
段階開放 runbook の S2 の前提条件に明記した。

---

## B-3: `runs` が当日分しか見えない（**データはあるのに見えない**）

```js
const today = jstDateString(nowMs);
const ids = [today];                    // ← 当日のみ
```

`runs()` は当日の `runId` を 1 つ引くだけ。UI の「run 履歴」は**昨日以前を表示できない**。

### 見立ての補正

当初は「履歴が短い」だけと書いたが、実際は
**Redis には残っているのに API から辿れない**という形。`saveRun` / `createRun` は

```js
await call(['SET', autoKey.run(run.runId), JSON.stringify(r)]);   // TTL 無し
```

で保存しており、**run は消えない**。つまり欠けているのは保存ではなく**引き方**。

### 直し方

- `runId` は `<automationId>#<YYYY-MM-DD>` と**決定的**なので、
  直近 N 日ぶんの id を組み立てて `MGET` すれば足りる（索引を増やさずに済む）
- 実行が疎らなら `SADD ak:marketing-automation:runs:<automationId>` の索引を持つ手もあるが、
  **キーを増やす前に決定的 id で足りるかを見る**

### 影響度

送信事故には繋がらない。ただし **S5（初回配信）の後に「昨日の結果」を UI で追えない**ため、
初回配信の振り返りは `run-detail` を runId 直指定で叩くか、Function ログで行う必要がある。
runbook の S5 にその前提を書いた。

---

## B-4: 状態変更と索引更新が 2 段（**表示の食い違いが起きる**）

| 操作 | 順序 | 途中で失敗したら |
|---|---|---|
| `activate` | `saveDefinition` → `markActive` | **ACTIVE なのに索引に無い** |
| `pause` / `cancel` | `saveDefinition` → `unmarkActive` | **PAUSED / CANCELLED なのに索引に残る** |

### 送信の安全性

**どちらも誤送信にはならない。** scheduler は索引から引いた Definition を
`isDue` で再判定し、`status !== 'ACTIVE'` を弾く。索引に残っていても送られない。

### 実害は「表示」

`list` の `保存済み` は**索引から**構成される。したがって

- `activate` が中途半端に終わると、**`get` は ACTIVE と言うのに `list` に出てこない**
- しかも scheduler も動かない（索引に無いので拾われない）
- 管理者からは「ACTIVE にしたのに何も起きない」に見える — **A-1 と同じ見え方の事故**

A-1（`enabled` が保存されない）を直した動機は「状態の食い違いを作らない」ことだったので、
**同じ理由でこれも直す価値がある**。

### 付随して見つけた点

`cancel` は `_transitionTo`（内部で `unmarkActive` を呼ぶ）の**後にもう一度** `unmarkActive` を呼ぶ。
`SREM` は冪等なので害は無いが、**同じことを 2 か所でやっている**のは読み手を惑わせる。

### 直し方

1. **索引を状態から導出する**のが本筋（`index:active` を持たず、全 Definition を走査）。
   ただし Definition の一覧を引く手段が今は無いので、索引自体は残す方が現実的
2. **tick の先頭で索引と status を突き合わせて掃除する**（不一致を検知したらログに出して除去）
3. `activate` は **`markActive` を先**にする（失敗しても「索引にあるが DRAFT」= 送られない安全側）

**推奨**: 3（順序の入れ替え）+ 2（tick での掃除）。1 は Definition 一覧の仕組みが要るので後回し。

---

## B-5（新規）: run キーに TTL が無く、無期限に残る

`saveRun` / `createRun` は `SET`（TTL 無し）。`runId` は 1 automation × 1 日 1 個なので、
7 プリセット × 365 日 = **年 2,555 キー**程度。Upstash の容量としては小さいが、

- **意図して残しているのか、付け忘れなのかが読み取れない**
- 監査のために残すなら**保持期間を決めて書く**べき（例 400 日）
- `recipient` claim は `CLAIM_TTL_SEC = 7 日`、`lock` は 300 秒と TTL がある中で、
  **run だけ無期限**なのは一貫していない

**推奨**: 意図（監査ログとして残す）を明記した上で `EX` を付ける。B-3 で直近 N 日を引くなら、
**N より十分長い保持期間**にする。

---

## B-6（新規）: 本番 Redis の `index:active` が空であることを確認

`list` の実測で `保存済み: []` / `保存先: {ok:true}`。
**production の Redis には自動化の Definition が 1 件も無い**（canary は完全に撤収済み）。

これは問題ではなく**開放前の基準点**として記録する。S2 で最初の Definition を保存したとき、
`list` に 1 件だけ現れることが期待値になる。

---

## 優先順位（提案）

| 順 | 項目 | 理由 |
|---|---|---|
| 1 | **C-2** | 取り込み完了で**機能が死ぬ**。期限がある |
| 2 | **B-4** の 3（`markActive` を先に）| 1 行で安全側に倒せる。A-1 と同種の事故を塞ぐ |
| 3 | **B-3** | S5 の振り返りに要る。決定的 id の `MGET` で足りる |
| 4 | B-5 | 保持期間を決めて明示 |
| 5 | B-4 の 2（tick での掃除）| 1〜3 の後 |

**いずれも本監査では実装していない（read-only）。** 着手は別途承認を得てから。
