# 強制ログアウト機能ガイド

## 📋 **概要**

**目的:** ユーザーと連絡が取れない場合に、サーバーサイドで強制的にセッションを無効化し、再ログインを促す機能

**導入日:** 2026年2月28日

**対象ケース:**
- ✅ Status が "active" になっているが、ユーザーがログアウト→再ログインしていない
- ✅ プラン変更後にセッション情報が古いまま
- ✅ メール連絡が取れず、手動でログアウトさせたい

---

## 🚀 **使用方法**

### **💡 銀行振込の日常運用（推奨）**

**入金確認時に Status と ForceLogout を同時に更新するだけでOK！**

**Step 1: 入金確認**
```
三井住友銀行 洲本支店で入金確認
```

**Step 2: Airtableで2箇所更新（30秒）**
```
1. Customers テーブルで該当レコードを開く
2. Status を "pending" → "active" に変更
3. ForceLogout にチェック ✅（+5秒だけ）
4. 保存
```

**Step 3: 顧客が次回アクセス（自動）**
```
顧客が次回アクセス
  ↓
強制ログアウト
  ↓
「プランが更新されました。再度ログインしてください。」表示
  ↓
再ログイン
  ↓
Premium プランに反映 ✅
```

**所要時間: 30秒（従来+5秒だけ）**

---

### **🔧 初回セットアップ（1分・1回のみ）**

**Airtable 管理画面での作業:**

1. **Customers テーブルを開く**
   - https://airtable.com/

2. **新しいフィールドを追加**
   - 右上の「+」ボタンをクリック
   - フィールドタイプ: **Checkbox**
   - フィールド名: **ForceLogout**
   - 説明: 強制ログアウトフラグ（チェック時に次回アクセスで強制ログアウト）

3. **保存**

---

### **⚠️ 特殊ケース：既に Status が "active" のユーザー**

**連絡が取れないユーザー（例: シミズさん）のみ手動でチェック:**

1. **Customers テーブルを開く**
2. **対象ユーザーを検索**（メールアドレスまたは名前）
3. **ForceLogout フィールドにチェック ✅**
4. **保存**

**所要時間: 10秒**

---

### **Step 3: ユーザーが次回アクセスした際に自動的にログアウト**

**自動処理:**

1. **ユーザーが dashboard にアクセス**
   - または次回ログイン試行時

2. **auth-user.js が ForceLogout フラグを検知**
   - ✅ ForceLogout = true → 強制ログアウト
   - ✅ Airtable の ForceLogout フラグを自動的に false にリセット
   - ✅ クライアントサイドで LocalStorage をクリア

3. **ユーザーにメッセージ表示**
   - 「プランが更新されました。再度ログインしてください。」

4. **ユーザーが再ログイン**
   - → 最新の Status（active）が反映される
   - → Premium プランに正しく切り替わる ✅

---

## 🔧 **技術実装の詳細**

### **サーバーサイド（netlify/functions/auth-user.js）**

```javascript
// 強制ログアウトチェック
const forceLogout = user.get('ForceLogout') === true || user.get('ForceLogout') === 1;
if (forceLogout) {
  console.log(`🚨 強制ログアウトフラグ検出: ${email}`);

  // フラグをリセット
  await base('Customers').update(user.id, {
    'ForceLogout': false
  });

  return {
    statusCode: 401,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success: false,
      forceLogout: true,
      message: 'セッションが無効化されました。再度ログインしてください。'
    })
  };
}
```

### **クライアントサイド（dashboard.astro）**

```javascript
// 強制ログアウトチェック
if (data.forceLogout) {
  console.log('🚨 強制ログアウト検出');
  // LocalStorageをクリア
  localStorage.removeItem('isLoggedIn');
  localStorage.removeItem('userEmail');
  localStorage.removeItem('userPlan');
  localStorage.removeItem('user-plan');

  showError('プランが更新されました。再度ログインしてください。');
  return;
}
```

---

## 📊 **動作フロー図**

```
マコさんの作業:
  ↓
1. Airtable で ForceLogout にチェック ✅
  ↓

ユーザーの次回アクセス:
  ↓
2. dashboard にアクセス（またはログイン試行）
  ↓
3. auth-user.js が ForceLogout = true を検知
  ↓
4. Airtable の ForceLogout を false にリセット
  ↓
5. クライアントに "forceLogout: true" を返す
  ↓
6. dashboard.astro が LocalStorage をクリア
  ↓
7. ユーザーにエラーメッセージ表示
  ↓
8. ユーザーが再ログイン
  ↓
9. 最新の Status（active）が反映される ✅
  ↓
10. Premium プランに正しく切り替わる ✅
```

---

## 📝 **日常運用の例**

### **ケース1: 通常の銀行振込入金確認（推奨）**

**入金確認時に Status と ForceLogout を同時に更新:**

```
1. 銀行口座で入金確認
   ↓
2. Airtable で該当レコードを開く
   ↓
3. Status を "pending" → "active" に変更
   ↓
4. ForceLogout にチェック ✅（+5秒）
   ↓
5. 保存
   ↓
6. 顧客が次回アクセス → 自動ログアウト → 再ログイン → Premium 反映 ✅
```

**所要時間: 30秒（従来+5秒だけ）**

---

### **ケース2: 既に Status が "active" だが連絡が取れないユーザー（シミズさん）**

**特殊ケース（連絡不能ユーザー）:**

```
1. Airtable Customers テーブルを開く
   ↓
2. シミズさんのレコードを検索
   ↓
3. ForceLogout フィールドにチェック ✅
   ↓
4. 保存
   ↓
5. シミズさんが次回アクセス → 自動ログアウト → 再ログイン → Premium 反映 ✅
```

**所要時間: 10秒**

---

## 🚨 **重要な注意事項**

### **1. ForceLogout フラグは自動的にリセットされる**
- ✅ 一度強制ログアウトが実行されると、Airtable の ForceLogout フラグは自動的に false になる
- ✅ 同じユーザーに対して複数回強制ログアウトを実行したい場合は、再度チェックを入れる

### **2. 他のページ（premium-predictions, standard-predictions など）も自動的にログアウト**
- ✅ dashboard.astro で LocalStorage がクリアされる
- ✅ LocalStorage ベースの認証を使用している全ページで自動的にログアウト状態になる

### **3. セッションが完全にクリアされる**
- ✅ isLoggedIn
- ✅ userEmail
- ✅ userPlan
- ✅ user-plan（プラン詳細データ）

---

## 📝 **トラブルシューティング**

### **Q1: ForceLogout にチェックを入れたが、ユーザーがログアウトされない**

**A1: ユーザーがまだアクセスしていない可能性があります**
- 強制ログアウトは次回アクセス時に実行されます
- ユーザーに「一度サイトにアクセスしてください」と連絡する

### **Q2: ForceLogout フラグが false に戻らない**

**A2: auth-user.js の処理が正しく実行されていない可能性があります**
- Netlify Functions のログを確認
- エラーがないか確認

### **Q3: ユーザーが再ログインしても Premium に反映されない**

**A3: Status が "active" になっているか確認**
- Airtable Customers テーブルで Status を確認
- pending → active に変更されているか確認

---

## 🎯 **まとめ**

**強制ログアウト機能の利点:**
- ✅ **連絡が取れないユーザーにも対応可能**（メール不要）
- ✅ **サーバーサイドで確実に実行**（クライアント依存なし）
- ✅ **自動的にフラグリセット**（手動リセット不要）
- ✅ **所要時間: 10秒**（Airtable でチェックを入れるだけ）

**使用タイミング:**
- ✅ Status が "active" だが、ユーザーがログアウト→再ログインしていない
- ✅ プラン変更後にセッション情報が古いまま
- ✅ メール連絡が取れず、手動でログアウトさせたい

**日常運用（銀行振込）:**
1. 入金確認
2. Airtable で Status → "active" + ForceLogout にチェック ✅（30秒）
3. 顧客が次回アクセス → 自動ログアウト → 再ログイン → Premium 反映 ✅

**特殊ケース（連絡不能ユーザー）:**
1. Airtable で ForceLogout にチェック ✅（10秒）
2. ユーザーが次回アクセス → 自動ログアウト → 再ログイン → Premium 反映 ✅

**これで完了です！** 🎉
