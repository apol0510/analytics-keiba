# 📅 **日常更新作業手順マニュアル**

## ⚠️ **🚨 削除厳禁・超重要ファイル 🚨**

**このファイルは絶対に削除してはいけません！**

- ✅ マコさんとクロちゃんの日常業務の根幹
- ✅ 5つの更新作業（馬単・三連複・予想・穴馬・画像）の完全手順
- ✅ バックアップファイル: `DAILY_UPDATE_PROCEDURES.BACKUP.md`
- ✅ CLAUDE.md軽量化のためにアーカイブ分割したもの
- ✅ 2026-01-18に復元・作成された重要資産

**削除・変更する場合は必ずマコさんに確認すること！**

---

## 📋 **概要**

マコさん（プロダクトオーナー）がクロちゃん（Claude）に指示する日常更新作業の定型フロー集です。

**5つの更新作業：**
1. 🔮 予想更新
2. 🐴 穴馬更新
3. 📊 馬単結果更新
4. 📊 三連複結果更新
5. 📸 画像更新

---

## 🔮 **予想更新の手順**

**マコさんが「予想更新コミットプッシュ」と指示したら：**

### **Step 1: ファイル確認**
```bash
# allRacesPrediction.json の先頭部分を確認
Read src/data/allRacesPrediction.json (limit: 50)
```

### **Step 2: public/dataに同期（必須・スキップ禁止）**
```bash
cp src/data/allRacesPrediction.json public/data/
```
- ✅ **既存ファイルがあっても必ず実行**

### **Step 2.5: 無料予想アーカイブ自動保存（必須・スキップ禁止）** 🆕
```bash
python3 scripts/archive-free-prediction.py
```
- ✅ **allRacesPrediction.jsonを日別ファイルとして自動保存**
- ✅ **src/data/free-predictions/YYYY-MM-DD.json に保存**
- ✅ **public/data/free-predictions/YYYY-MM-DD.json に同期**
- ✅ **SEO効果：日別アーカイブページ自動生成（/free-prediction/YYYY/MM/DD/）**

**⚠️ 重要：**
- 毎日の予想更新時に必ず実行
- スキップすると、過去の予想が消える
- アーカイブファイルも自動的にGitに追加される

### **Step 3: JSON検証**
```bash
python3 <<'PY'
import json
with open('src/data/allRacesPrediction.json', 'r', encoding='utf-8') as f:
    data = json.load(f)
    main_race = next((r for r in data['races'] if r.get('isMainRace')), None)
    print(f'✅ レース日: {data["raceDate"]}')
    print(f'✅ 会場: {data["track"]}')
    print(f'✅ レース数: {data["totalRaces"]}')
    if main_race:
        print(f'✅ メインレース: {main_race["raceNumber"]} {main_race["raceInfo"]["raceName"]}')
PY
```

### **Step 4: コミット・プッシュ（必須・スキップ禁止）**
```bash
# 予想データ + 無料予想アーカイブを同時にコミット
git add src/data/allRacesPrediction.json public/data/allRacesPrediction.json src/data/free-predictions/ public/data/free-predictions/

git commit -m "$(cat <<'EOF'
🔮 予想更新・YYYY-MM-DD

- 会場: ○○競馬
- レース数: ○R
- メインレース: ○○賞
- 無料予想アーカイブ保存 ✅

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

git push origin main
```

**用途：**
- `/premium-predictions/`（全レース予想・馬単買い目）
- `/standard-predictions/`（後半3レース・三連複買い目）
- `/free-prediction/`（全レース予想・買い目なし）
- トップページ（メインレースプレビュー）

---

## 🐴 **穴馬更新の手順**

**マコさんが「穴馬更新コミットプッシュ」と指示したら：**

### **Step 0: Git状態確認（最優先・スキップ絶対禁止）**
```bash
git status
```

**⚠️ 致命的エラー防止：**
- src/data/darkHorseData.json が modified または untracked の場合 → 必ず git add する
- public/data/darkHorseData.json が modified または untracked の場合 → 必ず git add する
- **両方のファイルを git add しないと、本番サイトに反映されない**
- **この確認を怠ると、コミット漏れが発生し、本番サイトが古いデータのままになる**

### **Step 1: ファイル確認**
```bash
# darkHorseData.json の先頭部分を確認
Read src/data/darkHorseData.json (limit: 50)
```

### **Step 2: public/dataに同期（必須・スキップ禁止）**
```bash
cp src/data/darkHorseData.json public/data/
```
- ✅ **既存ファイルがあっても必ず実行**

### **Step 3: JSON検証**
```bash
python3 <<'PY'
import json
with open('src/data/darkHorseData.json', 'r', encoding='utf-8') as f:
    data = json.load(f)
    race_count = len(set([r['raceNumber'] for r in data['races']]))
    horse_count = len(data['races'])
    print(f'✅ レース日: {data["date"]}')
    print(f'✅ 会場: {data["track"]}')
    print(f'✅ レース数: {race_count}R')
    print(f'✅ 穴馬候補数: {horse_count}頭')
PY
```

---

## 🚨🚨🚨 **STOP！ここで必ず STORAGE_VERSION を更新すること！** 🚨🚨🚨

### **Step 4: STORAGE_VERSION更新（必須・スキップ絶対禁止）** 🔴🔴🔴

**🔴 絶対に忘れないこと！LocalStorageキャッシュが残る原因になります**

```bash
# dark-horse-picks.astro のSTORAGE_VERSIONを更新日付に変更
Edit src/pages/dark-horse-picks.astro

# Line 396 と Line 435 の2箇所を更新
# const STORAGE_VERSION = 'YYYY-MM-DD'; ← darkHorseData.jsonの"date"と同じ日付に変更
```

**検索・置換で一括更新（推奨）：**
```javascript
// 古い日付（前回の更新日）を検索
STORAGE_VERSION = '2026-03-02'

// 新しい日付（今日の日付）に置換
STORAGE_VERSION = '2026-03-03'

// 必ず2箇所（Line 396, Line 435）両方とも置換されたか確認
```

**⚠️ この更新を忘れると：**
- ❌ ブラウザのLocalStorageに古いデータが残る
- ❌ 「穴馬を見る」ボタンが「再確認する」のままになる
- ❌ ハードリロードしても古い穴馬データが表示され続ける
- ❌ 月替わり時に特に問題が発生しやすい

**✅ 正しく更新すると：**
- ✅ ブラウザが古いバージョンを検出してLocalStorageを自動クリア
- ✅ 最新の穴馬データが正しく表示される
- ✅ 「穴馬を見る」ボタンが正しく動作する

### **Step 5: コミット・プッシュ（必須・スキップ禁止）**

**⚠️ 致命的エラー防止：必ず3つのファイルを追加すること**
```bash
# Git状態を再確認（絶対にスキップしないこと）
git status

# データファイル + STORAGE_VERSION更新をコミット（3つ全て必須）
git add src/data/darkHorseData.json public/data/darkHorseData.json src/pages/dark-horse-picks.astro

# 追加されたか確認（絶対にスキップしないこと）
git status

git commit -m "$(cat <<'EOF'
🐴 穴馬更新・YYYY-MM-DD

- 会場: ○○競馬
- レース数: ○R
- 穴馬候補数: ○頭
- STORAGE_VERSION更新 ✅

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

git push origin main

# STORAGE_VERSIONのコミット（別コミット）
git add src/pages/dark-horse-picks.astro

git commit -m "$(cat <<'EOF'
🔧 STORAGE_VERSION更新・YYYY-MM-DD

- dark-horse-picks.astro: STORAGE_VERSION更新
- キャッシュバスティング対応
- 穴馬を見るボタン正常表示対応

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

git push origin main
```

**用途：**
- `/premium-predictions/`（穴馬情報表示）
- `/standard-predictions/`（穴馬情報表示）
- `/dark-horse-picks/`（穴馬ピック専用ページ）
- 管理画面（/admin/dark-horse-finder/）

**注意：**
- STORAGE_VERSIONは**手動更新必須**（自動管理ではない）
- 更新を忘れるとブラウザキャッシュが残り、ボタン表示が正常にならない

---

## 📊 **馬単結果更新の手順**

**マコさんが「馬単結果更新」または「馬単結果更新コミットプッシュ」と指示したら：**

### **🚨 重要：クロちゃん（Claude）への指示 🚨**

**絶対に「更新不要」判定をしないこと！**
**絶対にユーザーに確認を求めないこと！**

- ❌ 「12/01, 02, 03のデータは存在しています、更新不要です」と言ってはいけない
- ❌ 「新しいデータはありますか？」と聞いてはいけない
- ❌ 「同期とコミットを進めればよいですか？」と聞いてはいけない
- ✅ **常に以下の手順を即座に全て実行する**（既存データの有無に関わらず）
- ✅ 月別ファイル内の最新日をそのまま採用して更新を実行する
- ✅ 月替わりでも確認を求めず、自動で対象月ファイルを判定して進める
- ✅ マコさんが貼り付けたデータを信頼し、必ず同期・コミット・プッシュする

**理由：**
- 月別ファイル（archiveResults_YYYY-MM.json）にデータが存在しても
- トップページ用ファイル（archiveResults.json）が古い可能性がある
- public/data/が古い可能性がある
- **→ 毎回必ず全ての同期処理を実行する**

---

### **Step 0: 年月の自動判定**

- `<env>Today's date` から現在の年月を読み取る
- 手順書の例をそのままコピーしない
- データ確認・更新は必ず `/src/data/` から（`/public/data/` ではない）

---

### **Step 1: 月別ファイル確認**
```bash
Read src/data/archiveResults_YYYY-MM.json
```
※ YYYY-MM は現在の年月に置き換える

### **Step 2: トップページ用ファイル更新（必須・スキップ禁止）**
```bash
python3 <<'PY'
import json
from datetime import datetime

now = datetime.now()
year = str(now.year)
month = str(now.month).zfill(2)

filename = f'src/data/archiveResults_{year}-{month}.json'
with open(filename, 'r', encoding='utf-8') as f:
    monthly_data = json.load(f)

days = sorted(monthly_data[year][month].keys(), reverse=True)
latest_day = days[0]
latest_day_data = monthly_data[year][month][latest_day]

top_page_data = {
    year: {
        month: {
            latest_day: latest_day_data
        }
    }
}

with open('src/data/archiveResults.json', 'w', encoding='utf-8') as f:
    json.dump(top_page_data, f, ensure_ascii=False, indent=2)

print(f'✅ 最新日: {year}-{month}-{latest_day}')
print(f'✅ 会場: {latest_day_data["venue"]}')
print(f'✅ 的中: {latest_day_data["hitRaces"]}/{latest_day_data["totalRaces"]}')
print(f'✅ 回収率: {latest_day_data["recoveryRate"]}%')
PY
```
- ✅ **既存データがあっても必ず実行**
- ✅ **最新1日分のみ抽出**（1年後もファイルサイズ1.8KB維持）
- ✅ 編集ミス防止のため手動編集なし
- ✅ **datetime.now()で現在の年月を自動取得**（手動指定によるミスを防止）

### **Step 3: JSON検証**
```bash
python3 <<'PY'
import json
with open('src/data/archiveResults.json', 'r', encoding='utf-8') as f:
    data = json.load(f)
    year = list(data.keys())[0]
    month = list(data[year].keys())[0]
    days = list(data[year][month].keys())
    latest_day = days[0]
    latest_data = data[year][month][latest_day]
    print(f'Year: {year}')
    print(f'Month: {month}')
    print(f'Days: {days}')
    print(f'Latest Day: {latest_day}')
    print(f'Venue: {latest_data["venue"]}')
    print(f'HitRaces: {latest_data["hitRaces"]} / {latest_data["totalRaces"]}')
    print(f'Recovery: {latest_data["recoveryRate"]} %')
PY
```

### **Step 4: public/dataに同期（必須・スキップ禁止）**
```bash
# ⚠️ 注意：YYYY-MMは現在の年月に置き換える！
# 例: 2026年2月なら archiveResults_2026-02.json

cp src/data/archiveResults_YYYY-MM.json public/data/
cp src/data/archiveResults.json public/data/
```
- ✅ **既存ファイルがあっても必ず実行**

### **Step 5: コミット・プッシュ（必須・スキップ禁止）**
```bash
# ⚠️ 注意：YYYY-MMは現在の年月に置き換える！
# 例: 2026年2月なら archiveResults_2026-02.json

# 月別ファイル + トップページ用ファイルを同時にコミット
git add src/data/archiveResults_YYYY-MM.json src/data/archiveResults.json public/data/archiveResults_YYYY-MM.json public/data/archiveResults.json

git commit -m "$(cat <<'EOF'
📊 馬単結果更新・YYYY-MM-DD

- MM/DD（会場）: 的中○/12レース
- 回収率: ○○%
- 総払戻: ○○,○○○円
- 月別ファイル + トップページ用ファイル同時更新

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

git push origin main
```

- ✅ **月別ファイルとトップページ用ファイルを1回のコミットで同時更新**
- ✅ データの整合性を保証
- ✅ コミット漏れを防止

---

## 📊 **三連複結果更新の手順**

**マコさんが「三連複結果更新コミットプッシュ」と指示したら：**

### **🚨 重要：三連複は馬単と違う運用方法 🚨**

**三連複結果の用途：**
1. `/archive-sanrenpuku/YYYY/MM/`（当月全日分）
2. `/archive-sanrenpuku/YYYY/MM-1/`（前月全日分）
3. `/standard-predictions/`（最新日のみ使用）
4. `/premium-predictions/`（最新日のみ使用）

**→ archiveSanrenpukuResults.jsonには前月全日分+当月全日分が必要！**

---

### **Step 0: 年月の自動判定**

- `<env>Today's date` から現在の年月を読み取る
- 前月も自動計算する（手順書の例をそのままコピーしない）
- データ確認・更新は必ず `/src/data/` から（`/public/data/` ではない）

---

### **Step 1: 月別ファイル確認**
```bash
Read src/data/archiveSanrenpukuResults_YYYY-MM.json
```
※ YYYY-MM は現在の年月に置き換える

### **Step 2: 前月分+当月分を統合（必須・スキップ禁止）**
```bash
python3 <<'PY'
import json
from datetime import datetime, timedelta

now = datetime.now()
year = str(now.year)
month = str(now.month).zfill(2)

prev_month_date = now.replace(day=1) - timedelta(days=1)
prev_year = str(prev_month_date.year)
prev_month = str(prev_month_date.month).zfill(2)

prev_filename = f'src/data/archiveSanrenpukuResults_{prev_year}-{prev_month}.json'
with open(prev_filename, 'r', encoding='utf-8') as f:
    prev_data = json.load(f)

curr_filename = f'src/data/archiveSanrenpukuResults_{year}-{month}.json'
with open(curr_filename, 'r', encoding='utf-8') as f:
    curr_data = json.load(f)

combined_data = {
    prev_year: {
        prev_month: prev_data[prev_year][prev_month]
    }
}

if year != prev_year:
    combined_data[year] = {
        month: curr_data[year][month]
    }
else:
    combined_data[year][month] = curr_data[year][month]

with open('src/data/archiveSanrenpukuResults.json', 'w', encoding='utf-8') as f:
    json.dump(combined_data, f, ensure_ascii=False, indent=2)

prev_days = list(prev_data[prev_year][prev_month].keys())
curr_days = list(curr_data[year][month].keys())
print(f'✅ 前月（{prev_year}-{prev_month}）: {len(prev_days)}日分')
print(f'✅ 当月（{year}-{month}）: {len(curr_days)}日分')
print(f'✅ 合計: {len(prev_days) + len(curr_days)}日分')
PY
```
- ✅ **既存データがあっても必ず実行**
- ✅ **前月全日分 + 当月全日分を統合**
- ✅ /archive-sanrenpuku/ で全日分表示
- ✅ **datetime.now()で現在の年月と前月を自動計算**（手動指定によるミスを防止）

### **Step 3: JSON検証**
```bash
python3 <<'PY'
import json
with open('src/data/archiveSanrenpukuResults.json', 'r', encoding='utf-8') as f:
    data = json.load(f)
    total_days = 0
    for year in data.keys():
        for month in data[year].keys():
            days_count = len(data[year][month].keys())
            print(f'{year}年{month}月: {days_count}日分')
            total_days += days_count
    print(f'合計: {total_days}日分')
PY
```

### **Step 4: public/dataに同期（必須・スキップ禁止）**
```bash
# ⚠️ 注意：YYYY-MMは現在の年月に置き換える！
# 例: 2026年2月なら archiveSanrenpukuResults_2026-02.json

cp src/data/archiveSanrenpukuResults_YYYY-MM.json public/data/
cp src/data/archiveSanrenpukuResults.json public/data/
```
- ✅ **既存ファイルがあっても必ず実行**

### **Step 5: コミット・プッシュ（必須・スキップ禁止）**
```bash
# ⚠️ 注意：YYYY-MMは現在の年月に置き換える！
# 例: 2026年2月なら archiveSanrenpukuResults_2026-02.json

# 月別ファイル + アーカイブファイルを同時にコミット
git add src/data/archiveSanrenpukuResults_YYYY-MM.json src/data/archiveSanrenpukuResults.json public/data/archiveSanrenpukuResults_YYYY-MM.json public/data/archiveSanrenpukuResults.json

git commit -m "$(cat <<'EOF'
📊 三連複結果更新・YYYY-MM-DD

- MM/DD（会場）: 的中○/12レース
- 回収率: ○○%
- 月別ファイル + 前月全日分+当月全日分統合

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

git push origin main
```

- ✅ **月別ファイルとアーカイブファイルを1回のコミットで同時更新**
- ✅ データの整合性を保証
- ✅ コミット漏れを防止

---

## 📸 **画像更新の手順**

**マコさんが「画像更新コミットプッシュ」と指示したら：**

### **🎯 更新される3箇所**

| ページ | 更新対象 | 表示枚数 | 更新方法 |
|--------|----------|----------|----------|
| **/premium-plus/** | Line 1367-1383 | 直近5戦 | 手動更新必須 |
| **/premium-sanrenpuku/** | Line 401-413 | 直近3戦（CTA） | 手動更新必須 |
| **/withdrawal-upsell/** | Line 534 | 最新1枚 | **自動読み込み** ✅ |

### **Step 0: 画像ファイルのGit状態確認（必須・最優先）**
```bash
# 新しい画像ファイルがGitに追加されているか確認
git status

# Untracked filesに upsell-YYYYMMDD.png がある場合は追加
git add public/upsell-images/upsell-YYYYMMDD.png
```

**⚠️ 重要：**
- 画像ファイルがGitにコミットされていないと、Netlifyにデプロイされない
- **必ずgit statusで確認してから次のステップへ進む**

### **Step 1: premium-plus.astro（5枚更新）**
```astro
<!-- Line 1367-1383 -->
<img src="/upsell-images/upsell-YYYYMMDD.png" />  <!-- 最新日 -->
<img src="/upsell-images/upsell-YYYYMMDD.png" />  <!-- 1日前 -->
<img src="/upsell-images/upsell-YYYYMMDD.png" />  <!-- 2日前 -->
<img src="/upsell-images/upsell-YYYYMMDD.png" />  <!-- 3日前 -->
<img src="/upsell-images/upsell-YYYYMMDD.png" />  <!-- 4日前 -->
```

### **Step 2: premium-sanrenpuku.astro（3枚更新）**
```astro
<!-- Line 401-413: Premium Plus CTAセクション -->
<img src="/upsell-images/upsell-YYYYMMDD.png" />  <!-- 最新日 -->
<img src="/upsell-images/upsell-YYYYMMDD.png" />  <!-- 1日前 -->
<img src="/upsell-images/upsell-YYYYMMDD.png" />  <!-- 2日前 -->
```

### **Step 3: withdrawal-upsell.astro（自動）**
- ✅ **自動で最新画像を読み込み**（Line 534）
- ✅ 最大10日前まで遡って検索
- ✅ 手動更新不要

### **Step 4: コミット・プッシュ（画像ファイル + Astroファイル）**
```bash
# 画像ファイルがUntracked filesの場合は追加（再確認）
git add public/upsell-images/upsell-YYYYMMDD.png

# Astroファイルも追加
git add src/pages/premium-plus.astro src/pages/premium-sanrenpuku.astro

# コミット
git commit -m "📸 Premium Plus実績画像更新・YYYY-MM-DD"

# プッシュ
git push origin main
```

### **コミットメッセージ例**
```
📸 Premium Plus実績画像更新・YYYY-MM-DD

- premium-plus.astro: 直近5戦（MM/DD〜MM/DD）
- premium-sanrenpuku.astro: 直近3戦（MM/DD〜MM/DD）
- withdrawal-upsell.astro: 自動読み込み ✅

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
```

### **⚠️ 重要ポイント**
- 📂 画像は `/public/upsell-images/upsell-YYYYMMDD.png` に配置
- 📅 ファイル名形式: `upsell-20251128.png`（8桁日付）
- 🔄 withdrawal-upsellは自動読み込みのため更新不要

---

## ✅ **チェックリスト（絶対に忘れない）**

### **予想更新時：**
- [ ] マコさんが管理画面でallRacesPrediction.json生成・配置
- [ ] クロちゃんが public/data/ に同期（**必須・スキップ禁止**）
- [ ] クロちゃんが 無料予想アーカイブ保存実行（**必須・スキップ禁止**）
- [ ] クロちゃんが JSON検証
- [ ] クロちゃんが コミット・プッシュ（**必須・スキップ禁止**）
- [ ] **❌「更新不要」判定は絶対にしない**

### **穴馬更新時：**
- [ ] マコさんが管理画面でdarkHorseData.json生成・配置
- [ ] クロちゃんが public/data/ に同期（**必須・スキップ禁止**）
- [ ] クロちゃんが JSON検証（レース数・穴馬候補数）
- [ ] クロちゃんが STORAGE_VERSION更新（**2箇所・必須**）
- [ ] クロちゃんが コミット・プッシュ（**必須・スキップ禁止**）
- [ ] **❌「更新不要」判定は絶対にしない**

### **馬単結果更新時：**
- [ ] マコさんが archiveResults_2025-12.json に貼り付け
- [ ] クロちゃんが **最新1日分のみ抽出**してarchiveResults.jsonに保存（**必須・スキップ禁止**）
- [ ] クロちゃんが JSON検証
- [ ] クロちゃんが public/data/ に両方同期（**必須・スキップ禁止**）
- [ ] クロちゃんが 1回のコミットで両ファイル更新・プッシュ（**必須・スキップ禁止**）
- [ ] **❌「更新不要」判定は絶対にしない**

### **三連複結果更新時：**
- [ ] マコさんが archiveSanrenpukuResults_2025-12.json に貼り付け
- [ ] クロちゃんが **11月分+12月分を統合**してarchiveSanrenpukuResults.jsonに保存（**必須・スキップ禁止**）
- [ ] クロちゃんが JSON検証（11月○日分+12月○日分）
- [ ] クロちゃんが public/data/ に両方同期（**必須・スキップ禁止**）
- [ ] クロちゃんが コミット・プッシュ（**必須・スキップ禁止**）
- [ ] **❌「更新不要」判定は絶対にしない**
- [ ] **❌「最新1日分のみ抽出」は絶対にしない**（11月分が消える）

### **画像更新時：**
- [ ] マコさんが upsell-YYYYMMDD.png を public/upsell-images/ に配置
- [ ] クロちゃんが git status で確認（**必須**）
- [ ] クロちゃんが premium-plus.astro 5枚更新（**必須**）
- [ ] クロちゃんが premium-sanrenpuku.astro 3枚更新（**必須**）
- [ ] クロちゃんが コミット・プッシュ（**必須・スキップ禁止**）
- [ ] **❌「更新不要」判定は絶対にしない**

---

## 📊 **馬単と三連複の違い（重要）**

| 項目 | 馬単結果 | 三連複結果 |
|------|----------|------------|
| **月別ファイル** | archiveResults_2025-12.json | archiveSanrenpukuResults_2025-12.json |
| **統合ファイル** | archiveResults.json | archiveSanrenpukuResults.json |
| **統合ファイル内容** | **最新1日分のみ** | **11月全日分+12月全日分** |
| **用途1** | トップページ「昨日の結果」 | /archive-sanrenpuku/2025/11/ |
| **用途2** | /archive/2025/12/ | /archive-sanrenpuku/2025/12/ |
| **用途3** | - | /standard-predictions/（最新日のみ使用） |
| **用途4** | - | /premium-predictions/（最新日のみ使用） |
| **長期運用** | 常に1日分（2.8KB） | 月が増えるごとに増加（11月+12月=約10KB） |

**重要ポイント：**
- ✅ **馬単**：トップページで使うため、最新1日分のみ抽出（ファイルサイズ最小化）
- ✅ **三連複**：/archive-sanrenpuku/で全日分表示するため、複数月統合が必要

---

## 🗓️ **月末処理（1月1日など）**

### **🚨 重要：新月開始時の必須手順（3ステップ）**

新月開始時に以下の3つを必ず実行してください：

#### **Step 1: 新しい月別ファイルを作成**
```bash
# 例: 2026年2月開始時
cp src/data/archiveResults_2026-01.json src/data/archiveResults_2026-02.json
cp src/data/archiveSanrenpukuResults_2026-01.json src/data/archiveSanrenpukuResults_2026-02.json

# 中身を空にして新月開始（手動編集）
```

#### **Step 2: アーカイブページにインポート追加（必須・忘れるとビルドエラー）**

**⚠️ 絶対に忘れてはいけない：**
新しい月別ファイルを作成したら、**必ず**アーカイブページにインポートを追加してください。
忘れると`validate-archive-data.js`がビルドエラーを発生させます。

**馬単アーカイブ（archive/index.astro）:**
```astro
// インポート追加
import archiveData2026_02 from '../../data/archiveResults_2026-02.json';

// データ統合に追加
const archiveData = {
  '2026': {
    ...archiveData2026_01['2026'],
    ...archiveData2026_02['2026']  // ← 新月分を追加
  }
};
```

**三連複アーカイブ（archive-sanrenpuku/index.astro）:**
```astro
// インポート追加
import archiveData2026_02 from '../../data/archiveSanrenpukuResults_2026-02.json';

// データ統合に追加
const archiveSanrenpukuResults = {
  '2026': {
    ...archiveData2026_01['2026'],
    ...archiveData2026_02['2026']  // ← 新月分を追加
  }
};
```

#### **Step 3: 月別アーカイブページ作成（必須・忘れるとリンク切れ）**

**⚠️ 重要：新月開始時は必ず月別アーカイブページも作成してください！**

**馬単アーカイブページ（/archive/2026/02.astro）:**
```bash
# 前月をコピーして作成
cp src/pages/archive/2026/01.astro src/pages/archive/2026/02.astro

# 以下の箇所を手動で編集（1月→2月に変更）
# - Line 3: import archiveData from '../../../data/archiveResults_2026-02.json';
# - Line 6: const month = '02';
# - Line 35: <title>2026年2月 南関競馬的中実績｜...
# - その他のメタタグ・本文中の「1月」→「2月」
```

**三連複アーカイブページ（/archive-sanrenpuku/2026/02.astro）:**
```bash
# 前月をコピーして作成
cp src/pages/archive-sanrenpuku/2026/01.astro src/pages/archive-sanrenpuku/2026/02.astro

# 以下の箇所を手動で編集（1月→2月に変更）
# - Line 3: import archiveData2026_02 from '../../../data/archiveSanrenpukuResults_2026-02.json';
# - Line 6: const month = '02';
# - Line 35: <title>2026年2月 三連複的中実績｜...
# - その他のメタタグ・本文中の「1月」→「2月」
```

**年間indexページに2月リンク追加（/archive/2026/index.astro）:**
```astro
// インポート追加
import archiveData02 from '../../../data/archiveResults_2026-02.json';

// データ統合に追加
const yearData = {
  ...archiveData01[year],
  ...archiveData02[year]  // ← 新月分を追加
};
```

**年間indexページに2月リンク追加（/archive-sanrenpuku/2026/index.astro）:**
```astro
// インポート追加
import archiveData2026_02 from '../../../data/archiveSanrenpukuResults_2026-02.json';

// データ統合に追加
const yearData = {
  ...archiveData2026_01[year],
  ...archiveData2026_02[year]  // ← 新月分を追加
};
```

#### **Step 4: コミット・プッシュ**
```bash
git add src/data/archiveResults_2026-02.json \
        src/data/archiveSanrenpukuResults_2026-02.json \
        src/pages/archive/index.astro \
        src/pages/archive-sanrenpuku/index.astro \
        src/pages/archive/2026/02.astro \
        src/pages/archive-sanrenpuku/2026/02.astro \
        src/pages/archive/2026/index.astro \
        src/pages/archive-sanrenpuku/2026/index.astro

git commit -m "🗓️ 2026年2月ファイル作成 + アーカイブページ追加 + インポート追加"
git push origin main
```

### **⚠️ よくあるミス（絶対にしないこと）**

❌ **月別ファイルだけ作成してアーカイブページを更新し忘れる**
- 結果: ビルドエラー（validate-archive-data.jsが検出）
- 修正: archive/index.astro と archive-sanrenpuku/index.astro にインポート追加

❌ **月別アーカイブページ（02.astro）を作成し忘れる**
- 結果: /archive/2026/ のリンクが404エラー
- 修正: archive/2026/02.astro と archive-sanrenpuku/2026/02.astro を作成

❌ **年間indexページ（/archive/2026/index.astro）に2月リンクを追加し忘れる**
- 結果: /archive/2026/ に2月が表示されない
- 修正: archive/2026/index.astro と archive-sanrenpuku/2026/index.astro にインポート追加

❌ **インポートだけ追加してデータ統合を忘れる**
- 結果: アーカイブページに新月データが表示されない
- 修正: `...archiveData2026_02['2026']` を統合オブジェクトに追加

✅ **正しい手順:**
1. 月別データファイル作成（archiveResults_2026-02.json, archiveSanrenpukuResults_2026-02.json）
2. アーカイブトップページにインポート追加（archive/index.astro, archive-sanrenpuku/index.astro）
3. データ統合に追加（yearData）
4. **月別アーカイブページ作成**（archive/2026/02.astro, archive-sanrenpuku/2026/02.astro）
5. **年間indexページに2月リンク追加**（archive/2026/index.astro, archive-sanrenpuku/2026/index.astro）
6. コミット・プッシュ（全ファイル一括）

---

**最終更新**: 2026-04-02
**バージョン**: 2.4.0 - Python実行形式をheredocに統一・確認禁止ルール追加

## 🔄 更新履歴

### 2.4.0 (2026-04-02) - Python実行形式の安全化・確認禁止ルール追加
- **全箇所**: `python3 -c "..."` を `python3 <<'PY' ... PY` heredoc形式に統一
- **全箇所**: Bash文字列内の `#` コメントを除去（確認ダイアログ防止）
- **馬単結果更新**: 確認を求めず即座に実行するルールを明記
- **Step 0簡素化**: 冗長な警告を削除し、要点のみに整理

### 2.2.0 (2026-02-12) - 年月指定の自動化・再発防止対策
- **馬単結果更新**: 年月を手動指定から`datetime.now()`による自動取得に変更
- **三連複結果更新**: 前月・当月を自動計算する仕組みを実装
- **Step 0追加**: 現在の年月確認を最優先手順として追加
- **警告メッセージ追加**: 手順書の例をそのままコピーしてはいけない旨を明記
- **再発防止**: 2026-02-12に発生した「2025年12月のファイルを誤って更新」問題を完全解決

### 2.1.0 (2026-02-02) - 月末処理の注意事項追加
- 新月開始時の必須手順を詳細化
- アーカイブページのインポート追加手順を明記
- よくあるミスのチェックリスト追加

### 2.3.0 (2026-02-12) - 穴馬更新の致命的エラー防止策追加
- Step 0: Git状態確認を最優先で追加
- Step 5: コミット前後にgit status確認を義務化
- src/data/ と public/data/ 両方のコミットを強調
- コミット漏れ防止のための警告メッセージ追加
