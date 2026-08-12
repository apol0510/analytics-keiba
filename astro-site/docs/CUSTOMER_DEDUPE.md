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

## 5. 統合できる項目（**自動では移さない**）

ポイント残高だけは削除で失われる。移すかどうかは運用判断なので、
**スクリプトは 1 点も移さず、残高がある組は `review` に落とす**。

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
