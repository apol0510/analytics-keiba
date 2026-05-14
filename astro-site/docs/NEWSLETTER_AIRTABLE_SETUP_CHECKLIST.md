# Newsletter Airtable 手動セットアップ チェックリスト（Customers 拡張）

**作成日**: 2026-05-14  
**改訂日**: 2026-05-14（調査レポート [NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md](./NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md) の発見を反映）  
**作業者**: マコさん（手動 Airtable UI 操作）  
**所要時間**: 約25〜35分  
**前提**: [NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md](./NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md) を読了済み

---

## 1. 目的

完全自動化メルマガ配信システムで以下を実現するため、Airtable `Customers` テーブルに **新規フィールド9個** を追加し、**既存 `Status` フィールドに選択肢を6個追加**する。

- **ブランド識別**: 顧客が analytics-keiba / keiba-intelligence のどちらに登録しているか判定
- **配信停止管理**: ブランドごとに独立した unsubscribe 状態を保持
- **会員状態管理**: 既存 `Status` フィールド（active / pending）に expired / unpaid / cancelled / refunded / withdrawn / test を追加
- **配信履歴**: 直近メルマガ送信のメタ情報を保持

これにより、以下の事故を構造的に防ぐ:
- 誤って analytics-keiba 顧客に keiba-intelligence のメールを送る
- analytics-keiba を停止した人に、なお analytics-keiba メールを送る
- 既に退会・返金した顧客に通常メールを送る

---

## 2. 作業対象

| 項目 | 内容 |
|---|---|
| 場所 | **Airtable Base**（nankan-analytics と共有しているもの） |
| テーブル | **`Customers`** |
| 操作 | **(A) 新規9フィールドの追加** + **(B) 既存 `Status` フィールドの選択肢を6個追加** |
| やってはいけない操作 | 既存テーブル削除 / 既存フィールド削除 / 既存レコード変更 / 既存 Status 選択肢 (`active` / `pending`) の削除・リネーム / Status の値の既存レコードへの一括設定 |

⚠️ 今回は**追加のみ**。既存データは触らない。  
特に **`Status` は既存運用中（bank-transfer-application.js / send-payment-confirmation.js が書き込み中）** なので、既存値を絶対に消さない。  
遡及付与（既存顧客に Brand を設定する）は **次のステップ (c)** で READ ONLY スクリプトを実行してから手動インポートする予定。

---

## 3. 追加フィールド一覧（新規9個 + 既存1個の選択肢追加）

> 🚨 **2026-05-14 改訂**: 調査レポート [NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md](./NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md) で
> `Status` フィールドが既に存在し、`bank-transfer-application.js` が `Status='pending'` を、
> `send-payment-confirmation.js` が `Status='active'` を書き込んでいることが判明。
> したがって `Status` は **新規追加せず、既存 Single select に選択肢を追加する**運用に変更する。

### 一覧表

| # | フィールド名 | 操作 | 型 | 選択肢 / 設定 | デフォルト | 用途 |
|---|---|---|---|---|---|---|
| 1 | `Brand` | **新規追加** | Multiple select | `analytics-keiba` / `keiba-intelligence` | （空） | ブランド識別 |
| 2 | `ServiceType` | **新規追加** | Multiple select | `analytics-keiba` / `keiba-intelligence` | （空） | 将来サービス分離用（当面 Brand と同値） |
| 3 | `AudienceType` | **新規追加** | Single select | `free` / `light` / `standard` / `premium` / `premium-combo` / `expired` / `unpaid` / `admin-test` | （空） | 配信対象セグメント判定 |
| 4 | `Status` | **既存・選択肢追加のみ** | Single select（既存） | 既存値 `active` / `pending` を**保持**し、`expired` / `unpaid` / `cancelled` / `refunded` / `withdrawn` / `test` の6個を**追加**する | 既存値のまま | 配信可否判定 |
| 5 | `UnsubscribedAnalyticsKeiba` | **新規追加** | Checkbox | — | `false`（unchecked） | analytics-keiba 配信停止フラグ |
| 6 | `UnsubscribedKeibaIntelligence` | **新規追加** | Checkbox | — | `false`（unchecked） | keiba-intelligence 配信停止フラグ |
| 7 | `UnsubscribedAtAnalyticsKeiba` | **新規追加** | Date（Include a time field: ✅ON） | — | （空） | analytics-keiba 停止日時 |
| 8 | `UnsubscribedAtKeibaIntelligence` | **新規追加** | Date（Include a time field: ✅ON） | — | （空） | keiba-intelligence 停止日時 |
| 9 | `LastNewsletterSentAt` | **新規追加** | Date（Include a time field: ✅ON） | — | （空） | 直近メルマガ送信日時 |
| 10 | `LastNewsletterBrand` | **新規追加** | Single select | `analytics-keiba` / `keiba-intelligence` | （空） | 直近送信ブランド |

### 各フィールドの Airtable UI 操作手順

各フィールドは右端の **`+` ボタン**（最後のフィールドの右隣）から追加する。

#### ① Brand（Multiple select）
1. `+` → フィールド名に `Brand` と入力
2. **Type** で `Multiple select` を選択
3. **Add options** で 2 つ追加:
   - `analytics-keiba`
   - `keiba-intelligence`
4. **Allow adding new options**: ❌ OFF（タイポ防止）
5. **Default value**: 設定しない（空のまま）
6. **Create field** クリック

#### ② ServiceType（Multiple select）
- Brand と同じ手順、フィールド名のみ `ServiceType`

#### ③ AudienceType（Single select）
1. `+` → `AudienceType`
2. **Type**: `Single select`
3. **Add options** で 8 つ追加（スペルを厳密に）:
   - `free`
   - `light`
   - `standard`
   - `premium`
   - `premium-combo`
   - `expired`
   - `unpaid`
   - `admin-test`
4. **Allow adding new options**: ❌ OFF
5. **Default**: 設定しない
6. Create

#### ④ Status（**既存フィールド** - 選択肢を追加するのみ）

⚠️ **Status は既存フィールド**。新規追加ボタン (`+`) を押してはいけない。  
既存値 `active` / `pending` が運用中なので、絶対に消さない。  
**選択肢を追加する**だけの操作になる。

1. 既存の `Status` フィールドのヘッダをクリック → **Customize field type**（または鉛筆アイコン → Edit field）を開く
2. 開いた画面で **既存選択肢が表示されている**ことを確認:
   - `active`（最低限あるはず）
   - `pending`（最低限あるはず）
   - その他の値があればメモ（**絶対に削除しない**）
3. **Add an option** から以下を**1個ずつ追加**（既存値の下に追加されればよい、スペル厳密）:
   - `expired`
   - `unpaid`
   - `cancelled`
   - `refunded`
   - `withdrawn`
   - `test`
4. **Allow adding new options**: ❌ OFF（既存設定を維持。既存が ON だった場合のみそのまま）
5. **Default**: 既存設定を維持（変更しない）
6. **Save** クリック（フィールドの再作成ではないので「Create field」ではなく「Save」ボタンになる）

##### Status が見つからない場合

- `Status` フィールドが見つからない場合は、**作業を停止して Claude（私）に報告**してください
- そのまま新規追加してはいけません（既存コードが想定する `Status` と衝突する可能性があるため、現状を確認してから方針を決めます）
- 想定: `Status` は Single select で `active` / `pending` を含むはず（[NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md §5.2](./NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md#52-重大-status-フィールド衝突の詳細) 参照）

##### 既存値・既存レコードへの影響

- 既存レコードの `Status` 値は**そのまま**（`active` / `pending` のまま変わらない）
- 既存値の **削除・リネームは絶対にしない**
- 新規追加した6選択肢は当面どのレコードにも値が入らない（手動操作 or 遡及付与スクリプトで後付け）

#### ⑤ UnsubscribedAnalyticsKeiba（Checkbox）
1. `+` → `UnsubscribedAnalyticsKeiba`
2. **Type**: `Checkbox`
3. **Style**: 任意（推奨 ✅ 緑チェック）
4. Create
   → 既存レコードは自動的に `false`（unchecked）になる

#### ⑥ UnsubscribedKeibaIntelligence（Checkbox）
- ⑤ と同じ手順、フィールド名のみ `UnsubscribedKeibaIntelligence`

#### ⑦ UnsubscribedAtAnalyticsKeiba（Date with time）
1. `+` → `UnsubscribedAtAnalyticsKeiba`
2. **Type**: `Date`
3. **Date format**: `ISO` 推奨（`YYYY-MM-DD`）
4. **Include a time field**: ✅ **ON**
5. **Time format**: 24-hour 推奨
6. **Use the same time zone (GMT) for all collaborators**: ❌ OFF（JSTで運用）
7. Create

#### ⑧ UnsubscribedAtKeibaIntelligence（Date with time）
- ⑦ と同じ手順、フィールド名のみ `UnsubscribedAtKeibaIntelligence`

#### ⑨ LastNewsletterSentAt（Date with time）
- ⑦ と同じ手順、フィールド名のみ `LastNewsletterSentAt`

#### ⑩ LastNewsletterBrand（Single select）
1. `+` → `LastNewsletterBrand`
2. **Type**: `Single select`
3. **Add options** で 2 つ追加:
   - `analytics-keiba`
   - `keiba-intelligence`
4. **Allow adding new options**: ❌ OFF
5. Create

---

## 4. 既存フィールドとの対応確認

Airtable で **以下の既存フィールドが存在するかどうか**を確認し、状態を記録する。

| 確認項目 | チェック | 想定される既存名 | 今後の扱い |
|---|---|---|---|
| メールアドレス | ☐ 存在 / ☐ なし | `Email` | そのまま継続使用（lowercase 正規化はコード側で） |
| 名前 | ☐ 存在 / ☐ なし | `Name` / `氏名` / `お名前` / `ユーザー名` | 任意。あればメール冒頭の `{{name}}` 置換で使用 |
| プラン | ☐ 存在 / ☐ なし | `プラン`（日本語が主用） / `Plan` / `PlanType` | **既存コードが多数参照中（send-newsletter, create-newsletter-queue, get-customer-stats 等）**。新規 `AudienceType` にマッピング、当面は並走 |
| **Status（既存）** | ☐ **必ず存在するはず**（既存値 `active` / `pending`） | `Status` | **既存コードが書き込み中**（bank-transfer = `pending`、send-payment-confirmation = `active`）。新規追加せず、選択肢を6個追加するのみ |
| 支払い方法 | ☐ 存在 / ☐ なし | `PaymentMethod` | bank-transfer が `'Bank Transfer'` を書く |
| 退会要求 | ☐ 存在 / ☐ なし | `WithdrawalRequested`（Checkbox） + `WithdrawalDate` + `WithdrawalReason` | process-withdrawal が書く。**新 `Status='withdrawn'` へ統合予定**、当面並走 |
| 配信停止（旧フィールド） | ☐ 存在 / ☐ なし | `メール配信`（unsubscribe.js が `'OFF'` を書く） | ⚠️ `send-newsletter.js` コメントは「{メール配信} は存在しない」と言っており**矛盾**。現物の有無を必ず確認 |
| 配信停止日（旧フィールド） | ☐ 存在 / ☐ なし | `配信停止日` | unsubscribe.js が `YYYY-MM-DD` 形式で書く |
| 有効期限 | ☐ 存在 / ☐ なし | `有効期限` / `ValidUntil` / `ExpirationDate` / `ExpiryDate` | ⚠️ **4種混在の可能性**。各関数で別名参照。実在するものを必ず特定 |
| 会場アクセス | ☐ 存在 / ☐ なし | `VenueAccess` | verify-magic-link が読む。例: `all` / `jra` |
| Lifetime Sanrenpuku | ☐ 存在 / ☐ なし | `LifetimeSanrenpuku` / `三連複Lifetime` | verify-magic-link が読む。買い切りフラグ |
| MailingList | ☐ 存在 / ☐ なし | `MailingList`（Multi-select） | send-newsletter のセグメント分けに使用 |
| 登録元 | ☐ 存在 / ☐ なし | `Source` | bank-transfer が `'nankan-analytics'` を書く |
| PaymentEmailSent | ☐ 存在 / ☐ なし | `PaymentEmailSent`（Checkbox） | verify-magic-link コメント参照。入金メール送信済フラグ |
| 最終ログイン | ☐ 存在 / ☐ なし | `LastLoginAt` / `最終ログイン` | あれば休眠セグメント判定に使う |

⚠️ **既存フィールドがあった場合の重要ルール**:
- 削除しない
- リネームしない
- 既存値を変更しない
- 重複する役割の新フィールド（例: `AudienceType` と既存 `プラン`）は **両方並走**させる。後ほど移行スクリプトでダブルライト方式に切り替える

⚠️ **`Status` フィールド固有のルール**:
- 既存値 `active` / `pending` は**絶対に削除・リネームしない**
- `bank-transfer-application.js` が `pending` を、`send-payment-confirmation.js` が `active` を書き込み続けるため、これらを消すと既存決済フローが壊れる
- 選択肢追加は「追加」のみで、既存選択肢には触らない

⚠️ **新規フィールド名と既存フィールド名が衝突した場合**:
- 衝突した名前を一時的に `<新規名>__New`（例: `LastNewsletterBrand__New`）にする
- このチェックリストに**衝突を記録**して、Claude（私）に報告
- 後でリネーム計画を立てる

詳しい既存挙動の根拠は [NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md](./NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md) を参照。

---

## 5. ブランド別配信停止の方針（再確認）

| ユーザー操作 | `UnsubscribedAnalyticsKeiba` | `UnsubscribedKeibaIntelligence` |
|---|---|---|
| analytics-keiba メール内 unsubscribe リンク | `true` にセット | 変更しない |
| keiba-intelligence メール内 unsubscribe リンク | 変更しない | `true` にセット |
| 両方一括停止リクエスト（サポート） | `true` | `true` |

- 配信時は `brand=analytics-keiba` のキャンペーンなら `UnsubscribedAnalyticsKeiba=false` のみ対象
- 既存 `unsubscribe.js` は**今回は触らない**（後で別タスクで `brand` パラメータ必須化に改修予定）
- 既存 `WithdrawalRequested=true` の顧客は、別ステップで `Status='withdrawn'` に移行（その時点で両ブランドの送信対象から外れる）

---

## 6. 作業前チェック（マコさん作業）

作業開始前に以下を確認・記録する。**この時点ではフィールド追加していない**。

### 6.1 基本確認

- [ ] **Airtable の現状フィールド一覧をスクショまたはメモ**
  - Customers テーブルを表示
  - 全フィールド名を列挙してメモ（後で差分確認に使用）
- [ ] **既存レコード件数を記録**
  - Airtable 右下の `<件数> records` を記録
  - 例: `15,432 records`
- [ ] **新規フィールド名と既存フィールド名が衝突しないか確認**
  - §3 の表で「新規追加」と書かれている**9個**を既存リストと突き合わせ
  - 衝突があれば一旦止めて Claude（私）に報告
- [ ] **作業対象 Base を間違えていないか確認**
  - Base 名: `nankan-analytics`（または analytics-keiba と共有しているもの）
  - keiba-intelligence の Base ではないこと（別 Base の場合）

### 6.2 `Status` フィールド事前確認（重要）

- [ ] **`Status` フィールドが既存テーブルに存在する**
  - ☐ 存在 → §3 ④ の手順で**選択肢追加のみ**実施
  - ☐ なし → **作業停止して Claude に報告**（想定外）
- [ ] **`Status` の既存選択肢を記録**
  - 期待値: `active` / `pending`
  - 実値: ___（その他があればメモ）
- [ ] **既存 `Status='active'` の件数を記録**: ___
- [ ] **既存 `Status='pending'` の件数を記録**: ___
- [ ] **既存 `Status` がその他の値の件数**: ___

### 6.3 既存 配信停止・期限関連フィールドの実在確認

- [ ] **`メール配信` フィールドの有無**
  - ☐ 存在 → 型を記録（Text / Single select 等）、`'OFF'` の件数を記録
  - ☐ なし → unsubscribe.js はサイレント失敗中（要別タスク改修、本作業では触らない）
- [ ] **`配信停止日` フィールドの有無**
  - ☐ 存在 / ☐ なし
- [ ] **`WithdrawalRequested` フィールドの有無と件数**
  - ☐ 存在: true=___, false=___
  - ☐ なし
- [ ] **`WithdrawalDate` / `WithdrawalReason` フィールドの有無**
  - ☐ 存在 / ☐ なし
- [ ] **有効期限系フィールド（4種混在の可能性）の実在確認**
  - `有効期限`: ☐ 存在 / ☐ なし
  - `ValidUntil`: ☐ 存在 / ☐ なし
  - `ExpirationDate`: ☐ 存在 / ☐ なし
  - `ExpiryDate`: ☐ 存在 / ☐ なし

### 6.4 その他既存フィールド確認

- [ ] **`プラン` フィールドの実在と取りうる値リスト**
  - 値リスト: ___（例: `Free`, `Standard`, `Light`, `Premium`, `Premium Predictions`, `Premium Sanrenpuku`, `Premium Combo`, `Premium Plus`, `Test` など）
- [ ] **`PlanType` フィールドの有無**: ☐ 存在 / ☐ なし
- [ ] **`Plan`（英語名）フィールドの有無**: ☐ 存在 / ☐ なし（`プラン` と並走している可能性）
- [ ] **`PaymentMethod` / `PaymentEmailSent` / `Source` / `VenueAccess` / `LifetimeSanrenpuku` / `MailingList` の有無**

上記の事前調査結果は [NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md §7](./NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md#7-次に-airtable-画面で確認すべき項目) のテンプレを使って Claude（私）に報告すると、フィールド追加作業前に最終整合を確認できる。

---

## 7. 作業後チェック（マコさん作業）

新規9フィールド追加 + 既存 `Status` への選択肢追加が終わったら、以下を確認する。

### 7.1 新規9フィールドの追加確認

- [ ] **追加した9フィールドがすべて表示されている**
  - `Brand`
  - `ServiceType`
  - `AudienceType`
  - `UnsubscribedAnalyticsKeiba`
  - `UnsubscribedKeibaIntelligence`
  - `UnsubscribedAtAnalyticsKeiba`
  - `UnsubscribedAtKeibaIntelligence`
  - `LastNewsletterSentAt`
  - `LastNewsletterBrand`
- [ ] **選択肢のスペルが設計書と完全一致**（コピペ推奨）
  - `Brand`: `analytics-keiba`, `keiba-intelligence`
  - `ServiceType`: `analytics-keiba`, `keiba-intelligence`
  - `AudienceType`: `free`, `light`, `standard`, `premium`, `premium-combo`, `expired`, `unpaid`, `admin-test`
  - `LastNewsletterBrand`: `analytics-keiba`, `keiba-intelligence`
- [ ] **新規フィールドで「Allow adding new options」が OFF になっている**（タイポ防止）
- [ ] **新規9フィールドはすべて空 / unchecked**（既存レコードに値が入っていない）

### 7.2 既存 `Status` フィールドの確認（最重要）

- [ ] **`Status` の既存選択肢 `active` / `pending` がそのまま残っている**
  - ☐ `active` 残存 / ☐ `pending` 残存
- [ ] **`Status` に新規6選択肢が追加されている**
  - ☐ `expired`
  - ☐ `unpaid`
  - ☐ `cancelled`
  - ☐ `refunded`
  - ☐ `withdrawn`
  - ☐ `test`
- [ ] **既存レコードの `Status` 値が変わっていない**
  - §6.2 でメモした `active` 件数 ___ と現在の件数を比較 → 一致するか
  - §6.2 でメモした `pending` 件数 ___ と現在の件数を比較 → 一致するか
- [ ] **`Status` フィールド自体が削除・リネームされていない**
- [ ] **`Status` のフィールド型が Single select のままで変わっていない**

### 7.3 既存全体の確認

- [ ] **既存レコード数が変わっていない**（§6.1 でメモした件数と一致）
- [ ] **既存フィールドが1つも削除されていない**（§6.1 でメモしたフィールド一覧と突き合わせ）
- [ ] **既存レコードのデータが変更されていない**（適当な数件を開いて確認）
- [ ] **`プラン` / `WithdrawalRequested` / `Email` / `氏名` / 期限系フィールド等が無傷**
- [ ] **作業後の Customers テーブルをスクショ**（変更履歴用）

### ⚠️ もし何かが想定と違う場合

- 値が勝手に入った
- フィールドが追加できない
- 既存データが消えた
- 既存 `Status` の選択肢が消えた
- `Status` フィールド自体が消えた

→ **すぐに作業を停止して Claude（私）に報告**。Airtable は変更履歴が残るので、復元可能なことが多い。  
特に **`Status` の既存値 `active` / `pending` が消えた場合は決済フローが壊れる**ので最優先で報告。

---

## 8. 次のステップ（このチェックリスト完了後）

このセットアップが終わったら、以下に進む:

1. **(c) Brand 遡及付与 CSV 出力スクリプト**
   - Airtable READ ONLY（既存レコードを書き換えない）
   - SendGrid カスタムフィールド `registered_analytics` / `registered_intelligence` を見て、各顧客がどちらのブランドに属するか判定
   - 結果を CSV に出力（私が出力するだけ、Airtable には書き込まない）
   - マコさんが CSV を**人間レビュー**してから、Airtable に手動インポート

2. **(d) newsletter-preview に audienceMode 追加**
   - dry-run のまま、`audienceMode: "real-count-only"` で実会員数だけカウント
   - Airtable READ のみ、WRITE なし、SendGrid なし

3. それ以降は [NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md §12](./NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md#12-実装順序) の (e) 以降に従う

---

## 9. 完了報告フォーマット（マコさん → Claude 用）

作業完了後、以下を Claude（私）に報告してください:

```
■ Airtable Customers 拡張セットアップ完了報告

作業日時: YYYY-MM-DD HH:MM JST

【作業前】
- 既存フィールド数: ___ 個
- 既存フィールド一覧: ___（コピペ）
- 既存レコード数: ___ records
- Base 名: ___

【作業前 Status 確認】
- Status フィールドの実在: ☐ Yes / ☐ No（No なら作業停止して報告のはず）
- 既存選択肢: ☐ active / ☐ pending / ☐ その他 ___
- active 件数: ___
- pending 件数: ___
- その他値の件数: ___

【作業前 配信停止・期限フィールド確認】
- メール配信 フィールド存在: ☐ Yes（型: ___、OFF件数: ___） / ☐ No
- 配信停止日 フィールド存在: ☐ Yes / ☐ No
- WithdrawalRequested 存在: ☐ Yes（true=___, false=___） / ☐ No
- WithdrawalDate 存在: ☐ Yes / ☐ No
- WithdrawalReason 存在: ☐ Yes / ☐ No
- 有効期限: ☐ Yes / ☐ No
- ValidUntil: ☐ Yes / ☐ No
- ExpirationDate: ☐ Yes / ☐ No
- ExpiryDate: ☐ Yes / ☐ No

【作業内容】
- 新規追加フィールド: 9個（チェックリスト §3 の操作=「新規追加」）
- 既存 Status の選択肢追加: 6個（expired/unpaid/cancelled/refunded/withdrawn/test）
- 既存フィールド変更: なし
- 既存選択肢変更: なし
- 既存レコード変更: なし

【作業後 新規9フィールド確認】
- Brand 表示: ☐ Yes / ☐ No
- ServiceType 表示: ☐ Yes / ☐ No
- AudienceType 表示: ☐ Yes / ☐ No
- UnsubscribedAnalyticsKeiba 表示: ☐ Yes / ☐ No
- UnsubscribedKeibaIntelligence 表示: ☐ Yes / ☐ No
- UnsubscribedAtAnalyticsKeiba 表示: ☐ Yes / ☐ No
- UnsubscribedAtKeibaIntelligence 表示: ☐ Yes / ☐ No
- LastNewsletterSentAt 表示: ☐ Yes / ☐ No
- LastNewsletterBrand 表示: ☐ Yes / ☐ No
- 選択肢スペル設計書と一致: ☐ Yes / ☐ No
- 「Allow adding new options」OFF: ☐ Yes / ☐ No

【作業後 既存 Status 確認（最重要）】
- active 選択肢残存: ☐ Yes / ☐ No
- pending 選択肢残存: ☐ Yes / ☐ No
- expired 選択肢追加: ☐ Yes / ☐ No
- unpaid 選択肢追加: ☐ Yes / ☐ No
- cancelled 選択肢追加: ☐ Yes / ☐ No
- refunded 選択肢追加: ☐ Yes / ☐ No
- withdrawn 選択肢追加: ☐ Yes / ☐ No
- test 選択肢追加: ☐ Yes / ☐ No
- 既存 active 件数 §6.2 と一致: ☐ Yes（___） / ☐ No（差: ___）
- 既存 pending 件数 §6.2 と一致: ☐ Yes（___） / ☐ No（差: ___）
- Status のフィールド型が Single select のまま: ☐ Yes / ☐ No

【作業後 既存全体】
- 既存レコード数変化なし: ☐ Yes / ☐ No
- 既存フィールド削除なし: ☐ Yes / ☐ No
- プラン / WithdrawalRequested / Email / 氏名 / 期限系 が無傷: ☐ Yes / ☐ No

【既存フィールドとの対応（参考情報）】
- Email フィールド: ☐ Yes（名前: ___） / ☐ No
- プラン フィールド: ☐ Yes（名前: ___、値リスト: ___） / ☐ No
- PlanType フィールド: ☐ Yes / ☐ No
- PaymentMethod フィールド: ☐ Yes / ☐ No
- VenueAccess フィールド: ☐ Yes / ☐ No
- LifetimeSanrenpuku フィールド: ☐ Yes（名前: ___） / ☐ No
- MailingList フィールド: ☐ Yes / ☐ No
- Source フィールド: ☐ Yes / ☐ No
- PaymentEmailSent フィールド: ☐ Yes / ☐ No
- LastLoginAt フィールド: ☐ Yes（名前: ___） / ☐ No

【衝突・問題点】
- フィールド名衝突（新規9個分）: ☐ なし / ☐ あり（詳細: ___）
- Status フィールドが見つからなかった: ☐ なし / ☐ あり（→ 報告のみで作業停止）
- 想定外の挙動: ☐ なし / ☐ あり（詳細: ___）

【スクショ】
- 作業前後の Customers テーブル全体スクショを添付
- 作業前後の Status フィールド編集画面（選択肢一覧）スクショを添付
```

この報告を受けてから、私は (c) の CSV 出力スクリプトの作成に進みます。  
詳しい既存挙動の根拠は [NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md](./NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md) を参照してください。

---

## 10. 禁止事項（再掲）

このチェックリスト作業中、以下は**絶対にしない**:

- ❌ 既存テーブル削除
- ❌ 既存フィールド削除・リネーム
- ❌ 既存レコードの一括変更
- ❌ **`Status` フィールドの新規追加**（既存のため、選択肢追加のみ）
- ❌ **`Status` の既存選択肢 `active` / `pending` の削除・リネーム**（決済フロー崩壊リスク）
- ❌ Status の値の既存レコードへの一括設定
- ❌ Brand の値の既存レコードへの一括設定
- ❌ 既存メルマガ送信機能の操作（admin 画面 / send-newsletter API 等）
- ❌ `NEWSLETTER_AUTOMATION_ENABLED` の設定変更
- ❌ Airtable API 経由の操作（手動 UI 操作のみ）

不明点があれば、**着手前に必ず Claude（私）に確認**してください。
