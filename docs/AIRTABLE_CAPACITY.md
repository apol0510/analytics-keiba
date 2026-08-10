# Airtable レコード上限と、配信履歴の置き場所

**本書は「Airtable に何を置き、何を置かないか」の正本。** 2026-08-09 に Team 上限
50,000 件を超過（実測 50,456 件）したときの調査と、恒久構成の設計を記録する。

検査: `npm run check:airtable-capacity`（read-only。認証が無ければ skip）

---

## 1. 現在の内訳（2026-08-09 実測 / 全 12 table）

| table | 件数 | 比率 | 性質 |
|---|---:|---:|---|
| **EmailEvents** | 18,793 | 37.2% | append-only テレメトリ |
| **Customers** | 15,970 | 31.7% | **正本**（人が扱う） |
| **CampaignDeliveries** | 14,416 | 28.6% | 冪等性の台帳 |
| EmailBlacklist | 346 | 0.7% | suppression（**正本**） |
| StepEnrollments | 342 | 0.7% | 運用 |
| AuthTokens | 324 | 0.6% | 短命 |
| ScheduledEmails | 174 | 0.3% | ジョブ（完了後は履歴）|
| PromotionalOffers | 74 | 0.1% | 正本 |
| PointExchangeRequests | 7 | 0.0% | 正本 |
| CampaignDeliveries_M5A3LiveTest | 6 | 0.0% | 試験残骸 |
| CampaignDeliveries_MarketingAutomation | 4 | 0.0% | **KMA 側**（AK は触らない）|
| ProcessedWebhookEvents | 0 | 0.0% | 空 |
| **合計** | **50,456** | | 上限 50,000 に対し **+456** |

**上位 3 table で 97.5%。** うち Airtable でなければならないのは Customers だけ。

## 2. 最大の増加源は「配信 1 回」

| table | 2026-07 | 2026-08 | 備考 |
|---|---:|---:|---|
| Customers | 23 | 14,519 | 大半は一度きりの外部リスト取り込み。**自然増は月 20〜100 件** |
| CampaignDeliveries | 71 | 14,345 | 配信 1 回で受信者数ぶん |
| EmailEvents | 0 | 18,793 | **最古が 2026-08-02**。8 日で 18,793 件 |

`EmailEvents` は **open / click を重複排除しない**（`buildEventKey` のコメント:
「同じ人が 3 回開いたら 3 行」）。したがって受信者数に比例せず、**開封のたびに増える**。

### 14,279 名へ 1 回送ると何件増えるか（コードから算出・実測で裏付け）

| 生成物 | 件数 | 根拠 |
|---|---:|---|
| CampaignDeliveries | 14,279 | 受信者 1 人 1 行（`DeliveryKey` upsert）|
| ScheduledEmails | 143 | `RECIPIENTS_PER_JOB = 100` |
| EmailEvents `delivered` | 13,956 | 実測 |
| EmailEvents `bounce` / `dropped` | 336 | 実測 |
| EmailEvents `open` | **5,600〜12,600** | delivered × 0.4〜0.9（下記）|

open 倍率の根拠: 今回の配信は送信 10 時間後で 4,093（×0.29）とまだ増加中。
6 日経過した `comeback-light-30d-granted:v2` は 55/64 = **×0.86**（ただし n=64 と小さい）。

| 見積り | 1 配信あたり |
|---|---:|
| 楽観（open ×0.4）| **34,296 件** |
| 中位（open ×0.6）| **37,088 件** |
| 悲観（open ×0.9）| **41,274 件** |

**固定分（Customers + 運用系）は 17,243 件。Team の残り 32,757 件では 1 回も入らない。**

## 3. API 呼び出し（100,000 calls/月）も同時に効いてくる

| 内訳 | 概算 calls |
|---|---:|
| 配信結果 PATCH（**受信者ごとに 1 回**）| 14,279 |
| CampaignDeliveries upsert（10 件/回）| 1,428 |
| ScheduledEmails 作成 | 143 |
| enqueue の名指し読み（29 バッチ）| ~1,972 |
| dispatch の再検証読み | ~4,290 |
| Event Webhook の書き込み | ~1,900 |
| **合計** | **≈ 24,000 / 1 配信** |

**月 4 回でレコード上限より先に API 上限へ当たる。** 週 1 配信は API 側でも成立しない。

## 4. 選択肢の比較

### A. Airtable Business へ上げる（125,000 records/base）

| 項目 | 値 |
|---|---:|
| 現在 50,456 に対する空き | 74,544 件 |
| **追加で送れる回数** | **2 回** |
| 月 1 回配信なら | **約 2 か月で再枯渇** |
| 週 1 回配信なら | **約 2 週間で再枯渇** |

費用は座席課金（Business は Team の約 2 倍強の単価）。**座席数は API から取得できない**
（`/v0/meta/whoami` は id しか返さない）ので、正確な差額は Airtable 管理画面で要確認。

→ **金を払っても 2 か月しか買えない。構造が変わらないので却下。**

### B. Team 維持 + 配信履歴だけ Airtable の外へ ★推奨

Airtable に残すのは「人が画面で直接扱うもの」と「小さい正本」だけ。

| 残す（Airtable）| 出す |
|---|---|
| Customers / EmailBlacklist / PromotionalOffers / PointExchangeRequests / StepEnrollments / AuthTokens / 実行中の ScheduledEmails | CampaignDeliveries（冪等性）/ EmailEvents（テレメトリ）/ 完了済み ScheduledEmails |

**移行先は新サービスを増やさない。** AK には既に

- **Upstash Redis**（`UPSTASH_REDIS_REST_URL` / `..._TOKEN` が production に設定済み。
  大量取り込みジョブの正本として本番稼働実績あり）
- **Netlify Blobs**（Pro に含まれる。Premium Plus 実績画像で稼働中）

がある。

| 常駐件数 | Team 上限までの余裕 |
|---|---|
| 17,243 件 | 32,757 件。Customers 自然増 50 件/月なら **50 年以上** |

### C. Airtable 内で archive Base へ分離

- archive 側も **同じ 50,000 件上限の対象**。1〜2 回の配信で archive が埋まる
- Base 間はリンクできないので、管理画面・監査は 2 Base を横断する実装が要る
- API 呼び出しは減らない（むしろ増える）

→ **上限問題を先送りするだけ。却下。**

### D. 保持期間で減らす（単独では不十分・B と併用する）

| データ | 永久保持が要るか | 最小限 |
|---|---|---|
| `EmailEvents` の open | **不要**。集計値があれば足りる | campaign×version×日 の**カウント** |
| `EmailEvents` の delivered | 送達の証跡として一定期間 | 90 日 + 集計 |
| `EmailEvents` の bounce / dropped / spam_report | **suppression の根拠なので残す**。ただし正本は `EmailBlacklist` と provider 側 | 恒久（件数は小さい）|
| `CampaignDeliveries` | **`DeliveryKey` の集合だけが冪等性に必須**。本文・時刻・JobId は運用の便宜 | `DeliveryKey` の集合 |
| `ScheduledEmails` | 完了後は履歴 | 実行中のみ |

D だけでは足りない: 保持 90 日でも月 1 配信で 3 か月ぶん（約 111,000 件）を抱えるため
Team にも Business にも入らない。**B と組み合わせて初めて成立する。**

## 5. 推奨アーキテクチャ

```
                 ┌─────────────── Airtable（Team のまま）────────────────┐
                 │ Customers / EmailBlacklist / PromotionalOffers /      │
   人が扱う正本  │ PointExchangeRequests / StepEnrollments / AuthTokens  │
                 │ ScheduledEmails（実行中のみ）                          │
                 └───────────────────────────────────────────────────────┘
                                     ▲ 読み書き（従来どおり）
                                     │
   配信 ──────────┬──► Upstash Redis  : DeliveryKey の SET（冪等性の正本）
                  │                     campaign×version 単位の集計カウンタ
                  └──► Netlify Blobs  : 生イベントの NDJSON（監査用・追記のみ）
```

### 冪等性をどう守るか（**ここを間違えると二重送信になる**）

いま必要なのは「この `DeliveryKey` は既に送ったか」の 1 問だけ。行そのものは要らない。

- Redis の **SET**（`ak:delivered:<campaignId>:v<version>`）に `DeliveryKey` を入れる
- 判定は `SISMEMBER`（O(1)）。現行の `fetchDeliveredKeys`（名指し取得）を置き換える
- 容量: 14,279 件 × 約 80 バイト ≒ **1.2 MB / 配信**。年 12 回でも 15 MB 程度
- コマンド数: 1 配信で `SADD` + `SISMEMBER` ≒ 29,000

**移行は二重書き込みから始める。** Redis と Airtable の両方へ書き、判定は
「Redis に無ければ Airtable も見る」。両者が一致することを 1〜2 配信ぶん確認してから
Airtable 側の行を止める。**いきなり切り替えない。**

### Blobs の multi-writer 問題を踏み込まない書き方

Premium Plus 実績画像で踏んだ eventual consistency / CAS の問題は
「**同じキーを読んで書き戻す**」から起きる。イベントログは
**webhook バッチごとに固有キー**（`events/YYYY-MM-DD/<batchId>.ndjson`）で
**新規作成しかしない**。読み書き競合が構造的に発生しない。

## 6. 必要なコード変更

| # | 変更 | 規模 | リスク |
|---|---|---|---|
| 1 | `deliveryKeyStore.js`（Redis SET の薄いラッパー・純粋 I/F）| 小 | 低 |
| 2 | `admin-marketing.js` の `fetchDeliveredKeys` を store 経由へ（二重読み）| 小 | 中 |
| 3 | enqueue 時に Redis へも `SADD`（二重書き）| 小 | 低 |
| 4 | 突合スクリプト（Redis と Airtable の DeliveryKey 集合が一致するか）| 小 | 低 |
| 5 | Event Webhook の書き込み先を Blobs + Redis カウンタへ | 中 | 中 |
| 6 | 管理画面の開封表示を Redis カウンタから読む | 中 | 中 |
| 7 | Airtable 側の旧行を削除（**別承認**）| 小 | **高** |

1〜4 で「これ以上増やさない」が成立する。5〜6 は EmailEvents を止めるために要る。
7 は既存 33,000 件を消す作業で、**バックアップ確認後に別途承認**。

## 7. 移行対象の件数

| 対象 | 件数 |
|---|---:|
| Redis へ入れる `DeliveryKey` | 14,416 |
| Blobs へ書き出す `EmailEvents` | 18,793 |
| 削除できる Airtable 行（上記 2 つ + 完了 ScheduledEmails）| **約 33,300** |
| 削除後の常駐 | **約 17,200** |

## 8. rollback

| 段階 | 戻し方 |
|---|---|
| 二重書き込み中 | Redis 側を無視するだけ。Airtable が正本のまま動く |
| 判定を Redis へ切替後 | env で store を `airtable` に戻す（コード変更なし）|
| Airtable 行の削除後 | **戻せない。** 削除前に CSV/JSON でエクスポートし、Blobs へ退避してから実行する |

**削除は最後。** 1〜6 が本番で 1 配信ぶん検証できるまで実行しない。

## 9. 費用

| 項目 | 月額追加 |
|---|---:|
| Upstash Redis | **0 円の見込み**（既に production で稼働中。データ 15 MB / 月 3 万コマンド程度）※現行プランの上限は Upstash 管理画面で要確認 |
| Netlify Blobs | **0 円**（Pro に含まれる）|
| Airtable | **0 円**（Team のまま）|

対して Business へ上げると座席数 × 単価差が毎月かかり、それでも 2 か月で再枯渇する。

## 10. 触ってはいけないこと

- **`EmailBlacklist` を移さない。** suppression の正本で、件数も小さい
- **`Customers` を移さない。** 人が画面で直接扱う正本
- **`CampaignDeliveries_MarketingAutomation` は KMA 側のテーブル。** AK は読み書きしない
- **二重書き込みの検証前に Airtable 側の書き込みを止めない**
- **`DeliveryKey` の作り方（`campaignId × version × 受信者 × 送信元`・日付非依存）を変えない。**
  変えると既送分と鍵が変わり二重送信になる
- provider suppression（SendGrid）への依存はそのまま。AK 側台帳だけで判断しない


---

# 実装（2026-08-09 / 段階移行）

**既定の挙動は変えていない。** env を入れるまで従来どおり Airtable のみに書く。

## 段階を表す env（既定 OFF）

| env | 値 | 意味 |
|---|---|---|
| `MARKETING_DELIVERY_STORE` | 未設定 / `airtable` | 従来。Airtable のみ |
| | `dual` | Airtable **と** Redis へ書き、判定は**和集合** |
| | `redis` | Redis のみ |
| `MARKETING_EVENT_SINK` | 未設定 / `airtable` | 従来。EmailEvents 行を書く |
| | `dual` | Airtable + Blob + Redis カウンタ |
| | `blob` | **Airtable へ行を書かない**。Blob + カウンタのみ |

未知の値は **airtable へ倒す**（勝手に新経路へ行かせない）。

## モジュール

| ファイル | 役割 |
|---|---|
| `src/lib/marketing/deliveryKeyStore.js` | Redis の DeliveryKey 集合。TTL なし・fail closed |
| `src/lib/marketing/deliveryKeySource.js` | どこを信じるかの単一源（読み=和集合 / 書き=二重）|
| `src/lib/webhooks/emailEventBlobStore.js` | Blob へ追記専用。**バッチ固有キー・読み書き戻しなし** |
| `src/lib/webhooks/emailEventSink.js` | イベントの書き込み先と失敗時の扱い |
| `src/lib/marketing/deliveryStoreReconcile.js` | 突合と切替可否の判定 |
| `scripts/reconcile-delivery-stores.mjs` | 全件突合（Function では 26 秒に収まらないため運用スクリプト）|
| `scripts/check-airtable-capacity.mjs` | 件数と上限比の監視 |

## 失敗時の扱い（表にして固定する）

| 状況 | 挙動 |
|---|---|
| `dual` で Redis が読めない | Airtable の答えで判定を継続し `degraded` を記録。**送信は止めない** |
| `redis` で Redis が読めない | **例外**。判定できないので送らない |
| `dual` で Redis 書き込み失敗 | 致命にしない（Airtable が正本）。差分は突合で拾う |
| `redis` で Redis 書き込み失敗 | **例外**（記録が残らないと次回二重送信）|
| Airtable 書き込み失敗 | **常に致命**（台帳が欠ける）|
| `dual` で Blob 失敗 | 致命にしない。`degraded` に残す |
| `blob` で Blob 失敗 | **例外**。provider へ 5xx を返し**再送させる** |
| カウンタ失敗 | 常に致命にしない（Blob から数え直せる）|

## retention（推測で消さない。ここに書いたものだけ消す）

| データ | Airtable | Redis | Blob |
|---|---|---|---|
| `DeliveryKey` | 切替後は不要 | **永久**（TTL 禁止。消えると再送）| — |
| `CampaignDeliveries` の本文・時刻・JobId | 運用の便宜。**90 日**で十分 | 持たない | — |
| `EmailEvents` の `delivered` | 切替後は不要 | 件数のみ | **生ログを保持** |
| `EmailEvents` の `open` / `click` | **不要**（重複排除しないので最大の増加源）| 件数のみ | 生ログ 400 日 |
| `EmailEvents` の `bounce` / `dropped` / `spam_report` | 切替後は不要 | 件数のみ | **永久**（suppression の根拠）|
| suppression の**正本** | `EmailBlacklist`（移さない）| — | — |
| `ScheduledEmails` | 実行中のみ。`SENT`/`FAILED` は 90 日 | — | — |

**保持期間の根拠が docs に無いものは消さない。** 上表に無いデータは現状維持。

## 切替の順序（飛ばさない）

1. `MARKETING_DELIVERY_STORE=dual` → 1 配信 → `npm run reconcile:delivery-stores` が
   `safeToSwitch=true` を返すことを確認
2. `MARKETING_EVENT_SINK=dual` → 1 配信 → 件数突合
3. `redis` / `blob` へ切替
4. **ここで初めて** Airtable の旧行を export → 削除（別承認）

各段は redeploy が要る（env 変更だけでは Function に反映されない）。


---

# 移行ツール（2026-08-09 / 本番未実行）

## スクリプト

| コマンド | 何をするか | 既定 |
|---|---|---|
| `npm run backfill:delivery-keys` | CampaignDeliveries → Redis の DeliveryKey 集合 | **dry-run** |
| `npm run backfill:email-events` | EmailEvents → Blob へ NDJSON 退避 | **dry-run** |
| `npm run export:airtable-tables` | 削除前の復元用 export（3 table）| 常に read-only |
| `npm run reconcile:delivery-stores` | DeliveryKey 集合の突合 | read-only |
| `npm run reconcile:email-events` | EventKey 集合 + 種別件数の突合 | read-only |
| `npm run check:airtable-capacity` | 件数と上限比 | read-only |

書き込むには **`--apply` を明示**する。付けなければ 1 バイトも書かない。

## dry-run の実測（2026-08-09 / 本番データ・書き込み 0）

| 対象 | ページ | 読み取り | 移行対象 | skip |
|---|---:|---:|---:|---:|
| CampaignDeliveries（sent/queued）| 145 | **14,415** | 14,415 | 0 |
| EmailEvents | 190 | **18,995** | 18,995 | 0 |

CampaignDeliveries は総数 14,416 のうち `skipped-duplicate` 1 件を除いた数。
**EmailEvents は open が増え続けるので、実行時に必ず再計測すること**（この数字は測定時点の値）。
**送っていない行を「送信済み」に入れない**ため、`sent` / `queued` だけを対象にする。

## checkpoint の方式

**Airtable の `offset` を保存しない。** offset は短命で、期限切れの値で再開すると
途中から読み始めて**取りこぼす**。代わりに:

  - 書き込みを**すべて冪等**にする（Redis=SADD / Blob=内容ハッシュのキー）
  - 再開は「最初から読み直し、既にある分は冪等で素通り」
  - checkpoint（`.migration-state/<job>.json`）は**進捗表示と検算のためだけ**

読んだ件数と（書いた + 飛ばした）件数が合わなければ **完了扱いにしない**。

## 二重実行・部分失敗

| 事象 | 結果 |
|---|---|
| 同じ backfill を 2 回流す | Redis の集合は変わらない / Blob は同一キーなので増えない |
| Airtable が途中で失敗 | 例外。部分的に入った分はそのまま。再実行で完全になる |
| Redis / Blob が途中で失敗 | 例外。**完了扱いにしない** |
| 部分的にしか入っていない | 突合が `missingInRedis` / `missingInBlob` を検出し **切替不可** |

## 突合の判定（件数一致では PASS にしない）

| 対象 | 比べるもの | 切替可の条件 |
|---|---|---|
| DeliveryKey | **集合そのもの** | Redis に足りない鍵が 0（余分は可）|
| EmailEvents | **EventKey 集合** + 種別ごとの件数 | Blob に足りない鍵が 0 かつ種別件数が一致 |

片側を読めなかったら `unavailable` とし、**「一致」とは扱わない**。

## 削除前 export

`export:airtable-tables` が recordId と**全フィールド**を NDJSON で落とし、
件数と SHA-256 を manifest に残す。行を作り直せる。

⚠️ 出力は **PII を含む**。`.migration-export/` は .gitignore 済み。repo へ入れない。
⚠️ 退避しただけでは消してよいことにならない。**突合の PASS が先**。
