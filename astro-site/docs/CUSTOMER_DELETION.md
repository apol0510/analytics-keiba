# 移行済み Customers の削除

CSV 取り込み分を prospect プール（Redis）へ移したあと、**Customers 側の重複行**を消す工程。
**元に戻せない操作**なので、下見・控え・上限・確認文字列・fail closed を重ねている。

> 前提: `docs/PROSPECT_MIGRATION_PLAN.md`（移行そのもの）／
> 索引の健全性は `scripts/verify-prospect-migration.mjs` と `scripts/audit-prospect-index.mjs`

## ⚠️ 消してよい条件（5 つ全部・1 つでも欠けたら消さない）

| # | 条件 | なぜ |
|---|---|---|
| 1 | `decideForRecord()` が **`migrate`** | native / converted / engaged / suppressed / operator grant / ambiguous を**構造的に除外**する |
| 2 | prospect **レコードが存在する** | 移っていない人を消すと復元手段が消える |
| 3 | prospect が **送信候補の state** | 移った先で送れないなら、まだ消せない |
| 4 | **`ACTIVE_INDEX` に居る** | レコードだけ在って索引に居ない事故（2026-08-27）を通さない |
| 5 | **開封の集計が読めている** | 読めないと反応した人を `migrate` と誤判定する |

判定の単一源は `src/lib/marketing/customerDeletionPlan.js`。
**分類（1）は自前で書き直さない**。`prospectMigrationPlan.js` の `decideForRecord()` を使う。

⚠️ 索引・プール・開封のいずれかが読めなければ **対象 0 件**（fail closed）。
「読めない」を「移り終わっている」と扱うと、**移っていない人を消す**。

## 手順

```bash
cd astro-site

# 1) 下見（1 件も消さない）。live 状態から数え直し、控えを保存する
ADMIN_SECRET=... node scripts/delete-migrated-customers.mjs

# 2) 削除前の基準を保存（Redis と 8/31 の配信結果）
ADMIN_SECRET=... node scripts/verify-after-customer-deletion.mjs --save /path/baseline.json

# 3) 実削除（**承認を得てから**）
ADMIN_SECRET=... node scripts/delete-migrated-customers.mjs --apply

# 4) 削除後の検証（Redis と配信の続きが 1 も動いていないこと）
ADMIN_SECRET=... node scripts/verify-after-customer-deletion.mjs --compare /path/baseline.json
ADMIN_SECRET=... node scripts/audit-prospect-index.mjs <hashes.json>
```

## 控え（export）と rollback

- 削除の前に**対象の全フィールド**を控える。保存先は既定で
  `~/.analytics-keiba-ops/prospect-migration/customers-delete-export-<digest>.json`
  （**リポジトリの外**・`0600`）
- 控えを**読み戻して**件数が合うことを確かめてからでないと削除へ進まない
- rollback:

```bash
ADMIN_SECRET=... node scripts/restore-customers-from-export.mjs --apply <export.json>
```

⚠️ 控えファイルには**アドレスが入る**。リポジトリへ置かない・ログへ貼らない。

### ⚠️ 控えをそのまま POST してはいけない（2026-08-27 修正）

控えは**監査用に全フィールド**を持つが、Airtable には**書き込めない field** がある。
本番 Customers の **`登録日` は `createdTime`**（自動値）。そのまま POST すると
**復元そのものが失敗する** ＝ rollback が効かない ＝ 削除が取り返しのつかない操作になる。

復元は **本番 schema（Meta API）を取り直し、「作成時に書ける型」だけを通す**。

| 扱い | 型 |
|---|---|
| 書く（allow-list）| `singleLineText` / `multilineText` / `richText` / `email` / `url` / `phoneNumber` / `number` / `currency` / `percent` / `rating` / `duration` / `checkbox` / `singleSelect` / `multipleSelects` / `date` / `dateTime` / `barcode` |
| **絶対に書かない** | `createdTime` / `lastModifiedTime` / `createdBy` / `lastModifiedBy` / `formula` / `rollup` / `count` / `multipleLookupValues` / `autoNumber` / `button` / `aiText` |
| 復元では使わない | `multipleRecordLinks`（**再配線は別工程**・下記）|

**知らない型は書かない**（allow-list なので、新しい型が増えても黙って POST しない）。
送る直前に `validateRestorePayload()` で検算し、計算 field が 1 つでも混ざっていたら送らない。
契約は `airtableWritableFields.test.mjs` が**本番 schema のスナップショット**に対して固定する。

### ⚠️ recordId は変わる。参照は自動では直らない

復元すると **recordId は新しく振られる**。他テーブルの `CustomerRecordId` は
**`singleLineText`（ただの文字列コピー）**なので、Airtable は何も直してくれない。
削除した時点で**参照は宙に浮き**、復元しても**古い recordId のまま**残る。

「prospect は hash で紐づくから配信は続く」は事実だが、**それは rollback の完了条件ではない**。

#### 本番実測（2026-08-27・削除対象 11,961 件への参照）

| テーブル.field | 型 | 全行 | 値あり | **削除対象を参照** |
|---|---|---:|---:|---:|
| `StepEnrollments.CustomerRecordId` | singleLineText | 360 | 359 | **0** |
| `StepEnrollments.Customer`（リンク）| multipleRecordLinks | 360 | **0** | **0** |
| `CampaignDeliveries.CustomerRecordId` | singleLineText | 34,162 | 34,162 | **23,452** |
| `EmailEvents.CustomerRecordId` | singleLineText | 0 | 0 | **0** |
| `PromotionalOffers.CustomerRecordId` | singleLineText | 75 | 75 | **0** |
| `CouponOperationHistory.CustomerRecordId` | singleLineText | 10 | 10 | **0** |

- **影響があるのは `CampaignDeliveries` だけ**（23,452 行 ≒ 11,961 人 × 約 2 通ぶんの履歴）
- `StepEnrollments` のリンク field は**全行が空**で、実際には使われていない
- 削除すると 23,452 行の `CustomerRecordId` は**宙に浮く**。復元しても
  **新しい recordId とは一致しない**（`singleLineText` なので Airtable は直さない）

#### 再配線が要るか

| 観点 | 判定 |
|---|---|
| 配信の継続（8/31 の 2 通目）| **不要**。移行後の配信対象は prospect プール（Redis）で、hash で紐づく |
| Premium Plus の「案内済み」判定 | **不要**。`buildPlusDeliveryFormula()` は `CustomerRecordId` と `RecipientEmail` の **OR** で引くのでアドレス側で当たる（そもそも対象 0 件）|
| 配信履歴の監査（どの会員へ何通送ったか）| **要る**。recordId で辿る経路は切れる |

→ **復元したときは `CampaignDeliveries` の再配線が必要**。
`customerDeletionRestore` は **旧 recordId → 新 recordId の対応表（`mapping`）** を返す。

#### 再配線の手順

```bash
# 下見（1 行も書き換えない）
ADMIN_SECRET=... node scripts/rewire-campaign-deliveries.mjs <mapping.json> <export.json>
# 実行
ADMIN_SECRET=... node scripts/rewire-campaign-deliveries.mjs --apply <mapping.json> <export.json>
```

| | |
|---|---|
| 対象 | 対応表に載っている `oldId` の行**だけ** |
| 二重確認 | `CustomerRecordId` の一致に加えて **`RecipientEmail` も一致**すること |
| 他の会員 | **1 文字も触らない**（`not_in_mapping` として拒否）|
| 冪等性 | 既に新 id を指す行は `alreadyRewired`。**2 回実行しても壊れない** |
| 分割・再開 | 100 件ずつ。進捗を `<mapping.json>.progress.json` に書き、**同じコマンドで続きから** |
| 上限 | 1 回 100 件（対応表）|
| 確認文字列 | `REWIRE CAMPAIGN DELIVERIES` |
| 既定 | **下見** |
| 書き換える field | **`CustomerRecordId` だけ**（アドレスも他の列も触らない）|

**完了判定は「更新できた件数」ではない。** 書いたあとに読み戻し、
**古い参照が 0 件／新しい参照が期待件数**であることを確かめる（`verifyRewire()`）。
どちらか外れたら **rollback は完了扱いにしない**。

## ⚠️ rollback の完成条件（これを全部満たすまで「戻せた」と言わない）

| # | 条件 | 確かめ方 |
|---|---|---|
| 1 | 控えが読み戻せる | 件数一致・全件 Email あり |
| 2 | 復元 payload が本番 schema に対して有効 | `validateRestorePayload()`（計算 field 混入 0）|
| 3 | Customers が期待件数まで戻る | 復元後の件数 |
| 4 | **`CampaignDeliveries` の再配線が済んでいる** | **古い参照 0 / 新しい参照が期待件数** |
| 5 | prospect プールと 8/31 の配信結果が動いていない | `verify-after-customer-deletion.mjs --compare` |
| 6 | 索引に orphan がいない | `audit-prospect-index.mjs`（`hasRecord:true` が 0）|

⚠️ **「prospect は hash だから配信は続く」は 5 の一部でしかない。**
1〜6 のどれか 1 つでも未達なら rollback は未完了。

## ⚠️ バッチ幅（200 件にしない）

削除は Airtable の DELETE を **1 件ずつ直列**に投げる。本番実測で **1 件 344ms**。

| 幅 | 1 バッチの所要 | 可否 |
|---:|---:|---|
| 25 件 | 約 **8.6 秒** | ✅ 本番 11,930 件をこの幅で完走（2026-08-27）|
| 200 件 | 約 **69 秒** | ✖ **Netlify Functions の実行時間を超える** |

途中で切られると、そのバッチは**どこまで消えたか分からないまま**中断する
（再実行すれば `already_deleted` として回復はするが、切り分けが無駄に増える）。

`scripts/delete-migrated-customers.mjs` の `CHUNK` は **25**。
`customerDeletionPlan.test.mjs` の guard が、
**1 バッチの推定所要が 12 秒を超える幅へ戻ると落ちる**。
上げるなら**先に 1 件あたりの所要を測り直す**こと。

> Function 側の `DELETE_MAX_PER_CALL`（200）とは**別物**。あちらは「取り違えの被害を
> 小さくする」ための上限で、こちらは**所要時間**で決まる。

## 二重実行しても安全

- 実行側が渡した id を**そのまま消さない**。サーバ側で計画を作り直し、
  **いまも消してよいと判定された id だけ**を消す（`reconcileDeletionTargets`）
- もう存在しない id は **`already_deleted`**（エラーにしない）
- 状態が変わった id は **`refused`**（消さずに報告する）
- Airtable が 404 を返しても成功扱い（もう消えている）

## 上限・確認文字列

| | |
|---|---|
| 1 回で消せる件数 | **200 件**（`DELETE_MAX_PER_CALL`）|
| 確認文字列 | `DELETE MIGRATED CUSTOMERS` |
| 控えの申告 | `exportSaved: true` が無ければ実行しない |
| 既定 | **下見**（`apply: true` が無ければ 1 件も消さない）|

## 索引監査の終了コード（2026-08-27 変更）

`scripts/audit-prospect-index.mjs` は「索引に居ない」を **2 種類に分ける**。

| | 意味 | 終了コード |
|---|---|---|
| `hasRecord: false` | そもそも**投入していない**（移行判定で除外された）| **0（正常）** |
| `hasRecord: true` | **レコードは在るのに索引に居ない**（事故）| **1（異常）** |

以前は両方をまとめて異常終了させていたため、正当な除外 3 件でも「✖」と出て
運用側で正常・異常を切り分けられなかった。
