# Customers の重複レコード整理

同じメールアドレスの Customers が 2 件あると、`auth/customerLookup` が **CONFLICT として
fail closed でログインを拒否**する。重複の解消は、その人のログインを取り戻す作業でもある。

## 1. 監査（read-only）

2026-08-12 実施。**Customers 15,971 件 / 一意アドレス 15,961 件 / 重複 10 アドレス・20 レコード。**

| 取り込みバッチ | 作成件数 |
|---|---|
| `imp-2026-08-09-001` | 14,279 |
| `imp-2026-08-05-003` | 100 |
| `imp-2026-08-04-002` | 100 |
| `imp-2026-08-04-001` | 10 |
| 合計 | **14,489** |

> **重要**: 重複 10 アドレスのうち、**CSV 取り込み由来のレコードは 0 件**。
> 10 組とも取り込み以前から存在した重複で、**取り込みは重複を 1 件も作っていない**
> （取り込みは既存アドレスを UPDATE 扱いにし、CREATE しない設計）。

## 2. どちらを残すか（判定順）

1. **権利・課金・意思表示の値が多い方**を残す
   （有効期限 / PlanType / PaymentConfirmed / PaidAt / LifetimeSanrenpuku /
   LightGrant* / Requested* / Unsubscribed* / WithdrawalRequested / PremiumPlus* / 最終ログイン …）
2. 同点なら **`CampaignDeliveries` / `PromotionalOffers` から参照されている方**
3. それも同点なら **作成が古い方**

## 3. 削除してよい条件（1 つでも外れたら skip）

- 残す側が実在し、**同じメールアドレス**である
- 削除側に上記の値が **1 つも無い**
- 削除側のポイントが既定値（**1**）以下
- 削除側のプランが残す側より強くない

## 4. 参照整合性

| 参照元 | 参照の仕方 | 削除の影響 |
|---|---|---|
| `CampaignDeliveries.CustomerRecordId` | recordId（文字列） | 削除側を参照する行があれば **skip**（監査時点 0 件） |
| `PromotionalOffers.CustomerRecordId` | recordId（文字列） | 同上（監査時点 0 件） |
| `CampaignDeliveries.RecipientEmail` | メールアドレス | 残す側が同じアドレスなので**壊れない** |
| `AuthTokens.Email` | メールアドレス | 同上 |
| `EmailBlacklist.Email` | メールアドレス | 同上 |
| `ScheduledEmails.Recipients` | メールアドレス | 同上 |
| `EmailEvents` | Blob（`emailHash` / `customerRecordId`） | 監査用の append-only ログ。過去行は書き換えない |

## 5. ポイント残高がある組の扱い

### 「ポイント」を書く経路（2026-08-12 全数監査）

| # | 経路 | 更新式 | 種類 |
|---|---|---|---|
| 1 | `netlify/functions/daily-points.js`（AK） | `'ポイント': currentPoints + pointsToAdd`（free +1 / standard +10 / premium +30）を**全 Customers レコードに対して**実行 | 加算 |
| 2 | `netlify/functions/auth-user.js`（AK） | 新規作成時のみ `'ポイント': 1` | 作成時のみ |
| 3 | `src/lib/crm/importWritePlan.js`（AK） | CREATE 時のみ `'ポイント': 0` | 作成時のみ |
| 4 | `nankan-analytics/netlify/functions/daily-points.js` | AK と同じ加算式。**同じ Base `apptmQUPAlgZMmBC9` を共有** | 加算 |
| 5 | `nankan-analytics/netlify/functions/auth-user.js` | 新規作成時 `'ポイント': 1` | 作成時のみ |
| 6 | `nankan-analytics/netlify/functions/send-magic-link.js` | 新規作成時 `'ポイント': 0` | 作成時のみ |

**消費・減算の経路は存在しない。**
`point-exchange.js` / `claim-reward.js` は申請メールを送るだけで Customers のポイントを引かない
（`claim-reward.js` が書くのは `特典申請済み` のみ。しかもこの列は現行 schema に無い）。
管理画面からのポイント更新経路も無い（`admin/point-exchange-requests.astro` は表示のみ）。
Airtable Automation でポイントを書くものは docs / repo からは確認できない。
git 履歴上、ポイントを書いていた（削除済み含む）Function は `daily-points.js` / `auth-user.js` だけ。

### 二重付与を「証明」できるか

できない。理由:

- 付与は**レコード単位**なので、重複していた期間は二重に付与されうる（＝差の一部は二重計上）
- しかし残高の内訳を復元する**台帳が存在しない**（`PointHistory` 相当のテーブルは無く、
  `PointExchangeRequests` は申請の記録で残高の履歴ではない）
- 付与元が **AK と nankan-analytics の 2 系統**あり、どちらがいつ動いたかを repo から確定できない
  （どちらも cron 未登録で、過去の稼働実績を追えない）
- 実データも「同じ付与を二重に受けた」形になっていない（後述の 3 組を参照）

→ **証明できない場合は削除しない。** ポイントを失わせない側へ倒す。

### どうしても消す場合の唯一の方法（値を固定した個別許可）

汎用の「ポイント無視」オプションは**作らない**。対象ファイル側で組ごとに宣言する:

```json
{
  "id": "recXXXX", "keepId": "recYYYY", "email": "a@example.com",
  "pointsPolicy": "max_keep_wins",
  "expectedDeletePoints": 102,
  "expectedKeepPoints": 1230
}
```

実行直前に**実値と完全一致**しなければ skip する（1 点でも動いていたら止まる）。
さらに `正本 >= 削除候補` を実値で再確認する（最大値採用が成り立たない組は消せない）。

## 6. 実行

```bash
# dry-run（既定。1 バイトも書かない）
AIRTABLE_API_KEY=... node scripts/dedupe-customers.mjs \
  --targets targets.json --expect 7 --export rollback.json

# 実削除（承認後）
AIRTABLE_API_KEY=... node scripts/dedupe-customers.mjs \
  --targets targets.json --expect 7 --export rollback.json --execute
```

- `--targets` … `[{ id, keepId, email }]`。**コマンドラインで即席に指定できない**
- `--expect` … 件数が一致しなければ中止
- `--export` … 削除前の完全な中身を保存。**書けなければ中止**
- 削除直前に 1 件ずつ再検証し、条件から外れていれば skip
- 既に削除済み（403 / 404）は失敗ではなく完了として数える（**再実行安全**）

## 7. rollback

`--export` のファイルに削除前の全フィールドが入っている。
Customers へ `fields` をそのまま create すれば内容は戻る。
**ただし recordId は新しくなる**ため、recordId 参照（`CampaignDeliveries.CustomerRecordId` /
`PromotionalOffers.CustomerRecordId`）は復元されない。
→ 参照がある行は**そもそも削除しない**（上の条件）ので、実害は無い。

検証: `node --test scripts/dedupeCustomers.test.mjs`
