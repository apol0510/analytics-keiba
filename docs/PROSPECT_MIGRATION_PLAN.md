# CSV 取り込み分を prospect プールへ戻す 移行計画

**状態: 本番可能状態まで完成。本番の write は 1 件も実行していない。**
更新 2026-08-27 ／ 数字はすべて本番の read-only 実測。

> **8/31 より前に移す。** Airtable は上限超過中で、現行経路のまま 2 通目を送ると
> `CampaignDeliveries` が **+6,308 行**増える（§8）。移行後は **0 行**。

| 停止境界 | 状態 |
|---|---|
| 本番 Redis への大量書き込み（prospect 投入）| **未実行** |
| **Customers の削除** | **未実行** |
| production env の変更（`MARKETING_DELIVERY_STORE` 等）| **未実行** |
| 実送信 / queue 登録 | **未実行** |

進捗と次作業は `docs/progress.md` 2026-08-27 の項が正本。
確定仕様は `docs/spec.md`「外部 CSV は prospect プールで扱う」、
判断の記録は `docs/decisions.md` 2026-08-27 の 5 項。

---

## 1. 正本の方針（`prospectPolicy.js`）

> 外部 CSV の 1 万数千件を**そのまま Airtable Customers へ入れない**。
> 反応が無いアドレスまで顧客台帳に混ぜると、顧客数・セグメント・集計が薄まり、
> 「顧客」と「まだ顧客でない人」の区別が消える。
> **1 回でも反応した人だけ**を Customers へ昇格させ、無反応なら登録せずに外す。

```
NEW ──送信──▶ SENDING ──反応──▶ ENGAGED ──登録──▶ PROMOTED
                │
                ├─ **delivered ≥ 10 かつ 開封 0** ──▶ EXHAUSTED（登録しない）
                └─ bounce / 苦情 / 配信停止 ──────▶ SUPPRESSED（即時）
```

置き場所は `ak:prospect:` 名前空間（**AK で唯一アドレスの保存を許した領域**。
キーは `sha256(email)`、一覧・ログ・集計にアドレスを出さない、`purge()` で生アドレスごと消せる）。

## 2. 実際に起きたこと（方針との差分）

| | 正本の方針 | 実際 |
|---|---|---|
| CSV の置き場所 | prospect プール（Redis）| **Airtable Customers へ直接 CREATE** |
| 昇格の条件 | 反応した人だけ | （昇格の概念を通っていない）|
| 無反応の扱い | 打ち切って登録しない | Customers に残り続ける |
| 使った経路 | `admin-marketing-prospect` / `cron-prospect-worker` | `admin-customer-import`（別に作られた経路）|

**prospect プールは一度も使われていない。** 本番実測（管理 API `status`）:

```
送信候補 0 ／ 反応済み未登録 0 ／ 永久除外 0 ／ writeEnabled: false
```

## 3. 打ち切りは **delivered 10**（2026-08-27 確定 / 旧「送信 3 回」は廃止）

**確定仕様**: CSV 取り込み由来だけ、

> **累計 delivered ≥ 10** かつ **open = 0** かつ **購入・ログイン等の本人の反応が無い**
> → 以後の通常マーケティング配信から自動除外する

| 数える | 数えない |
|---|---|
| 配信成功（`delivered`）| enqueue（キュー登録）/ send attempt（送信試行）/ 弾かれた回 |

⚠️ **`MAX_SENDS_WITHOUT_ENGAGEMENT = 3` は定数ごと削除した。** 復活させない。
3（送信回数）と 10（delivered）の二重基準が残ると、どちらで切れたのか説明できない。

⚠️ 現在の割引メールは 3 通構成なので、**1 キャンペーンでは 10 通に届かない**
（＝このキャンペーンだけでは誰も打ち切られない）。これは意図どおり。

| 何 | どこ |
|---|---|
| 判定の単一源 | `src/lib/marketing/prospectEngagement.js` |
| 数字の正本 | `src/lib/marketing/engagementPolicy.js` |
| 打ち切りが起きる唯一の場所 | `applyDelivered()` / `prospectStore.recordDelivered()` |

## 4. 対象件数（本番 read-only 実測 2026-08-27）

Customers **15,976 件**。母数と判定の合計は一致（取りこぼしなし）。

| 判定 | 件数 |
|---|---:|
| **prospect へ戻す** | **12,872** |
| 取り込み由来でない（残す）| 1,487 |
| **本人が動いた**（購入・申込・入金・ログイン。残す）| **49** |
| **運営側の付与だけ**（保留・消さない）| **1,566** |
| 由来不明の値あり（保留・消さない）| 0 |
| 配信停止・バウンス・退会（いまは残す）| 2 |
| 反応があった（残す）| **未適用**（§6-1 参照）|

⚠️ 旧版は運営側の付与を「顧客になった」に数えて **1,615 件**としていた。
分離して数え直すと **本人が動いたのは 49 件**、残る **1,566 件は運営側の付与だけ**。
**1,615 は確定値ではない。**

取り込みバッチ別:

| バッチ | 移す | 残す（うち保留）|
|---|---:|---|
| `imp-2026-08-09-001` | 12,669 | 1,610（1,559）|
| `imp-2026-08-05-003` | 100 | 0（0）|
| `imp-2026-08-04-002` | 94 | 6（6）|
| `imp-2026-08-04-001` | 9 | 1（1）|

判定の単一源は `marketing/prospectMigrationPlan.js`（純粋）。**迷ったら残す**。

## 5. 移行は 9/6 を待たない（parity を先に証明する）

Airtable は既に上限超過（§8）で、待つほど危険が増す。
そこで **8/31・9/6 の配信を壊さずに早期移行できる状態**を作った。

| 部品 | 役割 |
|---|---|
| `prospectSequenceAdapter.js` | prospect を**取り込みが Customers へ書いたのと同じ `fields`** へ復元 |
| `prospectSequenceHydration.js` | Redis 台帳・反応・除外を配信の入力へ復元 |
| `prospectAudienceSource.js` | **prospect プールから受信対象を作る**（移した瞬間に配信が止まらない）|
| `prospectIntakePlan.js` | Customers → prospect の**引き継ぎ内容**と投入の安全条件 |
| `sequenceParity.js` | 2 経路の突合（差分 0 でなければ移行しない）|

比較する 5 点（**1 つでも差があれば移行しない**）:

1. いま送れる相手（due）の集合
2. 相手ごとの次の step
3. 相手ごとの **`DeliveryKey`**（変わると二重送信）
4. 止めた相手の停止理由
5. 相手ごとの **delivered 回数**（打ち切り判定の分母）

⚠️ **鍵と delivered を突き合わせていない parity は合格にしない**
（`keysChecked` / `deliveredChecked` が false なら必ず不合格）。
⚠️ Redis 台帳を**読めなかった**ときは中止する（未送信と見なすと全員へ再送する）。
⚠️ prospect の**索引**を読めなかったときも中止する（0 人と見なすと 2 通目が黙って止まる）。

判定を新しく作らず既存の `resolveCustomerMarketing()` → `buildSequenceProgress()` を
通すので、parity は「合わせ込み」ではなく**構造的に**成立する。

### 本番実測の parity（2026-08-27 / read-only・全 12,872 名）

| 比べたもの | 差分 |
|---|---:|
| 対象のみ片側 | **0** |
| due のみ片側 | **0** |
| 次 step 不一致 | **0** |
| 状態不一致 | **0** |
| 停止理由不一致 | **0** |
| DeliveryKey 不一致 | **0** |
| delivered 不一致 | **0** |

**8/31 09:00 JST 時点の 2 通目**も両経路で完全一致:

| | Customers 経路 | prospect 経路 |
|---|---:|---:|
| due 合計 | 6,308 | **6,308** |
| うち step2 | 5,980 | **5,980** |
| 片側だけ | 0 | **0** |

⚠️ `DeliveryKey` は送信元アドレスを材料に含む。実送信と同じ
`getBrandConfig(BRAND).defaultFromEmail`（`noreply@keiba.link`）で計算しないと
鍵が変わり、**既送信を 1 件も照合できず「全員未送信」と誤判定する**（実際に一度そうなった）。
`SENDGRID_FROM_EMAIL`（`support@keiba.link`）ではない。

### 打ち切り（delivered 10）はいま誰にも当たらない

全 Customers の delivered 回数（`Status='sent'` の行数）は **最大 5 通**。
**10 通以上は 0 名**（5 通以上は 694 名）。したがって開封の集計が無くても
**parity は影響を受けない**（どちらの経路でも engagement では 1 人も止まらない）。

開封の集計が要るのは「開封した人を Customers へ残す」判定の側だけ。

## 6. 🔴 実行前に必ず埋める穴

### 6-1. 反応（開封）の一覧が計画に入っていない

開封の記録は Redis にあり、手元からは読めない（本番 env の値はマスクされる）。
**反応した人は本来 Customers へ残す（昇格対象）** なので、一覧を当てずに実行すると
**開封した人まで prospect へ落としてしまう**。

下見スクリプトは一覧が無いと `engagementApplied: false` を記録する。
**`false` のまま実行しないこと。**

### 6-2. 反応の集計は**本番からしか読めない**

`ak:mkt:eng:v1` は Redis にあり、`UPSTASH_REDIS_REST_URL` / `..._TOKEN` は
**production コンテキストにしか無く、ローカルでは masked**（`****`）。
Deploy Preview にも無いので、preview から呼んでも `redis_not_configured` になる（実測）。

読むための read-only 経路は用意した（`admin-marketing?action=engagementDigest`。
**hash だけを返しアドレスは出さない**）が、**production へ deploy しないと呼べない**。

| 選択肢 | 影響 |
|---|---|
| A. この PR を merge して production へ出し、digest を読む | production deploy が要る |
| B. Redis env を deploy-preview へ足す | **production env 変更＋認証情報の露出**。推奨しない |
| C. 開封を当てずに移す | **開封した人まで prospect へ落とす**。投入側が fail closed で拒否する |

⚠️ C は選べない。`planProspectIntakeFromCustomers()` は集計が無いと**1 件も作らない**。

## 7. 手順（承認後に実行する）

| # | 作業 | 書き込み | 停止条件 |
|---|---|---|---|
| 1 | 反応の一覧を作る（管理 API 側で開封記録を突合）| なし | 一覧が空なら中止 |
| 2 | 下見をやり直す（`engagementApplied: true`）| なし | 母数≠合計 なら中止 |
| 3 | prospect 側 enqueue を配線（台帳は Redis 限定）| コード | ✅ 完了 |
| 4 | **全件 parity**（Customers 経路 vs prospect 経路・差分 0）| なし | ✅ 差分 0（§5）|
| 5 | prospect プールへ投入（`prospectIntake`）| **Redis** | ← **ここで停止し、改めて承認を取る** |
| 6 | 投入後に**再 parity**（差分 0）| なし | 差分 1 件でも中止 |
| 7 | 抑止台帳へ hash を引き継ぎ、載ったことを読み直す | **Redis** | 1 件でも載らなければ中止 |
| 8 | 削除前の全フィールドスナップショット | なし（ローカル）| 取れなければ中止 |
| 9 | **Customers から削除** | **Airtable** | ← **ここで停止し、改めて承認を取る** |
| 10 | 削除後の検証（残件数・配信継続・実績表示）| なし | — |

**5 と 9 は別承認。** 5 まで済ませても Customers は無傷なので、いつでも引き返せる。
**Customers を先に削除しない。**

## 8. Airtable の上限は Customers 削減だけでは解決しない

本番実測 2026-08-27（全 13 table）:

| table | 件数 |
|---|---:|
| **CampaignDeliveries** | **33,112** |
| Customers | 15,976 |
| ScheduledEmails / EmailBlacklist / AuthTokens / StepEnrollments ほか 9 table | 1,701 |
| **合計** | **50,789 / 上限 50,000（Team）＝ 超過中** |

増加の主因は Customers ではなく**配信台帳**。本番の `MARKETING_DELIVERY_STORE` は
いま **`dual`**＝Airtable にも書き続けている。

| 配り方 | Airtable の増加 |
|---|---:|
| 12,872 名 × 2 step を **Customers 経路**で配る | **+25,744 行** |
| 同じ人数を **prospect 経路**で配る | **0 行** |

**決めたこと**: prospect（CSV 由来）の配信台帳は **Airtable へ書かない**。
env のモードに関わらず構造的にそうする（`resolveRecipientLedgerPolicy()`）。
読みは従来どおり和集合（移行途中の既送信を見落とさないため）。

⚠️ 出所が書かれていない受信者は **customer 扱い**（prospect へ倒すと台帳が消える）。
⚠️ `DeliveryKey` の作り方は変えない。
容量の全体設計は `docs/AIRTABLE_CAPACITY.md`。

## 9. 巻き戻し

- **手順 5 まで**: prospect 側を `purge()` で消すだけ。Customers は無傷
- **手順 9 のあと**: 保存した計画（recordId + Email + Source）から Customers へ再 CREATE。
  下見で**巻き戻しに必要な項目が 12,872 件すべてそろっている**ことを確認済み
- ⚠️ 再 CREATE では `登録日`（createdTime）が変わる。**元の登録日は復元できない**ため、
  削除前に全フィールドのスナップショットを取る（手順 8）

## 10. 配信停止・バウンス・退会の扱い

`keep_suppressed`（2 件）は「**いま消さない**」であって恒久保持ではない。

| 役割 | 置き場所 | 生アドレス |
|---|---|---|
| 「もう送らない」の正本 | `EmailBlacklist`（Airtable）| 持つ |
| 「再取り込みで復活させない」| `ak:prospect:blocked:<sha256>`（Redis・TTL なし）| **持たない** |

**順序を逆にすると復活する**: 台帳へ hash を書く → 読み直して確認 → そのあと生アドレスを消す。
`canPurgeRawEmails()` が確認できるまで削除へ進めない（台帳を読めない場合も 1 件も消さない）。

## 11. 移行後の姿

| | 移行後 |
|---|---|
| Customers | 約 3,100 件（顧客・保留・取り込み由来でない人だけ）|
| prospect プール | 約 12,872 件（アドレスは `ak:prospect:` にのみ）|
| 配信 | prospect パイプライン経由。delivered 10 通・開封 0 で自動打ち切り |
| 配信台帳 | prospect 側は **Redis のみ**（Airtable の行は増えない）|
| 昇格 | 反応した人だけ Customers へ CREATE（`cron-prospect-worker`）|
| 反応なし除外 | prospect の打ち切りに一本化（Customers 側の除外は既存顧客だけに残る）|

## 12. まだ決まっていないこと

1. 実績可視化を prospect 経路へどう出すか（同じ画面に並べるか、分けるか）
2. `review_operator_grant` 1,566 件を最終的にどちらへ寄せるか（**急がない**・消さない）
3. `MARKETING_DELIVERY_STORE` を `dual` → `redis` へ切り替えるか
   （切り替えれば Customers 経路の増加も止まる。**production env 変更＝停止境界**）


## 13. 投入のやり方（承認後）

投入は **admin Function の 1 アクション**で、**Customers を 1 件も消さない**。

```
POST /.netlify/functions/admin-marketing
{ "action": "prospectIntake", "campaignId": "campaign-discount-free",
  "offset": "<前回の nextOffset>", "apply": true, "confirm": "MIGRATE PROSPECTS" }
```

`apply` を省けば**下見**（1 バイトも書かない）。書き込みが起きるのは **4 つ全部**が
そろったときだけで、1 つでも欠ければ下見の結果だけを返す:

| # | 条件 | 満たさないと |
|---|---|---|
| 1 | `PROSPECT_MIGRATION_ENABLED=true`（env）| `write_disabled` |
| 2 | `confirm` が一致 | `not_confirmed` |
| 3 | 反応（開封）の集計が**読めている** | `engagement_unavailable` |
| 4 | **そのページの parity が差分 0** | `parity_not_proven` |

- 1 回 **300 件**ずつ。`nextOffset` を渡して続きから（全件走査しない）
- 既に居るアドレスは**上書きしない**（`addIfAbsent`）。抑止台帳の相手は復活しない
- 既送信の `DeliveryKey` はそのまま台帳へ入れ、**読み戻して確かめる**（`unverified` を返す）
- 応答は**件数だけ**（アドレスも recordId も出さない）

### 引き継ぐ内容

| 引き継ぐもの | どこから |
|---|---|
| `sends`（試行）| その人の `CampaignDeliveries` 行数（`sent` + `queued`）|
| **`delivered`** | **`Status='sent'` の行数だけ**（`queued` は数えない）|
| `lastSentAt` | `SentAt` の最大値（次 step の間隔計算に使う）|
| `opens` / `clicks` | 反応の集計に hash が載っているか |
| 既送信の `DeliveryKey` | その人の行にある鍵を**そのまま** |

### 投入後にやること（Customers 削除の前）

1. **再 parity**（差分 0）
2. 抑止台帳へ hash を引き継ぎ、**載ったことを読み直す**
3. 削除前の**全フィールドスナップショット**
4. → **ここで改めて承認を取る**（削除は別工程）
