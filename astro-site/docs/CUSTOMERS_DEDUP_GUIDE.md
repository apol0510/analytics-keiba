# Customers テーブル 重複レコード対応ガイド

最終更新: 2026-05-12

## 1. 背景

`Customers` テーブルで同一メールアドレスのレコードが複数作成されるケースが発生していた。
原因は `netlify/functions/auth-user.js` の検索条件が

```
AND({Email} = 'xxx', OR({Source} = 'nankan-analytics', {Source} = BLANK()))
```

となっており、既存レコードの `Source` が別値（移行データなど）の場合に既存会員を見逃して
新規作成していたこと、および check-then-create がアトミックでないため同時リクエストで
両方が新規作成に走る可能性があったこと。

2026-05-12 のコード修正で以下を実施済み:

- `auth-user.js` / `send-magic-link.js` / `verify-magic-link.js` の `Customers` 検索を
  Email 完全一致のみ（`LOWER(TRIM({Email})) = '...'`）に統一
- `auth-user.js` で create 直前に再検索する race-safe チェックを追加

ただし、既に作成されてしまった重複レコードはコードでは整理されない。
**運用での対応手順を以下に示す。**

## 2. 重複レコードの検出

Airtable 側で重複検出ビューを作る:

1. `Customers` テーブルで **新規 View → Grid view** を作成
2. 並び替え: `Email` 昇順
3. 必要に応じてグループ化: `Email` でグループ化すると 2 件以上のグループが重複候補

または「Find duplicates」拡張機能を使う場合: Extensions → "Dedupe records" → Match field = `Email`。

## 3. 統合前に必ず確認するフィールド

どちらのレコードを残すかを判断する前に、**両レコードで以下を比較**する:

| フィールド | 確認ポイント |
|---|---|
| `Status` | `active` の方を優先（または `pending` の最新） |
| `プラン` (Plan) | Free 以外の有料プランがあれば必ず保持 |
| `PlanType` | `lifetime` > `annual` > `monthly` の優先順 |
| `CustomerType` | 課金種別 |
| `PaymentEmailSent` | true の方を残すと再送防止が効く |
| `有効期限` / `ExpirationDate` | 未来日に近い方を優先 |
| `WithdrawalRequested` / `WithdrawalDate` / `WithdrawalReason` | 退会フラグ |
| `LifetimeSanrenpuku` / `三連複Lifetime` | 永久アクセス権 |
| `VenueAccess` | JRA/南関アクセス権 |
| `ポイント` | 多い方を残す（または合算して片方に集約） |
| `最終ポイント付与日` | 新しい方 |
| `Source` | 値が入っている方（空欄より優先） |
| `登録日` / `Created` | 古い方が顧客としては実体 |
| `Memo` | 両方にあれば結合 |
| `Ip_Address` / `User_Agent` | デバッグ用、新しい方で OK |

## 4. 統合手順（推奨）

**削除する前に必ず Airtable の「Snapshot」を取る**（Help → "Create snapshot"）。

1. **残すレコードを決める**: 上記の優先順位で重要情報が集まった方を「正レコード」とする
2. **失われる情報を正レコードへ手動コピー**: もう片方にしかないフィールド値（例: 有効期限、PaymentEmailSent、Memo、特殊フラグ等）を正レコードに反映
3. **`Source` が空なら `nankan-analytics` に揃える**（任意・推奨）
4. **削除前に削除予定レコードのスクリーンショットを保存**
5. **削除予定レコードを削除**

## 5. 削除よりマージを優先するケース

以下のいずれかに該当する場合は、**自動削除をせず管理者判断で個別対応**する:

- 両方に有効な決済履歴がある（PaymentEmailSent / 有効期限が両方有効）
- 片方に有料プラン、もう片方に Free でログイン履歴が両方ある
- LifetimeSanrenpuku / 永久アクセス権がどちらかにのみ立っている
- 「氏名」「お名前」が異なる（家族名義違い等の可能性）

## 6. apolone_bkm@yahoo.co.jp / kaiseido@sa8.gyao.ne.jp のケース

### kaiseido@sa8.gyao.ne.jp（1110 / 1111）

- 両方とも `プラン=Free`、登録日も近接
- 上記 §4 に従って、`Source` が `nankan-analytics` の方を残し、もう片方を削除して問題ない見込み
- ポイントが片方にしかない場合は合算して残す方に転記してから削除

### apolone_bkm@yahoo.co.jp（氏名: テスト）

入金確認メールが届かない件は、`PaymentEmailSent` が過去のテストで true になっている可能性が高い。

**対処**:
1. Airtable で当該レコードを開く
2. `PaymentEmailSent` フィールドのチェックを外す（false/空）
3. `Status` を `active` → `pending` → `active` に切り替えて Airtable Automation を再トリガー
4. Netlify Functions ログで `send-payment-confirmation-auto` の動作を確認
   - `Payment email already sent, skipping` が出ていなければ送信成功
   - SendGrid エラーが出る場合は `SENDGRID_API_KEY` を再確認

## 7. 今後の予防

- 2026-05-12 修正以降は同一 Email での新規重複は基本作成されない
- ただし旧データの重複は残るため、定期的に Airtable で重複ビューを確認すると安全
- 重複検出時はこのガイドの手順で統合する
