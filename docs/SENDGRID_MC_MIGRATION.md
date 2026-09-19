# prospect 選別配信を SendGrid Marketing Campaigns へ移す（2026-09-18 MK 確定）

> **確定仕様。** 約 15,000 件の選別配信の**実行**は、AK 自作の cron / queue / rotation ではなく
> **SendGrid Marketing Campaigns Advanced / Custom Automation** が担う。
> AK 自作の配信エンジンを主経路として完成させ続ける方針は**終了**する。
>
> ⚠️ **本番切替は未実施。** このドキュメントは設計・手順・停止境界の正本であり、
> 「やった記録」ではない。実施済みかどうかは `docs/progress.md` 先頭の常設ブロックが正本。

関連: [`MARKETING_PLATFORM.md`](./MARKETING_PLATFORM.md)（**責務境界の正本**）/
[`docs/spec.md`](./spec.md)（確定仕様）/ [`docs/decisions.md`](./decisions.md)（判断の記録）/
[`docs/progress.md`](./progress.md)（現在地）/
[`ENGAGEMENT_SUPPRESSION.md`](../astro-site/docs/ENGAGEMENT_SUPPRESSION.md)（反応・打ち切りの単一源）

---

## 1. 役割分担（ここが変わる / 変わらない）

| 担当 | 中身 |
|---|---|
| **AK** | 元データの所在・状態管理 / 各受信者の現在位置と**次に送るメール番号** / SendGrid へ渡す contact・segment / Event Webhook の受領（delivered・open・click・bounce・unsubscribe）/ 反応者を DRM へ接続 / 選別済み・抑止済みの監査 |
| **SendGrid Marketing Campaigns** | 1 日 1 通のスケジュール / 最大 10 通の Automation / contact・list・segment / unsubscribe・suppression / Automation の entry と exit / **実際の大量送信** |

**変わらないもの（1 つも緩めない）**

- 二重送信防止（`DeliveryKey` は**引き続き AK 側の正本**）
- unsubscribe / bounce / complaint / provider suppression による除外
- 1 日 1 通・最大 10 通
- **delivered 累計 10 通で無反応なら通常マーケティングから除外**
- 反応者は DRM へ
- **既送信 step の再送禁止**

**「反応」の定義は変えない。** 単一源は `prospectPolicy.js` / `prospectEngagement.js` /
`engagementPolicy.js`。SendGrid で直接取れない反応（購入・ログインなど）は、
**AK が contact を list から外す**ことで Automation から退出させる。

### 選別のルール（2026-09-18 で明文化）

- **原則 1 日 1 通 × 最大 10 通。** 「10 通を数週間・数か月かけて送る」設計にしない
- 次のいずれかは**途中でも即除外**する（10 通を待たない）:
  unsubscribe / hard bounce / spam complaint / 永久除外 /
  **購入済みで不要になった訴求** / その他 安全上送るべきでない状態
- 選別後に残った見込み客へは **週 2 回程度の一斉メルマガ**（約 月 8 回）で継続 DRM する
- KMA（`keiba-marketing-automation`）は**凍結**。照合・rollback 材料として保持するだけで、
  **移行先にも中継先にもしない**

---

## 2. 通し番号 1〜10（移行の背骨）

| 通し番号 | campaignId | step |
|---|---|---|
| 1〜3 | `campaign-discount-free`（第 1 期）| 1〜3 |
| 4〜10 | `campaign-prospect-phase2`（第 2 期）| 1〜7 |

単一源は `src/lib/marketing/sendgridMessagePlan.js`。

- **文面・`version`・step 定義は 1 バイトも変えない**（変えると `DeliveryKey` が変わり再送になる）
- campaign が**期間外でも対応表は変わらない**（`includeDisabled: true` で解決する）
- 3 + 7 ≠ 10 になったら **plan を作らない**（fail closed）

### 次に送る番号の決め方（**再送禁止の中核**）

`src/lib/marketing/sendgridNextMessage.js`

1. **`highestSent + 1`**。受け取った通数ではなく**最大の通し番号**で決める
2. **穴は埋めない**（1 と 3 が届いていれば次は 4。2 を送り直さない）
3. **台帳を引けなければ `unresolved`**（未送信と見なさない＝全員再送を防ぐ）
4. ENGAGED / PROMOTED / EXHAUSTED / SUPPRESSED は**移行対象にしない**
5. 10 通配り終えていれば `completed`（入れる Automation が無い）

---

## 3. なぜ開始番号ごとに Automation を分けるのか

SendGrid の Automation は**入った contact を 1 通目から順に**送る。「4 通目から始める」入り方は無い。
したがって **4 通目から始めたい人は「4 通目始まりの Automation」へ入れる**以外に再送を避ける方法が無い。

| 開始番号 | list 名 | Automation 名 | 通数 |
|---|---|---|---|
| 1 | `ak-prospect-select-start-1` | `AK Prospect Selection start 1` | 10 |
| … | … | … | … |
| 10 | `ak-prospect-select-start-10` | `AK Prospect Selection start 10` | 1 |

- 各 Automation の n 番目は **entry から (n-1) 日後**（1 日 1 通）
- **対象が 0 人の入口は作らない**（実測の分布しだいで、作るのは 10 本より**ずっと少ない**）
- **segment は使わない。** segment は条件に合致すると出入りが動的に起きるので、
  `ak_next_message` を後から更新した拍子に**別の Automation へ再入場して同じ通が二度出る**恐れがある。
  入口は**静的な list**（明示的に入れた人だけ）に固定する
- 何を作るかは `describeMinimalSetup()` が返す（**それ以上を SendGrid 側に増やさない**）
- ⚠️ AK 側の `delayDays`（2〜6 日）とは別物。**AK の step 定義を書き換えて合わせない**
  （書き換えると `contentHash` → `DeliveryKey` が変わり再送の入口になる）

単一源: `src/lib/marketing/sendgridAutomationPlan.js`

---

## 4. contact の作り方（変換層）

`src/lib/marketing/sendgridContactExport.js`

**必要最小限しか作らない。** 必須は **1 本だけ**。

| custom field | 型 | 要否 | 中身 |
|---|---|---|---|
| `ak_next_message` | Number | **必須** | 次に送る通し番号（1〜10）。どの Automation に入れるかを画面で確かめるために要る |
| `ak_delivered` | Number | 任意 | 移行時点の delivered 累計の控え |
| `ak_migrated_at` | Text | 任意 | 移行日時（ISO8601 / UTC）|

- 任意の 2 本は **SendGrid に無ければ作らずに進む**（値を送らないだけで移行も送信も成立する）
- `ak_prospect_hash` は**作らない**（Event Webhook が `email` を返すので AK 側で照合できる）

- **`ready` 以外は 1 件も出さない**
- **必須の custom field の id が解決できなければ何も作らない**（任意の欠けは止めない）
- **list id が解決できない通し番号は出さない**
- 変換の時点でも `assertNoResend` を通す（判定と変換のどちらが壊れても止まる）
- 生成物（アドレスを含む配列 / CSV）は **repo・docs・ログへ保存しない**

---

## 5. 文面の移植

`src/lib/marketing/sendgridContentExport.js` が既存 catalog の `renderCampaign` 出力をそのまま返す。
**SendGrid 用に置き換えるのは 2 つだけ**:

| AK | SendGrid |
|---|---|
| `{{unsubscribeUrl}}` | `<%asm_group_unsubscribe_raw_url%>` |
| 宛名 | 固定（prospect は氏名を持たないので**推測で名前を作らない**）|

⚠️ 配信停止タグは **描画後に差し替える**。`renderCampaign` に直接渡すと href が HTML escape され
（`&lt;%…%&gt;`）、SendGrid が置換できず**配信停止リンクが壊れる**。
タグが消えていたら**その文面は出さない**（停止できないメールを配らない）。

---

## 6. 反応の受領と退出

| 反応 | 誰が検知 | SendGrid をどう抜けるか |
|---|---|---|
| open / click | SendGrid → Event Webhook → AK（`ENGAGED`）| **AK が list から contact を外す** |
| 購入・ログイン等 | AK（既存の反応判定）| 同上 |
| bounce / 苦情 / 配信停止 | SendGrid（suppression）| SendGrid 側で自動停止 ＋ AK が `SUPPRESSED` |
| delivered 10・無反応 | AK（`applyDelivered` の打ち切り）| 10 通目で Automation は終端。AK が `EXHAUSTED` |

### 戻すイベントと扱い

| イベント | 扱い |
|---|---|
| `processed` | 送信受理。**配達ではない** |
| `delivered` | 配達成功。**打ち切り（10 通無反応）の分母** |
| `open` | 弱いシグナル。**単独で購入意向と見なさない** |
| `click` | 強いシグナルだが、現状 provider 側でリンク追跡 OFF のため実質 0。当てにしない |
| `bounce` / `dropped` | 即時除外（`SUPPRESSED`）|
| `unsubscribe` / `spam report` | 即時除外。**解除しない**（再取り込みでも復活させない）|

反応の**意味づけは AK 側**で行い、サイトアクセス・CTA・購入情報と組み合わせて
マーケティング状態を判断する（`MARKETING_PLATFORM.md` §8）。

- Event Webhook は **`custom_args` を要求しない**（`planProspectEventUpdates` は
  `email` + `event` だけで判定する）。**Automation 送信でもそのまま動く**
- `MARKETING_PROSPECT_EVENTS_ENABLED=true` が要る（設定済み・変更しない）
- 署名検証は既存のまま（`SENDGRID_WEBHOOK_VERIFICATION_KEY` / fail closed）

---

## 7. 本番切替（**二重稼働 0**）

### 全体の順序（**この順に進む**）

```text
現状 read-only 監査 → 対象突合（15,509 件等） → 既送信 step 確定 → suppression 突合
→ Contacts / List / Segment 設計 → Automation 設計 → テスト対象だけで検証
→ 旧 AK 本番配送を停止 → 最終 snapshot → production contacts import
→ Automation 開始 → Event Webhook 確認 → AK 管理画面への状態反映確認
→ 二重送信 0 確認 → 本番選別開始 → 安定確認後に旧配送基盤 廃止 Phase
```

⚠️ **旧配送基盤の廃止と KMA の廃止は、選別が安定してからの独立 Phase**。
切替と同時に消さない（照合・rollback ができなくなる）。

`src/lib/marketing/sendgridCutover.js`

```
  ak_live ──停止──▶ frozen ──live──▶ sendgrid_live
     ▲                 │                   │
     └──状態確認のうえ再開──┘◀──Automation を Disable──┘
```

**`ak_live` から `sendgrid_live` へ直接は進めない。** 必ず `frozen`（どちらも送らない）を挟む。

| # | 段 | 承認 | 中身 |
|---|---|---|---|
| 1 | `stop_ak_prospect` | **要** | production の `MARKETING_PROSPECT_ENGINE=sendgrid` ＋ redeploy |
| 2 | `verify_stopped` | — | prospect 宛 enqueue 0 件・送信待ちジョブ 0 件を read-only で確認 |
| 3 | `snapshot` | — | 索引 / 台帳 / 通し番号別件数を控える（`digest` つき）|
| 4 | `import_contacts` | **要** | 通し番号別 list へ upsert（**Automation はまだ live にしない**）|
| 5 | `verify_import` | — | list ごとの contact 数が通し番号別件数と一致するか |
| 6 | `set_live` | **要** | 対象が居る Automation だけ live |
| 7 | `verify_single_engine` | — | AK 側 0 件 ＋ SendGrid 側が動いていることを両方確認 |

### AK 側の停止は env 1 つ

| `MARKETING_PROSPECT_ENGINE` | AK の挙動 |
|---|---|
| 未設定 / `ak` | **従来どおり**（1 バイトも変わらない）|
| `sendgrid` | prospect を母集団に入れない。prospect 専用 campaign は 1 件も積まない |

- 未知の値は `ak` へ倒す（勝手に新経路へ行かせない）
- **Customers 向けの配信は止めない**（止まるのは prospect 宛だけ）
- 配線は `cron-campaign-sequence.js`（guard テストで固定）

### rollback（**同じメールを二重送信する rollback は禁止**）

1. SendGrid Automation を**すべて Disable**
2. SendGrid で送られた通を AK 側の台帳へ**反映**（Event Webhook の delivered を数え直す）
3. **通し番号の進みが合っていることを確認してから** `MARKETING_PROSPECT_ENGINE` を外して再開

---

## 8. 費用最小化（2026-09-18 MK 確定）

> **月額およそ 1〜2 万円程度（目安 1.6 万円）の外部配送費は事業コストとして許容する**
> （開発時間と事故リスクの削減と引き換え）。そのうえで
> **必要要件を満たす範囲で、常に最小プランを選ぶ。上位プランを先回り契約しない。**
> 超過料金込みで上位プランより高くなる場合だけ、比較したうえで判断する。
>
> ⚠️ **価格・プラン名称・送信上限・Automation 条件を不変の仕様として固定しない**（変動する）。
> **契約直前に必ず SendGrid 公式の現行条件を確認する。**

⚠️ **コスト削減のために配信安全性を落とさない。** 送信頻度・選別処理・二重送信防止・
unsubscribe・suppression・10 通・打ち切り・DRM 接続は**削らない**。
「費用を抑える」は**必要以上の contact 枠・email 枠を契約しない**ことだけで実現する。

| 局面 | 想定 | 第一候補 |
|---|---|---|
| 初回の約 15,000 件 選別期間 | 既送信を引き継ぎ、全員 1 通目から送り直さない | **Advanced 20K** |
| 選別終了後（例: 約 5,000 件）| 週 2 回 × 月約 8 回 = 約 40,000 通/月 | **Advanced 10K（月 50,000 通枠）** |

- 選別が終わったら**要件を満たす最小の Advanced へダウングレード**する。20K / 50K を惰性で維持しない
- 判定の単一源: `src/lib/marketing/sendgridPlanSizing.js`
  - `estimateSelectionVolume()` — 残送信総数 = Σ(人数 × 残り通数)
  - `estimateSteadyVolume()` — 選別後 = contact 数 × 月 8 回
  - `recommendPlan()` — **枠に収まるいちばん小さいプラン**。未確認の枠は「収まる」と言わない
  - `canDowngrade()` — 1 段階下げられるか
- ⚠️ **コードに金額を持たない**（料金表を書き写すと請求額とズレる）。金額の比較が要る場面では
  そのとき公表値を確認する（`requiresQuote: true` が出る）

### 毎月確認する（`MONTHLY_REVIEW_ITEMS`）

active contact 数 / 月間予定送信数 / Automation 利用の有無 / 超過料金 / 1 段階下げられるか

### 停止境界

**契約・アップグレード・ダウングレードを含むすべての課金変更は、実行直前で停止して MK 承認を取る。**

---

## 9. 管理 API（`admin-sendgrid-migration`）

| action | 副作用 | 中身 |
|---|---|---|
| `scan` | **なし** | 索引を窓で読み、通し番号別の件数（アドレスなし）|
| `plan` | **なし** | 通し番号別件数 → list / Automation 計画 |
| `content` | **なし** | 10 通の件名（`full:true` で本文も）|
| `preflight` | **なし** | SendGrid の custom field / list / contact 数 / unsubscribe group |
| `import` | 書き込み | contact の upsert |
| `exit` | 書き込み | 反応・抑止した人を list から外す |

**write は三重の条件**（`SENDGRID_MIGRATION_WRITE_ENABLED=true` ＋ 合言葉 ＋ `apply: true`）。
どれか 1 つでも欠ければ **SendGrid へ 1 リクエストも出さない**。
`import` は AK 側がまだ prospect を送る設定なら **409（二重稼働の防止）**。

### 走査の窓

10 通ぶんの鍵を引くので、既存の下見（`prospectSequenceCheck`）より**窓を小さく**する（既定 500）。
`nextOffset` で続きから読み、**`missing` の合計が 0 のときだけ「確定」**と呼ぶ。

---

## 10. 突合は手元から 1 コマンド（read-only）

11,000 件超 × 10 通ぶんの照会は**同期 Function に収まらない**ので、手元から読む。
**新しい基盤は作らない**（既存の判定・鍵の作り方をそのまま import するだけのスクリプト）。

```bash
cd astro-site
UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
AIRTABLE_API_KEY=... AIRTABLE_BASE_ID=... SENDGRID_API_KEY=... \
npm run audit:sendgrid-migration > /tmp/ak-migration-audit.json
```

| 守っていること | どう守るか |
|---|---|
| **読むだけ** | Redis は `SMEMBERS / SCARD / MGET / SMISMEMBER / GET / SISMEMBER` のみ許可。Airtable / SendGrid は **GET だけ** |
| **アドレスを出さない** | 出力は件数と分布だけ。`@` が混ざったら**出力せず中止**（exit 3）|
| **資格情報が無ければ何もしない** | exit 2 で終了（ネットワークへ出ない）|
| **判定を再実装しない** | `sendgridMessagePlan` / `sendgridNextMessage` / `deliveryKeyStore` を import |

出力に入るもの:

- prospect の 送信候補 / 反応済み / 永久除外 / 読めた件数 / **値なし**（0 でなければ「確定」と呼ばない）
- **通し番号別の件数**（＝ 既送信 step 別の人数）・穴あき・除外理由の内訳・delivered 分布
- Customers 側（Airtable 台帳）の campaign 別 行数・status 別・**ユニーク宛先**と、
  その人たちが**いまどこに居るか**（prospect 送信候補 / 反応済み / 永久除外 / それ以外）
- SendGrid 側の現況（contact 数 / 必須 custom field の有無 / 移行用 list / unsubscribe group）
- 見積り（残送信総数・月間通数・**枠に収まる最小プラン**）

検証: `npm run test:marketing`（`sendgridMigrationAudit.guard.test.mjs` が read-only を固定）

---

## 11. 実数で確定した移行対象と最小構成（2026-09-18 実測）

read-only 突合（§10）の結果。**`missing 0` ＋ 索引 digest 一致**で確定した値。

| 項目 | 実測 |
|---|---:|
| 移行対象（prospect 送信候補）| **11,749**（最新測定）|
| 反応済み（移行しない）| **196** |
| 永久除外（移行しない）| **31** |
| 10 通 配り終えた人 | **0** |

| 次の通 | 人数 | 作る list / Automation |
|---:|---:|---|
| 1 | **328** | `ak-prospect-select-start-1` ／ 10 通 |
| 2 | **3,442** | `ak-prospect-select-start-2` ／ 9 通 |
| 3 | **7,979** | `ak-prospect-select-start-3` ／ 8 通 |
| 4〜10 | **0** | **作らない** |

- **list 3 本 / Automation 3 本 / custom field 1 本（`ak_next_message`）/ unsubscribe group 1 本**
- 残送信総数 **98,090 通**、1 日 1 通なので**全員 9 日**で配り終える
- ⚠️ **2 と 3 の人数は動く**（旧 AK 経路が step2 を配り続けているため）。
  **list を分けるのは投入直前の再測値で行う**（328 だけは動かない）
- ⚠️ 選別期間の月間送信数 ≒ **98,090 通**。**Advanced 20K の月間送信枠を契約画面で確認**し、
  超えるなら「開始を分散」か「超過を許容」を決める（**推測で枠を書かない**）
- SendGrid の suppression 実測: bounces **309** / blocks **51** / spam reports **1** /
  global unsubscribes **0**

### ✅ ブロッカー解消（2026-09-18）— Marketing Campaigns API は **200**

MK が **Advanced 20K を契約**（Email API Essentials 50K は維持）し、**本番で使っているキーの権限を編集**
（キー名も `AK SendGrid Production` へ変更。**値は差し替えていない ＝ env 変更なし**）した結果:

| endpoint | 結果 |
|---|---|
| `/v3/marketing/contacts/count` | **200** |
| `/v3/marketing/field_definitions` | **200** |
| `/v3/marketing/lists` | **200** |
| `/v3/marketing/segments/2.0` | **200** |
| `/v3/marketing/senders` | **200** |

| 確認 | 実測 |
|---|---|
| 使用中キー名 | **`AK SendGrid Production`** |
| scope 総数 | 208 → **203** |
| `marketing.*` | **`marketing.read`**（Automation は No Access のまま = 想定どおり）|
| **既存機能の権限が落ちていないか** | ✅ `mail.send` / `asm.groups.create` / `asm.groups.read` / `suppression.*` / `whitelabel.read` / `user.account.read` すべて残存。**編集前に確認できていた scope の欠落 0** |

⚠️ **次に必要なのは `marketing.write`**（list / custom field / sender の作成と contact 投入に要る）。
いまは **`marketing.read` だけ**なので、**読むことはできるが作れない**（＝いまの停止位置として正しい）。

### 以下は解消前の記録（historical / 2026-09-18）

Advanced 20K の契約後も Marketing Campaigns API は **403 のまま**。原因は切り分け済み:

| 確認したこと | 実測 |
|---|---|
| API キーの総 scope 数 | **208** |
| `marketing` で始まる scope | **0 個**（1 つも無い）|
| SendGrid が返す 403 の本文 | `access forbidden. please ensure you have the correct scopes defined.` |
| 同じキーで読める API | `/v3/asm/groups` `/v3/verified_senders` `/v3/whitelabel/domains` `/v3/user/account` `/v3/suppression/*` は **200** |
| アカウント | `type: paid` / `reputation: 99` |

→ **契約の問題ではなく、API キーに Marketing Campaigns の権限が付いていない。**

#### ⚠️ **権限を足す相手を間違えない**（2026-09-18 実測で判明）

production の `SENDGRID_API_KEY` が指しているのは、SendGrid 上の
**「20250924200」というキー**（`/v3/api_keys` と token の key id を突き合わせて確定）。
別のキーを編集しても 403 は解けない。

| キー名 | scope 数 | `marketing.*` | 使用中 |
|---|---:|---|---|
| **20250924200** | 208 | **なし** | ✅ **これが本番で使われている** |
| アナリティクス | 171 | `marketing.read` | — |
| keiba-intelligence | 209 | `marketing.read` | — |

⚠️ **`SENDGRID_API_KEY` を別のキーへ差し替えない。** env 変更（承認＋再デプロイ）になるうえ、
「アナリティクス」は scope 171 と**現行より狭い**ので、既存 Function が使っている権限を失う恐れがある。
**使用中キーの権限を編集する**のが正しい直し方。

#### UI 上の位置（どこを変えるか）

```
SendGrid 管理画面
  → Settings → API Keys
  → キー名「20250924200」の行 → Edit（鉛筆アイコン）
  → API Key Permissions → **Restricted Access**
  → 一覧を下へスクロールし **Marketing** の行
  → **Read Access**（表示が No Access / Full Access の 2 択なら Full Access）
  → Update
```

- **Automation の行は No Access のままでよい**（Automation の作成・Set Live は画面で行い、API を使わない）
- 同じ Marketing 区画にある **Design Library** は既に Full（＝この区画自体は表示されている）
- 変更後は再デプロイ不要（**キーの値は変わらない**）。read-only で再確認できる

#### 足りない最小の権限

| 用途 | 必要な scope |
|---|---|
| **いま**（read-only で現況を確認する）| **`marketing.read`** |
| 後で（list / custom field 作成・contact 投入）| `marketing.read` ＋ **`marketing.write`** |
| 既にある（追加不要）| `asm.groups.create` / `asm.groups.read` / `mail.send` / `suppression.*` / `whitelabel.read` |

⚠️ **既存キーの権限を編集するだけでよい。新しいキーを発行しない**
（新規発行すると `SENDGRID_API_KEY` の差し替え＝**env 変更**になり、承認と再デプロイが要る）。
SendGrid の画面で該当キーを編集し、**Marketing に Read Access**（後で Full Access）を足す。

#### もう 1 つの前提（アカウントは KI と共用）

| 実測 | 影響 |
|---|---|
| unsubscribe group が `テストグループ` / **`KEIBA Intelligence メルマガ`** の 2 つだけ | **AK 用の group が無い**。作るときは KI のものに触らない |
| verified sender の nickname に `nankan analytics` / `NANKAN NoReply` / `nankankeiba` / `keiba-review` / `intelligence` | AK 専用 sender は**まだ無い**（`keiba.link` ドメインは認証済み・valid）|
| 認証済みドメイン | `keiba.link`（valid）ほか 4 件 |

→ [`MARKETING_PLATFORM.md` §10](./MARKETING_PLATFORM.md) の分離方針は**最初から必要**。

---

## 11-b. AK 用の最小構成（**作成手順 / 未実行**）

⚠️ **ここから先はすべて MK 承認が要る。この PR では 1 つも作っていない。**
順番を守る（後ろの段が前の段に依存する）。

### 作成は 1 コマンド（**`marketing.write` が無ければ 1 つも作らない**）

```bash
cd /Users/user/Projects/analytics-keiba
# 下見（何も作らない）
netlify dev:exec --context production -- node astro-site/scripts/sendgrid-create-minimal-setup.mjs
# 実行（MK 承認のうえで）
netlify dev:exec --context production -- node astro-site/scripts/sendgrid-create-minimal-setup.mjs \
  --apply --confirm "CREATE AK MINIMAL SETUP"
```

| 守っていること | どう守るか |
|---|---|
| 作るのは 6 つだけ | 名前の単一源 `buildMinimalSetupNames()`（group 1 / field 1 / list 3 / sender 1）|
| 既存を壊さない | **POST と GET しか持たない**（PUT / PATCH / DELETE を書かない）。同名があれば飛ばす |
| KI に触らない | `intelligence` / `keiba-review` / `nankan` / `テストグループ` は素通り |
| contact を入れない | `/v3/marketing/contacts` を触らない（別工程・別承認）|
| 中途半端な状態を作らない | `marketing.write` が無ければ**着手前に中止**。失敗したらその場で停止 |
| 住所を捏造しない | sender の住所欄は**既存の `keiba.link` sender から引き写す** |

⚠️ **Automation は API で作れない**（公開 API は統計のみ）。スクリプトは画面で入れる値
（入口 list / 通数 / 何日後 / 件名 / unsubscribe group / sender）を最後に表示する。

| # | 作るもの | 中身 | 状態 |
|---|---|---|---|
| 0 | API キーに `marketing.read` | 既存キーを編集（値は不変）| ✅ **完了**（キー名 `AK SendGrid Production`）|
| 0-b | read-only 再確認 | contacts / field_definitions / lists / segments / senders が **200** | ✅ **完了** |
| 0-c | API キーに Marketing の書き込み権限 | 同じキーを編集（値は不変）| ✅ **完了**（⚠️ scope 名は `/v3/scopes` に出ないが**作成は通る**）|
| 1 | AK 用 **sender 1 件** | `KEIBA Analytics` / from `noreply@keiba.link` / reply-to `support@keiba.link` | ✅ **完了**（verified: true）|
| 2 | unsubscribe group **1 本** | `AK Marketing` | ✅ **完了**（**id 34108**）|
| 3 | custom field **1 本** | `ak_next_message`（Number）| ✅ **完了** |
| 4 | list **3 本** | `ak-prospect-select-start-1` / `-2` / `-3` | ✅ **完了**（各 contacts **0**）|
| 5 | Automation **3 本** | 各 list を入口に 10 / 9 / 8 通・**1 日 1 通**・文面は書き出し済みを貼る | **未（API に作成経路が無い → 画面で作る）**|
| 6 | contact 投入 | 通し番号別に list へ upsert（**Automation は live にしない**）| **未 / 承認** |
| 7 | 旧 AK prospect 配信の停止 | `MARKETING_PROSPECT_ENGINE=sendgrid` ＋ redeploy | **未 / 承認** |
| 8 | Automation を live | 対象が居る 3 本だけ | **未 / 承認** |

**作らないもの**: 4〜10 始まりの list / Automation、segment、`ak_prospect_hash`、KI 用 group の変更。

---

## 11-d. Design Library 登録 完了 ／ Automation に出ない原因（2026-09-18）

### ✅ Design を 10 件登録した（手で HTML を貼らないため）

| 項目 | 実測 |
|---|---|
| 登録 | **10 件**（`AK Prospect Selection 01`〜`10`）/ editor **code** |
| 中身 | 書き出し済みファイルを**無加工**（`generate_plain_content: false`）|
| 検証 | 作成後 GET で subject / html / plain を突き合わせ **全件一致** |
| 二重作成 | 同名は飛ばす（再実行で 10 件とも `skip（既存）`）|

スクリプト `scripts/sendgrid-create-designs.mjs`（`/v3/designs` の **GET と POST だけ**）:

```bash
netlify dev:exec --context production -- node astro-site/scripts/sendgrid-create-designs.mjs \
  --apply --confirm "CREATE AK DESIGNS"
```

### 🔎 Automation の「Your Email Designs」に出ない原因（read-only 調査）

**アカウントやリージョンの不一致ではない。** Automation が参照しているのは
**Design Library ではなく Dynamic Template（`d-…`）**で、Design Library に作った
`editor: 'code'` の Design は UI の候補に出ていない。

| 否定できた仮説 | 根拠 |
|---|---|
| 別アカウント / subuser | `/v3/user/username` = **user_id 55647039**（`unified_acct_US…`）/ `/v3/subusers` **0 件** |
| EU と global の分裂 | `api.eu.sendgrid.com` でも**同じ user_id・同じ 10 件**が返る |
| 作成失敗 | `/v3/designs` に **10 件**（id / subject / thumbnail / `editor:"code"` まで取得可）|
| 中身の破損 | 作成直後の突き合わせで**全件一致** |

| 分かった構造 | 実測 |
|---|---|
| Automation のメール本文の実体 | **Dynamic Template**（例 `d-d9a2e28b…` / `generation: dynamic` / version の `editor: "code"`）|
| その template は一覧に出るか | **出ない**（`/v3/templates?generations=dynamic` は 0 件なのに id 直指定の GET は 200）＝ MC が内部生成する隠しテンプレ |
| Design Library の中身 | **10 件すべて `editor: "code"`**。design editor の Design は **0 件** |
| 既存 Automation | `AK Prospect Selection start 1`（**draft** / message_count **1**）。1 通目の subject は通し番号 01 と一致 |

→ **UI が「Your Email Designs」に出すのは design editor 側の Design だけ**で、
アカウントには code の Design しか無いため **Blank Template だけ**に見える、という説明が
すべての実測と整合する。

#### 次の最小確認（MK / 1 操作・書き込み無し）

Automation のメール追加で **「Code Editor」を選んだ状態**で "Your Email Designs" を開く。
`AK Prospect Selection 01`〜`10` が出れば確定。

#### 出なかった場合の代替（**承認前・未実行**）

Automation の本文は `d-…` Dynamic Template なので、**API で流し込む余地がある**
（`templates.create` / `templates.versions.create` の権限はある）。
27 通を手で貼る運用には戻さない。⚠️ **Automation 自体の作成・更新の公開 API は無い**（読み取りのみ）。

### ❌ Automation 方式は取りやめ（2026-09-18 MK 確定）

実画面で **Design Library の 10 件が Automation に出ない**ことを確認した。加えて
**Automation は公開 API に作成・更新の経路が無い**（読み取りのみ）ため、
画面で 27 通ぶんを組む運用になる。**目的は「SendGrid 上で自動配信すること」であって、
Automation 機能を使うことではない**ので、**Single Sends API 方式へ切り替える**。

- 作りかけの Automation `AK Prospect Selection start 1` は **draft のまま残す**（削除しない）
- Design Library の 10 件も残す（Single Send は本文を直接持つので必須ではないが、消さない）

以下は旧方針の記録（historical）:

### （旧・不採用）Automation は start 1 だけ作り、Duplicate で 2 / 3 を作る

| # | 操作 | 中身 |
|---|---|---|
| 1 | `AK Prospect Selection start 1` | 入口 `ak-prospect-select-start-1` / **10 通** / **1 日 1 通** / sender `KEIBA Analytics` / group `AK Marketing` |
| 2 | 各メールに Design（または template）を当てる | n 通目 = **通し番号 0n** |
| 3 | **Duplicate** → `start 2` | **先頭 1 通を削除**し入口を `-2` へ（02〜10 の 9 通）|
| 4 | **Duplicate** → `start 3` | **先頭 2 通を削除**し入口を `-3` へ（03〜10 の 8 通）|

⚠️ **Set Live はしない**（別の承認）。⚠️ 文面の単一源は書き出しファイル / Design。**画面で本文を書き直さない。**

---

## 11-c. SendGrid 側の現況（read-only 実測 / 2026-09-18・**Marketing 権限つきで取得**）

| 項目 | 実測 | AK 移行への意味 |
|---|---|---|
| Marketing の contacts | **104**（課金対象 104）| **ほぼ空**。11,752 を入れても **11,856** で Advanced 20K の枠内 |
| custom field | `registered_intelligence`(Text) / `registered_analytics`(Text) | **`ak_next_message` は無い** → 作る（Number・1 本だけ）|
| list | **0 本** | start-1 / -2 / -3 の **3 本**を作る |
| segment | `keiba-intelligence` 1 本（KI 用）| **触らない**。AK は segment を使わない |
| Marketing sender | **0 件** | AK 用 sender を 1 件作る（`keiba.link` は認証済み・valid）|
| unsubscribe group | `テストグループ` / `KEIBA Intelligence メルマガ` | **AK 用が無い** → 1 本作る。**KI のものは触らない** |
| 認証済みドメイン | `keiba.link`(valid) ほか 4 件 | AK の送信元は `keiba.link` でよい |
| アカウント | `paid` / reputation **99** | — |
| suppression | bounces **309** / blocks **53** / spam **1** / global unsub **0** | 移行後もそのまま効く |

⚠️ **contacts 104 は KI 側の運用ぶん**とみられる（custom field に `registered_intelligence` がある）。
AK の投入で 11,856 になるので、**KI と同じアカウントで contact 枠を共有する**ことになる。
枠の消費は AK 側が圧倒的に大きい（**11,752 / 11,856 ≒ 99%**）。

---

## 11-e. Single Sends 27 通で配る（**現行方式** / 2026-09-18 MK 確定）

**SendGrid が実配送を担う点は不変。AK 側に配送エンジンは作らない。**
Single Sends は**作成・本文・宛先 list・配信停止グループ・予約まで API で完結**するので、
**UI 手作業ゼロ**で「1 日 1 通・最大 10 通・list 別の開始位置」を実現できる。

### 構成（既存 list 3 本をそのまま使う / segment は使わない）

| 宛先 list | 送る通し番号 | 通数 | 人数（実測）|
|---|---|---:|---:|
| `ak-prospect-select-start-1` | 01 → 10 | **10** | 328 |
| `ak-prospect-select-start-2` | 02 → 10 | **9** | 3,442 |
| `ak-prospect-select-start-3` | 03 → 10 | **8** | 7,979 |
| | **合計 27 Single Send** | | **11,749 名 / 98,090 通** |

- **同じ暦日に同じ通し番号**が出る（day0 = 01/02/03、day1 = 02/03/04 …）。
  3 本の list は互いに素なので **1 人が 1 日に受け取るのは 1 通**
- 全体は **10 日**で配り終える（`最長日数 9`）
- sender = `KEIBA Analytics`（id 9739270）/ unsubscribe group = `AK Marketing`（id 34108）
- 文面は書き出し済み 10 通を**無加工**（`generate_plain_content: false`）

計画の単一源: `src/lib/marketing/sendgridSingleSendPlan.js`
（27 通の組み立て / 予約時刻の算出 / 総送信数の見積り。**予約は計画に含めない**）

### 生成スクリプト（既定は下見）

```bash
cd /Users/user/Projects/analytics-keiba
# 下見（27 通を組み立てて全件検証・1 通も作らない）
netlify dev:exec --context production -- node astro-site/scripts/sendgrid-create-single-sends.mjs
# 作成（**承認後**。作っても draft のまま・予約しない）
netlify dev:exec --context production -- node astro-site/scripts/sendgrid-create-single-sends.mjs \
  --apply --confirm "CREATE AK SINGLE SENDS"
```

| 守っていること | どう守るか |
|---|---|
| **送らない・予約しない** | `send_at` を**組み立てない**。`/schedule` `/send` `/trigger` は URL の形で拒否。作成物は **draft** |
| 二重作成しない | 名前（`AK Prospect Selection s{start} m{nn}`）が識別子。同名は飛ばす |
| 文面を変えない | 書き出しファイルをそのまま。`generate_plain_content: false` |
| 宛先を間違えない | list id / sender id / group id を**引いてから**組む。1 つでも欠ければ何も作らない |
| segment を使わない | `send_to` は `list_ids` だけ |
| 作る前に確かめる | **27 件すべて**で subject / html / plain / list / sender / group / 予約なし を検証。NG が 1 件でもあれば作らない |
| 作った後も確かめる | GET で 1 件ずつ突き合わせ（`全件一致` が false なら異常終了）|

### 下見の結果（2026-09-18 / 本番 read-only）

```
SingleSend数 27（10 / 9 / 8）・間隔 1 日・最長 9 日
検証NG 0 ／ 既に存在 0
list 3 本・sender 9739270・unsubscribe group 34108 をすべて解決
```

### ✅ 案 B を採用：01 / 02 / 03 / 10 を**期限なしの選別用文面へ差し替え**（2026-09-18 MK 確定）

**割引期間（`CAMPAIGN_WINDOW`）はメール都合で延ばさない。10 通での選別も維持する。**
よって期限を含む 4 通だけを、選別用の**期限なし文面**へ差し替えた。

| 通 | 新しい役割 | CTA の行き先 |
|---|---|---|
| 01 | ご挨拶（この配信は何か・いつでも停止できる）| `/free-prediction/jra/` |
| 02 | 中央競馬（JRA）の予想ページの中身 | `/free-prediction/jra/` |
| 03 | 南関競馬（大井・船橋・浦和・川崎）の予想ページ | `/free-prediction/nankan/` |
| 10 | 有料プランで増えるもの（**金額は書かない**）| `/pricing/` |
| 04〜09 | **変更なし**（日付を含まないため）| 従来どおり |

単一源: `src/lib/marketing/prospectSelectionSteps.js`（差し替えは**描画の入力だけ**）

#### 差し替えで**変えていないもの**（ここが最重要）

| 変えないもの | 理由 |
|---|---|
| 通し番号 ↔ (campaignId, step) の対応 | 「誰が何通目まで受け取ったか」の判定がズレる |
| **`DeliveryKey`** | 鍵は campaign × version × step × 受信者で決まり**本文に依存しない**（テストで固定）|
| **next_message** | 上記が不変なので動かない |
| `campaignDiscountSteps.js` / `prospectPhase2Steps.js` | **catalog は 1 バイトも触らない**（旧 AK 経路と Customers 向け割引は現行のまま）|

#### 既送信の号を送らないことの**機械保証**

- 人は `next_message = highestSent + 1` の list にだけ入る
- start-N の list が受け取るのは **N〜10 だけ**（27 通の計画がそう組まれている）
- したがって **highestSent 以下の号は構造的に送られない**
- `prospectSelectionSteps.test.mjs`「【機械保証】既に受け取った通し番号は二度と送られない」で固定

#### 品質ガード（機械）

固定日付ゼロ（10 通すべて）／期限つき判定で 0 件／割引前提の表現なし／**金額を書き写さない**／
禁止表現・実績数値の手書きなし／CTA は**着地先で本当に見られるものだけ**を約束
（`emailCopyStandard` の `promise_not_on_landing_page` が `/free-prediction/` で伏せている
買い目・AI 総合指数・評価ポイントを検出）／件名 10 通すべて別。

#### 差し替え後の再監査（本番 read-only / 2026-09-22 開始で判定）

```
期限つきの通 [] ／ 成立 true ／ 違反 0
SingleSend数 27（10 / 9 / 8）／ 検証NG 0 ／ 既に存在 0
```

**任意の開始日で成立する**（`2026-09-19` / `2026-10-01` / `2027-01-05` でテスト固定）。

⚠️ **Design Library の 01 / 02 / 03 / 10 は旧文面のまま**。Single Send は本文を自分で持つので
配信には影響しないが、**参照しない**（整理は別途判断）。

### （historical）🛑 差し替え前の成立判定（2026-09-18）

**10 通のうち 4 通（01 / 02 / 03 / 10）に「2026年9月23日まで」が入っている。**
期限の正本はキャンペーン期間（`campaignOffers.CAMPAIGN_WINDOW` = 2026-09-10 〜 **09-24 00:00 JST**）で、
**期間外はサーバーが 1 円も割り引かない**。

| 通し番号 | 期限表記 | 判定 |
|---|---|---|
| 01 / 02 / 03 | あり（件名にも）| 期限日までに届けば成立 |
| 04〜09 | **なし** | **いつ送っても成立** |
| 10 | あり（価格の注記）| 期限日までに届けば成立 |

#### ⚠️ 現行の期間では**どの開始日でも成立しない**

10 通目が最後に出るので、**開始日 + 9 日（start-1）**が期限を越えてはいけない。

| list | 10 通目の day offset | **最遅の開始日** |
|---|---:|---|
| start-1 | day 9 | **2026-09-14**（既に過去）|
| start-2 | day 8 | **2026-09-15**（既に過去）|
| start-3 | day 7 | **2026-09-16**（既に過去）|

例（2026-09-19 開始の下見の実測）: 10 通目が start-1 **09-28** / start-2 **09-27** / start-3 **09-26**
＝ すべて期限を **3〜5 日超過**。01〜03 と 04〜09 は成立する。

#### 開始日 S を決めたときに必要な「まで」表記

**S + 9 日**（3 本同時に走らせるときの最後の通）。例: S = 09-22 なら **10-01 まで**が要る。

#### 取りうる選択（**どれも未実行・承認が要る**）

| 案 | 中身 | 影響 |
|---|---|---|
| A | `CAMPAIGN_WINDOW.endsAtIso` を **S + 9 日以降**へ取り直す | コード変更 + deploy。**サイトの割引適用期間も伸びる**（メールと画面が同じ値を使うのが正本）|
| B | 期限つき 4 通を**期限の無い文面に差し替える** | canonical を変える＝AK 側の `DeliveryKey` と食い違う。**再送禁止の前提に触る**ので要検討 |
| C | 期限つき 4 通を**今回の選別から外す**（04〜09 の 6 通だけ配る）| 10 通で選別する設計が崩れる（delivered 10 に届かない）|

⚠️ **機械で止める**: 生成スクリプトは `checkDeadlineFeasibility()` で成立を確かめ、
**成立しない計画では `--apply` を渡しても 1 通も作らない**（`npm run test:marketing` で固定）。

#### ⚠️ 移行で新しく生まれる危険（記録）

Single Send は**本文を自分で持つ**ので、期間が終わって `isCampaignActive()` が false になっても
**予約済みのメールは止まらない**。AK 側は期間外に割り引かないため、放置すると
**「案内は届くのに割引が乗らない」**（2026-08-25 と同型）になる。
期限つきの通を予約する前に、必ず上の判定を通す。

### ✅ 27 Single Send を draft で作成 完了（2026-09-18）

| 項目 | 実測 |
|---|---|
| 作成 | **27 件**（201 Created × 27・失敗 0）|
| status | **draft × 27**（`send_at` は **全件 null** ＝ 予約なし）|
| 検証 | GET で 1 件ずつ突き合わせ **27 / 27 一致**（subject / html / plain / list / sender / group）|
| 宛先 | list 3 本のみ（`segment_ids: []` / `all: false`）|
| 開封計測 | **27 / 27 で有効**（保存後の HTML 先頭に `%sg_open_track%`）|
| 再実行 | 同名は `skipped_existing`（**二重作成しない**）|

⚠️ SendGrid は保存時に **`%sg_open_track%`（開封ピクセル）を HTML 先頭へ付ける**。
これは provider 側の正常な加工なので、突き合わせでは**そのタグだけ外して**比べる。

---

## 11-f. 🛑 cutover 前提「反応したら選別から外れる」は**いまの構成では成立しない**

判定の単一源: `src/lib/marketing/sendgridExitReadiness.js`（実測値をテストで固定）

| 離脱の引き金 | 検知できるか | 次の号から外れるか | 外す役 |
|---|---|---|---|
| **bounce** | ✅ webhook `bounce: true` | ✅ **自動** | SendGrid suppression |
| **苦情（spam report）** | ✅ `spam_report: true` | ✅ **自動** | SendGrid suppression |
| **配信停止（unsubscribe）** | ⚠️ **AK に届かない**（`group_unsubscribe: false`）| ✅ **自動** | SendGrid suppression（group 34108）|
| **開封（open）** | ✅ 開封計測 ON ＋ webhook `open: true` | ❌ **外れない** | **誰も外していない** |
| **click** | ❌ **計測が無効**（`/v3/tracking_settings/click` = disabled・webhook `click: false`）| ❌ | — |
| **サイト再訪 / CTA 反応** | ❌ リンクに受信者識別子が無く**紐付け不可** | ❌ | — |
| **購入** | ❌ prospect の反応として扱う配線が無い | ❌ | — |

### なぜ外れないのか（構造）

Single Send は**送信時点の list の中身**へ送る。したがって
**送信前に list から外せていれば、その号には入らない**。
ところが **list から外す処理が動いていない**（`buildExitPlan()` /
`removeContactsFromList()` は実装済みだが、呼ぶのは未 deploy の管理 API だけで、
定期実行の配線が無い）。**開封した人にも 10 通届く。**

### ✅ 採用：**既存 webhook の中で選別 list から即時に外す**（2026-09-18 MK 確定）

**新しい cron も配送エンジンも作らない。** 既に open / bounce / 苦情 / 配信停止を受けている
`sendgrid-webhook.js` の処理の中で、そのまま list から外す。
除去は**即時 2 回再試行**し、失敗したら **SendGrid Event Webhook の非 2xx 再送（最大 24 時間）**で
再試行する。⚠️ **「必ず最終的に外れる」わけではない**（再送の窓を過ぎても失敗が続けば残る）。

| 外す相手 | きっかけ |
|---|---|
| `ENGAGED` | open（＝反応候補）→ 選別完了・DRM へ |
| `PROMOTED` | Customers へ昇格（購入・登録）|
| `SUPPRESSED` | 配信停止 / bounce / 苦情（`group_unsubscribe` を含む）|
| `EXHAUSTED` | delivered 10 通・無反応で打ち切り |

単一源: `src/lib/marketing/sendgridSelectionExit.js`

| 守っていること | どう守るか |
|---|---|
| **KI / KMA に触らない** | 触るのは名前が `ak-prospect-select-start-N` の list だけ（名前で突き合わせてから id を使う）|
| **API の範囲を閉じる** | `GET /v3/marketing/lists` / `POST /v3/marketing/contacts/search/emails` / `DELETE …/lists/{id}/contacts` の **3 つだけ**。送信・contact 作成・suppression 操作の経路を持たない |
| **べき等** | 状態が変わった人だけを対象にし、同じ webhook 内の重複は 1 回に畳む（大文字小文字も同一視）。SendGrid は既に居ない相手でも 202 を返すので二度実行しても害が無い |
| **暴走しない** | 1 回の webhook で外すのは最大 100 名（超過分は数えて次のイベントで回収）|
| **反応者の失敗は握り潰さない** | `ENGAGED` / `PROMOTED` を外せなかったら **503 を返して SendGrid に再送させる**（AK に queue を作らない）。一時障害は**同じ呼び出しの中で 2 回まで再試行**してから判断する |
| 抑止側は 200 のまま | `SUPPRESSED` / `EXHAUSTED` は **provider の suppression が list と独立に効く**ので、外し損ねても届かない。再送を求めない |
| **再送しても二重に数えない** | `sg_event_id` を鍵に **1 回だけ**通す（`webhookEventOnce.js` / Redis・TTL 7 日）。`recordDelivered()` は呼ぶたびに +1 するので、この印が無いと再送で**打ち切りの分母が狂う** |
| 再送を求めてよい条件 | **重複を防げているときだけ**（`sg_event_id` が無い / Redis 不通なら `guarded:false` → 503 にしない）|
| 再送の 2 回目で外せる | 状態が変わっていなくても「いまの状態が除外対象なら」対象へ積む（2 回目は `changed:false` になるため）|
| 未投入は失敗ではない | contact 検索で**見つからない**のは「まだ入れていない人」。**検索が HTTP で失敗した**ときだけ失敗扱い |
| **PII を出さない** | 応答・ログは件数だけ（`changes` は webhook の応答から落とす）|
| **止め方** | `SENDGRID_SELECTION_EXIT_DISABLED=true` の 1 つ。**既定は有効**（env を足さなくても動く）|

⚠️ **click tracking は今回有効化しない。サイト再訪の識別も追加しない**（MK 確定）。
open は「反応候補」として ENGAGED へ進め、**打ち切りの判定は delivered 10 通のまま**変えない。

#### `group_unsubscribe` トグルについて（**コード側の受け入れ準備は完了**）

`classifyEvent('group_unsubscribe')` は既に**抑止**として扱い、`SUPPRESSED` にしたうえで
選別 list からも外す（テストで固定）。したがって SendGrid 画面で

> Settings → Mail Settings → Event Webhook → **Group Unsubscribe を ON**

にして問題ない（**1 操作**）。ON にしなくても SendGrid 側の除外は効くが、
**AK 台帳に配信停止が残らない**。

### （historical）🔎 「SendGrid の Segment だけで開封離脱」は**成立しない**（2026-09-18 本番実測）

`POST /v3/marketing/segments/2.0` の**バリデータ**に式を投げて確かめた
（**不正な式は何も作らずに 400**。作成できてしまった検証用 segment は**すべて削除済み**で、
残っているのは `keiba-intelligence` のみ）。

| 試した式 | SendGrid の返答 |
|---|---|
| `CONTAINS(list_ids, '…')` | `unsupported SQL function: 'CONTAINS'` |
| `last_opened is null` | `illegal column name … 'last_opened' referenced for table: 'contact_data'` |
| `last_clicked` / `last_emailed` / `singlesend_id` / `automation_id` | 同上（**contact_data に無い**）|
| `select … from singlesend_data / automation_data / engagement_data / email_activity / message_data / singlesends / events / campaign_data` | すべて **`illegal table name`** |
| `list_ids` / `email` / `created_at` | **201 Created**（使える）|

→ **この本番アカウントの Segment V2 では、engagement（open / click / Single Send 別の反応）を
条件にできない。** 使えるテーブルは `contact_data` だけで、engagement の列も表も無い。

⚠️ `GET /v3/marketing/field_definitions` の `reserved_fields` には `last_opened` などが
**載っている**が、Segment のクエリでは**使えない**（載っていることと使えることは別）。
⚠️ 確かめたのは **API のバリデータ**。**画面の segment builder に engagement 条件が出るかは未確認**。
出るのであれば「segment を作って Single Send の宛先にする」案は成立しうる（**MK が画面で 1 回見れば確定**）。

#### では何が最小か（**新しい日次 cron は作らない**）

**既にある Event Webhook の中で list から外す。**
`sendgrid-webhook.js` は open / bounce / 苦情 / 配信停止を受けて prospect の状態を
すでに更新している。**その同じ処理の中で `removeContactsFromList()` を呼ぶ**のが最小で、

- **新しい cron を作らない**（既存 Function の延長）
- 除去は**即時 2 回再試行 ＋ 非 2xx 再送（最大 24 時間）**で再試行する
  （**「必ず外れる」ではない**。窓を過ぎても失敗が続けば残るので、そのときは人手で回収する）
- 実装は既にある（`buildExitPlan()` / `removeContactsFromList()`）。配線だけ

判定の単一源: `sendgridExitReadiness.js`（`SEGMENT_CAPABILITY` / `chooseExitMechanism()`）

#### ⚠️ open を主シグナルにすることの限界（正本）

| 限界 | 中身 |
|---|---|
| 誤検知 | **Apple Mail Privacy Protection** などが画像を先読みし、**開いていない人にも open が立つ** |
| 検知漏れ | 画像ブロック環境では、**開いた人でも open が立たない** |
| 方針 | open は「反応の可能性」であって「人の意思」ではない。**打ち切り（EXHAUSTED）の判定は delivered 10 通の既存ルールのまま変えない**。誤って外す方向は「送りすぎない」側に倒れるので、選別の目的とは矛盾しない |

### 最小の直し方（**自前の配送基盤は作らない**）

| # | 直すこと | やり方 | 新規実装 | 承認 |
|---|---|---|---|---|
| 1 | **list からの除外を定期実行**する | 既にある `buildExitPlan()` ＋ `removeContactsFromList()` を cron から呼ぶ（**1 日 1 回・送信前**）。対象は ENGAGED / PROMOTED / SUPPRESSED / EXHAUSTED | **無し（配線のみ）**| deploy |
| 2 | Event Webhook の **`group_unsubscribe` を ON** | SendGrid 画面のトグル 1 つ（AK 台帳に SUPPRESSED を残すため。除外自体は既に自動）| 無し | SendGrid 設定 |
| 3 | **click は当てにしない** | click tracking は**アカウント全体設定**で、ON にすると transactional の magic link まで書き換わる。**open を主シグナル**にする（既存方針どおり）| 無し | 方針判断 |
| 4 | **購入は「昇格した人」として外す** | 1 の対象集合に `PROMOTED` と Customers 在籍を含める | 無し | deploy |
| 5 | **サイト再訪は今回使わない** | 受信者識別子をリンクへ足す実装が要る（範囲外）。選別完了後に別途判断 | 要（見送り）| 方針判断 |

⚠️ **1 が入るまで contact を投入しない。** 投入すると「開封した人にも 10 通届く」状態で走り出す。

### 残る承認地点

1. **27 通の作成**（draft のまま）
2. contact 投入（通し番号別に 3 本の list へ）
3. **予約**（`buildSchedule()` で日付を与え、`/v3/marketing/singlesends/{id}/schedule`）
4. 旧 AK prospect 配信の停止 → 二重稼働 0 の確認

---

## 12. 本番切替までに必要な確認（**未完了**）

| # | 確認項目 | 状態 |
|---|---|---|
| 1 | Marketing Campaigns Advanced の契約プラン（公表値と枠）| ⚠️ **API が 403**。未契約 or キー権限不足（§11）|
| 2 | 元 15,509 件の突合（AK 側の所在・状態）| ✅ **完了**（2026-09-18 / 台帳ユニーク 15,556 → active 11,426 / engaged 194 / blocked 28 / 索引外 3,908）|
| 3 | 通し番号別の件数 | ✅ **完了**（1:328 / 2:3,692 / 3:7,734 / 4〜10:0）|
| 4 | 残送信総数と月間 email 枠 | 残送信 **98,380 通**（実測）。**枠は未確認**（§11 の 403）|
| 5 | 現在の sender / domain authentication を再利用できるか | **未確認** |
| 6 | unsubscribe group（`AK Marketing`）| **未作成**。既存は KI 用と test のみ（実測）|
| 7 | Event Webhook（既存経路がそのまま使えるか）| 設計上は可（`custom_args` 非依存）・**未検証** |
| 8 | Automation へ移植する 10 通の文面 | `content` で生成可・**未投入** |
| 9 | seed contact だけの E2E | **ローカルで完了**（`sendgridMigrationE2E.test.mjs`）|
| 10 | 二重送信 0 | 設計・テストで担保・**本番未検証** |

---

## 13. 検証

```bash
cd astro-site
npm run test:marketing   # 本移行のテストを含む（sendgrid*.test.mjs）
npm run check:fn-no-undef
```

固定している契約: 通し番号 3+7=10 / 鍵が既存と一致 / 再送禁止（`highestSent+1`・穴を埋めない・
読めなければ送らない）/ ready 以外を出さない / 通し番号ごとに別 list / 1 日 1 通 /
0 人の入口を作らない / 退出は全 list から外す / 配信停止タグが消えたら出さない /
ゲートが閉じていれば 1 リクエストも出さない / 二重稼働を拒否する / 最小プランを選ぶ /
コードに金額を持たない。

---

## 14. 予約の直前に list を AK へ合わせ直す（**reconcile** / 2026-09-19 追加）

### なぜ要るか（2026-09-19 の実測）

contact を投入したあと、**遅れて届いた `delivered` イベント**で AK の
「次に送る番号」が 2 → 3 へ進んだ人が出た。SendGrid 側は投入時のまま
（`ak_next_message = 2` / `start-2` 在籍）なので、**そのまま予約すると 2 通目が再送**される。
反応して離脱した人が list に残る取りこぼしも同じ形で起きる。

**これは「3 名を手で直す」話ではない。** 配送は非同期に遅れて届くので、
**予約の直前に毎回**、AK を正本として list を貼り替える。cutover のたびに再利用する。

### 正本（この順序で判定する）

1. **AK が正本**。SendGrid の `ak_next_message` も list 在籍も AK に合わせる
2. 送ってよい人（`READY`）は**自分の通し番号の list だけ**に居る
3. 送ってはいけない人（ENGAGED / PROMOTED / SUPPRESSED / EXHAUSTED / Customers 昇格済み）は
   **3 本すべての list に居ない**
4. **AK の list 以外には触らない**（KI / nankan / review の資産を巻き込まない）
5. **`provider rejected` は対象外のまま**。直し方が無いので「直った」ことにしない

### 順序（**remove → add**）

先に add すると、旧 list と新 list の**両方に居る瞬間**ができる。
その瞬間に予約が走れば 2 通届く。だから **必ず remove が先**。
順序は `reconcileSteps()` が固定し、guard テストで「remove の分岐が add より前」を検査する。

### 使い方

| 呼び出し | 何をするか |
|---|---|
| `{action:'reconcile', scope:'active', offset, limit}` | 送ってよい人の窓。**下見のみ**（既定）|
| `{action:'reconcile', scope:'excluded', offset, limit}` | 反応・抑止・打ち切り側の窓。**下見のみ** |
| 上記 ＋ `apply:true, confirm:'MIGRATE PROSPECTS TO SENDGRID'` | 実行（**`SENDGRID_MIGRATION_WRITE_ENABLED=true` が要る**）|

- 応答は**件数だけ**（アドレスを返さない・ログへ出さない）
- `RECONCILE_LIMITS.maxChanges`（3,000）を越える計画は**実行しない**で人に返す
- 旧 AK がまだ prospect を送る設定（`engine=ak`）なら**貼り替えない**（二重稼働の上で触らない）
- アドレスを持たない prospect レコード（purge 済み）は**触らず数えるだけ**

判定の単一源は `src/lib/marketing/sendgridListReconcile.js`、
テストは `sendgridListReconcile.test.mjs` と `sendgridReconcileHandler.guard.test.mjs`。

### 壊れた宛先で巻き添えにしない（2026-09-19 本番実測）

SendGrid の contacts API は、**受理できない宛先が 1 件でも混ざるとリクエスト全体を 400** で返す。
`PUT /v3/marketing/contacts`（投入）だけでなく **`POST /v3/marketing/contacts/search/emails`
（引き当て）でも同じ**ことを本番で踏んだ。

そのため reconcile は、引き当ても投入も **`runWithSplit()` で半分に割って再試行**する。
1 件まで割っても通らないものだけを `provider rejected` として**数える**
（**直せないものを直ったことにしない**）。応答に出すのは件数だけで、アドレスは出さない。

### 窓の大きさ（実測）

| scope | 安全な `limit` | 理由 |
|---|---:|---|
| `active` | **500** | 索引の窓読みと引き当てが同期 Function の時間に収まる |
| `excluded` | **50** | 反応済み・抑止側は 1 件ずつレコードを読むため、200 で時間切れ（500 を実測）|

---

## 15. 遅延 `delivered` の監視と「予約してよい」の判定（2026-09-19 追加）

旧 AK の prospect 配送を止めたあとも、**すでに送った分の `delivered` / `open` が
遅れて届き続ける**。届くたびに AK の通し番号と状態が動くので、
**動きが止まってから予約する**。

### 見る数（すべて read-only・アドレスを出さない）

| 記号 | 取り方 | 意味 |
|---|---|---|
| `A` | `{action:'scan'}` を全窓 → `indexSize` | AK の送信候補（active） |
| `D` | `{action:'scan'}` を全窓 → `次に送る番号別` | 通し番号の分布 |
| `E` | `admin-marketing` `{action:'prospectSequenceCheck'}` → `pool.反応済み未登録` | ENGAGED 数 |
| `L` | `GET /v3/marketing/lists` の `contact_count` 3 本 | list 在籍 |
| `R` | 正本に記録した `provider rejected` 件数 | SendGrid が受理しない宛先 |

### 不整合の定義

```
不整合 = |（A − R）− L合計|  ＋  Σ_n |D[n] − L[n]|  の食い違い分
```

- `A − R = L合計` なら**総数は合っている**
- 総数が合っていても **通し番号ごと**（`D[n]` と `L[n]`）がずれていれば、
  その人数だけ「間違った list に居る」＝**再送になる**

### 安定判定（**これを満たすまで予約しない**）

**30 分間隔で 3 回**続けて、次の 3 つがすべて動かないこと（＝**最低 1 時間**の静止）:

1. `E`（ENGAGED 数）が増えない
2. `D`（通し番号の分布）が変わらない
3. `L`（list 3 本の在籍数）が変わらない

1 つでも動いたら、**動いた時刻を「遅延 delivered の最終観測時刻」として記録**し、
そこから数え直す。静止を確認したら **reconcile の下見 → 実行 → もう一度下見で変更 0 件**
を確認し、そのうえで予約する。

### 記録すること

- 各回の観測時刻・`A` / `D` / `E` / `L`
- 遅延 `delivered` の最終観測時刻
- reconcile の下見件数と実行件数（**アドレスは書かない**）
