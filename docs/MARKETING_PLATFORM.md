# マーケティング基盤の構成（2026-09-18 MK 確定 / **最上位方針**）

> **この文書が責務境界の正本。** 「AK 独自配送を使う」「KMA を使う」「SendGrid を使う」が
> 同時に現行仕様として読める状態を禁じるため、**現行の姿はここだけに書く**。
> 他の doc が旧方針を述べている場合、この文書が優先し、旧記述は `superseded` として扱う。

関連: [`docs/spec.md`](./spec.md) 先頭（確定仕様）/ [`SENDGRID_MC_MIGRATION.md`](./SENDGRID_MC_MIGRATION.md)（移行手順）/
[`docs/decisions.md`](./decisions.md) 2026-09-18 / [`docs/progress.md`](./progress.md) 先頭（現在地）

---

## 1. 最上位目的（これを見失わない）

**目的は「自前のメール配送基盤を完成させること」ではない。**

> **顧客・prospect の行動を把握し、適切な CTA とメールマーケティングを行い、
> 有料転換・継続売上につなげること。**

大量メール配送は**自作しない**。配送と配送反応は専門サービスへ任せ、
AK は**顧客状態・行動・販売・CTA・マーケティング判断**に集中する。

---

## 2. 現行の構成（一意）

```
  AK（顧客状態・行動・販売判断・CTA・DRM）
     │  誰を・どの段階で・何通目から渡すか
     ▼
  SendGrid Marketing Campaigns（Contacts / List / Segment / Automation / 一斉 / drip / 配送）
     │  processed / delivered / open / click / bounce / dropped / unsubscribe / spam report
     ▼
  Event Webhook → AK（顧客状態へ反映 → 次の CTA・次の campaign を決める）
```

| 主体 | 役割 | 状態 |
|---|---|---|
| **AK**（`analytics-keiba`）| マーケティングの**頭脳**。顧客・prospect・会員状態・購入・行動・CTA 段階・DRM 段階・除外状態・次の訴求の判断 | **現行・強化していく** |
| **SendGrid Marketing Campaigns** | **配送装置**。Contacts / Lists / Segments / Automation / 一斉メール / drip / 配送反応 | **現行（移行中）** |
| **`/admin/premium-plus-eligibility/`** | AK のマーケティング運用画面（顧客カルテ・対象抽出・販売導線）| **維持・強化** |
| **KMA**（`keiba-marketing-automation`）| 過去配信実績・照合・rollback 材料の保管 | **凍結 → 移行確認後に廃止候補**（新規機能追加 禁止・削除も禁止）|
| **KI**（`keiba-intelligence`）| 別サービス。将来は**自分で** SendGrid MC を使う | **今回は調査・方針整理のみ。実装変更しない** |
| **旧 AK 自作配送**（cron / queue / dispatcher / `CampaignDeliveries` / `ScheduledEmails` / Redis delivery state）| 既送信判定・二重送信防止・突合・rollback・過去実績の**資産** | **削除禁止**。本番切替が確認できるまで保持。**新規強化はしない** |

### 中間層を育てない

**`AK → KMA → SendGrid` という中継構成を原則としない。** AK は SendGrid を直接使う。
KI も将来は直接使う（`AK → SendGrid` / `KI → SendGrid`）。**KMA を必須中継点にしない。**

### この方針の対象外（変えない）

**取引メールは対象外。** 決済確認・マジックリンク認証・サポート返信・期限通知・
Premium Plus の個別連絡などは、従来どおり AK が送信 API 経由で送る。
本方針が扱うのは **`EmailType='campaign'` のマーケティング配信だけ**。

---

## 3. AK が保持するもの（SendGrid へ移さない）

- 顧客 / prospect / 会員状態 / 商品購入状態
- Premium・Light・Premium Plus・三連複などの **AK 固有の権利情報**
- 誰がいつアクセスしたか / どのページを見たか / CTA への反応 / サイト内 engagement
- メール反応を含む顧客状態（delivered / open / click / bounce / unsubscribe）
- DRM 段階 / marketing stage / 必要なら HOT・WARM・COLD 等の事業分類
- `SUPPRESSED` / `EXHAUSTED` など **AK としての除外状態**
- 次に何を訴求するか / CTA をどの段階まで出すか
- **SendGrid へ誰を渡すかの事業判断**

⚠️ **SendGrid へ事業ロジックを移さない。** SendGrid が持つのは「配送と配送反応」だけで、
会員状態・購入状態・CTA 段階・DRM 判断の正本は**各事業 repo 側**に残す。

---

## 4. `/admin/premium-plus-eligibility/` は維持・強化する

KMA を縮小する以上、**AK のこの画面が運用の中心**になる。廃止しない。

### 最終的に 1 画面で把握したいもの（目標のデータ契約）

```text
最終アクセス      2026-09-18 07:42
直近閲覧          /premium-plus-v2/
訪問回数          6
現在プラン        Free
選別メール        3/10
Open              2
Click             1
Premium閲覧       済
購入              未
Marketing Stage   HOT
CTA Stage         Premium申込訴求
次アクション      SendGrid campaign B
```

### いまあるもの / 足りないもの（**推測で「ある」と書かない**）

| 項目 | 現状 | 単一源 |
|---|---|---|
| 会員プラン・権利・購入状態 | **ある** | `entitlements/resolveEntitlements.js` |
| 最終ログイン（出所 3 種を明示）| **ある** | `customerDossier.js` |
| 配信回数 / delivered / open / click / bounce / unsubscribe | **ある**（click は provider 側 OFF のため実質 0）| `customerTimeline.js` / `webhooks/emailEventLedger.js` / `engagementSignalStore.js` |
| 選別の進み（何通目 / 10 通中）| **ある**（prospect 側）| `sendgridNextMessage.js` / prospect `delivered` |
| 除外状態（SUPPRESSED / EXHAUSTED / engagement）| **ある** | `prospectPolicy.js` / `engagementPolicy.js` |
| DRM 段階 | **ある** | `drm/drmFunnel.js` |
| 次アクション候補 | **ある**（推奨の形）| `recommendedActions.js` |
| Premium Plus の閲覧・CTA 反応 | **ある**（PP の面に限る）| `premiumPlus/premiumPlusFunnel*.js` |
| **サイト全体の最終アクセス / 訪問回数 / 閲覧ページ** | ❌ **無い**（PP の面以外は未計測）| — |
| **marketing stage（HOT / WARM / COLD）** | ❌ **無い**（概念が未定義）| — |
| **次に送る campaign の確定表示** | ❌ **無い**（SendGrid 移行後に確定）| — |

⚠️ **今回この画面を大改修しない。** まず正本・データ契約・責務境界を確定する。
不足 3 項目は、移行後に**別 Phase**で設計する（何を計測してよいか・保持期間・PII の扱いを先に決める）。

⚠️ URL 名 `premium-plus-eligibility` は将来の役割に対して狭いため
`/admin/marketing/` 等への整理**候補**とするが、**現時点では URL を変えない**（決定ではない）。

---

## 5. 15,000 件の選別施策（AK の最優先）

```text
約15,000件 → 1日1通 → 最大10通 → 反応を見る
          → 10通送っても無反応なら除外
          → 反応したアドレスを残す → 残った見込み客で継続DRM
```

- **原則 1 日 1 通 × 最大 10 通。** 「10 通を数週間・数か月かけて送る」設計にはしない
- ただし次のいずれかは**途中でも即除外**する:
  unsubscribe / hard bounce / spam complaint / 永久除外 / 購入済みで不要になった訴求 /
  その他、安全上送るべきでない状態
- 既送信の引き継ぎ（**全員 1 通目から送り直さない**）は
  [`SENDGRID_MC_MIGRATION.md`](./SENDGRID_MC_MIGRATION.md) の通し番号 1〜10 が正本
- 元 15,509 件・prospect 移行件数・既送信 step は**推測しない**。既存データから read-only で突合する
  - ⚠️ **15,509 はアドレス一覧の件数ではない。** repo の記録では
    「割引キャンペーン 3 本の **1 通目が 3 区分あわせて 15,509 通 届いた**」（2026-08-24〜09-07）で、
    Customers 由来と prospect 由来が混ざっている。**アドレス単位への展開は未実施**
    （現在地は [`docs/progress.md`](./progress.md) 先頭）

### 選別後の通常運用

残った見込み客（仮に約 5,000 件）へ **週 2 回程度の一斉メルマガ**を基本運用候補とする。

```text
5,000件 × 週2回 ≈ 月8回 ≈ 月40,000通
```

内容は 新しい予想情報 / 無料コンテンツ / Premium / Light / Premium Plus / キャンペーン /
有料転換 / 再訪促進。**頻度は将来データを見て調整可能**（現時点の基本案が週 2 回）。

---

## 6. 費用の考え方

**月額およそ 1〜2 万円程度（目安 1.6 万円）の外部配送費は、事業コストとして許容する。**
開発時間と事故リスクを削減できるなら、その方が事業上は安い。

⚠️ **価格・プラン名称・送信上限・Automation 条件を「不変の仕様」としてコードや正本へ固定しない。**
これらは変動する。**契約直前に必ず SendGrid 公式の現行条件を確認する。**
枠に収まるかの判定は `sendgridPlanSizing.js`（**金額を持たない**）。

**課金変更（契約 / アップグレード / ダウングレード）はすべて実行直前で停止し MK 承認を取る。**

---

## 7. Build vs Buy（今回の反省を原則にする）

大量メール配送のように**成熟した専門サービスが存在する機能**は、着手前に必ず
**Build vs Buy を比較する**。

**再発させないこと**: 自前 queue / 自前 cron / 自前 dispatcher / 自前の大量送信制御 /
独自冪等性 / 独自 retry / 独自 batch 制御 / 独自配信 Automation を何か月も作り込み、
**本来の売上施策が止まる**こと。

事業上の差別化にならない基盤部分は、合理的なら外部サービスを使う。
差別化になるもの（予想ロジック / 顧客状態 / CTA 判断 / DRM）は自前で持つ。

---

## 8. Event Webhook（配送反応を AK へ戻す）

| イベント | 扱い |
|---|---|
| `processed` | 送信受理。**配達ではない** |
| `delivered` | 配達成功。**打ち切り（10 通無反応）の分母** |
| `open` | 弱いシグナル。**単独で購入意向と見なさない**（画像ブロック / プリフェッチで歪む）|
| `click` | より強いシグナル。ただし現状 provider 側でリンク追跡が OFF のため**実質 0**。当てにしない |
| `bounce` / `dropped` | 即時除外（`SUPPRESSED`）|
| `unsubscribe` / `spam report` | 即時除外。**解除しない**（再取り込みでも復活させない）|

- 反応の**意味づけ**は AK 側で行い、**サイトアクセス・CTA・購入情報と組み合わせて**
  マーケティング状態を判断する
- 受信経路・署名検証は既存のまま（[`SENDGRID_WEBHOOK.md`](../astro-site/docs/SENDGRID_WEBHOOK.md)）。
  Automation 送信でも `custom_args` に依存せず `email` + `event` で判定できる

---

## 9. KMA（`keiba-marketing-automation`）

**凍結 → 移行確認後に廃止候補。いきなり削除は禁止。**

- **新規のマーケティング機能を KMA へ追加しない**
- 過去配信実績 / campaign / delivery state / suppression / webhook / migration / fence /
  audit / rollback 材料が残っている可能性があるため、**SendGrid 移行完了まで保持**する
- KMA を残す必要性が実データ・実装上で確認された場合、**勝手に延命せず
  「残す必要がある責務」として明示して報告**する
- AK は従来どおり KMA のテーブル（`CampaignDeliveries_MarketingAutomation`）を読み書きしない

### 廃止判断の条件（**すべて満たしてから、独立 Phase で**）

1. AK が SendGrid で安定配信できている
2. 過去の KMA / AK 配信実績が必要箇所へ保存されている
3. suppression が移行済み
4. unsubscribe が失われない
5. rollback 不要と判断できる
6. KMA だけに残る事業ロジックが無い
7. KI への影響が整理されている
8. env / cron / webhook / scheduler の依存関係が解消されている

---

## 10. KI（`keiba-intelligence`）

- 将来像は **`KI → SendGrid Marketing Campaigns` を直接利用**（KMA を必須中継点にしない）
- **今回は KI のコードを 1 行も変更しない。** 現状調査と将来方針の正本整理まで
- AK / KI 間で **customer / membership / campaign state / 商品 / 料金 / entitlement を混ぜない**
  （既存方針 [`KI_INDEPENDENCE.md`](../astro-site/docs/KI_INDEPENDENCE.md) を維持）

### SendGrid 上での分離方針（KI が使い始める前に満たすこと）

| 分離対象 | 方針 |
|---|---|
| ブランド / sender | **送信元ドメイン・sender を分ける**（AK の送信レピュテーションと混ぜない）|
| List / Segment | **名前空間を分ける**（`ak-…` / `ki-…`）。同じ list を共有しない |
| Automation | repo ごとに別 Automation。1 本を両者で使い回さない |
| unsubscribe group | **別 group**。片方の配信停止が他方を止めない・他方の配信が止まった相手へ届かない |
| custom field | `ak_` 接頭辞で分ける（KI は `ki_`）|
| contact | 同一アドレスが両方に居ても、**状態の正本はそれぞれの repo** |

---

## 11. 旧 AK 自作配送基盤の扱い

- **削除禁止**（cron / queue / dispatcher / `CampaignDeliveries` / `ScheduledEmails` /
  Redis delivery state / `DeliveryKey` / campaign state / prospect delivery state /
  webhook / suppression / 配信実績）
- 用途は **既送信判定・二重送信防止・対象件数の突合・rollback・過去実績の保存**
- **新規のマーケティング機能をここへ足さない**（不具合の修正と安全側の停止は可）
- ⚠️ **旧自作配送経路と SendGrid の本番大量配送を同時に live にしない**
  （`ak_live → frozen → sendgrid_live`。[`SENDGRID_MC_MIGRATION.md`](./SENDGRID_MC_MIGRATION.md) §7）
- 安定確認後、**廃止は独立 Phase**で判断する

---

## 12. この方針が上書きした旧方針（superseded）

| 旧方針 | 旧記述の場所 | いまどうなるか |
|---|---|---|
| AK 自作 cron / queue / rotation を**主配信エンジンとして完成させる** | `docs/spec.md`「マーケティングメールは完全自動運用（2026-09-14）」| **superseded**。同節のうち「人手承認・env 開閉・日次 ARMED を通常運用に要求しない」という**運用原則は有効**。配送の実行は SendGrid |
| 選別の実行は AK の `cron-campaign-sequence` | 同上 / `MARKETING_ROLLOUT.md` / `CAMPAIGN_SEQUENCE.md` | **移行対象**。切替までは現行として動くが、**新規強化はしない** |
| 大量配送の改善を AK 側で作り込む | 各 perf 系 PR の記録 | **終了**。以後は Build vs Buy を先に比較する |
| KMA は「統合しないが並存する別サービス」 | `CUSTOMER_MARKETING.md` / `PREMIUM_PLUS_STAGED_RELEASE.md` | **凍結 → 廃止候補**。統合しない点は不変 |

**変わらないもの**（今回の方針でも 1 つも緩めない）:
反応の定義 / delivered 10 通・無反応での打ち切り / unsubscribe・bounce・complaint の即時除外 /
二重送信防止（`DeliveryKey`）/ 取引メールへの不適用 / PII を docs・ログ・repo へ出さないこと。
