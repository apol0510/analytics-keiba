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
