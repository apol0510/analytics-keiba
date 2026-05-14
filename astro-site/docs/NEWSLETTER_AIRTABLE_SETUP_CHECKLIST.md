# Newsletter Airtable 手動セットアップ チェックリスト（Customers 拡張）

**作成日**: 2026-05-14  
**作業者**: マコさん（手動 Airtable UI 操作）  
**所要時間**: 約20〜30分  
**前提**: [NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md](./NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md) を読了済み

---

## 1. 目的

完全自動化メルマガ配信システムで以下を実現するため、Airtable `Customers` テーブルに **新規フィールド10個** を追加する。

- **ブランド識別**: 顧客が analytics-keiba / keiba-intelligence のどちらに登録しているか判定
- **配信停止管理**: ブランドごとに独立した unsubscribe 状態を保持
- **会員状態管理**: 配信可否を一律のステータスで判定
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
| 操作 | **新規フィールドの追加のみ** |
| やってはいけない操作 | 既存テーブル削除 / 既存フィールド削除 / 既存レコード変更 / Status の値の既存レコードへの一括設定 |

⚠️ 今回は**追加のみ**。既存データは触らない。  
遡及付与（既存顧客に Brand を設定する）は **次のステップ (c)** で READ ONLY スクリプトを実行してから手動インポートする予定。

---

## 3. 追加フィールド一覧（10個）

### 一覧表

| # | フィールド名 | 型 | 選択肢 / 設定 | デフォルト | 用途 |
|---|---|---|---|---|---|
| 1 | `Brand` | Multiple select | `analytics-keiba` / `keiba-intelligence` | （空） | ブランド識別 |
| 2 | `ServiceType` | Multiple select | `analytics-keiba` / `keiba-intelligence` | （空） | 将来サービス分離用（当面 Brand と同値） |
| 3 | `AudienceType` | Single select | `free` / `light` / `standard` / `premium` / `premium-combo` / `expired` / `unpaid` / `admin-test` | （空） | 配信対象セグメント判定 |
| 4 | `Status` | Single select | `active` / `expired` / `unpaid` / `cancelled` / `refunded` / `withdrawn` / `test` | （空） | 配信可否判定 |
| 5 | `UnsubscribedAnalyticsKeiba` | Checkbox | — | `false`（unchecked） | analytics-keiba 配信停止フラグ |
| 6 | `UnsubscribedKeibaIntelligence` | Checkbox | — | `false`（unchecked） | keiba-intelligence 配信停止フラグ |
| 7 | `UnsubscribedAtAnalyticsKeiba` | Date（Include a time field: ✅ON） | — | （空） | analytics-keiba 停止日時 |
| 8 | `UnsubscribedAtKeibaIntelligence` | Date（Include a time field: ✅ON） | — | （空） | keiba-intelligence 停止日時 |
| 9 | `LastNewsletterSentAt` | Date（Include a time field: ✅ON） | — | （空） | 直近メルマガ送信日時 |
| 10 | `LastNewsletterBrand` | Single select | `analytics-keiba` / `keiba-intelligence` | （空） | 直近送信ブランド |

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

#### ④ Status（Single select）
1. `+` → `Status`
2. **Type**: `Single select`
3. **Add options** で 7 つ追加:
   - `active`
   - `expired`
   - `unpaid`
   - `cancelled`
   - `refunded`
   - `withdrawn`
   - `test`
4. **Allow adding new options**: ❌ OFF
5. **Default**: 設定しない（既存レコードは空のまま。後で遡及付与する）
6. Create

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
| 名前 | ☐ 存在 / ☐ なし | `Name` / `氏名` / `ユーザー名` | 任意。あればメール冒頭の `{{name}}` 置換で使用 |
| プラン | ☐ 存在 / ☐ なし | `プラン` / `PlanType` / `Plan` | **新規 `AudienceType` にマッピング**（次ステップで自動付与スクリプト作成） |
| 支払い状態 | ☐ 存在 / ☐ なし | `PaymentStatus` / `支払い状態` | あれば `Status` 判定の入力に使う |
| 退会要求 | ☐ 存在 / ☐ なし | `WithdrawalRequested` | **`Status='withdrawn'` に統合**（次ステップで移行） |
| 有効期限 | ☐ 存在 / ☐ なし | `有効期限` / `ExpiredAt` / `ValidUntil` / `ExpiryDate` | あれば `Status='expired'` 判定の入力に使う |
| 最終ログイン | ☐ 存在 / ☐ なし | `LastLoginAt` / `最終ログイン` | あれば休眠セグメント判定に使う |

⚠️ **既存フィールドがあった場合の重要ルール**:
- 削除しない
- リネームしない
- 既存値を変更しない
- 重複する役割の新フィールド（例: `AudienceType` と既存 `プラン`）は **両方並走**させる。後ほど移行スクリプトでダブルライト方式に切り替える

⚠️ **新規フィールド名と既存フィールド名が衝突した場合**:
- 衝突した名前を一時的に `<新規名>__New`（例: `Status__New`）にする
- このチェックリストに**衝突を記録**して、Claude（私）に報告
- 後でリネーム計画を立てる

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

- [ ] **Airtable の現状フィールド一覧をスクショまたはメモ**
  - Customers テーブルを表示
  - 全フィールド名を列挙してメモ（後で差分確認に使用）
- [ ] **既存レコード件数を記録**
  - Airtable 右下の `<件数> records` を記録
  - 例: `15,432 records`
- [ ] **新規フィールド名と既存フィールド名が衝突しないか確認**
  - 上記 §3 の10フィールド名を既存リストと突き合わせ
  - 衝突があれば一旦止めて Claude（私）に報告
- [ ] **作業対象 Base を間違えていないか確認**
  - Base 名: `nankan-analytics`（または analytics-keiba と共有しているもの）
  - keiba-intelligence の Base ではないこと（別 Base の場合）

---

## 7. 作業後チェック（マコさん作業）

10フィールド追加後、以下を確認する。

- [ ] **追加した10フィールドがすべて表示されている**
  - `Brand`
  - `ServiceType`
  - `AudienceType`
  - `Status`
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
  - `Status`: `active`, `expired`, `unpaid`, `cancelled`, `refunded`, `withdrawn`, `test`
  - `LastNewsletterBrand`: `analytics-keiba`, `keiba-intelligence`
- [ ] **「Allow adding new options」が OFF になっている**（タイポ防止）
- [ ] **既存レコード数が変わっていない**（§6 でメモした件数と一致）
- [ ] **既存フィールドが1つも削除されていない**（§6 でメモしたフィールド一覧と突き合わせ）
- [ ] **既存レコードのデータが変更されていない**（適当な数件を開いて確認）
- [ ] **新規10フィールドはすべて空 / unchecked**（既存レコードに値が入っていない）
- [ ] **作業後の Customers テーブルをスクショ**（変更履歴用）

### ⚠️ もし何かが想定と違う場合

- 値が勝手に入った
- フィールドが追加できない
- 既存データが消えた

→ **すぐに作業を停止して Claude（私）に報告**。Airtable は変更履歴が残るので、復元可能なことが多い。

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

【作業内容】
- 追加フィールド: 10個（チェックリスト §3 に従う）
- 既存フィールド変更: なし
- 既存レコード変更: なし

【作業後】
- 追加フィールド10個すべて表示されているか: ☐ Yes / ☐ No
- 選択肢スペル設計書と一致: ☐ Yes / ☐ No
- 「Allow adding new options」OFF: ☐ Yes / ☐ No
- 既存レコード数変化なし: ☐ Yes / ☐ No
- 既存フィールド削除なし: ☐ Yes / ☐ No

【既存フィールドとの対応】
- Email フィールド存在: ☐ Yes（名前: ___） / ☐ No
- プラン系フィールド存在: ☐ Yes（名前: ___） / ☐ No
- WithdrawalRequested 存在: ☐ Yes / ☐ No
- 有効期限系フィールド存在: ☐ Yes（名前: ___） / ☐ No
- LastLoginAt 存在: ☐ Yes（名前: ___） / ☐ No

【衝突・問題点】
- フィールド名衝突: ☐ なし / ☐ あり（詳細: ___）
- 想定外の挙動: ☐ なし / ☐ あり（詳細: ___）

【スクショ】
- 作業前後の Customers テーブル全体スクショを添付
```

この報告を受けてから、私は (c) の CSV 出力スクリプトの作成に進みます。

---

## 10. 禁止事項（再掲）

このチェックリスト作業中、以下は**絶対にしない**:

- ❌ 既存テーブル削除
- ❌ 既存フィールド削除・リネーム
- ❌ 既存レコードの一括変更
- ❌ Status の値の既存レコードへの一括設定
- ❌ Brand の値の既存レコードへの一括設定
- ❌ 既存メルマガ送信機能の操作（admin 画面 / send-newsletter API 等）
- ❌ `NEWSLETTER_AUTOMATION_ENABLED` の設定変更
- ❌ Airtable API 経由の操作（手動 UI 操作のみ）

不明点があれば、**着手前に必ず Claude（私）に確認**してください。
