## 2026-08-12 — ポイント交換 7 件の実態確定（Gmail 証拠 × ポイント変動の突き合わせ）

Airtable は **7 件すべて `Status=Pending`** だが、実態はバラバラだった。
**Status は実態と同期していない。**

| 申請 | Gmail | 申請時 pt → 現在 pt | 実態 |
|---|---|---|---|
| `recSQS3N0bbLO7Th2`（11-06 / 1,000pt） | **完了メールあり**（件名に申請 ID） | 1,091 → **121**（−970） | **提供済み・減算済み** |
| `rechMTQgCKlmOcGGe`（12-03 / 1,000pt） | 提供メールなし | 1,230 → 1,230（±0） | **未提供・未減算** |
| `recPYBFN9JbZi2akM`（01-27 / 1,000pt） | 提供メールなし | 1,110 → 1,230（+120） | **未提供・未減算** |
| `recFkpnHzUZOJ8UXg`（01-23 / 1,000pt） | 管理者通知**未照合** | 1,050 → 1,230（+180） | 不明（未減算） |
| `recL2D5BFu2kBKWoR`（10-22 / 1,000pt） | **未照合** | 1,710 → 660（−1,050） | 不明（**減算の痕跡あり**） |
| `rec12DhAPYThoJO1D`（12-26 / 2,000pt） | 提供メールなし | 2,022 → **0**（−2,022） | 不明（**減算の痕跡あり**） |
| `recmTm4C193Dah651`（12-26 / 2,000pt・**29 秒差**） | 同上 | 同上 | **重複申請** |

### ここで初めて分かった事実

1. **ポイントは実際に減っている**（−970 / −1,050 / −2,022）。しかし**減算するコードは
   AK にも旧 nankan-analytics にも無い** → **Airtable 画面での手動減算**が行われている。
   「減算経路なし」はコード上は正しいが、**運用では手で引かれている**
2. `Status` / `ProcessedDate` / `Notes` は一度も更新されていない（更新経路がコードに無い）
3. → **Airtable だけでは「提供したか」「引いたか」を判定できない。**
   Gmail の送信済みと残高の変動を突き合わせて初めて実態が分かった
4. **二重申請が実在**（29 秒差）。多重クリックを止める仕組みが無い

### 分類（確定分と保留分）

| 分類 | 件数 | 申請 |
|---|---|---|
| 1. 提供済み証拠あり | **1** | `recSQS3N0bbLO7Th2` |
| 2. 受付のみ・提供証拠なし | **2** | `rechMTQgCKlmOcGGe` / `recPYBFN9JbZi2akM` |
| 3. 重複申請 | **1** | `recmTm4C193Dah651`（`rec12DhAPYThoJO1D` と同一内容・29 秒差） |
| 4. 不明（照合待ち） | **3** | `recFkpnHzUZOJ8UXg` / `recL2D5BFu2kBKWoR` / `rec12DhAPYThoJO1D` |

**重複を除いた実対応件数 = 6 件 / 5 名。** うち**確実に未提供なのは 2 件**。

### 重複整理への影響

ポイントが**手動で調整される**運用だと分かったため、重複レコードの整理で
「ポイントの多い方＝正本」「最大値採用」という推論は**さらに根拠が弱い**。
残る 3 組を保留にした判断は維持する。

### 改善案

`docs/POINT_EXCHANGE_FULFILLMENT.md` に、
**「特典提供 + ポイント減算 + Status/ProcessedDate/Notes」を 1 つの冪等フローに閉じる**設計案を作成した
（入金確認メール v2 と同じ状態機械 + lease + 期待値 CAS。既定 OFF・dry-run 付き）。
**実装も本番操作も未実施。**

### 未実施（承認待ち）

Status 変更 / ProcessedDate 更新 / Notes 更新 / ポイント減算 / 顧客へのメール送信 —
**いずれも行っていない**。

- **Last verified**: 2026-08-12（本番 read-only + Gmail 照合結果の提供を受けて）

## 2026-08-12 — ポイント交換申請の監査（read-only）と、重複再発の外部要因

### A. ポイント交換申請 7 件はすべて未処理（`Status=Pending`）

`PointExchangeRequests` の全 7 件が **Pending のまま**で、`ProcessedDate` / `Notes` も空。
**一度も処理済みへ更新された記録が無い。**

| 申請日 | 必要 pt | 申請時 pt | 特典 |
|---|---|---|---|
| 2025-10-22 | 1,000 | 1,710 | AI解析による隠れ上昇馬情報 |
| 2025-11-06 | 1,000 | 1,091 | 同上 |
| **2025-12-03** | **1,000** | **1,230** | **同上（重複整理の正本 `rec6ZC…`）** |
| 2025-12-26 | 2,000 | 2,022 | AI解析による急上昇 激走穴馬情報（**同一アドレスで同日 2 件**） |
| 2025-12-26 | 2,000 | 2,022 | 同上（重複申請） |
| 2026-01-23 | 1,000 | 1,050 | AI解析による隠れ上昇馬情報 |
| 2026-01-27 | 1,000 | 1,110 | 同上（同一アドレスで 2 回目） |

### B. 正式な処理フロー（コードで確認できる範囲）

```
顧客が申請
  → point-exchange.js
      ・ currentPoints < requiredPoints ならエラー（不足チェックのみ）
      ・ PointExchangeRequests を create（Status='Pending' / ProcessedDate=null / Notes=''）
      ・ 管理者メール（nankan.analytics@gmail.com 宛 / from nankan-analytics@keiba.link）
      ・ 顧客へ受付メール（「1営業日以内にメールで特典をお送りします」）
      ・ ⚠️ **Customers のポイントは 1 点も引かない**
  → /admin/point-exchange-requests（get-point-exchange-requests.js）
      ・ **読み取り専用**。Status で絞って表示するだけで、更新 API を呼んでいない
```

**重要（推測ではなく実装の事実）**:

- **ポイントを減算する仕様はどこにも無い**（AK・旧 nankan-analytics の両方に無い）
- **Status を `Completed` にする経路がコードに無い**。更新するなら **Airtable 画面で手動**
- 特典そのものの送付経路もコードには無い（管理者が手作業でメールする前提）
- したがって「7 件すべて Pending」は
  **①まだ提供していない** / **②提供したが Status を更新していない**
  のどちらとも取れる。**コードとデータからは区別できない**

### C. 対象顧客（`rec6ZCzkrIn6Bai2d`）の現在

| 項目 | 値 |
|---|---|
| ポイント | 1,230（**申請時と同値** = 減算されていない） |
| 最終ポイント付与日 | 2025-11-25 |
| プラン | Premium（**有効期限 2025-11-17 = 期限切れ**） |
| 退会 | **申請済み**（`WithdrawalRequested=true` / 2025-10-17 / 理由未記入） |
| Status 列 | 空 |
| 申請 | 1 件のみ（`rechMTQgCKlmOcGGe` / 2025-12-03）。**過去に同じ申請を処理した記録は無い** |

⚠️ 申請日（2025-12-03）は**退会（10-17）・期限切れ（11-17）より後**。
必要ポイント 1,000 は現残高 1,230 で満たしている。

### D. 判断が要る点（**未実施・承認待ち**）

特典提供 / `Status` 変更 / ポイント減算 / メール送信は**いずれも行っていない**。
実施するなら次を決める必要がある:

1. 7 件すべてが未提供なのか（提供済みなら Status を後追いで更新するだけ）
2. 退会済み・期限切れの顧客へ特典を提供するのか
3. 提供したらポイントを引くのか（**引く実装は無い**ので、引くなら手動 or 実装追加）
4. 同一アドレスの重複申請 2 件（2025-12-26）をどう扱うか

### E. 重複再発の外部要因（**AK のコードでは直せない**）

`nankan-analytics`（旧サイト）は **同じ Airtable Base `apptmQUPAlgZMmBC9`** を使い、
`netlify/functions/auth-user.js` の検索条件が**旧いまま**である:

```js
filterByFormula: `AND({Email} = '${email}', OR({Source} = 'nankan-analytics', {Source} = BLANK()))`
```

これは `docs/CUSTOMERS_DEDUP_GUIDE.md` §1 が重複の原因として挙げているものと同一で、
AK 側は 2026-05-12 に Email 完全一致へ修正済みだが、**旧サイト側は未修正**。
旧サイトが稼働している限り、`Source` が別値の顧客に対して**新しい重複が作られ得る**。

- ⚠️ **AK のコードでは直せない**（AK から旧 repo を変更しない方針）
- 対応するなら旧 repo 側の別案件。AK 側の作業に混ぜない
- AK 側でできるのは「重複を検出して整理する」ことだけ（`scripts/dedupe-customers.mjs`）

### F. 今回の方針（確定）

- 残る重複 3 組は **削除せず保留**（ポイントの二重付与を証明できないため）
- PR #317（値を固定した個別許可の仕組み）は **merge しない**
- ポイント交換申請は **read-only 監査のみ**。提供・Status 変更・減算・送信はしない

- **Last verified**: 2026-08-12（本番 read-only）

## 2026-08-12 — 【運用事故】作業ブランチの HEAD を main へ直接 push し、PR #316 を誤って merge した

### 何が起きたか

重複削除の結果を `docs/progress.md` へ記録するとき、**作業ブランチの HEAD をそのまま
`git push origin HEAD:main` した**。ブランチにはレビュー待ちのスクリプトコミット
（`fa6e4904`）も載っていたため、docs だけでなく

- `astro-site/scripts/dedupe-customers.mjs`
- `astro-site/scripts/dedupeCustomers.test.mjs`
- `astro-site/docs/CUSTOMER_DEDUPE.md`

が同時に main へ入り、GitHub が **PR #316 を MERGED と判定**した。
「#316 の merge は別判断」という指示に反する結果になった。

### 影響

- 実害なし（スクリプトは手動実行専用で、どこからも自動起動されない。CI も green）
- ユーザー判断により **revert せず、このまま残す**ことを確認済み

### 再発防止（今後の rule）

- **作業ブランチの HEAD を `main` へ直接 push しない。**
  `git push origin HEAD:main` は、ブランチに載っている**全コミット**を main へ入れる。
- `main` へ入れてよいのは、その 1 コミットだけを載せた状態のときに限る。
  docs だけを反映したい場合は、**`origin/main` から新しく切った作業場所**で
  その変更だけをコミットして push する（レビュー待ちのコミットを巻き込まない）。
- レビュー対象を含むブランチは **PR 経由でのみ** main へ入れる。

## 2026-08-12 — 残る重複 3 組の精査（read-only / 書き込みなし）

重複 7 件の削除後に残った 3 組（削除側にポイント残高があるため保留したもの）を精査した。
**本番へは 1 バイトも書いていない。**

### 3 組の内訳

| 組 | レコード | ポイント | 最終付与 | プラン | 有効期限 | 退会 | 参照 | 登録 |
|---|---|---|---|---|---|---|---|---|
| A | `rec6ZCzkrIn6Bai2d` **正本** | 1,230 | 2025-11-25 | Premium | 2025-11-17（期限切れ） | ✅ 2025-10-17 | 0 | 2025-09-29 13:45 |
| A | `reck9LS8az6SI11yj` 削除候補 | 102 | 2025-09-30 | Free | — | — | 0 | 2025-09-29 12:10 |
| B | `recWeIweTrEBIzy2G` **正本** | 101 | 2025-09-23 | Free | — | — | 0 | 2025-09-23 |
| B | `recWRR2CEEzREaUg6` 削除候補 | 2 | 2026-03-23 | Free | — | — | 0 | 2026-02-25 |
| C | `recbpvkL1v0JBzdv3` **正本** | 108 | 2026-05-26 | Free | — | — | 0 | 2025-09-30 02:53:54 |
| C | `recrr0kwuhJ6UOVE8` 削除候補 | 101 | 2025-09-30 | Free | — | — | 0 | 2025-09-30 02:53:54 |

3 組とも: `PaymentConfirmed` / `PaidAt` / `LifetimeSanrenpuku` / Light・Premium grant /
`unsubscribe` / blacklist / 最終ログイン は**両側とも空**。`CampaignDeliveries` /
`PromotionalOffers` / `AuthTokens` からの参照も**両側 0 件**。

### 正本の判定

- **A** … 削除候補側は Free・値なし。正本側に Premium 契約・**退会記録**・氏名・電話がある。
  退会（`WithdrawalRequested`）は課金停止の記録であって配信拒否でもアカウント停止でもない
  （`comebackPolicy` / `resolveEntitlements`）。**消すと退会の事実が失われる**ので正本は確定
- **B** … 両側とも値なし。**古い方**（ポイントも多い）を正本にする
- **C** … 登録日時が**秒まで同一** = 二重登録。ポイントも活動も新しい方を正本にする

### ポイントの扱い: **「最大値採用」＝ 今回は移行しない**

根拠は日次付与の実装（`netlify/functions/daily-points.js`）:

```js
// 全 Customers レコードをループし、**レコードごとに**加算する
const currentPoints = record.get('ポイント') || 0;
let pointsToAdd = 1;                    // free
if (planLower === 'standard') pointsToAdd = 10;
if (planLower === 'premium')  pointsToAdd = 30;
await base('Customers').update(record.id, { 'ポイント': currentPoints + pointsToAdd });
```

- 重複レコードは**同じ日次付与を 2 回受け取っていた**。つまり残高の差は
  「その人が 2 倍稼いだ」ではなく**同じ付与が二重に記録された**もの
- したがって **「加算」は二重計上**になる（顧客が得ていない残高を確定させてしまう）
- 実態に最も近いのは **「最大値採用」**（レコード 1 本ぶんの正しい累積）
- そして **3 組とも正本側 ≥ 削除候補側**（1,230>102 / 101>2 / 108>101）
  → **最大値採用の結果は「書き込み不要」**。ポイントは 1 点も移さない

補足:
- 日次付与は **cron 未登録**（`export const config` なし・`netlify.toml` にも記載なし）で、
  `auth-user.js` にも「日次ポイント付与は廃止・書き込みゼロ」とある。残高は事実上凍結。
- 重複していた間は `classifyCustomerMatches` が **CONFLICT で fail closed**（判定・トークン発行・
  Cookie 発行・更新をすべて拒否）していたため、**本人はログインもポイント交換もできていない**。
  重複解消で初めて正本 1 件が使えるようになる。

### 統合案（承認待ち・未実行）

| 項目 | 内容 |
|---|---|
| 削除候補 | `reck9LS8az6SI11yj` / `recWRR2CEEzREaUg6` / `recrr0kwuhJ6UOVE8`（**3 件**） |
| 残す | `rec6ZCzkrIn6Bai2d` / `recWeIweTrEBIzy2G` / `recbpvkL1v0JBzdv3` |
| ポイント移行 | **なし**（最大値採用の結果、正本側が既に上回っているため） |
| 他フィールドの統合 | **なし**（削除候補側に固有の値が 1 つも無い） |
| 参照整合性 | recordId 参照 0 件。メール参照は正本が残るので不変 |
| 実行方法 | `dedupe-customers.mjs --targets <file> --expect 3 --export <file>`（既定 dry-run） |
| rollback | `--export` の全フィールドを create し直す（recordId は変わるが参照ゼロなので実害なし） |

⚠️ ただし `dedupe-customers.mjs` は **ポイントが既定値 1 を超える削除候補を skip する**設計。
このまま実行すると 3 件とも skip される（安全側）。実行するには
**「ポイントは移行しない」と決めたうえで、その組だけを明示的に許可するオプション**が要る。
オプションの追加も承認後に行う（勝手に緩めない）。

### 触っていないもの

- `...@gmail.comtonari` のアドレス不正（**別案件**。重複解消では直らない）
- 本番書き込み・ポイント移行・削除（**すべて未実行**）

- **Last verified**: 2026-08-12（本番 read-only）

## 2026-08-12 — Customers の重複レコードを 7 件削除（本番実行済み）

同じメールアドレスの Customers が 2 件あると、`auth/customerLookup` が **CONFLICT として
fail closed でログインを拒否**する。重複の解消は、その人のログインを取り戻す作業でもある。

### 監査（read-only）で分かったこと

| 項目 | 値 |
|---|---|
| Customers 総数 | 15,971 |
| 一意アドレス | 15,961 |
| 重複アドレス | **10**（20 レコード） |
| CSV 取り込みで作成 | 14,489（`imp-2026-08-09-001` 14,279 / `imp-2026-08-05-003` 100 / `imp-2026-08-04-002` 100 / `imp-2026-08-04-001` 10） |

> ⚠️ **前提の訂正**: 重複 10 組のうち **CSV 取り込み由来（`Source = customer-import:*`）は 0 件**。
> 10 組とも取り込み以前から存在した重複で、**取り込みは重複を 1 件も作っていない**
> （取り込みは既存アドレスを UPDATE 扱いにし CREATE しない設計）。
> 「取り込み側を消す」対象は存在しなかった。

### 判定

**残す** = 権利・課金・意思表示の値が多い方 → 参照されている方 → 作成が古い方。
**消してよい**のは、削除側が次を全部満たす場合だけ:

- 有効期限 / PlanType / PaymentConfirmed / PaidAt / LifetimeSanrenpuku / LightGrant* /
  Requested* / Unsubscribed* / WithdrawalRequested / PremiumPlus* / 最終ログイン / Memo / Phone が **1 つも無い**
- ポイントが既定値（1）以下
- 残す側より強いプランでない
- `CampaignDeliveries` / `PromotionalOffers` からの **recordId 参照が 0 件**

→ **削除 7 / 要確認 3**（削除側にポイント残高 102・101・2 点）。
**ポイントは 1 点も移していない**（統合は運用判断のため、残高がある組は触らない）。

### 実行（2026-08-12）

`astro-site/scripts/dedupe-customers.mjs`（PR #316・**merge 前**のスクリプトを使用）

```
対象 7 件 / 指紋 f46d9119180c6365 / モード ⚠️ 実削除
💾 export: dedupe-rollback-export.json（7 件）
検証: 削除可 7 / skip 0 / 既に削除済み 0
🗑️  削除 7 / 7
```

削除前の最終確認（すべて一致）: 総数 15,971 / 重複 10 組 / target 7 件が条件を満たす /
keep 側 7 件が実在 / target への recordId 参照 0 / export 7 件 / fingerprint 一致。

### 削除後の read-only 確認

| 確認項目 | 結果 |
|---|---|
| deleted / skipped | **7 / 0** |
| Customers 総数 | **15,964**（15,971 − 7） |
| 一意アドレス | 15,961（変化なし） |
| 残る重複 | **3 組**（ポイント 102 / 101 / 2 の要確認分と一致） |
| 削除した 7 アドレス | 各 **1 件**に収束（ログイン復旧） |
| keep 側の権利・課金・配信停止 | **変化なし**（プラン / PlanType / 有効期限 / PaymentConfirmed / PaidAt / LifetimeSanrenpuku / LightGrantUntil / Unsubscribed / WithdrawalRequested / ポイント / Status を pre-post 比較） |
| 孤児参照 | `CampaignDeliveries` 0 / `PromotionalOffers` 0 |
| `AuthTokens` の孤児 | 10 件（**削除前も 10 件**。今回とは無関係の既存状態） |
| 消えたアドレス | 0 件 |
| 新規重複 | なし |

### rollback

削除前の全フィールドを `dedupe-rollback-export.json`（7 件・sha256 `f35f59a092a4954d…`）に保存し、
**repo 外の永続保管**（`~/.analytics-keiba-ops/dedupe/2026-08-12/`、パーミッション 700）へコピー済み。
**PII を含むため git には commit / push しない。**
戻す場合は `fields` をそのまま create する（recordId は新しくなるが、
recordId 参照がある行はそもそも削除していないので実害なし）。

### 残件

- **要確認 3 組**（ポイント 102 / 101 / 2 点）は未処理。統合するか放置するかは運用判断
- `...@gmail.comtonari` のアドレス不正は**別案件**（重複解消では直らない。今回は触っていない）
- PR #316（スクリプトと docs）は**未 merge**。今回の削除とは別判断

- **Last verified**: 2026-08-12（本番 read-only）

## 2026-08-12 — 反応が無い相手への配信除外（#313 本番反映 / 観測は継続中）

1 万数千件規模のキャンペーンで「**10〜20 回送っても開封が無い相手を配信から外す**」を、
誤除外なしで成立させた。判定（`engagementPolicy.js` / 5・10・20 通）は #296 で入っていたが、
**`admin-marketing.js` が `engagementByEmail` を渡していなかったため実際には 1 人も除外されていなかった**
（判定モジュールの単体テストは全部 pass するのに効いていない状態）。
配線だけ先に入れると「開封しているのに記録が無い人」を切るため、**反応の正本を作ってから**繋いだ。

### 反応の正本

| 指標 | 正本 | 読み方 |
|---|---|---|
| sent / delivered | `CampaignDeliveries`（`EmailType='campaign'`） | 宛先ぶんだけ名指し取得（既存） |
| **open / click** | Event Webhook → Redis `ak:mkt:eng:v1:{open,click}` | `HGETALL` 数回 |
| 購入 / ログイン | `Customers.PaidAt` / `LastLoginAt` | 既存 |

- **Blob（NDJSON）が監査の正本**。Redis は**再構成できる補助索引**で、落ちても監査は欠けない
  （`blob` モードの Blob 失敗は従来どおり致命 = provider へ再送させる。Redis 失敗は非致命）
- **Airtable `EmailEvents` の全件走査へは戻していない**（容量対策で行は削除済み）。
  guard テスト（`engagementWiring.guard.test.mjs`）が `EmailEvents` の再登場を検知する
- フィールドは `EmailHash`（台帳と同じ `sha256(lower(email))` 先頭 32 桁）。Redis に生アドレスを置かない
- **回数を持たず「最後に反応した時刻」だけ**保持 → 1 バッチ `HSET` 1 回・provider 再送でも二重計上なし

### fail closed（1 つでも欠けたら誰も除外しない）

`guard_off` / `signal_store_unavailable` / `open_not_measured`（**無効も不明も不可**） /
`no_open_recorded` / `signal_stale`（既定 7 日） / `no_coverage_start`。
さらに **集計を始めて以降の配信だけ**を数える（送信時刻が読めない行も数えない）。
`MARKETING_ENGAGEMENT_COVERAGE_SINCE` は後ろへずらせるが**記録開始より前へは戻せない**。

→ **deploy 直後は誰も除外されない。これは正常**（「0 人だから完了」ではない。下の観測条件を参照）。

### 変えていないもの

`Customers` は削除しない / unsubscribe・bounce・provider suppression が**先に**効く（理由を奪わない） /
取引メール（payment・auth・support・expiry・step・race_main・transactional）は対象外 /
benefit の無い大量配信を止める guard は据え置き / `CampaignDeliveries` の dual 運用不変 /
`MARKETING_EVENT_SINK` 不変 / **production env 変更なし・本番 datastore への手動書込みなし・本番メール送信なし**。

### 検証（マージ前）

- 新規テスト 45 件（境界 **4/5/9/10/19/20**、open あり/なし/記録なし、購入・ログインでの ACTIVE 復帰、
  **下見と enqueue の一致・再実行の安定**、既存除外との併用、Redis/応答への PII 非露出）
- `test:marketing` 1204 / `test:crm` 545 / `test:webhooks` 163 pass、`build` OK、`check:safety` exit 0
- **配線そのものを検査する guard** を追加（#296 の「テストは通るが効いていない」を再発させない）

### 本番反映（read-only で確認済み / 2026-08-12）

- deploy `6a7bd79b` = `81813ab5`（main / state=ready / published 02:18 UTC）
- `/admin/premium-plus-eligibility/`（HTTP 200）に **engagement パネルが配信されている**
  （`mkEngBox` / `mkRenderEngagement` / 「このセグメントの送信対象」/「うち 反応なしで除外」/
  「適用していません」/ `blockedBySegment` / `blockedThisPlan` を実測）
- `admin-marketing`（secret 無し）→ **403**。認可は従来どおり（副作用ゼロ）
- CI: main の `check:ssr-runtime-data` は #314 で green に復帰済み

### ⏳ 未完了の観測条件（**ここが埋まるまで本件は完了ではない**）

deploy 直後に「除外 0 人」なのは**設計どおり**であって、動作の証明ではない。
次の 3 段が自然に埋まったことを確認して初めて完了とする。

1. **反応の記録が動くこと**
   `sendgrid-webhook` の正常受信で `sink.engagementSignal === 'ok'`、かつ
   `blob` は `ok` のまま（`blob_failed` = 0 / `degraded` なし）。
   確認法: Netlify Function ログ、または下の管理画面で「最後に反応を受信」が更新されること。
2. **`適用中` へ変わること**
   自然な開封が貯まり `coverage.openRecorded > 0` かつ受信が新しい状態になると、
   セグメント下見の表示が `適用していません（no_open_recorded）` → **`適用中`** に変わる。
   このとき「数えている期間」に記録開始日が出る。
3. **`engagement_blocked` が自然発生すること**
   記録開始**以降**に 10 通以上届いて無反応の相手が現れたら、
   dry-run の除外明細と下見の「うち 反応なしで除外」に `engagement_blocked` が**実際に**出る。
   ⚠️ 現状は 1 人あたりの生涯送信回数が最大 2〜4 回（#296 実測）なので、
   **数か月単位で送信を重ねないと到達しない**。到達前に「効いていない」と判断しないこと。

確認手順（read-only・送信もキュー登録もしない）:
`/admin/premium-plus-eligibility/` → 「セグメントの下見」→ 管理シークレット入力 →
「人数を数える（送信しません）」。engagement パネルに 5 区分・閾値 5/10/20・適用状態・
除外人数・数えている期間・最後に反応を受信が出る。

### rollback

`MARKETING_ENGAGEMENT_GUARD=off` を production env へ設定して redeploy → コード変更なしで
従来の挙動（engagement 除外なし）へ戻る。仕様は `docs/ENGAGEMENT_SUPPRESSION.md`。

### 変更範囲

`src/lib/marketing/engagementSignalStore.js`（新規）/ `engagementGuard.js`（新規）/
`engagementStats.js`（`sinceMs`）/ `campaignSend.js`・`campaignPlanView.js`（ラベル）/
`src/lib/crm/audienceSegments.js`（`SEG_EXCLUDE.ENGAGEMENT_BLOCKED`）/
`netlify/functions/admin-marketing.js`（配線）/ `netlify/functions/sendgrid-webhook.js`（記録）/
`src/pages/admin/premium-plus-eligibility.astro`（表示）/ `docs/ENGAGEMENT_SUPPRESSION.md`（新規）/
`docs/CUSTOMER_MARKETING.md` / テスト 5 ファイル。
**`package.json` / lockfile / workflow / データ schema は未変更。**

- **Last verified**: 2026-08-12（本番 read-only。上の観測条件 1〜3 は未達）

## 2026-08-10 — 再発行閾値を idle TTL に比例させる（#311 本番反映・30日 idle 失効の回避）

#310 で keep-alive を有料 13 ページへ配線しても Cookie は延びなかった。
本番の `refresh-session` が **204 = `keep`（Set-Cookie 無し）** を返していたためで、
`decideRefresh` の再発行閾値が **固定 5 分**のままだったのが原因。

idle TTL が 20 分だった頃は「残り 5 分を切ったら延長」で妥当だったが、
**2026-07-24 に idle TTL だけ 30 日へ延ばした際に閾値が据え置かれた**。
その結果、再発行は「**30 日の最後の 5 分間にアクセスした場合**」しか起きなくなっていた。
配線は正しかったが、サーバー側が延長を返さないので会員は 30 日で締め出され続けていた。

### 修正（サーバー側 1 箇所）

| 定数 | 値 | 意味 |
|---|---|---|
| `REFRESH_THRESHOLD_RATIO` | `0.5` | 残りが idle TTL の**半分**を切ったら再発行 |
| `REFRESH_THRESHOLD_FLOOR_MS` | 5分 | 比例値の下限 |
| `resolveRefreshThresholdMs(idleTtlMs)` | — | `max(下限, TTL × 比率)` |

`decideRefresh` の既定を固定値からこの関数へ変更。idle TTL 30日 → 閾値 **15日**。
クライアント（`SessionKeepAlive`）の再配線は不要で、認可境界・Cookie 属性・失効条件は不変。

### 得られること / 得られないこと（誤解しやすい点）

- ✅ **15日以内に会員ページを開いていれば、idle TTL（30日の無アクセス失効）は回避できる**
- ✅ 再発行は最大でも半 TTL に 1 回（延長後は残りが 30日に戻る）＝ `Set-Cookie` は増えない
- ⚠️ **「失効しなくなる」わけではない。** `sessionStart` 起点の**絶対 TTL 90日**
  （`ABSOLUTE_SESSION_TTL_MS`）は延長されず、どれだけ頻繁にアクセスしても
  **初回ログインから最長 90 日で `reject`**、再度マジックリンク認証が必要。
  回避できるのは idle TTL だけ

> 当初 PR の説明は「15日以内に1度でも開けば失効しない」だったが、これは絶対 TTL を
> 無視した誤りだったため `b5fbae44` で訂正した（force push は使わず追加コミット）。
> テストも「絶対 TTL 90日で必ず reject に到達したこと」を必須アサーションにし、
> 「延長し続ければ無期限」と読めない形に固定した。

### 恒久ガード

`sessionRefresh.test.mjs` に 4 件追加（既存 20 件は不変で pass）。

- 閾値が idle TTL に比例する（30日→15日 / 40日→20日）
- **閾値が idle TTL の 25% を下回らない**（固定値へ戻す退行を検知）
- 下限は残る（極端に短い / 不正な TTL）
- 残り半分超は `keep` / 半分以下は `reissue`、延長後 `ttlMs` が満了分に戻る
- 半 TTL 以内の訪問なら idle 失効しない。**ただし絶対 TTL 90日で必ず `reject`**

**旧挙動（固定 5 分）へ戻すと新テスト 4 件が fail することを実測。**

### 本番検証（read-only / deploy `6a79d52c` = `fdcf18fb` / 22:43 JST）

| 確認項目 | 結果 |
|---|---|
| 新コードの反映 | main = `fdcf18fb`。旧 `REFRESH_THRESHOLD_MS = 5分` は **0 件** |
| 閾値 | 本番コードから算出して **15日**（idle TTL 30日 × 0.5） |
| 絶対 TTL | **90日を維持** |
| 判定の実挙動 | 残20日→`keep` / 残10日→`reissue` / 初回から91日→`reject` |
| keep-alive | `/premium-prediction/jra/` `/light-predictions/` とも表示ごとに **1 回**・**204**（残り15日超なので延長不要＝正常） |
| 認可経路 | 有料 5 ページとも未認証で `302 → /login/?r=no_session`。認証済みブラウザでは本文表示に退行なし |
| `refresh-session` | Cookie 無しの POST は **401**（正常） |
| 主要 URL | 公開ページ 200 / 有料ページ 302。**console エラー 0** |

### ログ観測課題（残）

**残り 15日未満の実セッションは人為的に作らない**方針のため、
`200 + Set-Cookie（Max-Age=2592000）` への切り替わりは**本番で未確認**。
既存セッションの発行から 15 日経過後に自然発生するので、
その時点で `refresh-session` のレスポンスを観測して確定させる。

### 触っていないもの

production env 変更 / 本番 datastore 変更 / 本番メール送信は**していない**。
予想 4 領域（JRA・南関 × 無料・有料）の表示・予想ロジックは不変。

### 一度だけ観測された非再現事象

`/premium-prediction/jra/` の初回ロードで keep-alive の発火が観測できない回が 1 度あった
（同ページの再試行では 1430ms に発火・204）。`/light-predictions/` は 1722ms に発火。
`SessionKeepAlive` は #311 で未変更のため本 PR 起因ではない。再現しないため経過観察とする。

- **Last verified**: 2026-08-10

## 2026-08-10 — 有料ログインの 3 障害を分離して修正（#309 / #310 本番反映）

有料会員から「マジックリンクからは予想を見られるが、あとでブラウザから直接開くと
再度メール認証を要求される」という報告が続いた。調べると**別々の 3 件**が重なっていた。

| # | 事象 | 期間 | 対応 |
|---|---|---|---|
| 1 | Yahoo 配信遅延 × TTL 15分 → 届いた時点で期限切れ | 〜8/9 14:11 | #271（TTL 60分）既済 |
| 2 | Airtable 一時障害を 10 分キャッシュし有効会員を締め出し | 8/8 | #269 既済 |
| 3 | **`/auth/verify` が TypeScript 構文混入で 1 行も動かず全滅** | **8/9 14:11 〜 8/10 19:52** | 本日 `3606e3aa` |

さらに、報告の主因と考えられる **「別ブラウザでは Cookie が共有されない」** は仕様どおりだが
説明が皆無だった（**最有力仮説・未確定**）。

### 障害 3 の真因（約 29 時間 41 分・有料ログイン成功ゼロ）

`7446b7e1` で `verify.astro` のスクリプトを `<script>` → `<script define:vars={...}>` に変えた。
**`define:vars` は `is:inline` を含意する**ため Astro がトランスパイルせず、残っていた
型注釈がそのままブラウザへ届き `SyntaxError: Unexpected identifier 'as'` で
**ブロック全体が実行されない**状態になった。画面は「認証中... トークンを確認しています」で
永久に停止し、`verify-magic-link` は呼ばれないので**サーバーログにも Airtable にも痕跡が残らない**。

`AuthTokens` の `Used=true` は #272「有効なリンクは常に 1 本」による**旧トークン無効化**であって
ログイン成功ではない。これを成功と誤読したため発見が遅れた。実被害 5 名 / 要求 14 回。

**再発防止**: `inlineScriptNoTs.guard.test.mjs` が `src/**/*.astro` の
`is:inline` / `define:vars` スクリプトを全走査し、素の JS として構文解析できないものを検出する。
修正前のコードで fail することを実測。

### #309 — 一時障害を「再ログイン要求」から分離（`0e540886` / deploy `6a79c787`）

`gatePaidPage` は Cookie 無し・期限切れ・権利不足・**Airtable 一時障害**をすべて
同じ `302 /login` に潰していた。有効会員が障害のたび「ログインが切れた」と誤認し、
再ログインを繰り返して負荷が増える悪循環になっていた（8/8 の障害）。

- **一時障害**（`lookup_unavailable` / `lookup_failed` / `key_missing` / `env_missing` /
  `unknown_required_plan`）→ `Retry-After: 30` 付き **503**。
  「ログイン状態は保持されています。ログインし直す必要はありません」と明示し、
  ページ内に `/login` 導線を置かない
- **認証失敗** → `/login/?r=no_session | session_expired | not_entitled`。
  コードは allow-list で、未知の内部 reason は既定値へ丸める（Location への注入経路にしない）
- `/login` は `?r=` を**描画せず**、一致時のみ固定文言を `textContent` で入れる
- `notFound:true` でも一時障害は 503。この分岐へ来るのは**有効な署名 Cookie を持つ利用者だけ**なので
  ページの存在は漏れない（匿名は前段で 404 のまま）
- ログインメールと `/auth/verify` 成功画面に「普段お使いのブラウザで開く」案内を追加（自動遷移 3秒→6秒）

**本番実測**: `?r=<img src=x onerror=alert(1)>` は**何も表示しない**。有料 4 ページは
`302 → /login/?r=no_session`。有効セッションの通過に退行なし。console エラー 0。

### #310 — keep-alive を共通部品化して有料ページへ配線（`b57a2c07` / deploy `6a79cc98`）

`ak_session` の Max-Age は**発行時に固定**される。keep-alive が入っていたのは
`/premium-plus/` だけで、`gatePaidPage` が守る**有料予想ページ 11 枚は未配線**だった。

`premium-plus.astro` の実装を `src/components/SessionKeepAlive.astro` へ抽出し、
11 ページ + premium-plus 系 2 ページへ配線。premium-plus の直書きは削除して単一源化した。
サーバー側は既存 `refresh-session` のままで、新しいトークン・Cookie・endpoint は足していない。

`sessionKeepAlive.guard.test.mjs` が ①gate ページは必ず配線 ②ページ直書き禁止（単一源）
③会員確定ページ以外へ置かない ④1ページ1個 を強制する。

**本番実測（read-only）**:

| 確認項目 | 結果 |
|---|---|
| 表示ごとの `refresh-session` | `/premium-prediction/{jra,nankan}` `/light-predictions/` `/premium-select/` すべて **1 回だけ** |
| 多重 POST | `visibilitychange` を 3 連投しても **+1 回のみ**（`pinging` ガードが抑止） |
| 復帰時トリガ | バックグラウンド（`hidden`）では**発火しない**。`visible` で発火することを実測 |
| 無料ページ | `/free-prediction/nankan/` は配線 **0 件**（未ログインが 401 を叩かない） |
| 認可・本文表示 | 退行なし。`ak_session` は JS から見えない（HttpOnly 維持） |
| console エラー | 0 件 |

### ⚠️ 未解決: Max-Age は実際には更新されない（次の課題）

本番の `refresh-session` は **204 = `KEEP`** を返し、**Set-Cookie が出ない**。
`decideRefresh` は `remainingIdle > REFRESH_THRESHOLD_MS` なら再発行しないためで、
**閾値が 5 分のまま idle TTL だけ 30 日へ延びている**（2026-07-24 の TTL 延長時に据置）。

→ 再発行は「30 日の最後の 5 分間に有料ページを開いた場合」だけ発生する。
**配線しただけでは 30 日での強制再ログインは解消しない**（#310 の表題は過大だった）。

残作業は `REFRESH_THRESHOLD_MS` を idle TTL に比例させる**サーバー側 1 定数の変更**
（例: 残り 50% を切ったら再発行 = 実質スライディングウィンドウ）。
`sessionRefresh.js` と対応テストのみで完結し、クライアント側の再配線は不要。

### 触っていないもの

production env 変更 / Airtable への書き込み / 実顧客へのメール送信は**していない**。
予想 4 領域（JRA・南関 × 無料・有料）の表示・予想ロジックは不変。
有料ページの認可境界（誰が見られるか）も不変で、変えたのは拒否時の返し方と Cookie 延長トリガのみ。

- **Last verified**: 2026-08-10

## 2026-08-10 — EmailEvents 19,158 行を Airtable から削除（上限超過を解消）

**A 案**: EmailEvents だけ先に削除。`CampaignDeliveries` は `MARKETING_DELIVERY_STORE` が
dual のままだと消しても書き戻るため触っていない。

| | 削除前 | 削除後 |
|---|---:|---:|
| EmailEvents | 19,158 | **0** |
| Airtable 総件数 | 50,825（**上限 +825**）| **31,667（63.3%）** |
| 残り | — | **18,333 件** |

削除 19,158 / 既に無し 0 / **失敗 0**。

### 削除してよい条件を機械で確かめてから消した

1. 削除前 export に recordId と**全フィールド**がある（復元できる）
2. その `EventKey` が **Blob 側の索引に存在する**
3. `MARKETING_EVENT_SINK=blob` で Airtable への追記が止まっている

**3 つすべてを満たした行だけ**を、export の recordId を指定して削除した。

### 🛡️ 安全ガードが実際に止めた

最初の dry-run で **19 件が Blob 索引に無く、全件中止**になった。
原因は「最後の索引化（07:47）以降に dual モードで書かれた 19 件が
Redis 索引に未反映」だったこと（19,158 − 19,139 = 19 と一致）。
再索引化して 0 件にしてから実行した。
**部分削除しない設計（1 件でも欠けたら全体中止）が効いた。**

### 監査記録の所在（失われていない）

- **Blob**: 索引一意 19,205 件（Airtable の 19,158 を包含）
- **export**: `.migration-export/EmailEvents-2026-08-10T0832.ndjson`（14.4 MB / SHA-256 digest 付き）

### 削除後も正常

`mode_blob=55` / `blob_ok=75` / `blob_failed=0` / degraded なし。
新着イベントは Blob に記録され続けている。

### 触っていないもの

`MARKETING_DELIVERY_STORE=dual`（維持）/ 配信 gate は閉じたまま /
`MIGRATION_WRITE_ENABLED` 未設定 / Customers 変更 0 / 新規メール送信 0 /
CampaignDeliveries 14,416 行は**そのまま**。

### 残件

`MARKETING_DELIVERY_STORE=redis` への切替 → `CampaignDeliveries` 14,416 行の削除
（→ 総数 約 17,251 まで下がる）。blob の重複整理（223 個）。


## 2026-08-10 — EmailEvents を Blob 単独へ切替（Airtable への追記が止まった）

`MARKETING_EVENT_SINK=blob`。**Airtable の EmailEvents に行を追加しなくなった。**
`MARKETING_DELIVERY_STORE` は **dual のまま維持**（Redis 単独へはまだ切り替えていない）。

### 実効の証拠（自然流入で確認・新規配信 0）

| 時刻 | Airtable EmailEvents | sink カウンタ |
|---|---:|---|
| 切替前 08:14Z | 19,157 | `mode_dual` |
| +3 分 | 19,158 | `mode_blob:2` `blob_ok:22` `airtable_skipped:2` |
| +6 分 | **19,158（増分 0）** | `mode_blob:5` `blob_ok:25` `airtable_skipped:5` |

**Airtable は止まり、Blob は増え続けている。** `blob_failed:0` / degraded なし。
19,158 のうち最後の +1 は切替直前の dual モードでの書き込み。

### rollback

`MARKETING_EVENT_SINK` を unset すれば `writesAirtableEvents` が true に戻り、
Airtable への追記が復活する（コード変更不要）。実装で確認済み。

### 削除前 export（実施済み・削除はしていない）

`.migration-export/`（**.gitignore 済み**）へ全フィールドを NDJSON で退避。

| table | 件数 | サイズ | digest |
|---|---:|---:|---|
| CampaignDeliveries | 14,416 | 9.4 MB | `b22c6623007bc7fa…` |
| EmailEvents | 19,158 | 14.4 MB | `8ecdf49a89a09918…` |
| ScheduledEmails（SENT/FAILED/CANCELLED）| 174 | 0.9 MB | `409c5eae89f4b0ee…` |

⚠️ **PII を含む。repo へコミットしない。** 退避しただけでは消してよいことにならない。

### 削除対象の最新（削除は未実施）

| 対象 | 件数 |
|---|---:|
| EmailEvents | 19,158 |
| CampaignDeliveries | 14,416 |
| 完了済み ScheduledEmails | 174 |
| **削除合計** | **33,748** |
| 現在の Airtable 総数 | 50,825 |
| **削除後の見込み** | **約 17,077** |

### まだやっていないこと

`MARKETING_DELIVERY_STORE=redis` / Airtable delete / 新規マーケティング配信 /
Customers 変更 / blob 整理削除。**いずれも未実施。**


## 2026-08-10 — dual write を本番有効化（EVENT_SINK / DELIVERY_STORE）

新着イベントが Airtable にだけ増え続ける状態を止めた。**新規メールは 1 通も送っていない。**

| env | 値 | write 先 |
|---|---|---|
| `MARKETING_EVENT_SINK` | **dual** | Airtable + Blob + Redis カウンタ |
| `MARKETING_DELIVERY_STORE` | **dual** | Airtable + Redis（判定は**和集合**）|

### 検証は自然流入で行った（検証目的の配信はしていない）

open が継続流入しているので、それを使って dual の実効を確認した。
`ak:mkt:events:sink` に `mode_dual` / `blob_ok` が積まれ、**degraded は 0**。

`mode_airtable:11 → mode_dual:7` と切り替わり、`blob_ok:7` / `counters_ok:7`。

### preflight で先に潰したこと

dual では **Blob 失敗が致命でない**ため、書けていなくても degraded ログだけで通過する。
移行 Function で `MissingBlobsEnvironmentError` を踏んだ前例があるのに、
webhook 側には確認手段が無かった。`ak:mkt:events:sink` カウンタを先に足し、
**「Blob へ書けていないのに書けているつもり」を構造的に防いだ**。

なお webhook は `export default async (req)` の **Web 形式**で、この形式では
Blobs が自動設定される（`connectLambda` が要るのは Lambda 形式のみ）。
本 repo に前例が無かったため断定せず、実データで確認してから先へ進めた。

### reconcile（両方 PASS）

| 対象 | 件数 | 結果 |
|---|---:|---|
| Airtable ↔ Blob（EventKey）| 19,139 | 欠け **0** ✅ |
| Airtable ↔ Redis（DeliveryKey）| 14,415 | 欠け **0** ✅ |

### rollback

`resolveEventSinkMode({})` / `resolveDeliveryStoreMode({})` はいずれも `airtable` を返す。
**env unset + redeploy で完全に元へ戻る**（コード変更不要）を実装で確認済み。

### 現在の状態

Airtable 総件数 **50,809**（EmailEvents 19,142 / CampaignDeliveries 14,416）。
**dual は Airtable にも書き続けるので、件数は減らない。** 減るのは完全切替 → 削除の後。

`MIGRATION_WRITE_ENABLED` は catch-up 後に UNSET + redeploy し 403 へ復帰済み。
`MARKETING_CAMPAIGN_ENABLED` / `MARKETING_CAMPAIGN_DISPATCH_ENABLED` は閉じたまま。

### 次（高リスク境界・未実施）

`MARKETING_EVENT_SINK=blob` / `MARKETING_DELIVERY_STORE=redis` への完全切替。
ここから先は **Airtable が正本でなくなる**ため、別承認。


## 2026-08-10 — 配信履歴の backfill を本番実行（Redis / Blob へ・Airtable 不変）

Airtable の外へ出す準備として、既存の配信履歴を Redis と Blob へ移した。
**Airtable は 1 行も削除・変更していない。** 読み手（env）もまだ切り替えていない。

### 結果

| 対象 | 件数 | 突合 |
|---|---:|---|
| DeliveryKey → Redis | **14,415** | 14,415 件を `SMISMEMBER` で個別照合 / 欠け **0** ✅ |
| EmailEvents → Blob | **19,074** | 開始時点の全件を照合 / 欠け **0** ✅ |

DeliveryKey はキャンペーン別に照合（dormant-reactivation v2 = 14,279 / comeback-offer v2 = 69 /
comeback-light-30d-granted v2 = 64 / marketing-canary v1〜v3 = 各 1）。

### 実行中に本番で見つけて直した不具合 3 件

| PR | 内容 |
|---|---|
| #300 | Blobs が `MissingBlobsEnvironmentError`。Lambda 互換ランタイムでは自動設定されない → `connectLambda(event)`（Premium Plus 実績画像と同じ） |
| #302 | `list()` の cursor 併用で 500。blob は数十個なので**一覧を取り直して from/limit の範囲で切る**方式へ。併せて **500 応答へ例外名を載せる**ようにした |
| #303 | `JOB_NAMESPACE` の import 漏れで 500（ReferenceError）。**直前の例外名返却のおかげで即特定できた**。再発防止に import 漏れ検査 guard を追加 |

いずれも fail closed が効いており、**壊れた状態で書き込みは起きていない**
（Blobs 失敗時は read=0 / written=0 で FAILED）。

### open が増え続けるので「完全一致」は一度きりの backfill では作れない

検証のたびに Airtable 側が増える（19,067 → 19,071 → 19,080）。残差は 24 → 2 → 6 と
振れ、**発散ではなく生きた尾を追っている**状態。そこで判定基準を
**「backfill 開始時刻より前に存在したイベントが全て Blob にあるか」**に変えた。
これは固定の的で、結果は **19,074 件 / 欠け 0**。

恒久的に一致させるには `MARKETING_EVENT_SINK=dual` が要る（**今回の承認範囲外**）。

### ⚠️ 再実行で Blob が増える

catch-up を流すとバッチ境界がずれて内容ハッシュが変わり、**別キーの blob が新しく作られる**
（39 → 78 → 117 個）。EventKey の集合は重複排除されるので**正しさには影響しない**が、
保存量は増える。切替後に古い blob を整理する余地がある。

### gate

`MIGRATION_WRITE_ENABLED` は実行後に **UNSET + redeploy** し、
`start` / `step` が **403 `blocked_by_design`** へ戻ったことを実測。

### まだやっていないこと

`MARKETING_DELIVERY_STORE=redis` / `MARKETING_EVENT_SINK=blob` の切替、
Airtable の export と削除、新規メール配信。**いずれも未実施。**

Airtable 総件数は **50,751**（上限 +751）。削除するまで減らない。


## 2026-08-10 — メールマーケティング方針を確定（#296 merged）

方針の正本は `docs/spec.md` の「メールマーケティング方針」。以下は運用の確定事項。

### 今後こうする（変更には別途判断が要る）

- **benefit の無い大量配信を禁止**（200 名超で `benefitType` / `benefitDescription` 未宣言は fail closed）
- **`dormant-reactivation` v2 の再大量配信を禁止**（`bulkSendAllowed: false`）。
  再利用には benefit の宣言し直しが要る
- **engagement 閾値は現状維持**（5 / 10 / 20）。
  **実測で 5 回以上送信された人が出てきた時点で初めて再評価**する。
  いま下げると 1 通の open だけを根拠に切ることになり、Apple MPP の影響で誤判定する
- **click tracking は未有効**（`MARKETING_CLICK_TRACKING_ENABLED` 未設定 +
  Event Webhook の `click=false`）。**click を有効なシグナルとして当てにしない**。
  購入・ログインで代替している

### 実測（2026-08-10 / 全 15,970 名）

ACTIVE 3,512 / LOW_ENGAGEMENT 0 / INACTIVE 0 / HARD_INACTIVE 0 / UNKNOWN 12,458。
送信回数の最大が 2〜4 回（59 名）で 5 回以上が 0 名のため、
**engagement guard は現状 1 人も止めない**。次回配信の削減は unsubscribe(2) と
provider suppression(388) のみで **2.4%**。

→ **いま送信数を減らす手段は「人を絞ること」ではなく「送らないこと」**。
benefit guard が主たる削減手段。

### 併せて完了（#294 / #295）

ワンクリック配信停止（RFC 8058）が全部 400 で落ちていた不具合を修正し本番反映。
Reply-To を `support@keiba.link` に設定（From は `DeliveryKey` の構成要素なので不変）。
配信停止申請者 1 名を反映し `sendable=false` を確認。

### 現在の状態

production env は**マーケティング関連すべて未設定**（gate 閉）。保留ジョブ 0。
**新規マーケティング配信は再開していない。**


## 2026-08-10 — ワンクリック配信停止が全部失敗していた（修正・本番反映済み）

利用者から「メール来ます」「配信停止申請」の問い合わせ（JST 11:36）を受けて実送信を
監査したところ、**配信停止の導線が壊れていた**ことが判明した。

### 監査結果（新規送信は発生していない）

gate は両方とも閉・保留ジョブ 0・queued 0。2026-08-09 の `dormant-reactivation` v2
（accepted 14,279 / delivered 13,956 / bounce 325 / dropped 11）で完結しており、
**同一キャンペーンの二重送信は 0**。宛先重複 59 名は 7〜8 月の別キャンペーンとの重複。
最初の送信 2026-08-09T15:31Z / 最後 17:52Z。問い合わせはその 8 時間 44 分後。

### 🔴 根本原因: RFC 8058 のワンクリックを JSON として読んでいた

送信メールは `List-Unsubscribe-Post: List-Unsubscribe=One-Click` を付けており、
Gmail / Yahoo はネイティブの配信停止ボタンを出す。押されると
**form-urlencoded** の POST が来るが、handler は body を無条件で `JSON.parse` しており
**400 で全部落ちていた**。13,956 通配信して配信停止フラグ 0 件だった理由がこれ。

**押した人は「止めたつもり」で止まっていない。** 問い合わせフォームへ回った利用者もいた。

修正（PR #294 `55bd1f20`）:
- `parseUnsubscribeRequest.js`（純粋）で Content-Type を判定
- **宛先は URL から取る**。body の email を宛先にしない（第三者を止められてしまう）
- ワンクリックは配信停止専用。既存 JSON 経路・Content-Type 未指定は従来互換
- 「登録が無い」はワンクリックでは 200（目的達成済み・存在を漏らさない）。
  構成不備 503 / Airtable 障害 502 は **2xx にしない**

本番実測: one-click **400 → 200**、実レコードへの書き込みも確認（冪等）。
合図の無い form は 400、JSON 経路は 404、確認ページは 200 で従来どおり。

### Reply-To が未設定だった

payload に `reply_to` が無く From が `noreply@` のため**返信できなかった**。
`support@keiba.link`（senderIdentity の OFFICIAL・production の SENDGRID_FROM_EMAIL・
問い合わせフォームの from と同一）を brand-config へ追加して配線。

**From は変えない**（`DeliveryKey` の構成要素。変えると既送分と鍵が変わり二重送信）。
Reply-To は鍵に入らないことを検証済み。

### 配信停止申請者

`rec6ExrifclyuPmiJ`（Source=imp-2026-08-09-001）を一意に特定し、本番 unsubscribe 経路で
`UnsubscribedAnalyticsKeiba=true` / `UnsubscribedAtAnalyticsKeiba` を反映。
`sendable=false`・送信直前の再検証でも `unsubscribed` で停止することを確認。
プラン・Status は不変。

### 再開の条件

**新規マーケティング配信は再開していない。** gate は閉じたまま。

# Project Progress

本書は `analytics-keiba` の **進捗の正本（canonical）** である。仕様は `docs/spec.md`、運用ルールは `CLAUDE.md`、設計判断は `docs/decisions.md` を参照。

> **本書の初版は 2026-07-20 に作成された。** 本書作成時点で完了しているのは **ドキュメント基盤の整備のみ**であり、
> コード実装の完了記録ではない。過去のコード作業の完了状況は git 履歴・`docs/MAINTENANCE_HISTORY.md`・
> `CLAUDE.md` を一次証拠とすること。


## 2026-08-09 — 移行/backfill ツールとreconciliationを完成（本番未実行）

#292 を merge（**env 未設定なので挙動は不変**）。既存 14,415 + 18,871 件を
安全に移せる状態まで作った。**production env 変更 / backfill 実行 / Airtable 削除は未実施。**

| 作ったもの | 中身 |
|---|---|
| `migrationCheckpoint.js` | 進捗と検算。**Airtable offset を保存しない**（期限切れで取りこぼす）|
| `completeRead.js` | 打ち切りを**例外**にする全件読み取り |
| `backfillRunner.js` | 移行本体。IO は全部注入するのでリハーサルと本番で**同一経路** |
| `backfill-delivery-keys.mjs` / `backfill-email-events.mjs` | 既定 dry-run。書くには `--apply` |
| `export-airtable-tables.mjs` | 削除前の復元用 export（全フィールド + SHA-256）|
| `reconcile-email-events.mjs` | EventKey 集合 + 種別件数の突合 |

### dry-run 実測（本番データ・書き込み 0）

CampaignDeliveries 145 ページ / **14,415 件**（総 14,416 − skipped-duplicate 1）。
EmailEvents 190 ページ / **18,995 件**。どちらも skip 0・重複 0。

### リハーサル

本番と同じ規模（14,416 / 18,793）を fixture で通し、集合突合まで PASS。
失敗注入（Airtable 途中失敗・Redis 途中失敗・Blob 途中失敗・壊れた応答・
部分 backfill・二重実行）と PII 漏洩ガードも固定。migration 26 / marketing+webhooks 1,269 pass。


## 2026-08-09 — 配信履歴を Airtable から外す段階移行を実装（既定 OFF・本番未切替）

Airtable Team 上限超過（50,456）への恒久対応。**Business へは上げない。**
設計と切替順序の正本は `docs/AIRTABLE_CAPACITY.md`、判断の記録は `docs/decisions.md`。

### 入れたもの（既定の挙動は変えていない）

| ファイル | 役割 |
|---|---|
| `deliveryKeyStore.js` | Redis の DeliveryKey 集合。**TTL なし**・fail closed・AK 名前空間 `ak:mkt:` |
| `deliveryKeySource.js` | 判定源の単一源。読み = **和集合** / 書き = 二重 |
| `emailEventBlobStore.js` | Blob へ追記専用。**バッチ固有キー・読み書き戻し無し** |
| `emailEventSink.js` | イベントの書き込み先と失敗時の扱い |
| `deliveryStoreReconcile.js` | 突合と切替可否 |
| `scripts/reconcile-delivery-stores.mjs` | 全件突合（Function の 26 秒に収まらないため運用スクリプト）|

env は `MARKETING_DELIVERY_STORE` / `MARKETING_EVENT_SINK` の 2 つ。
**未設定なら従来どおり Airtable のみ**。未知の値も airtable へ倒す。

### 実装中に判明したこと

- **Function 内で全件突合はできない。** `fetchAll` は 40 ページで黙って打ち切るため、
  そのまま使うと**偽の「一致」**を出して切替可と誤判定する。既存ガードが検知したので
  運用スクリプトへ移し、スクリプト側は打ち切りを**例外**にした
- 突合は**集合そのもの**を比べる。件数一致では中身の違いを検出できない

### テスト

marketing + webhooks 1,269 pass / crm 539 pass / build・check:safety 通過 / secret 検出 0。
失敗注入（Redis 不通・Blob 不通・部分失敗）、冪等性（2 回 SADD で増えない）、
TTL コマンドを一切発行しないこと、生アドレスを Blob へ書かないことを固定した。

### まだやっていないこと

**production env 変更 / store 切替 / 本番 migration / Airtable DELETE は一切していない。**
次は `MARKETING_DELIVERY_STORE=dual` を入れて 1 配信ぶん突合する段階。


## 2026-08-09 — Airtable Team 上限 50,000 件を超過（実測 50,456）／恒久構成を設計

**現状: 上限超過中。** 書き込みが静かに失敗しうる状態。設計の正本は
`docs/AIRTABLE_CAPACITY.md`。検査は `npm run check:airtable-capacity`（read-only）。

### 内訳（上位 3 table で 97.5%）

| table | 件数 | 性質 |
|---|---:|---|
| EmailEvents | 18,793 | append-only テレメトリ |
| Customers | 15,970 | **正本**（Airtable に置き続ける）|
| CampaignDeliveries | 14,416 | 冪等性の台帳 |
| その他 9 table | 1,277 | |

### 最大の増加源は「配信 1 回」

14,279 名へ 1 回送ると **34,300〜41,300 件**増える
（deliveries 14,279 + jobs 143 + events 19,900〜26,900）。
`EmailEvents` は **open を重複排除しない**（`buildEventKey`「同じ人が 3 回開いたら 3 行」）ため、
受信者数ではなく開封回数に比例して増える。

固定分（Customers + 運用系）は 17,243 件。**Team の残り 32,757 件では 1 回も入らない。**

### API も同時に効く

1 配信あたり約 **24,000 calls**（配信結果 PATCH が受信者ごとに 1 回）。
100,000 calls/月 なので **月 4 回でレコードより先に API 上限へ当たる**。

### Business へ上げても 2 か月

125,000 件へ増えても空きは 74,544 件 = **追加 2 回ぶん**。
月 1 配信で約 2 か月、週 1 配信なら約 2 週間で再枯渇する。**構造が変わらないので却下。**

### 推奨: Team 維持 + 配信履歴を既存インフラへ出す

新サービスは増やさない。AK には既に **Upstash Redis**（取り込みジョブで本番稼働）と
**Netlify Blobs**（Pro に含まれる）がある。

- 冪等性 = `DeliveryKey` の **SET を Redis へ**（`SISMEMBER` で O(1)。1 配信 1.2 MB）
- 生イベント = **Blobs へ NDJSON**。**バッチごとに固有キーで新規作成のみ**にして、
  Premium Plus 実績画像で踏んだ read-modify-write の競合を構造的に避ける
- 集計 = Redis カウンタ

常駐 17,243 件になれば、Customers 自然増（月 20〜100 件）で **50 年以上**持つ。
月額追加は **0 円の見込み**（Upstash の現行プラン上限だけ管理画面で要確認）。

### いま入れたもの

`npm run check:airtable-capacity` — 全 table を数えて上限比を出す read-only 検査。
認証が無ければ skip（CI 安全）。上限超過で exit 2、警告閾値で exit 1。
**ネットワークに出るため `check:safety` には組み込んでいない。**

### まだやっていないこと（本番 write / migration / env 変更は未実施）

二重書き込みの実装、Event Webhook の書き込み先変更、管理画面の開封表示の切替、
Airtable 旧行（約 33,300 件）の削除。**削除は 1 配信ぶんの検証後に別承認。**

### 分からなかったこと

Airtable の契約プランと課金座席数は **API から取得できない**
（`/v0/meta/whoami` は id しか返さない）。Business の差額は管理画面で要確認。
Upstash の現行プラン上限も CLI からは token がマスクされて確認できなかった。



## 2026-08-09 — 取り込みの残作業を確定し、無料会員 活性化テンプレートを追加

### 取り込みの積み残しは **ゼロ**（read-only 実測で確定）

「残り CREATE 候補 14,484 件」という旧記録は誤り。`imp-2026-08-09-001` で
CREATE 候補は**出し切っている**。CSV 3 本を取り込み時と同じ判定器
（`csvParse` → `mapColumns` → `mergeImportFiles`）に通し、Customers と突合した結果:

| 項目 | 値 |
|---|---|
| マージ後の一意エントリ | 15,779（docs 記載と一致）|
| Customers に存在 | 15,700 |
| **未取り込み** | **79** |

未取り込み 79 件の理由（**「理由なし」= 0 件**）:

| 理由 | 件数 |
|---|---|
| 配信失敗歴あり（`delivery_error_history`）| 64（うち 5 は suppression 併発 / 1 は共用アドレス併発）|
| provider suppression | 13 |
| 共用アドレス（role address）| 8 |

**この 79 件は取り込んではいけない。** バウンス歴・provider suppression 済み・
共用アドレスで、追加すると送信者評価を落とす。人が個別に判断する場合を除き放置が正解。

### UPDATE 経路は **設計として存在しない**

`importWritePlan.js` / `admin-customer-import-job.js` に
「作るのは CREATE_CANDIDATE だけ。**UPDATE_CANDIDATE は 1 件も触らない**」と明記があり、
`classifyCreateRow` も `existing` を落とす（`SKIP_REASON.EXISTING`）。
既存 1,373 件を CSV の値で上書きしたい場合は **新しい書き込み経路の実装が要る**。
既存の顧客データを壊しうるので、列ごとの上書き方針を決めてから着手すること。

### #283（名指し取得）の本番実地検証は**機会が無い**

取り込むものが無いため `importTargetedSelect.js` を実行する場面が来ない。
ただし**同じ設計**（名指し取得 + 打ち切りは例外）は marketing 側 #285 / #286 で
14,279 通の本番配信を通して実証済み。次の大量取り込みが来たときに、
最初の数バッチで `batch_verify` のログと所要時間を確認すること。

### `free-member-activation` v1 を追加（無料会員 活性化）

`docs/progress.md` のテンプレート台帳で「未着手」だったもの。

| 項目 | 値 |
|---|---|
| 件名 | 【KEIBA Analytics】無料でご覧いただける予想のご案内 |
| CTA | 今日の無料予想を見る → `/free-prediction/nankan/`（本番 200 実測）|
| audienceRule | `contracts:[none] / plans:[free] / enforce:true` |
| LOCKED hash | `256dfcbb6c06209c` |

**`dormant-reactivation` との違い**（同じ文面にまとめない理由）:

| | dormant-reactivation | free-member-activation |
|---|---|---|
| 前提 | 一度は接点があった（「ご無沙汰しております」）| **まだ無料の中身を使っていない** |
| 入口 | 実績ページ（有料の中身を見せる）| 無料予想ページそのもの |
| 対象 | contract none / expired | contract none **かつ** plan free |

価格・契約の勧誘は書かない（活性化が目的で、販売はここでやらない）。

### click 計測は**人の操作 2 つ待ち**（コード側は完成）

| 確認したこと | 結果 |
|---|---|
| 実装 | `sendOne` の `tracking_settings.click_tracking` = **per-message**。magic link 経路には影響しない |
| アカウント全体の click tracking | `enabled: false` ✅（**ここを true にしてはいけない**。magic link がボットの先読みで消費されログイン不能になる）|
| Event Webhook | `delivered/open/bounce/dropped/spam_report = true` / **`click = false`** |
| `MARKETING_CLICK_TRACKING_ENABLED` | 未設定（既定 OFF）|

残る 2 つは当方では実施できない:

1. **SendGrid Event Webhook の `click` を true にする**（provider 側の設定変更）
2. **受信したカナリアメールのリンクを人が実際に押す**（クリックが無ければ検証できない）

手順は `MARKETING_CLICK_TRACKING_ENABLED=true` + redeploy →
カナリア（**version 上げが必須**。v3 は 2026-08-09 に使用済み）→ 人がクリック →
`EmailEvents` に `click` 行と `UrlCategory` が入り、`UrlPath` にクエリが入らないことを確認。

### PR #172 は既に MERGED

「Draft・未マージ」という旧記録は誤り（2026-07-30 に merge 済み）。


## 2026-08-09 — 振込先口座を PayPay銀行へ変更（本番反映済み）

顧客の入金先を切り替えた。**旧口座はリポジトリから 0 件**（履歴文書 1 行を除く）。

| 項目 | 変更後 |
|---|---|
| 振込先銀行 | PayPay銀行 |
| 支店名 | 本店営業部 |
| 口座種別 | 普通（変更なし）|
| 口座番号 | 8307337 |
| 口座名義 | ｳｴﾌﾞｹｲﾊﾞ |

PR #288 `1de26b28` / 26 ファイル・159 行。

### なぜ 26 ファイルになるか（次に口座を変えるとき必読）

**振込モーダルは 18 ページへコピペで散在している。** 正本の `pricing.astro` だけ直すと
残り 17 ページが旧口座のまま残り、そこから申し込んだ顧客が**旧口座へ振り込む**。
2026-07 の `paymentCompletedConfirm` 未送信（16 ページ中 15 ページが壊れていた）と同じ構図。

置換対象は 4 つの文字列（銀行名・支店名・口座番号・口座名義）で、
**表示・コピーボタンの引数・メール本文**のすべてに出てくる。
メール Function 3 本（`bank-transfer-application` / `expiry-notification` /
`expiry-warning-notification`）と `offerIntakeEmail.js` も忘れないこと。

- `docs/MAINTENANCE_HISTORY.md` は**履歴なので変更しない**（当時の実装の記録）
- 口座名義の `font-size` 縮小指定は旧名義が長かったためのもの。短い名義では外す

### 本番実画面で確認した内容

| ページ | 結果 |
|---|---|
| `/pricing/` `/premium-upgrade/` `/light-campaign/` `/spring-campaign/` `/withdrawal-upsell/` `/sanrenpuku-demo/` `/archive-sanrenpuku-all/` `/dashboard/` `/offer/` | HTTP 200・新口座あり・**旧口座 0** |
| light/premium 予想系・`premium-prediction/nankan` | 302 → `/login/`（認証ゲート・想定どおり）|
| `/archive-sanrenpuku/` | 301 → `/archive-sanrenpuku-all/`（確認済み）|
| `/premium-plus/` | 404（段階公開・想定どおり）|

merge 前に Deploy Preview でも同じ検査を通している。


## 2026-08-09 — `dormant-reactivation` v2 を取り込み 14,279 名へ本番配信

**対象は `imp-2026-08-09-001` で CREATE した外部無料ユーザー 14,279 名だけ。**
既存無料会員・過去 customer-import（210 名）は**含めない**。

### 対象の一意復元（3 つの正本が一致）

| 根拠 | 値 |
|---|---|
| Customers `Source='customer-import:imp-2026-08-09-001'` | 14,279 |
| Redis 取り込みジョブ正本 `reconciliation.created` / `claims.CREATED` | 14,279 / 14,279（`claimedNotCreated` 0・`failedChecks` 0）|
| Customers 総数 1,688 + 14,279 | 15,967（実測と一致）|

過去 customer-import は `imp-2026-08-05-003` 100 / `imp-2026-08-04-002` 100 /
`imp-2026-08-04-001` 10 = **210** で、いずれも今回の Source と一致しないため混入しない。

### 除外 0 の理由（見落としではない）

コホートへ `unsubscribe / blacklist / withdrawn / test account / provider suppression /
duplicate / 同 campaign 既送` を適用した結果は **除外 0 / 送信 14,279**。
これは取り込み時点（`importEligibility.js`）で provider suppression・role address・
AK 内既存重複・flagged を除外済みのため、**同じ条件に二重に当たる対象が残っていない**から。

全体計算とも整合する: Customers 全 15,967 に同じ判定を当てると送信可能 15,880 / 除外 87。
`15,880 − 14,279 = 1,601 = 非コホート 1,688 − 87`。

### 配信の構成

| 項目 | 値 |
|---|---|
| キャンペーン | `dormant-reactivation` v2（休眠・無料会員 再アプローチ）|
| 送信元 | `KEIBA Analytics <noreply@keiba.link>`（`brand-config.js`）|
| 件名 | 【KEIBA Analytics】直近の的中実績をお届けします |
| CTA | 「昨日の買い目と結果」→ `/results-showcase/nankan/` |
| contentHash / shellVersion | `8bc34393b414464b` / 1 |
| enqueue | 500 件 × 29 バッチ（`MAX_RECIPIENTS_PER_SEND=500`）|
| ジョブ | 143（`RECIPIENTS_PER_JOB=100`）|

### カナリアを先に通したことで、配信前に 2 つの重大欠陥が露見した

カナリア（`marketing-canary`）は v2 を唯一のテスト受信者へ送信済みだった。
`DeliveryKey` は `campaignId × version × 受信者 × 送信元` で**日付を含まない**
（`campaignDate: 'fixed'`）ため、v2 のままでは `already_delivered` で送れない。
設計どおり **v3 へ上げて**（#284）実送信したところ、送信できずに欠陥が見つかった。

| PR | 欠陥 | 実害 |
|---|---|---|
| #285 | 送信計画が Customers を全件走査。`fetchAll` は `MAX_PAGES=40`（4,000 件）で **`break` するだけ**で打ち切りをエラーにしない | ① 15,967 件中 4,000 件目より後ろが `unknown_customer` で**黙って除外**（送ったつもりで未送信）。② 既送信突合も同じ打ち切りに晒され、**配信実績が 4,000 行を超えた時点で `already_delivered` を見落として二重送信**。今回 14,279 件で必ず超えるため、次バッチから防壁が壊れる状態だった |
| #286 | dispatcher 側にも同じ全件走査 | `unsubscribed` / `suspended` を打ち切られた範囲でしか作らない = **配信停止した人を除外し損ねる**。カナリアは `campaign_mismatch` で 0 通になった |

全件走査は Function の実行時間（最大 26 秒）にも収まらない（160 ページ ≈ 170 秒）。
**ページ上限を上げても直らない。** `imp-2026-08-09-001` の 504 と同じ **名指し取得**へ寄せた:

- 選んだ recordId / 宛先メールだけを `listRecords`（POST）で引く
- ページ打ち切りは `assertFetchComplete` で**例外**（黙って短い結果を返さない）
- enqueue 側は取得漏れがあれば **502 で停止**（`requested / received / missing` を応答に出す）
- dispatcher 側は顧客レコードを引けない宛先を `customer_record_missing` で
  **その 1 件だけ** skip（バッチ全体は止めない）

テストの偽 Airtable が `POST /{table}/listRecords` を「書き込み」と誤認していたため、
**実挙動どおり読み取りとして扱い、formula を実際に解釈する**ようにした。

### タイムアウトと冪等性

dispatch は 1 ジョブ 100 件を送り切る前に Netlify の proxy タイムアウトに当たる。
ただし **送信 → 台帳 PATCH を受信者ごとに行う**ため、落ちても既送分は `sent` で残り、
再実行時に `already_sent_in_job` で skip される。**受信者単位で冪等。**
ドライバは「応答が無くても状態を読み直す」方針で継続した（送信結果を推測しない）。

全員 skip になったジョブは `expectedWillSend: 0` の live 呼び出しで `SENT` へ確定させる。

### 触ってはいけないこと

- **送信元 `noreply@keiba.link` を変えない。** `from` は `DeliveryKey` の構成要素なので、
  変更すると既送分と鍵が変わり**二重送信になる**。決済経路の正式送信元
  `support@keiba.link`（`senderIdentity.js`）とは**意図的にスコープが分かれている**
  （`docs/decisions.md` 2026-07-20）。混同して統一しないこと
- `enforce: false` のキャンペーン（`comeback-light-30d-granted` / `comeback-offer`）は
  audience 制約が効かず**全員に当たる**。前者は付与していない「Light 30 日無料」を
  通知してしまう。宛先を明示選択する運用から外れないこと

### 最終突合（2026-08-09 / read-only 実測）

**queued / accepted / failed / delivered は別々に計測している。**
`sent` は「SendGrid が受理した」であって配信完了ではない。

| 指標 | 値 | 出所 |
|---|---|---|
| 対象 | 14,279 | Customers `Source` × Redis 正本 |
| queued（残）| **0** | CampaignDeliveries |
| **accepted** | **14,279** | CampaignDeliveries `Status='sent'` |
| failed | **0** | CampaignDeliveries |
| **delivered** | **13,953** | EmailEvents（Event Webhook 実測）|
| bounce | 325（2.28%）| EmailEvents |
| dropped | 11 | EmailEvents |
| open | 2,949 | EmailEvents |

| 冪等性の検証 | 結果 |
|---|---|
| DeliveryKey 一意 | 14,279 / 14,279 ✅ |
| 宛先一意 | 14,279 / 14,279 ✅ |
| accepted の宛先重複 | **0** ✅（二重送信なし）|
| delivered だが台帳に accepted 無し | 0 ✅ |
| accepted だが delivered 未観測 | 326（= bounce 325 + dropped 11 と概ね対応。webhook は遅延する）|
| ScheduledEmails | 143 本すべて `SENT` / PENDING 残 0 ✅ |
| 他キャンペーンの PENDING 滞留 | 0 ✅ |
| CampaignDeliveries 総数 | 14,416 = 今回 14,279 + 既存 136 + カナリア 1 ✅ |
| 取り込みジョブ（Redis）| COMPLETED / lock なし ✅ |

### ゲート再閉鎖（実証済み）

配信後に `MARKETING_CAMPAIGN_ENABLED` / `MARKETING_CAMPAIGN_DISPATCH_ENABLED` を
**UNSET → redeploy** し、ランタイムで `sendEnabled: false` / `dispatchEnabled: false` を確認。
実際に叩いて遮断されることまで確認した:

| 呼び出し | 結果 |
|---|---|
| `admin-marketing action=send` | **503** `flag: MARKETING_CAMPAIGN_ENABLED` / `sideEffects: none` |
| `marketing-campaign-dispatch dryRun=false` | **503** `flag: MARKETING_CAMPAIGN_DISPATCH_ENABLED` / `sideEffects: none` |

⚠️ 実装が返すのは **503 + フラグ名**（403 ではない）。運用手順に 403 と書かないこと。

### 次にやるとき

- bounce 325 は provider suppression へ入る。**次回の配信では自動的に除外される**
- 送信は 1 通ずつ（送信 → 台帳 PATCH）。1 ジョブ 100 件は Netlify の proxy タイムアウトに
  必ず当たるので、**応答が無いことを失敗と見なさない**。状態を読み直して継続する
- 全体で約 2 時間（accepted 14,279 / 平均 約 120 通/分）。並列化はしていない。
  **同一ジョブへの並行 dispatch は二重送信を作る**（`alreadySent` は呼び出し開始時点の
  スナップショット）ので、速度のために並列化しないこと


## 2026-08-09 — 外部リスト大量取り込み `imp-2026-08-09-001` 本番完了（14,279 件）

**結果: COMPLETED / CREATE 14,279 / UPDATE 0 / failed 0 / duplicate 0 / メール 0。**
Customers は 1,688 → **15,967**（= 1,688 + 14,279 で完全一致）。
reconciliation は最終 5 検査すべて PASS。write ゲート 2 件は **UNSET へ再閉鎖済み**。

| 項目 | 値 |
|---|---|
| ImportBatchId | `imp-2026-08-09-001` |
| Source | `customer-import:imp-2026-08-09-001` |
| CSV 母数 | 15,779（CSV 内の正規化メール重複 0）|
| CREATE / EXISTING / EXCLUDED / REVIEW | 14,279 / 1,373 / 33 / 94 |
| 子バッチ | 142 完了 |
| CSV fingerprint | `33200f587f03…` |
| snapshot fingerprint | `abecef6dd726…` |
| 書き込んだ列 | allow-list 内のみ |

### 実行中に本番で見つけて直した不具合（5 件）

**この経路は一度も通しで動いたことが無く、会計の不具合を 100 件ずつ本番で発見する形になった。**

| PR | 内容 |
|---|---|
| #275 | `reconciliation.checks[].name` が `assertNoPii` に PII と誤検知され**正本を保存できなかった**（Airtable へは書けているのに `created=0` のまま）|
| #276 | 取り残しを実測へ追いつかせる `adoptMeasuredCreated` |
| #278 | `attempted` 未加算で `counters_balanced` が必ず落ちる / BLOCKED 解除経路 `action=unblock` / **143 バッチ通し試験** |
| #280 | 書き込み中のページングによる**過少計測**（`4400 vs 4333`）で誤 BLOCKED → 一度だけ測り直す |
| #281 | `MAX_PAGES=60` で 6,000 件超を数え切れず実測が過少に → 250 + 打ち切りは例外 |

### 終盤の HTTP 504 と恒久対策（#283 / main 反映済み・**本番未検証**）

終盤は毎 step が 504 になった（**書き込みは成立**。応答が返らないだけ）。

計測（Customers 15,967 件）: 全件取得は **160 ページ / 約 170 秒**。**列を減らしても変わらない**
（コストはページ数）。step は facts 用と突合用で 2 回引いており約 340 秒。
Netlify Function のタイムアウト（最大 26 秒）では**全件走査は原理的に不可能**だった。

対して **対象 100 件の名指しクエリは 1 コール 1.7 秒**。

#283 で次のように変えた:
- facts は**名指し取得**（窓 300 件・上限 12 窓・`listRecords` POST）
- **per-batch 検証**を追加（書いたメールを引き直し、取りこぼし / 二重 CREATE / 他 Source を検知）
- 全体突合は **cadence 25 + 完了時必須**。省略回は `deferredFullReconcile: true` を正本に残す

⚠️ **#283 は本番での実地検証をまだ行っていない。**
   次回の大量取り込みが名指し取得方式の初回実行になる。開始時は
   最初の数バッチで `batch_verify` のログと所要時間（従来 340 秒 → 想定 4〜6 秒）を
   確認してから流し切ること。

### 次回に持ち越す注意

- 確定件数は**測定時点の値**。Customers は日々増えるので、開始直前に `plan` を
  再実行して確認文字列を取り直す（件数が変わると開始が拒否される）
- `action=step` は逐次のみ。並行実行しない（グローバルロックで拒否される）
- 504 が出ても書き込みは成立しうる。**状態（`action=status`）で判断する**
- 完了後は env 2 件を必ず UNSET し、redeploy で再閉鎖する


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

**大量取り込み（PR #235）の状態（2026-08-05 時点の記録・最新ではない）: 大量取り込みの恒久方式は PR #235（Draft）まで実装したが、
必須条件 2 件を満たせず **write 経路は BLOCKED**。正本と排他を Upstash Redis へ置き換える
ADR（`docs/decisions.md` 2026-08-05）を Proposed で起票し、**承認待ちで停止**している。
本番 env 変更・production deploy・本番 Airtable 書き込みは 1 件も行っていない。**

### ⛔ Redis canary Phase 0 / Phase 1 — **実行不能（アクセス経路が無い）**（2026-08-05）

ADR は承認されたが、**Phase 0 / Phase 1 は実行できなかった。** 原因は権限ではなく設計どおりの秘匿:

| 事実 | 値 |
|---|---|
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` の `is_secret` | **`true`**（Netlify は作成後に値を返さない） |
| scope | **`functions` のみ**（builds に配られない） |
| 値を持つ context | **`production` のみ**（`dev` / `branch-deploy` / `deploy-preview` / `dev-server` は空） |
| ローカル `.env` / シェル環境変数 | **無し**（`.env.production` にも `UPSTASH` 行は 0 件） |

`netlify env:get` / `env:list --json` / `getEnvVars` API のいずれも **16 桁マスク + 末尾 4 桁**しか返さない。

**したがって production Upstash へ到達できるのは production の Function だけ**であり、
Phase 0（PING / DBSIZE / EVAL）すら、次のどちらかが無いと実行できない:

1. **canary Function の production deploy** — 今回の承認範囲外（production deploy 禁止）
2. **実行者による認証情報の提供**（Upstash コンソールから取得）

`deploy-preview` context には値が無いため、**Deploy Preview 経由でも到達できない**。

#### 実施したこと

- 上記アクセス経路の調査（read-only。Redis へは **1 コマンドも送っていない**）

#### 採用した方式: 専用 canary Function（secret を Netlify 外へ出さない）

**ローカルへ認証情報を取得する方式は不採用**（利用者判断）。
代わりに **専用 canary Function** を置き、Function 内部だけで secret を使う。
ADR: `docs/decisions.md`「2026-08-05 — Redis canary は専用 Function で行う」

| 項目 | 値 |
|---|---|
| Function | `netlify/functions/admin-customer-import-redis-canary.js` |
| 認証 | **POST のみ** + `x-admin-secret`（AK 管理シークレット） |
| 有効化 | **`CUSTOMER_IMPORT_CANARY_ENABLED=true` が無ければ常時 403**（既定は無効） |
| action | `preview` / `run` / `status` / `cleanup` の 4 つだけ |
| canaryId | **サーバー側生成**（`preview` で発行。`^\d{14}-[a-f0-9]{8}$` 以外は拒否） |
| 確認文字列 | **`REDIS-CANARY <canaryId>`** |
| 実行回数 | **1 canaryId につき run はちょうど 1 回**（実行済みマーカーを `SET NX`） |
| 名前空間 | `customer-import:canary:<canaryId>:` 配下**のみ**。外は構造的に拒否 |
| 最大キー数 | **32** |
| 最大コマンド数 | **150** |
| canary キー TTL | **900 秒（15 分）** — cleanup 漏れでも自動消滅 |
| 実行済みマーカー TTL | 86,400 秒（24 時間） |

**触れないキー**: `customer-import:lock:global` / `customer-import:fence` /
`customer-import:email:*` / `customer-import:job:*` / `payemail:*`（テストで固定）。
**全キー列挙（`KEYS`）は禁止**。走査は `SCAN MATCH <prefix>*` のみ。
**Airtable に触れない。メールを送らない**（依存が存在しない）。

#### production 配備方式（調査で確定・2026-08-05）

**`netlify deploy --build --prod --context production` をブランチ worktree から実行する**（CLI 手動 deploy）。

他の手段が使えない理由を read-only で確認した:

| 手段 | 判定 |
|---|---|
| Build Hook | **不可**。hook は `main` に紐づく。ブランチを production へは出せない |
| Deploy Preview / Branch Deploy | **到達しても無意味**。`deploy-preview` / `branch-deploy` context には `UPSTASH_*` の値が無く、canary は `upstash_not_configured` で fail closed |
| 既存 preview deploy を production へ publish | **不可**。その deploy は preview context の env で作られており、production の secret を持たない |
| PR merge / main へ直接 push | **禁止**（今回の制約） |

> ⚠️ AK は**過去に手動 deploy を 1 度も使っていない**（直近 12 deploy はすべて `manual: false`）。
> CLI 手動 deploy は **`commit_ref` が origin/main と一致しない** deploy を作る。
> これは「公開 SHA == origin/main」という従来の前提を一時的に破る。**復帰は main の Build Hook 1 回**。

#### env 反映の契約（**「deploy 不要」の記述は撤回**）

以前この文書に書いた「Function は毎回 `process.env` を読むので env 変更に deploy は不要」は**誤り**。撤回する。

- Netlify CLI は `env:set` / `env:unset` のたびに
  **`Changes will require a redeploy to take effect on any deployed versions`** と表示する
- **AK 自身の実績も「env 変更 → redeploy」**:
  - 入金確認メール v2 の各境界（A / C / D）はすべて `env 変更 → redeploy`
    （`PAYMENT_EMAIL_V2.md`: 「env 更新 00:50 UTC / redeploy 00:53 UTC published」）
  - rollback も `GLOBAL_PAUSE=true → redeploy`、`PAYMENT_CONFIRM_SECRET unset → Build Hook で 1 回ビルド`
- したがって **env を変えたら必ず redeploy する**前提で手順を組む

#### production deploy 総回数: **最大 3 回（最小 2 回）**

**順序は fail-closed**（コードが先・env が後）。**Function 未配備の状態で env を true にしない。**

| # | source branch | source SHA | env 状態 | deploy 方法 | 期待される公開 SHA | rollback |
|---|---|---|---|---|---|---|
| **D1** | `feat/customer-import-job` | 本 PR HEAD | `CANARY_ENABLED` **未設定** | `netlify deploy --build --prod --context production` | 手動 deploy（`commit_ref` は origin/main と不一致）| main の Build Hook 1 回 |
| **D2** | 同上 | 同上 | `CANARY_ENABLED=true` を投入**後** | 同上（env 反映のための再 deploy） | 同上 | main の Build Hook 1 回 |
| **D3** | `main` | `origin/main` HEAD | `CANARY_ENABLED` **削除済み** | **Build Hook**（AK 標準） | `origin/main` HEAD | — |

- **D1 の時点では canary は 403**（env が無い）。安全側で着地する
- **D2 は条件付き**。D1 + env 投入の直後に `action:'preview'` を叩き、
  **200 が返れば env は反映済みなので D2 は不要**（＝ deploy 2 回で済む）。
  403 のままなら D2 を実行する。**推測せず実測で決める**
- **D3 で canary Function は消える**。main には canary Function が存在しないため、
  main を 1 回ビルドするだけで**コードごと本番から消える**（削除用の特別な commit は不要）
- したがって**最終状態**: production env に `CANARY_ENABLED` 無し / production code に canary Function 無し /
  import job の kill-switch は main 側に存在しない（**本 PR 未 merge のため、そもそも本番に無い**）

#### run exactly 1 から無効化までの手順

1. **D1**（コード配備・env 無し）→ `preview` が **403** であることを確認
2. `netlify env:set CUSTOMER_IMPORT_CANARY_ENABLED true --context production`
3. `preview` を叩く → **200 なら D2 不要 / 403 なら D2 を実行**
4. `preview` で **canaryId を発行**（Redis へは触れない）
5. `run` を **exactly 1 回**（確認文字列 `REDIS-CANARY <canaryId>`）
6. `cleanup` → **canary prefix 残存 0** を確認（墓標は残る＝再実行は塞がれたまま）
7. `finalize`（確認文字列 `REDIS-CANARY-FINALIZE <canaryId>`）→ **墓標も削除し残存を完全に 0**
8. `netlify env:unset CUSTOMER_IMPORT_CANARY_ENABLED --context production`
9. **D3**（main を Build Hook で 1 回ビルド）→ canary Function が本番から消える

> **7 → 8 は続けて行う。** finalize で墓標を消した後は、Redis 側で同一 canaryId の再実行を
> 拒否できない（再実行しても canary 名前空間しか触らないので本番影響は無いが、
> exactly-once の保証はそこで終わる）。

#### 墓標と「残存 0」の両立

「cleanup 後に残存 0」と「同一 canaryId を再実行させない」は、**墓標を別 prefix に置く**ことで両立させた。

| キー | prefix | cleanup | finalize |
|---|---|---|---|
| 検証データ | `customer-import:canary:<id>:` | **削除**（残存 0） | 残存 0 を再確認 |
| 実行済み墓標 | `customer-import:canary-run:<id>` | **残す**（再実行を拒否） | **削除**（最終的に 0） |

`cleanup` 時点で「canary prefix 残存 0」が成立し、かつ墓標が残るので再実行は拒否される。
`finalize` は Function 無効化の直前に 1 度だけ呼び、**両方 0** にする。

#### 無効化・rollback

- **即時無効化**: `netlify env:unset CUSTOMER_IMPORT_CANARY_ENABLED --context production` **＋ redeploy**
  （env だけでは反映されない前提。確実に止めるなら **D3 = main の Build Hook 1 回**が最短）
- **最も確実な rollback**: **main を Build Hook で 1 回ビルド**。
  main には canary Function が無いので、コードも env 依存も一括で消える
- canary は Airtable も本番 Redis キーも変更しないため、データ面の巻き戻しは不要

#### Upstash の plan / quota / rate limit

**確認不能。** Upstash コンソールおよび Upstash 管理 API の認証情報を保持していないため、
CLI からは確認できない。Phase 2 に進む前に**コンソールでの確認が必要**。

#### ADR の Status

**Proposed のまま据え置く。** Phase 1 を通していないため `Accepted` にはしない。

---

### 🚫 BLOCKED — 大量取り込みジョブの write 経路（2026-08-05）

PR #235 の差分を再監査した結果、**必須条件 2 件が未達**であることを確認した。
これらは運用で回避すべきものではなく、**設計で閉じる**。

| # | 未達の必須条件 | 実態 |
|---|---|---|
| 1 | **同時実行を fail-closed で拒否** | Netlify Blobs は last-write-wins。`onlyIfNew` / `onlyIfMatch` は best-effort（premium-plus canary #13 で実 lost-update 確認）。**リースは排他にならない** |
| 2 | **親 ImportJob が正本** | 正本を Airtable の `Source` 件数に置いたが、**snapshot / 失敗 / 未処理 / cancel 境界 / operationId を完全には復元できない** |

加えて、**Customers 直前照合だけでは TOCTOU が閉じない**。2 つの実行が同時に同じアドレスを
「まだ無い」と読めば両方が作成しうる。

> **「実績のある単発 run と同じ露出だから運用で閉じる」という整理は不採用とする。**
> 現在の Blobs 非正本方式を、本番 write 可能な完成形として扱わない。

#### 停止の範囲

- **停止**: ジョブ経路の本番 write（`start` / `step` の書き込み）
- **停止しない**: `plan`（read-only）・管理画面の下見/進捗表示・状態機械・eligibility・runner・テスト
  （いずれも Redis 版でそのまま再利用できる）
- **無変更**: 実績のある単発 100 件経路（`admin-customer-import-run.js` / `importWriteExecutor.js`）

#### 解決方針（ADR: `docs/decisions.md` 2026-08-05・**Proposed / 未承認**）— **実装済み**

**正本と排他を Upstash Redis へ移した。** Upstash は AK の既存基盤で、入金確認メール v2 の
dispatcher / worker / reconciler が `SET NX EX` + `INCR` fencing token で**本番稼働中**
（`src/lib/payments/paymentEmailDeps.js`）。production env に
`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` が secret-flagged で設定済み
（値は CLI でマスクされるため、ローカルからの疎通確認は**していない**）。

- **グローバルロック**（AK 全体で write ジョブ 1 つ）を `SET NX EX` + fencing token で取る。
  **job 単位ではないので異なる `batchId` 同士の競合も拒否**。取れなければ Airtable を読まない・書かない
- **行 claim は `batchId` で区切らず、正規化メールに対してグローバル**:
  `customer-import:email:<sha256(normalizedEmail)>`。
  `ownerJobId` / `batchId` / `operationId` / `fencingToken` / `state` / `claimedAt` / `expiresAt` を保持
  - ⚠️ 旧案の `importrow:<batchId>:<hash>` は**異なる batchId が同じメールを同時 claim できる**ため破棄
- **書き込み直前にロック所有権と fencing token を再検証**し、失っていたら create しない
- **claim は作成確認まで解放しない。回収は reconciler だけ**が 4 条件
  （Customers に同メール無し / 同 Source 無し / 期限切れ / 旧 fencing token が失効）を確認して行う
- snapshot は **chunk 分割**（500 件ずつ）して固定し、指紋で差し替えを検知
- 突合は **4 点**（Redis counters / Redis claim 状態 / Airtable Source 件数 /
  Customers 全体の重複メール数）。不一致なら **PARTIAL または BLOCKED** へ遷移し**自動続行しない**
- **新規外部サービス・env 追加・schema 変更・migration は不要**

検討した代替案（Airtable 専用テーブル / GitHub Contents API CAS / 新規 Postgres）と
判定理由は ADR の「Alternatives Considered」に記載。
**Airtable 専用テーブル案は成立しない**（transaction も unique 制約も CAS も無く、schema 変更が必要）。

#### 残る限界（承認前に把握しておくこと）

- **保証するのは「Redis が正常なときの at-most-once claim」であって literal exactly-once ではない。**
  claim 後・create 前にクラッシュすると「claim 済み・未作成」が残る。
  これは**重複ではなく取りこぼし**（安全側）で、reconciler が 4 条件を確認して回収する
- **Redis が異常なときは新規 Airtable 書き込みを全面停止する（fail-closed）。**
  到達不能 / Lua 結果不明 / lock 状態不明 / 正本が読めない / claim 不整合 / データ欠損の疑い、
  いずれも 503 で止める。**Customers 実在判定は第二防御であり、同時実行排他の代替ではない**
- **Upstash の現行プラン・残クォータ・レート上限は未確認。** 実行前に確認すること
- **Lua スクリプトの本文はテストで実行していない**（サーバ側でしか動かないため、
  fake は識別子で分岐して意味論を JS で再現している）。Lua 本文の正しさは **Redis canary** で確認する

（以下は BLOCKED 前に実装した内容の記録。**write 経路は上記のとおり停止中**。）

**（前段）外部リストの本番取り込みが 3 バッチ完了（10 + 100 + 100 = 210 件・

### 🔎 Premium Plus「即時販売」の実態調査と文言修正（2026-08-07・Draft PR）

**発端**: ある三連複会員が Premium Plus に反応しない。「CTA が見えていればクリックするはずの人」との指摘。

#### 分かったこと（read-only 調査）

| # | 事実 |
|---|---|
| 1 | **「即時販売」の仕組みは既に正しく動く**。`PremiumPlusReleaseOverride = 'phase4'` で段階公開を飛ばし、PHASE 4（CTA 表示・購入可）になる。route は本人本来のものを保つ |
| 2 | **該当者には既に override=phase4 が設定済み**（2026-07-30 admin 操作）。顧客側判定は `phase=4 / showProductPage=true / showPurchaseCta=true / purchaseEnabled=true / 受付中` |
| 3 | **`PremiumPlusCta` は 2026-07-15 からコメントアウト**（存在秘匿のため）。三連複ページに出るのは `PremiumPlusStageTeaser` の**予告枠リンクだけ** |
| 4 | クリック計測は**全経路で無効**（`MARKETING_CLICK_TRACKING_ENABLED` 未設定 / 共有 executor はハードコードで無効 / サイト側にも計測なし）。**「押したか」はデータで追えない** |
| 5 | 表示状態と override の突合（read-only・PII 非出力）: `PremiumPlusEligibility` 設定済み **3 件はすべて override=phase4**。**不整合 0 件** |

→ **「反応がない」の説明**: 販売状態は正しく開いており `/premium-plus/` で購入できる。
三連複ページの導線は**設計どおり予告枠リンクのみ**（強い CTA は存在秘匿のため非表示）なので、
リンクに気づかれていない可能性が高い。**導線の強化は段階公開設計の変更として別途判断する。**

#### 決定（再発防止・恒久ルール）

`docs/decisions.md` 2026-08-07 に記録。要点:

- **管理画面の文言と本番挙動の意味一致を完成条件にする**（ズレていればコードが正しくても未完成）
- **強い操作語**（即時販売 / 送信 / 昇格 / 販売可）は
  **管理操作 → 保存値 → 公開判定 → 商品ページの可否 → `purchaseEnabled`** を **E2E で確認**する
- **「即時販売」= 確定時点で即 PHASE 4 相当**にし、**`/premium-plus/` のアクセスと購入を即時可能**にする
  （eligible 化でも段階公開開始でもない）。
  **三連複ページの teaser / CTA は既存の段階公開設計を維持**し、強い CTA の即時表示は要件に含めない
- dry-run / preview は**「この操作後に顧客から何が見えるか」を明示**する設計を優先
- 恒久的な回帰条件: **「今すぐ販売可」確定 → `override=phase4` → `phase=4` →
  `showProductPage=true` → `purchaseEnabled=true` → 本人が `/premium-plus/` で購入できる**
  （`showPurchaseCta` は公開判定値として確認するが、三連複ページの強い CTA は完成条件にしない）
- **今後は運用者の手動監査を前提にせず、自動テストと仕様で検知する**

#### 直したこと（文言と実動作の一致）

管理画面の操作が「何を起こすか」「会員に何が見えるか」を操作前に明示するようにした。

- ボタン: `段階公開で販売可` → **`段階公開で販売可（CTAは待機後）`** / `今すぐ販売可` → **`今すぐ販売可（CTA表示・購入可）`**
- 一覧フィルタ: `すぐ販売できる（個別許可）` → **`即時販売（CTA表示・購入可）`**
- 通常操作の説明: 「販売資格を与えるだけ。**今日は買えません**」
- 強い操作の説明: 「待機日数を飛ばして即 PHASE 4」＋**どこに何が出るか**
  （`/premium-plus/` は開ける／三連複ページは**予告枠リンクだけ**／購入 CTA 本体は非表示）

**判定ロジック・フィールドは変更していない**（既存 override が正本。新しい列は増やさない）。

#### テスト

`premiumPlusImmediateSale.test.mjs` **13 件**を新設。顧客に見えるのと同じ経路で、
PHASE 3 の三連複会員 → 即時販売 → 即 PHASE 4 / CTA / 購入可・route 維持、
Premium 会員（30 日未満）でも同様、override なしなら段階公開のまま、
保留 / 販売対象外 / 契約無効は override があっても売らない、受付時間帯は不変、
冪等（2 回目は override を PATCH に含めない）、他顧客に波及しない、
schema 未準備なら fail closed、管理画面の文言が実動作と一致、を固定。

premiumPlus 全体 **407 pass** / `check:safety` 519 pass / build 成功。
**本番 Airtable write 0 / production env 変更 0 / deploy 0 / 送信 0。**

### ✅ メルマガ自動化 main 反映（2026-08-06・PR #237 squash `ba93eda`）

**production deploy 済み。env が全て閉じているため本番の挙動は変わらない**
（送信 0 / Redis・Airtable write 0 / 実顧客接触 0 / env 変更 0）。

merge 後の本番実測: cron 公開 URL は **403 / 本文 0 バイト**（scheduled function）、
管理 API の write は **403**、管理画面は 401、主要ページは全て 200、
`cron-marketing-automation` / `admin-marketing-automation` の invocation **0 件**。
`MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` / `..._SCHEDULER_ENABLED` /
`..._DISPATCH_ARMED` は **production 未設定のまま**。

**初回 schedule（JST 10:00 / cron `0 1 * * *`）のログ確認は未実施**。
確認内容は `docs/marketing-automation-release-runbook.md` の S1。

### 🚧 段階開放 runbook と残件の read-only 監査（2026-08-06・**C-2 / B-3 は解消済み**）

> **2026-08-06 追記**: 本節は監査時点の記録。**C-2 と B-3 は PR #241（`37090c0`）で解消**した。
> 未解決は **B-4（索引更新の 2 段）/ B-5（run キーの TTL）** の 2 件。
> 段階開放 runbook も見込み客プールを含む形へ更新済み。

- **[`docs/marketing-automation-release-runbook.md`](./marketing-automation-release-runbook.md)** を新設。
  S0（現状）→ S1（schedule 起動確認・env 変更なし）→ S2（管理 write）→ S3（ACTIVE 化）→
  S4（scheduler・当日武装なし）→ S5（初回実配信）の 5 段。各段に合格条件と rollback を明記。
  **env 変更は redeploy が要る / 1 段につき env 1 つ / 合格条件を満たさなければ閉じる。**
- 残件 B-3 / B-4 / C-2 を本番実測つきで再監査（`marketing-automation-preprod-audit.md` 末尾）。

**⚠️ C-2 を「運用品質」から格上げ**: `preview`（dry-run）は Customers を全件・逐次取得する。
本番実測で **1,678 件 = 17 ページで 7.65 s（cold）/ 3.48 s（warm）**。
Netlify 同期 Function のタイムアウトは既定 10 秒なので、**約 4,000 件でタイムアウト域**、
外部取り込み完了後の **15,800 件では 30〜70 秒で確実に失敗**する。
`activate` も同じ経路で再計算するため、**自動化を一切操作できなくなる**（壊れ方は fail-closed で安全側）。

> **✅ 解消（PR #241 / `37090c0`）**: 走査を **Scheduled Function**（`cron-prospect-worker`）へ移し、
> 同期側は Redis の写し（`ak:customer-snapshot:`）を読むだけにした。件数に依らず速く、
> 写しが無い / 古い / 壊れているときは fail-closed。**取り込み件数を理由に急ぐ必要は無くなった。**

B-3 は「Redis に run は残っているのに当日分しか引いていない」だけで、決定的 runId の `MGET` で足りる。
> **✅ 解消（PR #241）**: `runs` を **直近 30 日（最大 90 日）**へ拡張。索引は増やしていない。
B-4 は誤送信には繋がらないが、`activate` の途中失敗で **`get` は ACTIVE / `list` に出ない**という
A-1 と同種の食い違いを生む（`markActive` を先にするのが最小の対策）。
新たに B-5（run キーに TTL が無い）/ B-6（本番 `index:active` が空＝開放前の基準点）を記録。

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
| A-5 | **Netlify Scheduled Function 方式**へ変更（既存 cron と同じ **Functions v2 形式 + `export const config = { schedule: '0 1 * * *' }`** = **JST 10:00**。`netlify.toml` へは書かず二重登録を避ける。⚠️ **`export const config` が効くのは v2 形式だけ**で、v1 形式のままだと schedule が登録されず公開 HTTP Function になる — Deploy Preview で実測して判明し、v2 へ書き換えた）。scheduled function は**公開 URL からの HTTP が 404** になるため外部から起動できず、**専用 secret は廃止**（コードから完全削除）。多層防御として、scheduled 実行の形（`next_run` 付き本文）でないイベントは handler が **404**。判定は**ゲート・Redis / Airtable 初期化より前** |
| A-6 | 自動化専用ゲートを 2 つ要求（`SCHEDULER_ENABLED` + `DISPATCH_ARMED=<当日 JST 日付>`）。**日付一致なので翌日に自動的に閉じる** |
| B-1 | ページ上限で黙って `break` するのをやめ、`customers_truncated`（503）で**失敗させる**。上限も 60 → 300 ページ |
| B-2 | `preview` は**保存済み Definition を基準**にする（preset は保存済みが無いときだけ） |
| C-1 | UI はどの応答でも `writeEnabled` を反映し直し、`write_blocked` で即座に閉じる。`configVersion` の固定値送信を廃止し、設定変更で承認済み指紋を破棄 |

**dry-run・保存・実行が同じ対象集合を使う**ようになった。対象集合の組み立ては
`_computeSnapshot()` の 1 経路に集約し、`activate` は申告値を鵜呑みにせず**再計算して照合**する
（不一致は `snapshot_mismatch`）。

**Deploy Preview（env 全閉鎖）で実測**: cron は **Scheduled Function 化により公開 URL から
起動できない**（POST / GET / 詐称ヘッダ付きのいずれも **Netlify 層の 403・本文 0 バイト**で、
コードに到達しない）。管理 API は secret 無しで 403、secret 有りでも `create` / `activate` は
**403 `write_blocked`（Redis / Airtable 接続 0）**。`list` は `writeEnabled:false` + `store_unavailable`、
`get` は 503（推測データを返さない）、dry-run は Customers 1,677 件を最後まで取得して成功。
管理画面は Basic-Auth の 401。

> ⚠️ `PREMIUM_PLUS_ADMIN_SECRET` は **deploy-preview にも設定済み**だった。
> 本書の 2026-08-03 の記述「production 限定 → preview は 503」は現状と異なる。

テスト: marketing **973 pass**、payments 246 pass、CRM 246 pass、`check:safety` 519 pass、build 通過。
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

### 🚧 段階開放の preflight を整備（2026-08-07・read-only / 実行はまだ）

`docs/marketing-automation-release-runbook.md` の末尾に、開放直前に毎回見る節を追加した。
**production env 変更 0 / 本番 write 0 / 実送信 0 / deploy 0。**

- **env と write 経路の対応表**（開けたときに何が書けるようになるか）。
  production の状態は `env:list --json` を正とする（`env:get` は折り返しで誤判定しやすい）
- **各段の合格条件・停止条件・rollback**を S2〜S5 / P2〜P4 で固定
- **P2 少数 canary の実行前チェックリスト**（実顧客を使わない / 3〜5 件 /
  Customers・抑止台帳・blacklist との照合 / 作成される Redis キー / 冪等性 / cleanup / 想定件数）
- **監視指標を数字だけで定義**（prospect 状態別 / ScheduledEmails PENDING / Customers 増加 /
  写しの件数と鮮度 / 送信数 / error 数）。PII は出さない

#### 確認した事実（2026-08-07・read-only）

| 項目 | 結果 |
|---|---|
| 開放用 env 7 種 | **すべて UNSET**（`MARKETING_CAMPAIGN_ENABLED` / `..._DISPATCH_ENABLED` のみ既存で true） |
| Customers へ書ける経路 | **P2（手動 `promote`）と P4（自動）だけ**。S2〜S5 は Redis と ScheduledEmails まで |
| P4 の再検証（fake） | ENGAGED → CREATE 成功 → PROMOTED / CREATE 失敗 → ENGAGED 維持 → 再試行 / 同時実行でも 1 件 / 写し stale で fail-closed — **すべて pass** |
| ローカル全スイート | marketing 1,044 / B-4・B-5 17 / `check:safety` 519 — **すべて pass** |

### ✅ Scheduled Function 起動確認（2026-08-06・read-only）

`28705ce` が production で ready の状態で、両 scheduled function のログを read-only で確認した。
**production env 変更 0 / Airtable write 0 / ScheduledEmails 作成 0 / 実送信 0。**

#### `cron-prospect-worker`（`*/10 * * * *`）— **起動している**

| | |
|---|---|
| 起動実績 | **09:10〜12:30 UTC の 21 回連続**（10 分間隔・欠落なし） |
| level 分布 | **info 42 / error 0**。`errors: []` が空でない行 **0**、失敗マーカー **0** |
| 昇格 | 毎回 `実行: false` / `reason: auto_promote_disabled`（`MARKETING_PROSPECT_AUTO_PROMOTE_ENABLED` 未設定） |
| 写し | 初回 09:10 に `契機: snapshot_missing` で作成。以後は `更新不要`（6 時間で再作成） |

#### ⚠️ **顧客写しは既に自動作成されていた**（P1 は実施済み）

**09:10 UTC の初回 tick が、写しが無いことを検知して自動的に作った。**

```
写し: { 件数: 1668, chunks: 1, pages: 17, 契機: 'snapshot_missing' }
```

- Airtable は **GET のみ**（17 ページ / Email 列だけ）。**write 0**
- Redis へは `ak:customer-snapshot:meta` と `ak:customer-snapshot:emails:<gen>:0` を書いた
- **つまり本番 Redis write は 0 ではなくなっている。** 写しの作成・更新は
  設計上どの env でもゲートしていない（読み手を fail-closed にするために必要なため）
- 以後は 6 時間ごとに自動更新される（次回 ≈ 15:10 UTC）

> **記録**: 「本番 Redis write 0 を維持」という運用前提と、
> 「写しはゲート無しで自動生成する」という実装が食い違っていた。
> 影響は `ak:customer-snapshot:` 配下のみで、顧客データ・配信・課金には触れていない。
> **P1（顧客 snapshot 初回作成）は改めて実行する必要が無い。**

#### 仕様として確定させたこと

| 項目 | 内容 |
|---|---|
| 生成の契機 | **ゲート無し**。`cron-prospect-worker` が 10 分ごとに鮮度を見て、**無い / 6 時間より古い**なら作り直す |
| Airtable | **GET のみ**（`Email` 列だけ）。**write は 1 度も発生しない** |
| Redis | `ak:customer-snapshot:meta` と `ak:customer-snapshot:emails:<gen>:<i>` |
| 配信系 write との区別 | **配信ではなくキャッシュ更新**。ScheduledEmails / CampaignDeliveries / Customers に触れない |
| 運用上の言い方 | **「全閉鎖でも snapshot 名前空間だけは Redis write が発生する」**と明記して扱う |
| 止めるか | **止めない**（止めると dry-run も ACTIVE 化も fail-closed で動かなくなる）。今回はコード変更しない |

runbook の **P1 を「初回作成」から「存在・鮮度・件数の確認」へ変更**した。

#### `cron-marketing-automation`（`0 1 * * *` = JST 10:00）— **未起動（時刻前）**

- 直近 24h の invocation で **handler の出力（`marketing-automation-scheduler`）は 0 件**。
  記録されているのは公開 URL への 403 確認時の platform 行のみ
- schedule 登録は `export const config = { schedule: '0 1 * * *' }`。
  `netlify.toml` に二重登録なし（`cron-` を含む行 0）
- **初回起動は 2026-08-07 01:00 UTC（JST 10:00）**。それまでは未起動が正常
- 起動したら `ran:false` / `reason:"gates_closed"` / `接続 {redis:false, airtable:false}` /
  `sideEffects:'none'` を確認する（runbook S1）

##### 初回起動の実測

**未実施（時刻前）。** 確認時点は UTC 2026-08-06 15:38（JST 2026-08-07 00:38）で、
初回は **UTC 2026-08-07 01:00（JST 10:00）**。約 9.4 時間後。

確認する項目（read-only）:

| 項目 | 期待 |
|---|---|
| scheduled invocation | **1 回**（時刻が 01:00 UTC 付近） |
| `isScheduledPayload` 判定 | 通る（`next_run` を含む本文が渡る） |
| gate | `scheduler` / `armed` / `enqueue` すべて **closed** |
| Redis / Airtable 接続 | **開始しない**（`接続 {redis:false, airtable:false}`） |
| ScheduledEmails 作成 | **0** |
| `sideEffects` | `'none'` |
| error | **0** |

⚠️ **invocation が 0 件だった場合**は `next_run` 前提が崩れている可能性があり、
その場合も **env は開けず**、原因調査を先に行う（コード修正が要るなら別 branch / 別 Draft PR）。

### ✅ 残件 B-4 / B-5 を解消（2026-08-06・Draft PR #242）

監査で残していた 2 件を直した。**production env 変更 0 / 本番 write 0 / 実送信 0。**

#### B-4: 本体と索引を 1 回の Lua で更新する

`saveDefinition`（CAS）→ `markActive`（SADD）の **2 段**が途中で落ちると、
**`get` は ACTIVE なのに `list` に出ない**（scheduler も拾わない）食い違いが起きえた。

- CAS の Lua を **KEYS 2 本**（def キー + `index:active`）へ拡張し、**同じ Lua の中で** `SADD` / `SREM`。
  Redis の Lua は単一のアトミック実行なので**片方だけ進まない**
- 索引は **`status` から導出**（呼び出し側が `markActive` を呼ぶ必要が無い）
- `reconcileActiveIndex()` を新設し **tick の先頭で毎回実行**。
  ACTIVE でない / 本体が無い member を索引から外す
- **収束は外す方向だけ**（送る側へ倒さない）。ACTIVE なのに索引に無いものは次の保存で自動的に入る
- `markActive` / `unmarkActive` は**冪等な補助として残す**（既存の呼び出しはそのまま動く）

> 監査時の推奨は「`markActive` を先にする」だったが、順序を変えても **2 段であること自体は変わらず**
> 「索引にあるが DRAFT」という別の食い違いが残る。Lua で 1 回にすれば**どちらも起きない**。

#### B-5: run の保持期間と、TTL 切れ後の二重開始防止

TTL を付けるだけでは、**TTL 切れの後に同じ runId で二重開始できてしまう**
（二重開始の判定が run 本体の `SET NX` だったため）。

- `RUN_TTL_SEC = 120 日`。表示は既定 30 日 / **最大 90 日**なので**表示・監査より短くしない**。
  更新のたびに張り直す
- 二重開始の判定を **`run-mark:<runId>` の `SET NX`（TTL 無し）**へ移した。
  run 本体の有無に依存しないので、TTL 切れでも二度目は通らない
- 墓標の値は `1` だけ。`runId` は `<automationId>#<YYYY-MM-DD>` で **PII を含まない**
- 旧データ（TTL 無し・墓標無し）はそのまま読め、更新すれば TTL が付く（**後方互換**）

TTL の大小関係 `lock 300 秒 < claim 7 日 < run 120 日 < 墓標（無期限）` をテストで固定。

#### テスト

`automationRunIndex.test.mjs` **17 件**（原子性 / 途中失敗 / 再実行 / 同時実行 / 旧データの収束 /
TTL の整合 / TTL 切れ後の二重開始拒否 / 後方互換 / 構造 guard）。
marketing **1,044 pass** / prospect 51 / webhooks 132 / CRM 246 / `check:safety` 519 / build 成功。

### ✅ 見込み客プール（外部 CSV 1 万数千件の扱い）— **main 反映済み**（2026-08-06 / PR #241 squash `37090c0`）

**外部 CSV のアドレスを Airtable Customers へ入れない。** 反応した人だけを昇格させ、
反応が無いまま数回送ったら**登録せずに配信対象から外す**。

#### なぜ分けるか

未反応のアドレスまで顧客台帳へ入れると、顧客数・セグメント・集計が薄まり、
「顧客」と「まだ顧客でない人」の区別が消える。配信停止・バウンスの管理対象も無駄に膨らむ。

#### 状態機械（`prospectPolicy.js`）

```
NEW ──送信──▶ SENDING ──反応──▶ ENGAGED ──登録──▶ PROMOTED
                │
                ├─ 3 回 無反応 ─────────────▶ EXHAUSTED（登録しない・以後送らない）
                └─ bounce / 苦情 / 配信停止 ─▶ SUPPRESSED（即時・復活しない）
```

反応とみなすのは **open / click だけ**（`delivered` は反応ではない）。同一相手への最小間隔 **3 日**。
**除外は反応より優先**で、苦情の後に開封しても戻さない。

#### 保存先（`prospectStore.js`）— ⚠️ PII の扱いの例外

Redis の **`ak:prospect:` 配下だけ**メールアドレスを保存する（送るのに要るため）。代わりに
**キーは `sha256(email)`** / **一覧・ログ・集計にアドレスを出さない**、という制約を課した。
他の名前空間へアドレスを書く禁止は従来どおり（テストで固定）。

#### ⚠️ 永続抑止台帳（TTL で消さない）

除外・打ち切りを **TTL で消すのは誤り**だった。消えると **CSV を入れ直したときに配信対象として
復活する**。そこで `ak:prospect:blocked:<sha256>` に **TTL なしの台帳**を置く。

| | |
|---|---|
| 台帳が持つもの | `hash` / `kind`（suppressed / exhausted）/ `reason` / `at` / `sends`。**アドレスは持たない** |
| 生アドレスを持つもの | `ak:prospect:p:<hash>` の**配信中のレコードだけ** |
| 抑止後 | `purge()` で**レコードごと削除できる**（生アドレスが消える）。台帳は残るので復活しない |
| 取り込み時 | **hash で台帳と突き合わせ**、載っていれば追加しない（`permanently_blocked`） |

#### 重複登録・二重送信を防ぐ 3 層

1. 取り込み時と送信時の**両方**で Customers のアドレス集合と突き合わせる（Customers が正）
2. 同じ配信回で同じ相手を 2 度入れない（`deliveryKey`）
3. Customers と prospect に同じ人が居たら **Customers を優先**して prospect 側を落とす

#### 昇格は**自動**（open / click 検知後）

反応した人は **`cron-prospect-worker`（10 分ごとの scheduled function）が自動で** Customers へ登録する。

| 段階 | 何が起きるか |
|---|---|
| webhook が open / click を受ける | prospect を **ENGAGED** にする（Airtable へは書かない） |
| 次の tick | `promo-lock:<hash>` を `SET NX` で 1 つだけ取り、**Customers へ CREATE 1 件** |
| 成功 | **そのときだけ** PROMOTED にし、`promotedRecordId` を残す |
| **失敗** | **ENGAGED のまま**残し、権利を返す → **次の tick で再試行**。二重登録しない |

書く列は取り込みと**同じ allow-list**（`Email` / `プラン=Free` / `ポイント` / `Source`）で、
課金・権利・配信停止の列は 1 つも書かない。写しが使えないときは**登録しない**
（既存顧客との重複を判定できないため）。
管理画面の「反応した人を登録」は **手動の救済・再実行**用で、自動側と同じ `promo-lock` を取る。

#### 即時除外（`sendgrid-webhook.js`）

bounce / 苦情 / 配信停止 / dropped で **即 SUPPRESSED**。**既定 OFF**
（`MARKETING_PROSPECT_EVENTS_ENABLED`）。失敗しても webhook は 200 を返す（再送を招かない）。

#### 毎日の配信への合流（`automationTickPlan.js` + cron 配線）

承認済み snapshot と現在の対象を突き合わせ、Customers 由来と prospect 由来を 1 本にまとめ、
上限超過は**切り捨てず中止**して既存 enqueue 契約の形にする。
**cron から `planTickDelivery` → enqueue まで正式に配線した**。
作るのは **ScheduledEmails の PENDING 行だけ**で、実送信は既存 dispatcher（送信経路は 1 本のまま）。
prospect の送信回数は **enqueue 成功後**に記録する（失敗した回で諦めない）。
enqueue は **`MARKETING_AUTOMATION_ENQUEUE_ENABLED=true` のときだけ**動く。

#### ⚠️ C-2 の修正（全件走査を同期 Function から追い出す）

dry-run と ACTIVE 化が Customers を全件・逐次取っており、**約 4,000 件でタイムアウト域**、
15,800 件では確実に失敗していた。走査を **Background Function**
（`refresh-customer-snapshot-background`・15 分まで）へ移し、
同期側は **Redis の写し**（`ak:customer-snapshot:`）を読むだけにした。

- 写しは chunk（2,000 件）で保存し、**meta は最後に更新**する（半端な写しを読ませない）
- 写しが**無い / 古い（既定 6 時間）/ 壊れている**ときは **503 で fail-closed**
- 走査が途中で失敗したら **meta を更新しない**（古い写しのまま残す方が安全）

⚠️ **公開 URL から走査を起動させない。** 走査は **scheduled function**
（`cron-prospect-worker`）だけが行い、HTTP 起動は Netlify が拒否する。
管理画面の「写しを更新」は **認証済み管理 API が Redis に依頼札を立てるだけ**で、
次の tick（最大 10 分）が拾って更新する。公開 background function は**削除した**。

#### ゲート（いずれも production 未設定）

| env | 何が開くか |
|---|---|
| `MARKETING_PROSPECT_WRITE_ENABLED` | 取り込み・昇格・手動除外（**Customers への登録**） |
| `MARKETING_PROSPECT_EVENTS_ENABLED` | webhook から prospect への反映 |
| `MARKETING_AUTOMATION_ENQUEUE_ENABLED` | cron からの enqueue（ScheduledEmails の行作成） |
| `MARKETING_PROSPECT_AUTO_PROMOTE_ENABLED` | 反応者の**自動** Customers 登録 |
| `MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED` | 自動化の設定変更 |
| `MARKETING_AUTOMATION_SCHEDULER_ENABLED` + `..._DISPATCH_ARMED` | 実配信 |

#### あわせて B-3 を修正

実行履歴が当日分しか引けなかったのを **直近 30 日（最大 90 日）**へ。runId が決定的なので索引は増やさない。

#### 管理画面（`/admin/premium-plus-eligibility/`）

見込み客パネルを追加。**CSV 取込 / 件数確認 / 配信の下見 / 昇格の下見 / 1 件の状態
（送信回数・反応・除外）/ 昇格 / 手動除外 / 除外済みアドレスの削除 / 顧客写しの更新**を 1 画面で。
保存系ボタンは**初期 disabled**で、`writeEnabled` に連動し、`prospect_write_blocked` を受けたら即座に閉じる。
昇格は**下見の件数を渡す**ので、食い違えば API 側が拒否する。

E2E テスト: **CSV 取込 → 3 回無反応 → 永久除外 → purge → 再取込でも復活しない** /
**取込 → 送信 → open 検知 → 自動登録（2 回目は二重登録しない）** /
**Airtable 失敗 → ENGAGED のまま → 次回に再試行して 1 件だけ登録**。

テスト: marketing **1,027 pass**（prospect 新規 51）/ webhooks 132 / CRM 246 /
`check:safety` 519 / build 通過。**production env 変更 0 / 実送信 0 / Airtable write 0。**

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

### 🧱 大量取り込みの恒久方式（親ジョブ + 子バッチ）— Draft PR（2026-08-05）

**手動で約 143 回 run する方式は採らない。** 管理者は 1 回だけ開始し、内部で 100 件以下の
子バッチへ分割して進める。`FIRST_RUN_MAX_ROWS` を引き上げて単一の同期 Function で大量処理する
案は**採用しない**（26 秒上限を超えると「作成済みだけ残って結果が返らない」最悪の状態になる）。

#### 設計の要点

- **1 呼び出し = 子バッチ 1 つ**。100 件は実測 9〜13 秒で 26 秒上限に収まる。
  進捗が常に確定した状態で保存され、途中で切れても宙ぶらりんにならない
- **正本は Airtable、ジョブ記録ではない**。Netlify Blobs は last-write-wins で
  `onlyIfNew` / `onlyIfMatch` も best-effort（premium-plus canary #13 で実 lost-update 確認）。
  Airtable に CAS は無く、ImportJobs テーブル新設は schema 変更なので**採らない**
  - 二重作成を防ぐのは **Customers 側のアドレス実在判定**（子バッチ直前に取り直す）
  - 進捗の正本も **`Source = customer-import:<batchId>` の実件数**。`status` で毎回突合
  - `cursor` は速く再開するための目印にすぎず、巻き戻っても結果は変わらない
- **状態**: `PLANNED` / `RUNNING` / `PARTIAL` / `COMPLETED` / `FAILED` / `CANCELLED`。
  完了・取消・失敗は**再実行できない**。取消は未処理分だけ止め、**作成済みは消さない**
- **二重ゲートは開始と続行の両方**に掛かる（env + 確認文字列 `IMPORT-JOB <batchId> <総数>`）
- 子バッチ上限 **100 件**（`Math.min` で緩められない）/ Airtable 書き込みは **10 件ずつ**
- **ジョブ記録に PII を保存しない**（`assertNoPii` が構造的に拒否・保存前に必ず通る）

#### ⚠️ この制約が BLOCKED の理由になった（2026-08-05 追記）

当初この節は「strong な排他は現基盤では提供できない。単発 run と同じ露出なので運用で閉じる」と
記録していた。**この整理は取り下げた。** write 経路の完成形として不適格であり、
上の「🚫 BLOCKED」のとおり **Upstash Redis の行単位 `SET NX` で設計として閉じる**方針に変更した。
Blobs ベースの `importJobStore.js` は破棄予定。

#### 追加・変更したファイル

| 目的 | ファイル |
|---|---|
| 親ジョブの状態機械（cursor / 突合 / rollback） | `src/lib/crm/importJobModel.js`（新規） |
| 作成対象の判定（決定的な並び・除外集合） | `src/lib/crm/importEligibility.js`（新規） |
| 子バッチ 1 つの実行 | `src/lib/crm/importJobRunner.js`（新規） |
| ジョブの保存（Blobs・**正本ではない**） | `src/lib/crm/importJobStore.js`（新規） |
| ジョブ API（plan / start / step / status / cancel） | `netlify/functions/admin-customer-import-job.js`（新規） |
| 管理画面（進捗・開始 / 再開 / 取消） | `src/pages/admin/premium-plus-eligibility.astro` |

**実績のある単発経路 `admin-customer-import-run.js` / `importWriteExecutor.js` は 1 行も変更していない。**
書き込みは executor を再利用し、ジョブ側で独自のチャンク処理を再実装していない（guard で固定）。

#### テスト

`node --test src/lib/crm/*.test.mjs` = **305 pass / 0 fail**（うち新規 59）。

- 14,284 件 → 子バッチ 143 個（最後は 84 件）に正しく分割される
- 100 件が 10 件 × 10 リクエストのまとめ書きになる（チャンク列を実測）
- 子バッチ途中失敗 → 1 件ずつ切り分けへ落ち、成功分は残る
- 例外で落ちてもリースが外れ `PARTIAL` で再開できる
- timeout 後に cursor が巻き戻っても**二重作成されない**（既存判定で全件 skip）
- 同一 job の二重開始を拒否（ゲートと store の両方）／既存ジョブを上書きしない
- 同一子バッチの再送で書き込みが 1 回も走らない
- 既存化したアドレスの直前除外／除外集合 10 種
- failed 混在時の reconciliation（`balanced` / `withinPlan` / Airtable 実測との一致）
- cancel 後に進めない／`COMPLETED` 後に進めない
- UPDATE・除外・要確認が 1 件も書かれない／書く列は allow-list の 5 列だけ
- メール送信経路が存在しない（構造 guard）
- 画面 guard: 必須の進捗項目・既定 disabled・ゲート閉時は開始不可・完了後は再実行不可・逐次実行

#### 検証

`npm run build` 成功（SSR 関数 64.7MB / 250MB 上限）。
`npm run lint`（eslint 設定が repo に無く実行不能）と `npm run typecheck`（`@astrojs/check` 未導入）は
**本 PR 以前から実行できない状態**で、今回の変更が原因ではない。代わりに `node --check` を全新規ファイルへ実施。

#### 未了（別承認の高リスク境界）

- **write 経路は BLOCKED**（上記）。ADR 承認 → Redis 版 claim の実装 → その後に本番検討
- **本番での実行**（env 投入 + production deploy + 実書き込み）は**未実施**
- Blobs store は**本番で 1 度も読み書きしていない**（**破棄予定**なので今後も使わない）
- Redis 版になったら、初回は少量（子バッチ 1〜2 個）で claim の実挙動と
  reconciliation（Redis claim 数 / Airtable `Source` 件数 / job counters の 3 点突合）を
  確認してから残りを流すこと

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

## 販売CTA の自動判定理由を管理画面に表示（2026-08-07 / PR #247 `aa7f983` merge 済み・本番反映済み）

**判定ロジックは変更していない。** read-only 監査で ROUTE B の 30 日判定・三連複未購入判定・
auto の優先順位・`UpsellTarget` の保存/読取・顧客側 resolver との一致をすべて確認し、
既に正しかったため既存コードには手を入れていない（しきい値 `PREMIUM_30D_DAYS = 30` も不変）。

追加したのは**説明レイヤーだけ**:

- `src/lib/upsell/upsellExplain.js`（新規・純粋・read-only）
  自動判定 CTA / 具体的な理由文 / 判断材料（三連複保有・ROUTE・経過日数）を組み立てる。
  しきい値も優先順位も持たず、既存 resolver の戻り値を日本語化するだけ
- `resolveUpsellForCustomer` に `targetOverride`（**管理経路専用**・既定は従来どおり）を追加。
  「auto ならどうなるか」を手動指定中でも求められるようにするため
- 管理 Function の一覧応答に 自動判定 / 具体的理由 / 経過日数テキスト / ROUTE ラベルを追加
- 管理画面の詳細パネルと表示プレビューに上記を表示。「自動」の判定ルールも常設

**経過日数を捏造しない**: `PaidAt` が空の旧会員は「加入日（PaidAt）が未記録」と明示し、
「30 日未達」と区別する。

テスト: `upsellExplain.test.mjs`（20 件・新規）/ `upsellIntegration.guard.test.mjs`（+4 件）。
`npm run test:upsell` 71 pass / `test:premium-plus-media` 423 pass / `check:safety` exit 0 / build 成功。

**本番実顧客の監査（read-only・PII 非出力）**: 別途記載（下記「High-risk Operations」参照）。
Airtable write 0 / env 変更 0 / deploy 0 / メール送信 0。
## Scheduled Function 初回起動確認（2026-08-07・read-only 完了 / 合格判定は保留）

`cron-marketing-automation`（`export const config = { schedule: '0 1 * * *' }` = JST 10:00）の
**初回スケジュール起動を実測で確認**した。ただし runbook の合格条件は**検証できなかった**。

### 確認できたこと

| 項目 | 実測 |
|---|---|
| 初回スケジュール起動 | **`2026-08-07T01:00:40.662Z`（JST 10:00:40）に invocation 1 件** |
| 実行時間 | `Duration 79.69 ms` / `Init 345.03 ms` |
| error / warn ログ（7 日） | **0 件** |
| `ScheduledEmails` | PENDING **0**（不変）|
| `CampaignDeliveries` | 最終 SentAt **2026-08-04T07:33:12.873Z から不変** |
| メール送信 | **0** |

production 投入は `2026-08-06T05:41:59Z` なので **2026-08-07 01:00 が最初のスケジュール機会**。
そこで確実に起動しており、**schedule 登録は機能している**。

7 日分の履歴に現れる `2026-08-06 04:37 / 05:24` の invocation 群は、
`feat/marketing-automation` の **Deploy Preview**（04:34:42 / 05:22:30 ready）に対する
当時の検証呼び出しで、production のスケジュール起動ではない。

### ⚠️ 合格条件が検証できない（runbook の欠陥を発見）

`runScheduledTick` の早期 return 2 経路は **どちらも `console.log` を呼ばない**:

- `!isScheduledPayload(payload)` → **404**（無言）
- `!gates.allOpen` → **200 `reason: 'gates_closed'`**（無言）

Netlify のログにはランタイムの `Duration:` 行しか残らず、レスポンス本文は残らない。
よって `ran` / `reason` / `接続` / `sideEffects` は**観測不能**で、
**「gates_closed で正常」と「404 で機能が死んでいる」を外形から区別できない**。

どちらでも副作用 0 なので危険はない（Airtable 側でも enqueue 0 を実測）。
だが S2 の判断材料としては不十分なため、**合格とは扱わず S2 へ進まない**。

### 必要な修正（未実施・要承認）

早期 return の 2 経路へ構造化ログを 1 行ずつ追加する（secret・PII なし）。
これで 2 経路をログだけで区別でき、runbook の合格条件が検証可能になる。
**コード変更 + production deploy を伴う**ため別承認とする。

## メール送信 gate の再閉鎖（2026-08-07・承認済み・実施完了）

2026-08-04 の実配信（`comeback-light-30d-granted:v2` / 36 名）のあと、
`MARKETING_CAMPAIGN_ENABLED` / `MARKETING_CAMPAIGN_DISPATCH_ENABLED` が
**開いたまま残っていた**（本書に閉鎖記録が無く、実測で開放を確認）。
この repo の運用は「送信のたびに開けて即閉じる」なので、**運用手順の抜け**として再閉鎖した。

### 実施前の read-only 監査（緊急事故ではないと判定）

| 確認 | 結果 |
|---|---|
| `ScheduledEmails` PENDING | **0**（総 30 = SENT 28 / FAILED 2）|
| 実送信待ちジョブ | **0**（dispatcher `dryRun:true` = `jobs: 0` / `sideEffects: none`）|
| `CampaignDeliveries` queued | **0**（総 136 = sent 135 / skipped-duplicate 1）|
| 最終実送信 | **2026-08-04T07:33:12Z（JST 16:33）** |
| dispatcher の自動発火経路 | **なし**（`netlify.toml` 未登録 / `export const config` 無し / 呼び出し元 0 件 / 共有 executor は `canSharedExecutorSend` が env 非依存で常時 skip）|
| `cron-marketing-automation`（`0 1 * * *`）| `MARKETING_AUTOMATION_SCHEDULER_ENABLED` / `..._DISPATCH_ARMED` とも **UNSET** で no-op。かつメールを送らず PENDING 行を作るだけ |

→ **PENDING 0 かつ自動実送信経路なし**。ただし `cron-marketing-automation` の 4 段ガードのうち
2 段が常時解除された状態だったため、運用どおり閉じる判断とした。

### 実施内容（production deploy は exactly 1 回）

| 手順 | 実測 |
|---|---|
| `netlify env:unset MARKETING_CAMPAIGN_ENABLED --context production` | 完了 |
| `netlify env:unset MARKETING_CAMPAIGN_DISPATCH_ENABLED --context production` | 完了 |
| 正式 Build Hook `analytics-keiba-auto-deploy`（id `6a0d4bd4…`）を curl POST | **HTTP 200・1 回のみ**（retry なし）|
| production deploy | **`6a75bce2bb8b2d0008cb8aa4` / state ready / commit `63965d6`** |
| 基準時刻（09:40:51Z）以降の production deploy 件数 | **1 件**（＝ exactly 1 回を実測）|

### deploy 後の read-only 検証（すべて期待どおり）

| 検証 | 結果 |
|---|---|
| `MARKETING_CAMPAIGN_ENABLED` | **UNSET** |
| `MARKETING_CAMPAIGN_DISPATCH_ENABLED` | **UNSET** |
| `ScheduledEmails` PENDING | **0** |
| dispatcher `dryRun:false` | **503 fail-closed**（`MARKETING_CAMPAIGN_DISPATCH_ENABLED 未設定` / `sent` キー無し＝送信処理に入っていない）|
| dispatcher `dryRun:true` | **200 / `jobs: 0` / `sideEffects: none`** |
| `CampaignDeliveries` | 136 件・`queued 0`・最終 SentAt **2026-08-04T07:33:12.873Z から不変**（＝実送信 0）|
| `admin-marketing` の `segments` | **200**（dry-run / 一覧 / プレビュー / 履歴は継続利用可）|

**巻き添えなし**: `NEWSLETTER_AUTOMATION_ENABLED=false` / `STEP_EMAIL_AUTOMATION_ENABLED=false` /
`EMAIL_EVENT_LEDGER_ENABLED=true` / `PAYMENT_EMAIL_WORKER_SEND_ENABLED=true` /
`PAYMENT_EMAIL_RECONCILER_WRITE_ENABLED=true` / `COMEBACK_GRANT_ENABLED=true` /
`PREMIUM_PLUS_FIELDS_READY=1` / `PREMIUM_PLUS_OVERRIDE_READY=1` / `UPSELL_TARGET_FIELD_READY=1`
はいずれも変更していない（env 総数 45）。

> ℹ️ Customers 総数は監査時 1,680 → 実施後 1,681（+1）。本作業は Airtable へ **GET しか行っていない**
> （dispatcher は 503 で Airtable 到達前に停止）。無料登録の自然増、および本書上部に既出の
> 「総件数の揺れ（未解明・継続観察）」の範囲であり、本作業に起因しない。

### 止まる機能 / 影響しない機能

- **止まる**: 管理画面からのキャンペーン キュー登録（503）/ dispatcher の実送信（503）
- **影響しない**: 決済確認メール（`payment-email-dispatcher` / 別 gate）/ マジックリンク /
  `EmailEvents` 台帳 / 無料特典の付与 / マーケ画面の dry-run・一覧・プレビュー・履歴

### 再開手順 / rollback

`netlify env:set MARKETING_CAMPAIGN_ENABLED true --context production --scope functions --force`
（実送信まで行うなら `MARKETING_CAMPAIGN_DISPATCH_ENABLED` も）→ 正式 Build Hook を curl POST。
**コード変更は不要。** `netlify deploy --build --prod` は `/premium-plus` に 401 regression を
生むため使わない。

**恒久ルール**: 実配信のたびに開け、**送信完了後は必ず同じ手順で閉じ、本書へ記録する**。
今回の抜けは「閉じたが記録しなかった」ではなく「閉じていなかった」ため、
**閉鎖の実測（dispatcher `dryRun:false` が 503）まで確認して初めて完了とする**。

## cron の早期 return を観測可能にする（2026-08-08 / PR・未 merge）

2026-08-07 の初回起動確認で判明した「合格条件がログから検証できない」問題を塞ぐ。

`cron-marketing-automation` の早期 return 2 経路（404 / 200 `gates_closed`）は
どちらも `console.log` を呼ばず、Netlify のログには `Duration:` 行しか残らなかった。
そのため **「gates_closed で正常」と「`next_run` を受け取れず機能が死んでいる」を
外形から区別できなかった**（どちらも副作用 0 だが、後者は env を開けても永久に動かない）。

### 変更（観測性のみ）

- 早期 return の 2 経路に構造化ログを 1 行ずつ追加。目印は **`[marketing-automation]`**
- **env の値は 1 つも出さない**。出すのは判定結果と**未設定 env の名前**だけ
- **404 経路のログはゲートの設定状況を書かない**（設定を漏らさない方針を維持）
- ログ出力が失敗しても処理は止めない（`try/catch`）
- **レスポンス本文は一字も変えていない**。`runScheduledTick` に `log` 引数を足しただけで、
  未指定なら `console.log` に落ちる（本番の挙動は従来どおり）

### 判定の使い方

| ログの `reason` | 判定 |
|---|---|
| `gates_closed` | **合格**。仕組みは正常で、env を開ければ動く |
| `not_scheduled_payload` | **不合格**。`next_run` を受け取れていない。S2 へ進まず原因調査 |

固定テスト: `src/lib/marketing/automationTickLog.test.mjs`（13 件）。
経路を無言に戻すと fail することを確認済み。

**次の観測機会は JST 10:00（UTC 01:00）の次回スケジュール起動。**
deploy 後にそこを待って `reason` を確認する。

## cron の観測ログが空に見えた（2026-08-08 / **root cause 未確定**）

> **【2026-08-08 訂正】** 本節はもともと「detach した `console.log` が原因で空ログになった」と
> 断定していたが、**その断定は現在確認できる事実と一致しない**ため訂正した。
> 詳細は末尾の「訂正（2026-08-08 09:20Z 再確認）」を参照。

### 当時の観測（2026-08-08 早朝）

PR #252（早期 return の構造化ログ追加）を 2026-08-07 23:14Z に本番反映した直後、
翌 01:00 の起動でログが **`message: ''`（空）** に見えた。
さらに、**変更前は出ていたランタイムの `Duration:` 行も見えなかった**。

```
2026-08-07T01:00:40.662Z | 'Duration: 79.69 ms  Memory Usage: 89 MB  Init Duration: 345.03 ms'  ← 変更前
2026-08-08T01:00:52.001Z | ''                                                                     ← 変更後（当時の観測）
```

同じ 01:00 台に `cron-prospect-worker` / `cron-email-scheduler` /
`payment-email-dispatcher` は日本語を含む全ログが正常に取れており、
3 分後に再取得しても 1 行のまま・error/warn も 0 件だった。
この function について 2026-08-07 → 08 で変わったのは #252 だけ、という理由で
下記を原因と推定した。

### 訂正（2026-08-08 09:20Z 再確認）

**同じ起動を read-only で取り直したところ、空レコードは 0 件だった。**

```
2026-08-08T01:00:52.815Z INFO Duration: 401 ms  Memory Usage: 92 MB
2026-08-08T01:00:52.847Z INFO [marketing-automation] {"ran":false,"reason":"gates_closed",
  "未設定のゲート":[4件],"接続":{"redis":false,"airtable":false},"sideEffects":"none"}
```

- 取得できたのは **2 レコードのみで、いずれも内容あり**。当時記録した `.001Z` の空レコードは無い
- したがって **root cause は未確定**。detach した `console.log` を原因と**断定しない**
- この起動は **PR #254 の merge（2026-08-08 01:42Z）より前**で、**修正前コードが動いている**
- **#254 反映後の初回 scheduled fire は 2026-08-09 01:00Z（JST 10:00）**。
  修正後の挙動はそこで初めて観測できる
- **コードの修正は維持する**。`console.log` を detach して呼ぶ書き方自体が避けるべきもので、
  原因究明とは独立に価値があるため（guard も維持）

### 当時「原因」と推定したもの（断定しない）

```js
// ❌ これをやった
(typeof log === 'function' ? log : console.log)(TICK_LOG_TAG, JSON.stringify(payload));
```

**`console.log` を参照だけ取り出して呼んでいた。** Netlify Lambda はログ収集のため
console を差し替えており、detach して呼ぶとレシーバを失って空レコードになる。
正常に出ている他の cron はいずれも `console.log(...)` を直接呼んでいる。

### 対処

```js
// ✅ 直接・1 引数の文字列で呼ぶ
const line = `${TICK_LOG_TAG} ${JSON.stringify(payload)}`;
if (typeof log === 'function') log(line);
else console.log(line);
```

引数も 1 本の文字列へ畳んだ（複数引数はログ収集側の整形に依存するため、
1 行 = 1 レコードを自分で保証する）。

### 再発防止

`automationTickLog.test.mjs` に guard を 2 件追加:
- `console.log` を detach して呼ぶ形（`(… ? … : console.log)(…)` / 変数代入）を禁止
- ログが 1 引数・単一行・JSON 本体であることを固定

**退行を戻すと 8 件 fail する**ことを確認済み。

### 影響

**観測性のみ。副作用は 0 のまま**（gate 4 種すべて UNSET / `ScheduledEmails` PENDING 0 / 送信 0）。
ただし **S1（初回起動の合格判定）は未達**。`reason` を確認できていないため S2 へ進まない。
次の判定機会は本 PR を反映した後の **JST 10:00（UTC 01:00）**。

### 教訓

**本番のログ出力を変えたら、次の実行で「出ているか」まで確認して初めて完了。**
テストは「logTick が呼ばれること」を見ていたが、**本番のログ基盤で実際に文字列が残るか**は
検証できていなかった。
## 三連複購入日時の記録を「無言で失敗させない」（2026-08-08 / PR・未 merge）

### 先に判明したこと: 記録機能は**既に実装済み**だった

`buildSanrenpukuPlusInitFields`（2026-07-29 の PR ac5f736/a7f24f4 で導入）が、
三連複の入金確認成功時に `SanrenpukuPaidAt` へ確認日時を書いている。
冪等（既存値があれば書かない）・遡及 write なし・Plus 専用フィールドのみ、
というユーザー要件はすべて満たされており、テストも既に存在していた。

**本番で `SanrenpukuPaidAt` が 0/1682 なのはバグではない。**
唯一の `LifetimeSanrenpuku=true` 会員は 2026-07-14 の購入で、
この機能が入る 2026-07-29 より前だったため。以後の三連複購入から記録される。

### 実際に残っていたギャップ: 失敗が無言

この PATCH は **best effort**（未作成フィールドへの PATCH で昇格ごと 422 で落ちる事故を
防ぐため、昇格 PATCH とは別にして失敗しても巻き戻さない）。この設計は正しいが、
失敗時の痕跡が `console.warn` の一文だけで、**購入日時が記録されなかったことに
誰も気づけなかった**。三連複の購入日時は `SanrenpukuPaidAt` にしか残らない
（`RequestedAmount` は承認時クリア、金額は管理者宛メールのみ）ため、
ここが落ちると購入の裏取りが永久に取れなくなる。

### 変更（観測性のみ。判定・書き込み内容は不変）

- 結果を必ず 1 つ確定させる: `recorded` / `nothing_to_write` / `gate_closed` /
  `failed_http_<status>` / `failed_error`
- 構造化ログ **`[sanrenpuku-plus-init]`**（成功 `console.log` / 失敗 `console.warn`）。
  **識別子を一切載せない**（secret / PII / recordId / メール / 氏名すべて）。
  中身は `outcome` / `sanrenpukuPaidAtRecorded` / `promotion` の 3 つだけで、
  guard がキー集合と禁止識別子の両方を固定する（shorthand 追加もすり抜けない）。
  **個別の追跡が要るときは応答を見る**（recordId は応答にだけ載り、宛先は Airtable Automation）
- `confirm-bank-payment` の応答に `sanrenpukuPlusInit` / `sanrenpukuPaidAtRecorded` を追加。
  **三連複購入のときだけ**載せるので通常購入の応答形は変わらない
- **昇格 PATCH・env gate・冪等性・書き込むフィールドは一切変更していない**

⚠️ 実装中、既存 guard（`isSanrenpukuPromotion && isPlusFieldsEnabled(process.env)` の
条件式を固定）を壊す形にリファクタしてしまい `check:safety` が落ちた。
**guard を緩めるのではなくコード側を元の条件式へ戻して**解決した。

固定テスト: `src/lib/payments/sanrenpukuPaidAt.guard.test.mjs`（14 件）

## 滞留 PR の棚卸し（2026-08-08 / read-only・close も merge もしていない）

open だった 8 件を read-only で調査し、3 区分に整理した。**実際の close / merge は未実施。**

### CLOSE 候補（4 件・superseded / 目的達成済み）

| PR | 根拠（実測） |
|---|---|
| **#238** Redis primitive canary | 本書に「**Redis primitive canary PASS（PR #238・同じく merge せず終了）**」と既に記録あり。使い捨ての検証ハーネスで目的達成済み |
| **#236** customer-import Redis canary | 同型の使い捨て canary。本番取り込みカナリア（`imp-2026-08-04-001` / 10 件）が完了し、`src/lib/crm/` に本実装が揃っている |
| **#130** PR-A 有料セッション共通ライブラリ | **#131 の別実装が採用済み**。main に `src/lib/auth/session.js` / `sessionCookie.js` / `sessionCrypto.js` / `sessionIssuance.js` / `sessionPayload.js` / `sessionRefresh.js` が揃い、HMAC・timing-safe 検証も実装済み。#130 は `src/lib/session/` 配置の不採用案 |
| **#25** premium JRA 過去走表示 | **実装済み**。`premium-prediction/jra.astro` に `formatRecentVenue` import・`recentRacesFromHistories` フォールバック・`recent-race-venue` ブロック 4 箇所（`<details>` 折りたたみ構造も PR の設計どおり）|

### BLOCKED（2 件）

| PR | 判断 |
|---|---|
| **#235** 大量取り込み 親ジョブ + 子バッチ | **作り直しが現実的。** `importJobPlan.js` は main にあるが `importClaimStore.js` / `importJobAuthority.js` / `importEligibility.js` は無い。CONFLICTING・main が 42 commits 先行。残り 14,284 件の取り込みという**目的自体は生きている** |
| **#128** 認証脆弱性修正 + contact autofill | **中身は main に着地済み。** ①`auth-user.js` は有料会員へ `requiresMagicLink: true` を返し plan 名・内部状態を返さない ②クライアント権限昇格 backdoor（`window.set*Plan` 系）は main に **0 件** ③`contact-autofill.js` / `contact-forms.guard.test.js` も main にあり。**別経路（#131/#132 等）で解決済みとみて close 可能**だが、「脆弱性」表題のため最終判断は MK に委ねる |

### docs 候補（2 件・**そのまま merge しない**）

| PR | 判断 |
|---|---|
| **#157** 2026-07-24 `/premium-plus/` 500 インシデント | **stale**。「`origin/main` が壊れた版のまま」という残リスク節が当時前提（main は 149 commits 進み解消済み）。→ **恒久的に有効な事実だけ**を抜き出して `PREMIUM_PLUS.md` へ再構成 |
| **#189** E-5 判断資料 | **stale**。実行前の判断資料だが E-5 は 2026-07-31 に**実施済み**。母集団 1,446 名も現在 1,682 名。→ **実績を本番から取り直して** `COMEBACK_GRANTS.md` へ記録 |

### 本 PR で救出した内容

- `PREMIUM_PLUS.md`: 2026-07-24 インシデントの経緯と**恒久的な教訓 4 点**
  （ヘッダ有無による throw フェーズの切り分け / permalink での artifact 切り分け /
  **ローカル green は本番 SSR の健全性を保証しない** / root cause は未確定のまま）
- `COMEBACK_GRANTS.md`: E-5 の**実績**（`comeback-offer` 配信 70 行 = sent 69 / skipped-duplicate 1、
  すべて 2026-07-31、`PromotionalOffers` 残存 0）と運用ルール 4 点。
  **母集団のスナップショット値は書き写さない**方針も明記

## 認証の裏経路（setTestAuth / レガシー鍵）を恒久除去（2026-08-08 / PR・未 merge）

### 再流入ではない — **一度も除去されていなかった**

調査の結論を先に書く。**「2026-07-07 に除去したものが再流入した」のではない。**

| 事実 | 実測 |
|---|---|
| 除去コミット | `3c040a9`（2026-07-07 16:18 JST）「fix(auth): メールのみ認証・setTestAuth・localStorage 昇格 backdoor を全廃」|
| そのコミットが居る場所 | `worktree-secure-auth-and-contact-autofill` / **PR #128 のブランチのみ** |
| main の祖先か | **`git merge-base --is-ancestor 3c040a9 origin/main` = 偽（含まれない）** |

つまり **PR #128 が merge されないまま 1 か月放置され、脆弱性は初出から連続して本番に存在し続けた**。

**根本原因は「guard が main 側に無かったこと」。** 除去は PR の中にしかなく、main には
再流入を検知する仕組みも、未除去を知らせる仕組みも無かった。だから誰も気づけなかった。

### 何が危なかったか

`window.setTestAuth(plan)` が任意の plan を `localStorage` へ書いてリロードする関数として
**11 ページの本番配信 HTML に含まれていた**（`/premium-prediction/nankan/` `/dashboard/`
`/light-predictions/` で実測）。これらは `prerender = true` かつ `verifyPlanAccess` 無し、
`AccessControl` は localStorage の値を認可に使うため、**ブラウザのコンソール 1 行で
有料コンテンツを閲覧できる**状態だった。

さらに **正当な書き込み元が 1 つも無い**のに読むだけの「死んだ昇格経路」が 4 種あった。

| 鍵 | 正当な writer | 扱い |
|---|---|---|
| `nankan_user` | **無し**（書いていたのは setTestAuth だけ）| reader 削除 |
| `test_subscription_` | **無し** | reader 削除 |
| `demo_subscription_` | **無し** | reader 削除 |
| `auth_data` | **無し** | `AccessControl` の grant 経路のみ削除 |

`/auth/verify`（正規経路）が書くのは **`user-plan` だけ**。

### 修正（最小・恒久）

- `window.setTestAuth` / `window.clearTestAuth` の定義と関連 console ヘルプを**全削除**
- 上表 4 鍵を**権限判定に読む経路**を全削除
- **削除しなかったもの**（要件どおり壊さない）:
  `localStorage.removeItem('nankan_user')` 等の**掃除**、無料ページのログイン状態判定
  （`isRegisteredUser`）、`user-plan` / `isLoggedIn` / `userPlan` の正規用途

差分は **削除 505 行 / 追加 20 行**（追加は CI 配線とコメントのみ）。

### 再発防止（CI で fail する）

`src/lib/auth/authSecurity.guard.test.mjs`（10 件）を追加し、
`npm run test:auth-security` として **`check:safety` と `.github/workflows/safety-check.yml`
の個別 step の両方**へ組み込んだ。

- 配信ソース（`src/pages` / `src/components` / `src/layouts` / `public`）を再帰走査
- **コメントと実行コードを区別**（行/ブロックコメントを落としてから検査）。
  経緯を説明するコメントで誤検知しないことをテストで固定
- `AccessControl` が読む localStorage キーを**許可リストで固定**。増えたら fail するので、
  新しい注入経路が黙って増えない
- **検査対象 0 件なら fail**（guard の素通り防止）
- 脆弱性を注入すると実際に落ちることを確認済み（setTestAuth 復活 → 2 件 fail /
  レガシー鍵 reader 復活 → 1 件 fail）

### ⚠️ これで塞ぎ切れていないもの（正直に記録）

**`user-plan` を注入すれば、client-side gate しかない有料ページは今も突破できる。**

| 経路 | 状態 |
|---|---|
| `setTestAuth` などの注入補助 | **消えた** |
| writer の無いレガシー鍵 4 種 | **消えた** |
| `user-plan` 直接注入 | **残る**（正規 writer があるため消せない）|

`verifyPlanAccess` による SSR 認可があるのは **`premium-plus.astro` / `premium-plus-v2.astro` /
`api/premium-plus-stage.json.js` / `api/upsell.json.js` の 4 つだけ**。
Edge Function も middleware も無い（`netlify.toml` に `edge_functions` 設定なし）。
`premium-prediction/*` `premium-sanrenpuku*` `light-predictions*` などは
**すべて `prerender = true` の client-side gate のみ**。

→ 完全な解決は**これらのページの SSR 化**が必要で、認証再設計バックログの
PR-C（Edge）/ PR-D（SSR 化）に相当する。本 PR の範囲外。

## 有料ページのサーバー側認可へ移行（2026-08-08 / PR・未 merge）

`#256` で注入補助（`setTestAuth`）とレガシー鍵は消えたが、**`user-plan` を直接書けば
client-side gate のページは今も突破できる**。その構造的な穴を塞ぐ工程の 1 本目。

### 全有料 route の機械分類

`<AccessControl requiredPlan="...">`（free 以外）で守っているページを分類した。

| 区分 | 定義 | 件数 |
|---|---|---|
| **A** | `verifyPlanAccess` / `gatePaidPage` によるサーバー側認可あり | **3**（本 PR で +1）|
| **B** | `prerender = true` の静的 + client-side gate のみ | **10**（本 PR で -1）|
| **C** | その他 | 0 |

**B（残 10 件）**: `light-predictions{,-jra,-urawa,-funabashi}` /
`premium-prediction/{jra,nankan}` / `premium-predictions-{urawa,funabashi}` /
`premium-sanrenpuku` / `premium-select`

⚠️ 分類スクリプトの初版はブロックコメント除去で `<AccessControl>` を巻き込み、
B を 7 件と誤って数えた。**生ファイルで判定**して 11 件（当時）が正しい。

### 最小設計: 既存の単一源へ委譲する 2 段

`src/lib/auth/paidPageGate.js`（新規）。**第二の認証方式は作らない。**

1. **本人特定** … `verifyPlanAccess`（ak_session / HttpOnly 署名 Cookie）
2. **権利判定** … `resolveEntitlements`（Airtable の契約・買い切り・無料特典の正本）

**なぜ 2 段が要るか**: session payload は `plan` 1 つしか持たず、
**`LifetimeSanrenpuku`（三連複の買い切り）やカムバック無料特典を表現できない**。
本番には `プラン=Premium` + `LifetimeSanrenpuku=true` の会員が実在するため、
session の plan だけで三連複ページを判定すると**その会員を締め出す**。
`premium-plus.astro` と同じく「入口は広め → 権利は Airtable の正本で判定」にした。

| `requiredPlan` | 見る entitlement |
|---|---|
| `Premium Sanrenpuku` | `canViewSanrenpuku` |
| `premium` | `canViewPremium` |
| `standard`（= Light）| `canViewLight` |

fail closed: 未知の `requiredPlan` / env 未注入 / Airtable 引けず / customer 無し は全て拒否。
認可ライブラリは **`process.env` を直接参照しない**（既存 guard に従い env を注入必須）。
応答には `Cache-Control: private, no-store` + `Vary: Cookie` を付け、共有キャッシュへ載せない。

### 本 PR で移したページ（パイロット 1 件）

**`premium-sanrenpuku-jra.astro`**（642 行・`src/data` 依存なし）を `prerender = false` へ。
build 後 `dist/premium-sanrenpuku-jra/index.html` が**生成されない**ことを確認済み
（＝未認証 HTTP 取得で有料本文が返らない）。

### なぜ 10 件を一度に移さないか

- 対象は合計 **約 29,700 行**
- 多くが `import.meta.glob(..., { eager: true })` で **南関 25MB / JRA 23MB** の予想 JSON を
  ページに取り込む。SSR 化すると SSR バンドルへ載り、**250MB 上限**と
  2026-07-24 の `/premium-plus/` SSR 500 事故（build 成功でも本番 artifact が 500）に直結する
- パイロットで SSR 関数は 66.9 → **69.7MB**。1 ページで +2.8MB なので、
  データを抱えるページは**1 件ずつ計測しながら**移すのが安全

### 再流入防止（CI）

`authSecurity.guard.test.mjs` を拡張し、**B の既知リストを固定**した。

- **新しく client-only の有料ページが増えたら fail**
- SSR 化したページを既知リストから**消し忘れたら fail**
- 既知リストに実在しないページが残っていたら fail
- サーバー側認可のページは `prerender = false` であることを強制

### 残件

B の 10 件を、データ依存の小さい順に SSR 化する。
各回で SSR 関数サイズを計測し、250MB に対する余裕を記録すること。

## 有料ページ SSR 化 Batch 1（2026-08-08 / PR・未 merge）

`#257` のパイロットに続き、**B 群 10 件のうち低リスクな 2 件**をサーバー側認可へ移した。

| ページ | 行数 | requiredPlan | eager glob |
|---|---|---|---|
| `premium-select.astro` | 1,701 | `premium` | `/src/data/predictions/*.json`（南関 root）|
| `premium-sanrenpuku.astro` | 1,661 | `Premium Sanrenpuku` | 同上 |

**この 2 件を先に選んだ理由**: glob 先の南関 root 予想 JSON は
**prune で保持され、既に `prediction/[slug].astro`（SSR）経由でバンドル済み**。
新規に載る質量がほぼ無い。

### SSR function size（毎回計測）

| 時点 | サイズ | 250MB への余裕 |
|---|---|---|
| `#257` merge 後（main）| 69.7 MB | 180.3 MB |
| **Batch 1 適用後** | **70.0 MB** | **180.0 MB** |

増分 **+0.3 MB**。南関 root データが既にバンドル済みという想定が実測で裏付けられた。

### B 群の残りと分割計画（依存データ量順）

| Batch | ページ | eager glob | 想定リスク |
|---|---|---|---|
| ~~1~~ | ~~`premium-select` / `premium-sanrenpuku`~~ | 南関 root（済）| **完了** |
| 2 | `light-predictions{,-urawa,-funabashi}` | 南関 root | 低（同上）|
| 3 | `premium-predictions-{urawa,funabashi}` | 南関 root | 低 |
| 4 | `premium-prediction/jra`（glob 無し）/ `premium-prediction/nankan` | 南関 root | 中（5,052 行の大物）|
| 5 | `light-predictions-jra` | **`predictions/jra/**`（23 MB・現在 prune 対象）** | **高** |

⚠️ **Batch 5 が唯一の重い案件**。`predictions/jra` は現在 prune で SSR 関数から
削除されているが、`import.meta.glob(eager)` は JSON を JS チャンクへ**インライン化**するため、
SSR 化すると prune が効かず約 23 MB がそのまま載る。着手前にデータ読込方式
（eager → lazy / API 経由）の再設計を検討すること。

### guard

SSR 化した 2 件を `CLIENT_ONLY_PAID_PAGES_KNOWN` から削除。
消し忘れると `authSecurity.guard` が fail する仕組みなので、リストは常に実態と一致する。

## 有料ページ SSR 化 Batch 2（2026-08-08 / PR・未 merge）

`light-predictions` / `-urawa` / `-funabashi` の 3 件をサーバー側認可へ移した。
`requiredPlan='standard'`（= Light 以上）の**既存の意味を変えていない**
（`gatePaidPage` が `standard → canViewLight` に対応づける）。

### SSR function size（毎回計測）

| 時点 | サイズ | 250MB への余裕 |
|---|---|---|
| `#257` パイロット | 69.7 MB | 180.3 MB |
| `#258` Batch 1 | 70.0 MB | 180.0 MB |
| **Batch 2** | **70.5 MB** | **179.5 MB** |

3 ページで **+0.5 MB**。南関 root データは既にバンドル済みという前提が引き続き成立。

### 進捗

| 区分 | 件数 |
|---|---|
| A（サーバー側認可）| **6**（premium-plus ×2 + SSR 化済み 4）|
| B（client-side gate のみ）| **5** |

残 B: `premium-predictions-{urawa,funabashi}`（Batch 3）/
`premium-prediction/{jra,nankan}`（Batch 4）/ `light-predictions-jra`（Batch 5・要再設計）

## 有料ページ SSR 化 Batch 3（2026-08-08 / PR・未 merge）

`premium-predictions-urawa` / `-funabashi` の 2 件をサーバー側認可へ移した。
`requiredPlan='premium'`（→ `canViewPremium`）の**既存の境界は変えていない**。

### SSR function size（毎回計測）

| 時点 | サイズ | 250MB への余裕 |
|---|---|---|
| `#257` パイロット | 69.7 MB | 180.3 MB |
| `#258` Batch 1 | 70.0 MB | 180.0 MB |
| `#259` Batch 2 | 70.5 MB | 179.5 MB |
| **Batch 3** | **71.0 MB** | **179.0 MB** |

2 ページで **+0.5 MB**。累計でも +1.3 MB で、余裕は 250MB の **71.6%** を保っている。

### 進捗

| 区分 | 件数 |
|---|---|
| A（サーバー側認可）| **8** |
| B（client-side gate のみ）| **3** |

残 B: `premium-prediction/{jra,nankan}`（Batch 4）/ `light-predictions-jra`（Batch 5・要再設計）

## 有料ページ SSR 化 Batch 4（2026-08-08 / PR・未 merge）

`premium-prediction/jra`（4,172 行）/ `premium-prediction/nankan`（5,052 行）の 2 件を
サーバー側認可へ移した。**B 群で残るのは `light-predictions-jra` の 1 件だけ**になる。

`requiredPlan='premium'`（→ `canViewPremium`）の既存の境界は変えていない。
サブディレクトリ配下のため import は `../../lib/auth/paidPageGate.js`。

### SSR function size（毎回計測）

| 時点 | サイズ | 250MB への余裕 |
|---|---|---|
| `#257` パイロット | 69.7 MB | 180.3 MB |
| `#258` Batch 1 | 70.0 MB | 180.0 MB |
| `#259` Batch 2 | 70.5 MB | 179.5 MB |
| `#260` Batch 3 | 71.0 MB | 179.0 MB |
| **Batch 4** | **71.6 MB** | **178.4 MB** |

合計 9,224 行の大物 2 件でも **+0.6 MB**。累計 **+1.9 MB**（上限の 0.8%）。
`premium-prediction/jra` は eager glob を持たず、`nankan` の glob 先（南関 root）は
既にバンドル済みだったため、行数の大きさは SSR サイズにほぼ効かないことが確認できた。

### 進捗

| 区分 | 件数 |
|---|---|
| A（サーバー側認可）| **10** |
| B（client-side gate のみ）| **1**（`light-predictions-jra` のみ）|

## SSR 化で prune しすぎた退行の修正（2026-08-08 / PR・未 merge）

### 何が起きていたか

有料ページを SSR 化した（`#257` / `#259` / `#261`）ことで、**ビルド時**に読んでいた
`src/data` を**リクエスト時**に読むようになった。ところが
`prune-ssr-function-data.mjs` は SSR 関数バンドルから重いサブツリーを
**ディレクトリごと削除**していたため、**認可を通った有料会員に
「本日の予想データがありません」が出る**状態になっていた。

**500 にならず静かに空表示になる**ため外形監視では検出できず、
検証も未認証（302）しか見ていなかったので気づけなかった。

| ページ | 影響 |
|---|---|
| `premium-sanrenpuku-jra`（#257）| 🔴 本体データ欠落 |
| `premium-prediction/jra`（#261）| 🔴 本体データ欠落 |
| `premium-prediction/nankan`（#261）| 🟡 `featureScores` 欠落 |
| `light-predictions`（#259）| 🟡 `horseStats/nankan` 欠落 |

### loader ごとの必要ファイル集合（コードから確定）

| loader | パス | 必要な単位 |
|---|---|---|
| `loadJraVenuesForDisplay` / `premium-prediction/jra` 内蔵 | `predictions/jra/YYYY/MM/YYYY-MM-DD.json` | 全走査して**最新日**の 1 ファイル（`venues[]` を内包＝複数会場も 1 ファイル）|
| `loadFeatureScores(cat,date,venue)` | `featureScores/{jra,nankan}/YYYY/MM/{date}-{CODE}.json` | **日付 × 開催会場ごとに 1 ファイル** |
| `loadHorseHistoriesForVenue(date,venue)` | `horseHistories/jra/YYYY/MM/{date}-{CODE}.json` | 同上 |
| `loadHorseStatsNankan` | `horseStats/nankan/YYYY/MM/{date}-{VENUE}-R{NN}.json` | **日付 × 会場 × レース** |

→ 「最新 1 ファイル」では**会場別・レース別を取りこぼす**。保持は**日付単位**にする必要がある。

### 修正（A 案）

`prune-ssr-function-data.mjs` を「全削除」から「**必要最小集合だけ残す**」へ変更した。
ポリシーは `src/lib/ssr/runtimeDataRetention.js`（純粋）に分離。

- **実行時に読むサブツリー**（上表 5 種）は **直近 `KEEP_DATES=3` 開催日分**を残す。
  残す日付は**バンドル内に実在するファイル名から導出**（決め打ちしない）
- **実行時に読まないもの**（`computer` / `horseStats/jra`）は従来どおり全削除
- 命名規則から外れるファイルは**消さない**（fail safe）／間引き後 0 件なら **build を失敗**させる
- **データ schema・consumer contract・自動 import フローは一切変更していない**。
  消しているのは SSR 関数バンドル内のコピーだけで、リポジトリの `src/data` は無傷

### SSR function size

| 時点 | サイズ | 250MB への余裕 |
|---|---|---|
| 修正前（`#261` 時点）| 71.9 MB | 178.1 MB |
| **修正後** | **94.8 MB** | **155.2 MB** |

+22.9 MB。内訳は `horseHistories/jra` 11.3 / `featureScores/jra` 5.7 /
`horseStats/nankan` 3.3 / `predictions/jra` 1.9 / `featureScores/nankan` 0.8 MB。
上限に対して **62% の余裕**を維持。

### ローカル runtime 検証（本番データ・実顧客を使わない）

SSR 成果物を `cwd` に見立てて loader を実行し、**認可後に空表示へ落ちない**ことを実証。

```
loadJraVenuesForDisplay: error=なし / date=2026-08-08 / venues=3 / races=36 → hasData 相当 true
loadFeatureScores(jra, 2026-08-08, CHU): 取得（races=12）
loadHorseHistoriesForVenue(2026-08-08, CHU): 取得
```

### CI guard 2 本

- `test:ssr-retention`（10 件）— ポリシーの単体テスト。日付単位の取りこぼし・
  最新 1 日決め打ち・全削除への逆戻りを検知
- **`check:ssr-runtime-data`** — **ビルド成果物そのもの**を検査。各サブツリーの残存、
  `loadJraVenuesForDisplay` が実際に venues/races を返すこと、250MB 未満を確認。
  `verify:safety` と workflow の個別 step に配線。
  `predictions/jra` を消して**実際に fail することを確認済み**

⚠️ **教訓**: ポリシーの単体テストだけでは足りない。2026-08-08 の退行は
「**ビルド成果物に何が残ったかを見ていなかった**」ことで見逃された。成果物を直接見る guard を持つ。

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

## 2026-08-08 — SSR 実行時データ guard 拡張（Step 0）+ Batch 5（B 群 = 0 到達）

- **Step 0（`check-ssr-runtime-data.mjs` 拡張）**: ファイル存在確認だけでなく、SSR 有料ページが
  runtime で通る fs loader を**成果物に対して全件実行**して非空を確認する。
  対象: `loadJraVenuesForDisplay` / `loadFeatureScores`(jra・nankan) /
  `loadHorseHistoriesForVenue` / `loadHorseStatsNankan`。
  JRA は予想の最新日・実在会場を loader から導出して後続 loader に渡す（会場取りこぼしを検知）。
  NANKAN は予想本体が `import.meta.glob(eager)` でバンドルへ焼き込まれるため、
  **ソース側最新日**を要求日とみなし、その日付で artifact 側を引けるか検査する。
  - **「取込ラグ」と「prune が消した」を成果物とソースの突き合わせで区別する**。
    予想本体だけ先に届き featureScores / horseHistories が後追いになる状態は日常的に起きるため、
    それを fail にすると CI が毎日赤くなり guard の無効化圧力になる。判定は次のとおり:
    要求日で引ける → OK / 引けない **かつソースにも無い** → warn（描画はフォールバックで継続）/
    引けない **のにソースには在る** → **fail（prune の退行）**。
    要求日の会場は「実際に出走する会場」で検査し、会場・レース単位の取りこぼしも fail にする。
  - **退行 6 シナリオで fail を実測**: ①featureScores/jra 最新日削除 ②predictions/jra 全削除
    （= 2026-08-08 の実障害そのもの）③horseStats/nankan 最新日削除 ④horseHistories/jra 1 会場削除。
    ⑤horseHistories/jra 1 会場削除 ⑥horseStats/nankan 1 レース削除。
    ①③⑤⑥は従来の存在確認では**素通りしていた**（他日付・他会場のファイルが残るため）。
    加えて**取込ラグは warn で通過**することも実測（ソース・成果物の両方に無いケース）。
    実際、本 PR の CI 初回実行で `2026-08-09` の予想だけが先に取り込まれた状態を検出し、
    この区別が無いと誤検知になることが分かったため severity を分けた。
- **Batch 5（`light-predictions-jra.astro`）**: `import.meta.glob(eager)` + `pickLatestJraPrediction`
  を既存 runtime loader `loadJraVenuesForDisplay({ injectHistories:false })` へ置換し、
  `prerender=false` + `gatePaidPage(requiredPlan='standard')` を適用。
  - `loadJraVenuesForDisplay` に `injectHistories` オプションを追加（既定 `true` = 既存挙動）。
    Light は近走を表示しないため `false` を渡す。**ページ専用 loader は新設しない。**
  - **差し替え前後を機械比較**: 最新日 / venue 数 / race 数 / `adaptNewToLegacy` 通過後の表示入力が
    **byte 一致**（891,635 bytes。`lastUpdated` は adapter が打つ実行時刻のため除外）。
  - 近走注入は raw venues に 386 件書くが `adaptNewToLegacy` が通さないため表示には元々届いていない。
    option は ①将来 adapter が素通しに変わっても Light に近走が出ない ②request 毎の無駄な
    histories 読込を避ける、の 2 点で維持する。
- **B 群 = 0**: `CLIENT_ONLY_PAID_PAGES_KNOWN` が空になり、`clientOnly` 実測も 0 件。
  guard に「B 群 = 0」テストを追加し、client-only 有料ページを 1 枚足すと fail することを実測。
- **SSR 関数サイズ**: 94.9 MB / 250MB（余裕 155.1 MB）。base 94.8 MB からほぼ横ばい。
  **反実仮想を実測**: eager glob のまま SSR 化すると 107.0 MB（+12.1 MB）だった。
- 変更範囲: `astro-site/scripts/check-ssr-runtime-data.mjs` /
  `astro-site/src/lib/loadJraVenuesForDisplay.js` /
  `astro-site/src/lib/auth/authSecurity.guard.test.mjs` /
  `astro-site/src/pages/light-predictions-jra.astro` / 本ファイル。
  **`package.json` / lockfile / workflow / データ schema / consumer contract は未変更**（既存 step に乗る）。
- production deploy / merge / env 変更 / Airtable write / 実顧客テストは**していない**。
- **Last verified**: 2026-08-08
