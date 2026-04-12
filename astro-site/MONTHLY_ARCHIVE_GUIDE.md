# 📅 月替わり作業ガイド - アーカイブ管理

月が変わるときの作業を簡単にするための完全ガイドです。

## 🚀 クイックスタート（月が変わったら）

### 1️⃣ 新月アーカイブ作成（自動）

```bash
# 今月のアーカイブを自動作成
node scripts/create-new-month-archive.js

# または、特定の年月を指定
node scripts/create-new-month-archive.js 2026 04
```

**実行内容:**
- ✅ `src/data/archiveResults_YYYY-MM.json` 作成（馬単）
- ✅ `src/data/archiveSanrenpukuResults_YYYY-MM.json` 作成（三連複）
- ✅ `public/data/archiveResults_YYYY-MM.json` 作成
- ✅ `public/data/archiveSanrenpukuResults_YYYY-MM.json` 作成
- ✅ `src/pages/archive/YYYY/MM.astro` 作成（馬単ページ）

---

### 2️⃣ インポート文自動更新

```bash
# 各indexファイルに新月のインポートを追加
node scripts/update-archive-imports.js

# または、特定の年月を指定
node scripts/update-archive-imports.js 2026 04
```

**実行内容:**
- ✅ `src/pages/archive/index.astro` にインポート追加
- ✅ `src/pages/archive/YYYY/index.astro` にインポート追加
- ✅ `src/pages/archive-sanrenpuku/index.astro` にインポート追加
- ✅ `src/pages/archive-sanrenpuku/YYYY/index.astro` にインポート追加
- ✅ `src/pages/archive-sanrenpuku/YYYY/MM.astro` 作成（前月コピー）

---

### 3️⃣ コミット・プッシュ

```bash
git add .
git commit -m "📊 YYYY年MM月アーカイブ準備完了"
git push origin main
```

---

## 📝 日常の更新作業（月中）

### 馬単結果更新

1. **データ更新**
   ```bash
   # src/data/archiveResults_YYYY-MM.json にデータ追加
   # public/data/archiveResults_YYYY-MM.json にコピー
   cp src/data/archiveResults_2026-03.json public/data/
   ```

2. **トップページ更新**
   ```bash
   # src/data/archiveResults.json に最新日データ追加
   ```

3. **コミット**
   ```bash
   git add .
   git commit -m "📊 馬単結果更新・MM月DD日（競馬場）"
   git push origin main
   ```

---

### 三連複結果更新

1. **データ更新**
   ```bash
   # src/data/archiveSanrenpukuResults_YYYY-MM.json にデータ追加
   # public/data/archiveSanrenpukuResults_YYYY-MM.json にコピー
   cp src/data/archiveSanrenpukuResults_2026-03.json public/data/
   ```

2. **トップページ更新（Premium専用）**
   ```bash
   # src/data/archiveSanrenpukuResults.json に最新日データ追加
   ```

3. **コミット**
   ```bash
   git add .
   git commit -m "📊 三連複結果更新・MM月DD日（競馬場）"
   git push origin main
   ```

---

## 📂 **データファイルの場所ルール（超重要）** 📂

### ⚠️ **クロが間違えやすいポイント**

**絶対に守るルール：**

1. ✅ **データ確認・読み込みは必ず `/src/data/` から**
   - 例: `src/data/archiveResults_2026-03.json`
   - 例: `src/data/archiveSanrenpukuResults_2026-03.json`

2. ✅ **データ更新・書き込みは必ず `/src/data/` に**
   - 馬単結果更新 → `src/data/archiveResults_2026-03.json`
   - 三連複結果更新 → `src/data/archiveSanrenpukuResults_2026-03.json`

3. ✅ **更新後、必ず `/public/data/` に同期コピー**
   ```bash
   cp src/data/archiveResults_2026-03.json public/data/
   cp src/data/archiveSanrenpukuResults_2026-03.json public/data/
   ```

4. ❌ **絶対にしてはいけないこと**
   - `/public/data/` を確認して「データがない」と言う
   - `/public/data/` に直接書き込む
   - `/src/data/` を確認せずに新規作成する

**理由：**
- `/src/data/` = ビルド時にインポートされる**マスターデータ**（正しいデータ）
- `/public/data/` = ブラウザからのAPI読み込み用**コピー**（同期先）

**月替わり時も同じ：**
- 自動化スクリプトは `/src/data/` を基準に動作
- 月が変わっても、常に `/src/data/` が正解

---

## 🗂️ ファイル構成

### 馬単アーカイブ

```
src/
├── data/
│   ├── archiveResults.json                    # トップページ用（最新1日分）
│   ├── archiveResults_2026-01.json           # 1月データ
│   ├── archiveResults_2026-02.json           # 2月データ
│   └── archiveResults_2026-03.json           # 3月データ
└── pages/
    └── archive/
        ├── index.astro                        # 全年一覧
        └── 2026/
            ├── index.astro                    # 2026年一覧
            ├── 01.astro                       # 1月ページ
            ├── 02.astro                       # 2月ページ
            └── 03.astro                       # 3月ページ

public/
└── data/
    ├── archiveResults_2026-01.json           # 1月データ（API用）
    ├── archiveResults_2026-02.json           # 2月データ（API用）
    └── archiveResults_2026-03.json           # 3月データ（API用）
```

### 三連複アーカイブ

```
src/
├── data/
│   ├── archiveSanrenpukuResults.json         # トップページ用（最新1日分）
│   ├── archiveSanrenpukuResults_2025-11.json # 11月データ
│   ├── archiveSanrenpukuResults_2025-12.json # 12月データ
│   ├── archiveSanrenpukuResults_2026-01.json # 1月データ
│   ├── archiveSanrenpukuResults_2026-02.json # 2月データ
│   └── archiveSanrenpukuResults_2026-03.json # 3月データ
└── pages/
    └── archive-sanrenpuku/
        ├── index.astro                        # 全年一覧
        └── 2026/
            ├── index.astro                    # 2026年一覧
            ├── 01.astro                       # 1月ページ
            ├── 02.astro                       # 2月ページ
            └── 03.astro                       # 3月ページ

public/
└── data/
    ├── archiveSanrenpukuResults_2025-11.json # 11月データ（API用）
    ├── archiveSanrenpukuResults_2025-12.json # 12月データ（API用）
    ├── archiveSanrenpukuResults_2026-01.json # 1月データ（API用）
    ├── archiveSanrenpukuResults_2026-02.json # 2月データ（API用）
    └── archiveSanrenpukuResults_2026-03.json # 3月データ（API用）
```

---

## 🔧 トラブルシューティング

### ❌ ビルドエラー: 整合性チェック失敗

**原因:** インポート文が追加されていない

**解決策:**
```bash
node scripts/update-archive-imports.js
```

---

### ❌ トップページが前月のまま

**原因:** `archiveResults.json` または `archiveSanrenpukuResults.json` が更新されていない

**解決策:**
```bash
# 最新日のデータを手動で追加（3月の場合）
# src/data/archiveResults.json の先頭に "03": { "DD": {...} } を追加
# src/data/archiveSanrenpukuResults.json の先頭に "03": { "DD": {...} } を追加
```

---

### ❌ アーカイブページが「2月」と表示される

**原因:** ページテンプレートの月表示が前月のまま

**解決策:**
```bash
# src/pages/archive-sanrenpuku/2026/03.astro を開いて
# "2月" → "3月" に手動修正
```

---

## 📊 データフォーマット例

### 馬単データ (`archiveResults_YYYY-MM.json`)

```json
{
  "2026": {
    "03": {
      "02": {
        "venue": "川崎",
        "totalRaces": 12,
        "hitRaces": 8,
        "perfectHit": false,
        "totalPayout": 13220,
        "recoveryRate": 163,
        "races": [
          {
            "raceNumber": "1R",
            "raceName": "３歳(八)",
            "betType": "馬単",
            "betPoints": 3,
            "hit": true,
            "payout": 330
          }
        ]
      }
    }
  }
}
```

### 三連複データ (`archiveSanrenpukuResults_YYYY-MM.json`)

```json
{
  "2026": {
    "03": {
      "02": {
        "venue": "川崎",
        "totalRaces": 12,
        "hitRaces": 9,
        "perfectHit": false,
        "totalPayout": 33400,
        "recoveryRate": 309,
        "races": [
          {
            "raceNumber": "1R",
            "raceName": "３歳(八)",
            "betType": "三連複",
            "hit": true,
            "payout": 1590
          }
        ]
      }
    }
  }
}
```

---

## 🎯 月替わりチェックリスト

- [ ] `node scripts/create-new-month-archive.js` 実行
- [ ] `node scripts/update-archive-imports.js` 実行
- [ ] `git add . && git commit && git push` 実行
- [ ] Netlifyビルド成功確認
- [ ] 新月アーカイブページ表示確認
- [ ] トップページ最新結果表示確認

---

## 💡 ヒント

1. **月初1日に実行**
   - 前月データが確定したら、すぐに新月準備を実行

2. **src と public の同期**
   - 必ず両方のディレクトリにJSONファイルを配置

3. **インポート漏れ防止**
   - `update-archive-imports.js` スクリプトで自動化

4. **コミットメッセージ統一**
   - 馬単: `📊 馬単結果更新・MM月DD日（競馬場）`
   - 三連複: `📊 三連複結果更新・MM月DD日（競馬場）`
   - 月初: `📊 YYYY年MM月アーカイブ準備完了`

---

## 🤖 自動化スクリプト一覧

| スクリプト | 用途 | 実行タイミング |
|-----------|------|--------------|
| `create-new-month-archive.js` | 新月ファイル作成 | 月初1回 |
| `update-archive-imports.js` | インポート文自動追加 | 月初1回 |
| `validate-archive-data.js` | 整合性チェック | ビルド時自動 |

---

## 📞 サポート

問題が発生した場合は、以下を確認してください：

1. **Netlifyビルドログ**
   - エラーメッセージを確認

2. **ローカルビルド**
   ```bash
   npm run build
   ```

3. **整合性チェック**
   ```bash
   npm run validate
   ```

---

**作成日**: 2026年3月2日
**最終更新**: 2026年3月2日
