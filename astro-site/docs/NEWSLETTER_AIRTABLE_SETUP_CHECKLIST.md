# Newsletter Airtable 手動セットアップ チェックリスト（Customers 拡張）

**作成日**: 2026-05-14  
**改訂日**: 2026-05-15（**Airtable 実測結果反映 / 2 Base 構成に対応**、調査レポート [NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md §0](./NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md#0-airtable-実測結果2026-05-15-取得) 参照）  
**作業者**: マコさん（手動 Airtable UI 操作）  
**所要時間**: 約45〜60分（**2 Base 分の作業**）  
**前提**: [NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md](./NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md) を読了済み

---

## 1. 目的

完全自動化メルマガ配信システムで以下を実現するため、**`analytics-keiba` と `keiba-intelligence` の 2 つの Airtable Base** の `Customers` テーブルそれぞれに **新規フィールド9個** を追加し、**既存 `Status` フィールドに選択肢を Base 別に5個ずつ追加**する。

- **ブランド識別**: 顧客が analytics-keiba / keiba-intelligence のどちらに登録しているか判定
- **配信停止管理**: ブランドごとに独立した unsubscribe 状態を保持
- **会員状態管理**: 既存 `Status` フィールドの選択肢を Base 別に拡張し、両 Base 最終的に同じ9値に統一
- **配信履歴**: 直近メルマガ送信のメタ情報を保持

これにより、以下の事故を構造的に防ぐ:
- 誤って analytics-keiba 顧客に keiba-intelligence のメールを送る
- analytics-keiba を停止した人に、なお analytics-keiba メールを送る
- 既に退会・返金した顧客に通常メールを送る

### 1.1 新規フィールド命名規約

- 新規追加するメルマガ用フィールドは **英語名に統一**（`Brand` / `ServiceType` / `AudienceType` / `Unsubscribed*` / `LastNewsletter*`）
- 既存フィールドはリネームしない（日本語名・英語名が混在していても触らない）

### 1.2 既存フィールドのフォールバック方針（コード側の読み取り順）

実測で Base 間に既存フィールド名のズレがあるため、コードからは以下の順で fallback して読み取る:

| 項目 | 読み取り順（先勝ち） |
|---|---|
| 名前 | **`Name`** → `名前` |
| プラン | **`PlanType`** → `plan_type` → `Plan` → `プラン` |
| 期限 (analytics-keiba) | **`有効期限`** → `ExpiryDate` |
| 期限 (keiba-intelligence) | **`有効期限`** → `ExpirationDate` |

→ 本ドキュメントは**フィールド追加のみ**。フォールバック実装は別タスクで対応する。

---

## 2. 作業対象

⚠️ **2 つの Airtable Base に対して、それぞれ作業が必要**。

| 項目 | 内容 |
|---|---|
| 対象 Base 1 | **`analytics-keiba`** Base / `Customers` テーブル（実測 1,121 records） |
| 対象 Base 2 | **`keiba-intelligence`** Base / `Customers` テーブル（実測 32 records） |
| 操作 | **(A) 新規9フィールド追加（両 Base 共通）** + **(B) 既存 `Status` フィールドへの選択肢追加（Base 別の5個ずつ）** |
| やってはいけない操作 | 既存テーブル削除 / 既存フィールド削除 / 既存フィールドのリネーム / 既存レコード変更 / 既存 Status 選択肢の削除・リネーム / Status の値の既存レコードへの一括設定 |

⚠️ 今回は**追加のみ**。既存データは触らない。  
特に **`Status` は両 Base で既存運用中（bank-transfer-application.js / send-payment-confirmation.js が書き込み中）** なので、既存値を絶対に消さない。  
遡及付与（既存顧客に Brand を設定する）は **次のステップ (c)** で READ ONLY スクリプトを実行してから手動インポートする予定。

---

## 3. 追加フィールド一覧（**両 Base 共通**: 新規9個 + 既存 Status の選択肢追加 Base 別5個）

> 🚨 **2026-05-15 改訂**: Airtable 実測結果（[NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md §0](./NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md#0-airtable-実測結果2026-05-15-取得)）で:
> - メルマガ対象 Base は `analytics-keiba` と `keiba-intelligence` の **2つに分離**
> - `Status` 既存選択肢が Base 間で異なる:
>   - analytics-keiba: `active` / `pending` / `cancelled` / `suspended`
>   - keiba-intelligence: `pending` / `active` / `cancelled` / `expired`
> - 既存 `Status` は両 Base で運用中（bank-transfer / send-payment-confirmation が書き込み）  
>   したがって `Status` は両 Base で **新規追加せず、既存に選択肢を追加**する運用にする。
> - 追加後の取りうる値は両 Base で同じ9値（active / pending / cancelled / suspended / expired / unpaid / refunded / withdrawn / test）に統一

### 一覧表

| # | フィールド名 | 操作 | 型 | 選択肢 / 設定 | デフォルト | 用途 |
|---|---|---|---|---|---|---|
| 1 | `Brand` | **新規追加** | Multiple select | `analytics-keiba` / `keiba-intelligence` | （空） | ブランド識別 |
| 2 | `ServiceType` | **新規追加** | Multiple select | `analytics-keiba` / `keiba-intelligence` | （空） | 将来サービス分離用（当面 Brand と同値） |
| 3 | `AudienceType` | **新規追加** | Single select | `free` / `light` / `standard` / `premium` / `premium-combo` / `expired` / `unpaid` / `admin-test` | （空） | 配信対象セグメント判定 |
| 4 | `Status` | **既存・選択肢追加のみ（Base 別）** | Single select（既存） | **両 Base で既存値を保持**し、Base 別に追加: <br>・analytics-keiba: 既存 `active` / `pending` / `cancelled` / `suspended` を保持 + `expired` / `unpaid` / `refunded` / `withdrawn` / `test` の5個を追加 <br>・keiba-intelligence: 既存 `pending` / `active` / `cancelled` / `expired` を保持 + `suspended` / `unpaid` / `refunded` / `withdrawn` / `test` の5個を追加 | 既存値のまま | 配信可否判定 |
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

#### ④ Status（**既存フィールド** - 選択肢を追加するのみ、**Base 別に異なる**）

⚠️ **Status は両 Base ですでに存在する既存フィールド**（実測 2026-05-15 で両 Base で確認済）。  
新規追加ボタン (`+`) を押してはいけない。  
既存選択肢が**両 Base で異なる**ため、追加する選択肢も Base 別に異なる。

##### 共通 UI 操作

1. 既存の `Status` フィールドのヘッダをクリック → **Customize field type**（または鉛筆アイコン → Edit field）を開く
2. 開いた画面で **既存選択肢が表示されている**ことを確認（**絶対に削除しない**）
3. **Add an option** から下記リスト（Base 別）を**1個ずつ追加**（スペル厳密）
4. **Allow adding new options**: ❌ OFF（既存設定を維持。既存が ON だった場合のみそのまま）
5. **Default**: 既存設定を維持（変更しない）
6. **Save** クリック（フィールド再作成ではないので「Create field」ではなく「Save」になる）

##### Base 別 追加リスト

**analytics-keiba Base**
- 既存選択肢（実測 2026-05-15）: `active` / `pending` / `cancelled` / `suspended` — **温存**
- 追加する選択肢（5個）:
  - `expired`
  - `unpaid`
  - `refunded`
  - `withdrawn`
  - `test`

**keiba-intelligence Base**
- 既存選択肢（実測 2026-05-15）: `pending` / `active` / `cancelled` / `expired` — **温存**
- 追加する選択肢（5個）:
  - `suspended`
  - `unpaid`
  - `refunded`
  - `withdrawn`
  - `test`

→ 追加後、両 Base で取りうる値は**同じ9値**になる:  
`active` / `pending` / `cancelled` / `suspended` / `expired` / `unpaid` / `refunded` / `withdrawn` / `test`

##### Status が見つからない場合

- どちらの Base でも `Status` フィールドは既存（実測 2026-05-15）。見つからない場合は**作業を停止して Claude（私）に報告**してください
- そのまま新規追加してはいけません（既存コードが想定する `Status` と衝突する可能性があるため、現状を確認してから方針を決めます）

##### 既存値・既存レコードへの影響

- 既存レコードの `Status` 値は**そのまま**変わらない
- 既存値の**削除・リネームは絶対にしない**
- 新規追加した5選択肢は当面どのレコードにも値が入らない（手動操作 or 遡及付与スクリプトで後付け）

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

## 4. 既存フィールドとの対応（2026-05-15 実測ベース）

両 Base の実測結果を踏まえた既存フィールド対応表。新規フィールドは英語名で統一し、既存フィールドはリネームしないでフォールバック戦略で対応する。

### 4.1 両 Base の既存フィールド実測（2026-05-15）

| 観点 | analytics-keiba | keiba-intelligence | 今後の扱い |
|---|---|---|---|
| Email | あり | あり（想定） | 共通カノニカル、lowercase 正規化はコード側 |
| 名前フィールド | `名前`（日本語） | `Name`（英語） | コード側で **`Name` → `名前` のフォールバック** |
| プランフィールド | `プラン` | `PlanType` / `plan_type` / `Plan` | コード側で **`PlanType` → `plan_type` → `Plan` → `プラン` のフォールバック** |
| Status | あり（`active` / `pending` / `cancelled` / `suspended`） | あり（`pending` / `active` / `cancelled` / `expired`） | [§3 ④](#-status-既存フィールド---選択肢を追加するのみbase-別に異なる) で **Base 別に5個追加**して両 Base 9値に統一 |
| WithdrawalRequested | あり | **なし** | analytics-keiba は process-withdrawal が書き続ける。keiba-intelligence は退会判定を `Status='withdrawn'` 一本に絞る |
| 有効期限 | あり | あり | 主用フィールド（両 Base 共通） |
| ExpiryDate | あり | **なし** | analytics-keiba の補助。コード側 **`有効期限` → `ExpiryDate` の fallback** |
| ExpirationDate | **なし** | あり | keiba-intelligence の補助。コード側 **`有効期限` → `ExpirationDate` の fallback** |
| ValidUntil | **なし** | **なし** | 旧コードに残る fallback は将来削除候補（今回は触らない） |
| メール配信 | **なし** | **なし** | ⚠️ unsubscribe.js が両 Base で**サイレント失敗していた**（書き込み先が存在しない）。改修は別タスク、本作業では触らない |
| 配信停止日 | **なし** | **なし** | 同上 |

### 4.2 既存フィールド扱いの重要ルール

⚠️ **既存フィールドは触らない**:
- 削除しない
- リネームしない
- 既存値を変更しない
- 既存フィールドの**型を変更しない**
- 重複する役割の新フィールド（例: 新 `AudienceType` と既存 `プラン`）は**両方並走**させる。移行は別タスク

⚠️ **`Status` フィールド固有のルール（両 Base 共通）**:
- 既存選択肢は**絶対に削除・リネームしない**
  - analytics-keiba: `active` / `pending` / `cancelled` / `suspended` を温存
  - keiba-intelligence: `pending` / `active` / `cancelled` / `expired` を温存
- `bank-transfer-application.js` が `pending` を、`send-payment-confirmation.js` が `active` を書き込み続けるため、これらを消すと既存決済フローが壊れる
- 選択肢追加は「追加」のみで、既存選択肢には触らない

⚠️ **退会判定の Base 別差異**:
- analytics-keiba は `WithdrawalRequested` あり → 既存 process-withdrawal がそのまま動作
- keiba-intelligence は `WithdrawalRequested` **なし** → 新 `Status='withdrawn'` だけで退会判定する設計を前提にする

⚠️ **配信停止フィールドが両 Base にない件**:
- 既存 `unsubscribe.js` は `メール配信='OFF'` / `配信停止日` に書き込もうとしているが、両 Base ともフィールド自体が存在しないため**サイレント失敗**していた
- 今回の作業では `メール配信` / `配信停止日` を**新規追加しない**（旧ロジックを温存する意味がないため）
- 代わりに新規追加する `UnsubscribedAnalyticsKeiba` / `UnsubscribedKeibaIntelligence` でブランド別停止を新運用とする
- 既存 `unsubscribe.js` の改修は**別タスク**（このチェックリスト範囲外）

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

**事前調査は 2026-05-15 に完了済**（[AUDIT §0](./NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md#0-airtable-実測結果2026-05-15-取得) に実測値を保存）。本節は作業当日の最終確認用。

### 6.1 共通: 作業当日の最終確認

- [ ] **作業対象が `analytics-keiba` と `keiba-intelligence` の 2 つの Base である**ことを確認
- [ ] **両 Base の現状フィールド一覧をスクショ**（変更前）
- [ ] **両 Base の Customers レコード件数を記録**:
  - analytics-keiba: ___（実測 2026-05-15 時点で 1,121）
  - keiba-intelligence: ___（実測 2026-05-15 時点で 32）
- [ ] **新規フィールド名9個と既存フィールド名が衝突しないことを再確認**
  - 衝突があれば一旦止めて Claude（私）に報告

### 6.2 `Status` フィールド事前確認（重要・両 Base 個別）

⚠️ 実測 2026-05-15 で両 Base に `Status` フィールド存在を確認済。作業当日に再確認する。

**analytics-keiba Base**
- [ ] `Status` フィールドが存在する（Single select）
- [ ] 既存選択肢が **`active` / `pending` / `cancelled` / `suspended`** 4種であることを目視
  - 想定外の値があればメモして報告
- [ ] 各値の件数を記録: active=___, pending=___, cancelled=___, suspended=___
- [ ] 想定と異なる場合は**作業停止して報告**

**keiba-intelligence Base**
- [ ] `Status` フィールドが存在する（Single select）
- [ ] 既存選択肢が **`pending` / `active` / `cancelled` / `expired`** 4種であることを目視
  - 想定外の値があればメモして報告
- [ ] 各値の件数を記録: pending=___, active=___, cancelled=___, expired=___
- [ ] 想定と異なる場合は**作業停止して報告**

### 6.3 配信停止・期限・退会フィールドの再確認

実測 2026-05-15 結果は以下。作業当日にも軽く目視確認する。

**analytics-keiba Base**
- [ ] `メール配信` フィールド: なし（追加もしない）
- [ ] `配信停止日` フィールド: なし（追加もしない）
- [ ] `WithdrawalRequested`: あり（保持）
- [ ] `有効期限`: あり（保持）
- [ ] `ExpiryDate`: あり（保持）
- [ ] `ValidUntil` / `ExpirationDate`: なし（追加もしない）

**keiba-intelligence Base**
- [ ] `メール配信` フィールド: なし（追加もしない）
- [ ] `配信停止日` フィールド: なし（追加もしない）
- [ ] `WithdrawalRequested`: **なし**（追加もしない。退会は `Status='withdrawn'` で扱う）
- [ ] `有効期限`: あり（保持）
- [ ] `ExpirationDate`: あり（保持）
- [ ] `ValidUntil` / `ExpiryDate`: なし（追加もしない）

### 6.4 プラン・名前フィールドの再確認

**analytics-keiba Base**
- [ ] 名前フィールド: `名前`（日本語）あり
- [ ] プランフィールド: `プラン`（日本語）あり
- [ ] `PlanType` / `Plan`: なし

**keiba-intelligence Base**
- [ ] 名前フィールド: `Name`（英語）あり
- [ ] プランフィールド: `PlanType` / `plan_type` / `Plan` あり
- [ ] `プラン`: なし

→ 既存フィールドの整理（統一・リネーム等）は**本作業のスコープ外**。コード側でフォールバック対応する。

事前調査の詳細値は [NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md §0](./NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md#0-airtable-実測結果2026-05-15-取得) を参照。

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

### 7.2 既存 `Status` フィールドの確認（最重要・Base 別）

**analytics-keiba Base**

- [ ] **既存選択肢 `active` / `pending` / `cancelled` / `suspended` がそのまま残っている**
  - ☐ `active` 残存 / ☐ `pending` 残存 / ☐ `cancelled` 残存 / ☐ `suspended` 残存
- [ ] **追加した5選択肢が表示されている**
  - ☐ `expired` / ☐ `unpaid` / ☐ `refunded` / ☐ `withdrawn` / ☐ `test`
- [ ] **既存レコードの `Status` 値が変わっていない**
  - §6.2 でメモした件数と一致: active=___, pending=___, cancelled=___, suspended=___
- [ ] **`Status` フィールド自体が削除・リネームされていない**
- [ ] **`Status` のフィールド型が Single select のままで変わっていない**

**keiba-intelligence Base**

- [ ] **既存選択肢 `pending` / `active` / `cancelled` / `expired` がそのまま残っている**
  - ☐ `pending` 残存 / ☐ `active` 残存 / ☐ `cancelled` 残存 / ☐ `expired` 残存
- [ ] **追加した5選択肢が表示されている**
  - ☐ `suspended` / ☐ `unpaid` / ☐ `refunded` / ☐ `withdrawn` / ☐ `test`
- [ ] **既存レコードの `Status` 値が変わっていない**
  - §6.2 でメモした件数と一致: pending=___, active=___, cancelled=___, expired=___
- [ ] **`Status` フィールド自体が削除・リネームされていない**
- [ ] **`Status` のフィールド型が Single select のままで変わっていない**

→ 両 Base で取りうる Status 値が同じ9値（`active` / `pending` / `cancelled` / `suspended` / `expired` / `unpaid` / `refunded` / `withdrawn` / `test`）になっているか確認。

### 7.3 既存全体の確認（両 Base）

**analytics-keiba Base**
- [ ] **既存レコード数が変わっていない**（実測 2026-05-15 時点で 1,121）
- [ ] **既存フィールドが1つも削除されていない**
- [ ] **既存レコードのデータが変更されていない**（数件を開いて確認）
- [ ] **`名前` / `プラン` / `WithdrawalRequested` / `Email` / `有効期限` / `ExpiryDate` が無傷**
- [ ] 作業後のスクショを取得

**keiba-intelligence Base**
- [ ] **既存レコード数が変わっていない**（実測 2026-05-15 時点で 32）
- [ ] **既存フィールドが1つも削除されていない**
- [ ] **既存レコードのデータが変更されていない**（数件を開いて確認）
- [ ] **`Name` / `PlanType` / `plan_type` / `Plan` / `Email` / `有効期限` / `ExpirationDate` が無傷**
- [ ] 作業後のスクショを取得

### ⚠️ もし何かが想定と違う場合

- 値が勝手に入った
- フィールドが追加できない
- 既存データが消えた
- 既存 `Status` の選択肢が消えた
- `Status` フィールド自体が消えた
- どちらかの Base のレコード件数が変動した

→ **すぐに作業を停止して Claude（私）に報告**。Airtable は変更履歴が残るので、復元可能なことが多い。  
特に **`Status` の既存値が消えた場合は決済フローが壊れる**ので最優先で報告。

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

作業完了後、以下を Claude（私）に報告してください。**両 Base 分を別々に記入**してください。

```
■ Airtable Customers 拡張セットアップ完了報告（両 Base）

作業日時: YYYY-MM-DD HH:MM JST

================================================
[Base 1] analytics-keiba
================================================

【作業前】
- 既存レコード数: ___ records（実測 2026-05-15: 1,121）
- 作業前スクショ: ☐ 取得済

【作業前 Status 確認】
- Status フィールドの実在: ☐ Yes / ☐ No
- 既存選択肢:
  - ☐ active 件数: ___
  - ☐ pending 件数: ___
  - ☐ cancelled 件数: ___
  - ☐ suspended 件数: ___
  - その他値: ___

【作業内容】
- 新規追加9フィールド: ☐ 完了
- 既存 Status に5選択肢追加（expired / unpaid / refunded / withdrawn / test）: ☐ 完了

【作業後 新規9フィールド確認】
- Brand / ServiceType / AudienceType: ☐ 表示
- UnsubscribedAnalyticsKeiba / UnsubscribedKeibaIntelligence: ☐ 表示
- UnsubscribedAtAnalyticsKeiba / UnsubscribedAtKeibaIntelligence: ☐ 表示
- LastNewsletterSentAt / LastNewsletterBrand: ☐ 表示
- 選択肢スペル設計書と一致: ☐ Yes / ☐ No
- 「Allow adding new options」OFF: ☐ Yes / ☐ No

【作業後 既存 Status 確認（最重要）】
- 既存 active / pending / cancelled / suspended 残存: ☐ Yes / ☐ No
- 追加 expired / unpaid / refunded / withdrawn / test: ☐ 全追加 / ☐ 一部のみ
- 既存件数と一致: active=___, pending=___, cancelled=___, suspended=___
- Status のフィールド型 Single select 維持: ☐ Yes / ☐ No

【作業後 既存全体】
- 既存レコード数変化なし: ☐ Yes / ☐ No（現件数: ___）
- 既存フィールド削除なし: ☐ Yes / ☐ No
- 名前 / プラン / WithdrawalRequested / Email / 有効期限 / ExpiryDate 無傷: ☐ Yes / ☐ No

================================================
[Base 2] keiba-intelligence
================================================

【作業前】
- 既存レコード数: ___ records（実測 2026-05-15: 32）
- 作業前スクショ: ☐ 取得済

【作業前 Status 確認】
- Status フィールドの実在: ☐ Yes / ☐ No
- 既存選択肢:
  - ☐ pending 件数: ___
  - ☐ active 件数: ___
  - ☐ cancelled 件数: ___
  - ☐ expired 件数: ___
  - その他値: ___

【作業内容】
- 新規追加9フィールド: ☐ 完了
- 既存 Status に5選択肢追加（suspended / unpaid / refunded / withdrawn / test）: ☐ 完了

【作業後 新規9フィールド確認】
- Brand / ServiceType / AudienceType: ☐ 表示
- UnsubscribedAnalyticsKeiba / UnsubscribedKeibaIntelligence: ☐ 表示
- UnsubscribedAtAnalyticsKeiba / UnsubscribedAtKeibaIntelligence: ☐ 表示
- LastNewsletterSentAt / LastNewsletterBrand: ☐ 表示
- 選択肢スペル設計書と一致: ☐ Yes / ☐ No
- 「Allow adding new options」OFF: ☐ Yes / ☐ No

【作業後 既存 Status 確認（最重要）】
- 既存 pending / active / cancelled / expired 残存: ☐ Yes / ☐ No
- 追加 suspended / unpaid / refunded / withdrawn / test: ☐ 全追加 / ☐ 一部のみ
- 既存件数と一致: pending=___, active=___, cancelled=___, expired=___
- Status のフィールド型 Single select 維持: ☐ Yes / ☐ No

【作業後 既存全体】
- 既存レコード数変化なし: ☐ Yes / ☐ No（現件数: ___）
- 既存フィールド削除なし: ☐ Yes / ☐ No
- Name / PlanType / plan_type / Plan / Email / 有効期限 / ExpirationDate 無傷: ☐ Yes / ☐ No

================================================
[共通] 衝突・問題点
================================================

- フィールド名衝突（新規9個分）: ☐ なし / ☐ あり（詳細: ___）
- Status フィールドが見つからなかった: ☐ なし / ☐ あり（→ 報告のみで作業停止）
- 想定外の挙動: ☐ なし / ☐ あり（詳細: ___）

【スクショ】
- 両 Base の作業前後の Customers テーブル全体スクショを添付
- 両 Base の Status フィールド編集画面（選択肢一覧）スクショを添付
```

この報告を受けてから、私は (c) の CSV 出力スクリプトの作成に進みます。  
詳しい既存挙動の根拠は [NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md](./NEWSLETTER_CUSTOMERS_EXISTING_FIELDS_AUDIT.md) を参照してください。

---

## 10. 禁止事項（再掲）

このチェックリスト作業中、以下は**絶対にしない**（**両 Base で**）:

- ❌ 既存テーブル削除
- ❌ 既存フィールド削除・リネーム（`名前` / `Name` / `プラン` / `PlanType` / `plan_type` / `Plan` / `有効期限` / `ExpiryDate` / `ExpirationDate` / `WithdrawalRequested` 等すべて）
- ❌ 既存フィールドの型変更
- ❌ 既存レコードの一括変更
- ❌ **`Status` フィールドの新規追加**（両 Base とも既存のため、選択肢追加のみ）
- ❌ **`Status` の既存選択肢の削除・リネーム**（決済フロー崩壊リスク）
  - analytics-keiba の `active` / `pending` / `cancelled` / `suspended`
  - keiba-intelligence の `pending` / `active` / `cancelled` / `expired`
- ❌ Status の値の既存レコードへの一括設定
- ❌ Brand の値の既存レコードへの一括設定
- ❌ `メール配信` / `配信停止日` フィールドの新規追加（両 Base で意図的に作らない）
- ❌ 既存メルマガ送信機能の操作（admin 画面 / send-newsletter API 等）
- ❌ `NEWSLETTER_AUTOMATION_ENABLED` の設定変更
- ❌ Airtable API 経由の操作（手動 UI 操作のみ）

不明点があれば、**着手前に必ず Claude（私）に確認**してください。
