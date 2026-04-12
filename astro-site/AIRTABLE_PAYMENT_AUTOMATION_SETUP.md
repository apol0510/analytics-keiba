# Airtable入金確認メール自動送信 セットアップガイド

## 📅 作成日: 2026-02-12

## 🎯 目的

**Statusを"pending" → "active"に変更したら、自動的に入金確認メールを送信する**

---

## 📋 必須フィールド（Customersテーブル）

| フィールド名 | 型 | 必須 | 説明 |
|-------------|-----|------|------|
| Email | Email | ✅ | 顧客メールアドレス |
| 氏名 | Single line text | ✅ | 顧客氏名 |
| プラン | Single select | ✅ | プラン名（例: Premium Lifetime） |
| Status | Single select | ✅ | pending, active, expired, cancelled |
| ExpirationDate | Date | ✅ | 有効期限（Lifetimeの場合は2099-12-31） |
| PaymentEmailSent | Checkbox | ✅ | 入金確認メール送信済みフラグ |
| PaymentMethod | Single line text | - | 支払い方法（例: Bank Transfer） |

---

## 🔧 Airtable Automation設定手順

### ステップ1: Automationを作成

1. Airtableのワークスペースを開く
2. 左サイドバーの「Automations」をクリック
3. 「Create automation」をクリック
4. 名前: `入金確認メール自動送信`

### ステップ2: Triggerを設定

**Trigger type: When record matches conditions**

1. 「Choose trigger」→ 「When record matches conditions」を選択
2. Table: `Customers`
3. View: `All customers`（または全レコードを含むView）
4. Conditions（条件）:
   ```
   When:
     Status = "active"
   AND
     PaymentEmailSent ≠ true
   ```

**重要:**
- `Status = "active"`だけでは、既にactiveのレコードを再度activeにしたときに発火しない
- `PaymentEmailSent ≠ true`を追加することで、未送信のみ対象になる

### ステップ3: Actionを設定

**Action type: Send webhook request**

1. 「Add action」→ 「Send webhook request」を選択
2. URL:
   ```
   https://nankan-analytics.keiba.link/.netlify/functions/send-payment-confirmation-auto
   ```
3. Method: `POST`
4. Headers:
   ```
   Content-Type: application/json
   ```
5. Body:
   ```json
   {
     "airtableRecordId": "{RECORD_ID}"
   }
   ```

   **注意:** `{RECORD_ID}`はAirtableの動的変数。「Insert field」から選択する。

### ステップ4: Testして有効化

1. 「Test action」をクリック
2. テストレコードで動作確認
3. エラーがなければ「Turn on automation」をクリック

---

## 📊 動作フロー

### 正常フロー

```
1. 顧客が銀行振込申請フォームを送信
   ↓
2. bank-transfer-application.js が実行
   ↓
3. Airtableに登録（Status = "pending", PaymentEmailSent = false）
   ↓
4. マコさんが銀行口座で入金確認
   ↓
5. AirtableでStatus を "pending" → "active" に変更
   ↓
6. ✅ Airtable Automation が自動検知（Trigger発火）
   ↓
7. Webhook送信（send-payment-confirmation-auto.js呼び出し）
   ↓
8. send-payment-confirmation-auto.js が実行:
   - Airtableからレコード情報取得
   - PaymentEmailSentチェック（二重送信防止）
   - メール送信
   - PaymentEmailSent = true に更新
   - ExpirationDate更新（必要に応じて）
   ↓
9. ✅ 顧客にログイン情報メール送信完了
```

---

## 🚨 トラブルシューティング

### 問題1: Statusをactiveにしてもメールが送信されない

**考えられる原因:**

1. **Airtable Automationが無効になっている**
   - Airtableで「Automations」タブを開く
   - 「入金確認メール自動送信」が「On」になっているか確認

2. **Trigger条件が間違っている**
   - `Status = "active"` AND `PaymentEmailSent ≠ true`になっているか確認
   - `PaymentEmailSent`フィールドが存在するか確認

3. **PaymentEmailSentが既にtrueになっている**
   - レコードを開いて`PaymentEmailSent`がチェックされていないか確認
   - チェックされている場合、一度外してからStatusをactiveに変更

4. **Webhook URLが間違っている**
   - URLが正しいか確認: `https://nankan-analytics.keiba.link/.netlify/functions/send-payment-confirmation-auto`

5. **Netlify Functionがエラーを返している**
   - Netlify管理画面でFunctionsログを確認
   - エラーメッセージを確認

### 問題2: Airtableに登録されない

**考えられる原因:**

1. **環境変数が設定されていない**
   - Netlify管理画面で以下を確認:
     - `AIRTABLE_API_KEY`
     - `AIRTABLE_BASE_ID`

2. **プラン名が正規化されない**
   - 正規表現エラー（括弧が残る等）
   - ログで確認: `📅 計算された有効期限`

3. **Airtable APIエラー**
   - フィールド名が間違っている（日本語フィールド名）
   - Single selectオプションが存在しない

### 問題3: 二重送信される

**考えられる原因:**

1. **PaymentEmailSentがfalseのまま**
   - send-payment-confirmation-auto.jsでの更新が失敗している
   - Netlify Functionsログで確認

2. **Automationが複数回発火**
   - Trigger条件に`PaymentEmailSent ≠ true`が含まれているか確認

---

## 🔍 デバッグ方法

### 1. 環境変数チェック

ブラウザで以下にアクセス:
```
https://nankan-analytics.keiba.link/.netlify/functions/test-env
```

期待される出力:
```json
{
  "message": "環境変数チェック完了",
  "status": {
    "AIRTABLE_API_KEY": true,
    "AIRTABLE_BASE_ID": true,
    "SENDGRID_API_KEY": true,
    ...
  }
}
```

### 2. Netlify Functionsログ確認

1. Netlify管理画面にログイン
2. 「Functions」タブを開く
3. `bank-transfer-application`または`send-payment-confirmation-auto`をクリック
4. ログでエラーメッセージを確認

期待されるログ:
```
📅 計算された有効期限: { productName: '...', planName: 'Premium Lifetime', expirationDate: '2099-12-31' }
✅ Airtable created (new customer): example@email.com
✅ Payment confirmation email sent: example@email.com
✅ PaymentEmailSent updated to true: recXXXXXXXXXXXXXX
✅ ExpirationDate updated: 2099-12-31
```

### 3. 手動テスト

**Airtableで手動登録して確認:**

1. Customersテーブルに新規レコード作成:
   ```
   Email: test@example.com
   氏名: テスト太郎
   プラン: Premium Lifetime
   Status: pending
   ExpirationDate: 2099-12-31
   PaymentEmailSent: false
   PaymentMethod: Bank Transfer
   ```

2. Statusを`pending` → `active`に変更

3. 30秒以内にメールが届くか確認

4. `PaymentEmailSent`が`true`になっているか確認

---

## 📚 関連ファイル

| ファイル | 説明 |
|---------|------|
| `netlify/functions/bank-transfer-application.js` | 銀行振込申請処理 |
| `netlify/functions/send-payment-confirmation-auto.js` | 入金確認メール自動送信 |
| `netlify/functions/test-env.js` | 環境変数テスト用 |
| `AIRTABLE_LIFETIME_SETUP.md` | Lifetime対応セットアップガイド |
| `CLAUDE.md` | プロジェクト全体のルール |

---

## ✅ チェックリスト

設定が完了したら、以下をチェック:

- [ ] Customersテーブルに`PaymentEmailSent`フィールドが存在する
- [ ] Airtable Automationが作成されている
- [ ] Automation名: `入金確認メール自動送信`
- [ ] Trigger: `Status = "active" AND PaymentEmailSent ≠ true`
- [ ] Action: Webhook送信
- [ ] Webhook URL: `https://nankan-analytics.keiba.link/.netlify/functions/send-payment-confirmation-auto`
- [ ] AutomationがOnになっている
- [ ] 環境変数が設定されている（`test-env`で確認）
- [ ] 手動テストで動作確認済み

---

**🎉 マコ&クロの最強コンビで入金確認メール自動化を実装！**
