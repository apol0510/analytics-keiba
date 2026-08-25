# 会員階層システム - NANKAN Analytics

## 🚨 会員階層構造（段階的システム）

**会員は段階的にしか利用できない仕組み**

```
Free会員
  ↓
Premium会員（Standard会員含む）
  ↓
Premium Sanrenpuku会員（Combo含む）
  ↓
Premium Plus（単品商品）
```

---

## ⚠️ 絶対に間違えてはいけないこと

### 1. Premium Plusは単品商品である

- ❌ Premium Plus会員は存在しない
- ✅ Premium Plusは最上位の単品商品
- ✅ **Premium Sanrenpuku会員とPremium Combo会員のみが購入できる**

### 2. 三連複買い切りは Premium の期限に依存しない（恒久的に保持する）🚨

- ✅ **Premium Sanrenpuku Lifetime（¥78,000買い切り）**
- ✅ **Premium Combo Lifetime（¥78,000買い切り）**
- ✅ 買い切り = 追加料金なし・**恒久的な閲覧権**
- ✅ **Premium（馬単）の期限が切れても三連複は閲覧できる**。
  期限切れ後は**三連複ページだけ**が開き、馬単・Light は閲覧できない
- **買い切りの目印は `LifetimeSanrenpuku`（Customers のチェックボックス）**。
  三連複の入金確認で `buildConfirmationFields` が立て、`有効期限` は触らない
  （`src/lib/payments/bankPaymentFlow.js`）
- 判定の正本: `src/lib/entitlements/resolveEntitlements.js`
  （`canViewSanrenpuku = アカウント有効 AND LifetimeSanrenpuku`。tier も Premium 期限も見ない）／
  ログイン可否は `src/lib/auth/memberResolution.js`（期限切れでも `premium-sanrenpuku` の
  有料セッションを発行する。ここが free に落ちるとセッションが出ず、ページも開かない）
- 回帰テスト: `src/lib/auth/sanrenpukuLifetimeAccess.test.mjs`（`npm run test:auth-session`）

> ⚠️ **2026-08-25 訂正**: 本節はもともと「Premium 会員の有効期間内のみ閲覧可能」と
> 書かれていたが、**コードの実装と逆**だった（2026-07-18 に「買い切りは馬単の期限に
> 非依存」へ確定し、`99c6946` で AccessControl のバグも修正済み）。
> 誤った記述に合わせてコードを直すと、買い切り購入者を締め出す。

> ⚠️ **フラグの無い旧レコードは別問題**。`プラン='Premium Sanrenpuku'` だけで
> `LifetimeSanrenpuku` が無い会員は、買い切りだったのか期間契約だったのかを
> **データから判別できない**ため期限切れで閲覧できなくなる。
> 該当者が居る場合の正しい直し方は**フラグを立てること**で、判定式を緩めることではない
> （緩めると、期間契約が終わっただけの会員にも恒久的な権利を配ってしまう）。

### 3. 表示ルール

- ❌ Premium会員ページにPremium Plusを表示してはいけない
- ✅ **Premium Sanrenpuku会員・Premium Combo会員ページにのみ表示**
- **理由**: 段階的にしか利用できないから

### 4. アップセル導線

- Premium会員 → Premium Sanrenpukuへのアップセル
- **Premium Sanrenpuku会員・Premium Combo会員 → Premium Plus（単品商品）へのアップセル**
- **絶対に飛び級させてはいけない**

---

## 🚨 ページとproductNameの完全対応表

**⚠️ 重要：このページで何が購入できるかを絶対に間違えないこと**

### 各ページで購入できる商品

| ページURL | 対象ユーザー | 購入できる商品 | productName | Airtable登録 | BlastMail登録 |
|-----------|-------------|----------------|-------------|-------------|--------------|
| `/pricing/` | 新規ユーザー | **Standard, Premium のみ** | `Standard`, `Premium` | ✅ | ✅ |
| `/dashboard/` | 既存Premium会員 | **Sanrenpuku/Combo（アップグレード）** 🚨 | `Premium Sanrenpuku Lifetime`, `Premium Combo Lifetime` | ✅ | ✅ |
| `/premium-predictions/` | Premium会員 | **Sanrenpuku/Combo（アップセル）** 🚨 | `Premium Sanrenpuku Lifetime`, `Premium Combo Lifetime` | ✅ | ✅ |
| `/standard-predictions/` | 一般ユーザー | **Sanrenpuku/Combo** 🚨 | `Premium Sanrenpuku Lifetime`, `Premium Combo Lifetime` | ✅ | ✅ |
| `/sanrenpuku-demo/` | デモページ | **Sanrenpuku/Combo** 🚨 | `Premium Sanrenpuku Lifetime`, `Premium Combo Lifetime` | ✅ | ✅ |
| `/archive-sanrenpuku/` | アーカイブ | **Sanrenpuku/Combo** 🚨 | `Premium Sanrenpuku Lifetime`, `Premium Combo Lifetime` | ✅ | ✅ |
| **⚠️ `/premium-sanrenpuku/`** | **Sanrenpuku/Combo会員** | **🚨 Premium Plus（単品商品）のみ** | `Premium Plus` | **❌ スキップ** | **❌ スキップ** |
| **⚠️ `/withdrawal-upsell/`** | **退会時** | **🚨 Premium Plus（単品商品）のみ** | `Premium Plus` | **❌ スキップ** | **❌ スキップ** |
| `/premium-plus/` | - | **Premium Plus（単品商品）** | `Premium Plus` | ❌ | ❌ |

**🚨 三連複買い切り重要ルール:**
- 全て `Lifetime` = 買い切り（¥78,000）
- **ただしPremium会員有効期間内のみ閲覧可能**
- Premium解約 → 三連複買い切りもアクセス不可

---

## ❌ よくある間違い（絶対にしないこと）

### 1. `/pricing/` でPremium Sanrenpukuが買えると思う

- ❌ 間違い！`/pricing/`はStandard/Premiumのみ
- ✅ 正しい：新規ユーザーは最初にStandard/Premiumから始める

### 2. `/premium-sanrenpuku/` でPremium Sanrenpuku会員プランが買えると思う

- ❌ 間違い！このページで買えるのは**Premium Plus（単品商品）のみ**
- ✅ 正しい：このページはSanrenpuku/Combo会員向けで、Premium Plusのみ販売

### 3. Premium Plusに対してAirtable/BlastMail登録する

- ❌ 間違い！Premium Plusは単品商品なのでスキップ
- ✅ 正しい：月額プラン（Standard/Premium/Sanrenpuku/Combo）のみ登録

### 4. 三連複買い切りは買い切りだから永久に利用できると思う

- ❌ 間違い！Premium会員資格が失効すると閲覧不可
- ✅ 正しい：Premium会員（月払い/年払い/買い切り）の有効期間内のみ閲覧可能
- 例: Premium月払い（¥18,000/月）を解約 → 三連複買い切りも閲覧不可に

---

## ✅ 正しい理解

### 購入フロー（段階的）

```
新規ユーザー
  ↓
/pricing/ → Standard または Premium 購入（Airtable/BlastMail登録 ✅）
  ↓
/dashboard/ → Premium Sanrenpuku Lifetime または Premium Combo Lifetime にアップグレード（Airtable/BlastMail登録 ✅）
  🚨 買い切り（¥78,000）だがPremium有効期間内のみ閲覧可能
  ↓
/premium-sanrenpuku/ → Premium Plus（単品商品）購入（Airtable/BlastMail登録 ❌）
```

### 🚨 三連複買い切りの重要ポイント

- ✅ **買い切り** = 追加料金なし・永久所有権
- 🚨 **Premium会員有効期間内のみ閲覧可能**
- 例1: Premium月払い（¥18,000/月）+ 三連複買い切り（¥78,000） → Premium解約で三連複も閲覧不可
- 例2: Premium買い切り（¥78,000） + 三連複買い切り（¥78,000） → 両方とも永久に閲覧可能 ✅

### テスト時の正しいページ選択

**月額プランテスト（Airtable/BlastMail登録あり）:**
- `/pricing/` → Standard/Premium
- `/dashboard/` → Premium Sanrenpuku/Combo
- `/premium-predictions/` → Premium Sanrenpuku/Combo
- `/standard-predictions/` → Premium Sanrenpuku/Combo

**単品商品テスト（Airtable/BlastMail登録なし）:**
- `/premium-sanrenpuku/` → Premium Plus
- `/withdrawal-upsell/` → Premium Plus
