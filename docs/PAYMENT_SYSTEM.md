# 決済システム - NANKAN Analytics

## 💳 現在の決済手段

### 銀行振込（メイン）

**振込先:**
```
三井住友銀行 洲本支店
普通 5338892
名義: ティロル アナリティクス
```

**自動化システム:**
1. **申請受付**: `bank-transfer-application.js`
   - フォーム送信 → 管理者メール
   - 顧客メール（申請受付確認）
   - Airtable/BlastMail自動登録

2. **入金確認**: `send-payment-confirmation-auto.js`
   - Airtable Status: `pending` → `active`
   - 自動メール送信（ログイン情報）
   - PaymentEmailSent フラグ更新

### Paddle決済（審査通過済み・未統合）

**審査完了日**: 2026年1月26日
**専用サイト**: https://payment.tirol.link

**実装予定:**
- Payment Links設定
- Webhook統合（Airtable/BlastMail自動登録）
- nankan-analytics.keiba.linkに統合

---

## 💰 価格体系（2026-02-09更新）

### 主要プラン（/pricing/ で販売）

| プラン | 料金 | 内容 |
|--------|------|------|
| **Standard** | ¥5,980/月 | **一時非表示**（既存会員のみ利用可能）・後半3レース |
| **Premium 買い切り** | ¥108,000 → **¥78,000 特別価格** | **永久アクセス**・全レース |
| **Premium 年払い** | **¥68,000/年** | 全レース |
| **Premium 月払い** | **¥18,000/月** | 全レース（従来¥9,980から値上げ） |

### アップグレードプラン（既存会員向け）

| プラン | 料金 | 内容 |
|--------|------|------|
| **Premium Sanrenpuku 買い切り** | ¥108,000 → **¥78,000 特別価格** | **永久アクセス**・三連複予想 🚨 |
| **Premium Combo 買い切り** | ¥108,000 → **¥78,000 特別価格** | **永久アクセス**・Combo限定 🚨 |

🚨 **重要**: 三連複買い切りは**Premium会員有効期間内のみ閲覧可能**

### 単品商品（Sanrenpuku/Combo会員向け）

| プラン | 料金 | 内容 |
|--------|------|------|
| **Premium Plus** | ¥98,000 → **¥68,000 特別価格** | 単品商品・高精度予想（永久アクセス） |

---

## 🔧 銀行振込フォーム仕様

### フォーム項目（簡略化版・4項目）

1. **お名前**（必須）
2. **メールアドレス**（必須）
3. **振込完了日**（必須）
4. **振込金額**（自動入力）
5. **備考・ご要望**（任意）

### 自動設定項目

- **振込名義人**: `お名前` と同じ（自動設定）
- **振込時刻**: `00:00`（デフォルト値）

### 実装ページ（9ページ）

- `pricing.astro`
- `dashboard.astro`
- `premium-predictions.astro`
- `standard-predictions.astro`
- `premium-sanrenpuku.astro`
- `premium-plus.astro`
- `withdrawal-upsell.astro`
- `sanrenpuku-demo.astro`
- `archive-sanrenpuku/index.astro`

---

## 🤖 入金確認メール自動化

### Airtable Automation フロー

```
1. 銀行口座で入金確認
2. AirtableでStatusを "pending" → "active" に変更（スマホでも可）
3. → Airtable Automation が自動検知
4. → Netlify Function 呼び出し（send-payment-confirmation-auto.js）
5. → Airtableからレコード情報取得（email, 氏名, プラン）
6. → 二重送信防止チェック（PaymentEmailSentフィールド）
7. → メール送信（プラン別ログインURL・アクセス権限自動生成）
8. → PaymentEmailSent を true に自動更新 ✅
```

**所要時間: 30秒**（Status変更のみ）

### プラン別ログイン情報

| プラン | ログインURL | アクセス範囲 |
|--------|-------------|-------------|
| Standard | /dashboard/ | 後半3レース（10R、11R、12R） |
| Premium 買い切り/年払い/月払い | /dashboard/ | 全レース（1R〜12R） |
| Premium Sanrenpuku 買い切り | /dashboard/ | 全レース + 三連複予想 |
| Premium Combo 買い切り | /dashboard/ | 全レース + 三連複 + Combo限定 |
| Premium Plus | /premium-plus/ | 単品商品・高精度予想（永久アクセス） |

---

## 📊 Paddle決済（審査通過済み・未統合）

### payment.tirol.link 審査対策

**成功要因:**
1. ギャンブルキーワード完全排除
   - ❌ keiba（競馬）
   - ❌ prediction / predict / forecast
   - ✅ sports data analytics / statistical analysis

2. SaaSツール強調
   - ✅ Login/Dashboard ボタン
   - ✅ 「Dashboard access 24/7」「Real-time data updates」

3. 法的透明性完全対応
   - ✅ Terms & Conditions（日英併記・免責完全記載）
   - ✅ Privacy Policy
   - ✅ Refund Policy（14日間無条件返金）
   - ✅ Legal（特定商取引法・事業者情報）

### 実装予定タスク

**Step 1: Paddle Payment Links設定**
1. Paddleダッシュボードにログイン
2. Product作成（5プラン: Standard/Premium/Sanrenpuku/Combo/Plus）
3. Payment Links生成（各プラン用URL）
4. Webhook設定（Airtable/BlastMail自動登録）

**Step 2: nankan-analytics.keiba.link に統合**
1. `/pricing/` に Paddle Payment Links追加
2. `/dashboard/` にアップグレードボタン追加
3. 銀行振込フォームと併用（選択肢提供）
4. Airtable Webhook実装（Paddle購入 → Customers登録）

**Step 3: テスト決済実施**
1. Paddle Sandbox環境でテスト
2. 本番環境で少額決済テスト（Standard ¥5,980）
3. Webhook連携確認（Airtable/BlastMail）
4. 入金確認（Paddle → 銀行口座）

---

## 🔐 決済セキュリティ

### API Key保護

**❌ 絶対禁止（ブラウザに露出）:**
```javascript
const AIRTABLE_API_KEY = import.meta.env.AIRTABLE_API_KEY;
const jobResponse = await fetch(`https://api.airtable.com/v0/...`, {
  headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` }
});
```

**✅ 正しい方法（Functions経由プロキシ）:**
```javascript
// get-newsletter-status.js（サーバーサイド）
export default async function handler(request, context) {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;  // サーバーのみ
  const jobResponse = await fetch(`https://api.airtable.com/v0/...`, {
    headers: { 'Authorization': `Bearer ${AIRTABLE_API_KEY}` }
  });
  return new Response(JSON.stringify({ job, queueStats }));
}

// newsletter-status.astro（クライアントサイド）
const response = await fetch(`/.netlify/functions/get-newsletter-status?jobId=${jobId}`);
const data = await response.json();  // API Keyなし・安全
```

---

## 📝 運用フロー

### 銀行振込申請 → 入金確認 → アクセス許可

**Step 1: 顧客が銀行振込申請**
```
/pricing/ や /dashboard/ で「銀行振込」ボタンクリック
→ フォーム入力（4項目: 名前、メール、振込完了日、備考）
→ 送信
→ 管理者メール送信 ✅
→ 顧客メール送信（申請受付確認） ✅
→ Airtable/BlastMail自動登録 ✅
```

**Step 2: 管理者が入金確認**
```
銀行アプリで入金確認
→ Airtableアプリを開く（スマホでも可）
→ Statusを "pending" → "active" に変更（タップ2回）
→ 自動的にメール送信 ✅
→ PaymentEmailSent自動更新 ✅
```

**所要時間:**
- 顧客: 約1分（フォーム入力）
- 管理者: 約30秒（Status変更のみ）
