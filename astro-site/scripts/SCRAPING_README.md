# 🏇 外部サイト実績データ自動取り込みシステム

## 📋 概要

apolon.keibanahibi.com から**12年分（2013年9月〜現在）**のレース実績データを自動取得し、NANKANアナリティクスのarchiveResults.json形式に変換するスクリプトです。

## ✨ 機能

- ✅ **自動URL生成**: 2013年9月〜現在までの月別URL自動生成
- ✅ **HTML解析**: BeautifulSoupによる正確なデータ抽出
- ✅ **データ変換**: archiveResults.json形式への自動変換
- ✅ **既存データ保護**: 既存のarchiveResults.jsonとマージ（既存データ優先）
- ✅ **エラー処理**: 404エラー等の適切なハンドリング

## 🚀 実行方法

### 1. 依存ライブラリインストール

```bash
cd scripts
pip3 install -r requirements.txt
```

### 2. スクリプト実行

```bash
python3 scrape-external-results.py
```

### 3. 実行結果

```
🔍 外部サイトスクレイピング開始...
📅 対象期間: 2013年9月〜現在
📊 総URL数: 145件

⏳ 取得中: 2013年09月... ✅ 12レース取得
⏳ 取得中: 2013年10月... ✅ 15レース取得
...

📊 スクレイピング完了
✅ 成功: 120ヶ月
❌ 失敗: 25ヶ月
🏇 総レース数: 1,234レース

🔄 データ変換中...
✅ 変換完了

💾 保存完了: scraped_archive_results.json
```

### 4. 生成ファイル確認

```bash
# 生成されたJSONを確認
cat scraped_archive_results.json | head -50
```

### 5. 本番反映

```bash
# 問題なければarchiveResults.jsonにコピー
cp scraped_archive_results.json ../src/data/archiveResults.json

# git反映
cd ..
git add src/data/archiveResults.json
git commit -m "📊 12年分実績データ取り込み・外部サイトスクレイピング"
git push origin main
```

## ⚠️ 重要な注意事項

### データの制約

外部サイトには以下の制約があるため、完全なデータ復元は不可能です：

#### 1. **不的中レース情報なし**
- 外部サイトは的中レースのみ表示
- 不的中レースの情報は取得不可
- **影響**: 的中率が実際より高く表示される可能性

#### 2. **購入点数情報なし**
- 馬単の点数情報が不明
- **対応**: デフォルト1点（100円）として回収率計算
- **影響**: 回収率が不正確な可能性

#### 3. **レース名情報なし**
- 重賞レース名等の情報なし
- **対応**: 「XR」のみ表示

#### 4. **戦略情報なし**
- 少点数型・バランス型・高配当型の区別なし
- **対応**: 馬単のみなので「バランス型」と推測

### 推奨事項

1. **既存データ優先**
   - admin/results-managerで作成した正確なデータを優先
   - スクレイピングデータは**欠損期間の補完のみ**に使用

2. **データ検証**
   - scraped_archive_results.json を必ず確認
   - 明らかに異常な数値がないかチェック

3. **段階的反映**
   - まず一部期間（例：2023年〜）のみ反映
   - 問題なければ全期間反映

## 🔧 カスタマイズ

### スクレイピング期間変更

```python
# scrape-external-results.py 最下部
scraped_data = scrape_all_results(start_year=2020, start_month=1)  # 2020年1月〜
```

### デフォルト購入点数変更

```python
# scrape-external-results.py 内
total_bet = hit_races * 100  # ← この100を変更（例：200円=2点想定）
```

## 📊 出力フォーマット例

```json
{
  "2025": {
    "08": [
      {
        "date": "2025-08-31",
        "venue": "船橋",
        "totalRaces": 12,
        "hitRaces": 10,
        "hitRate": "83%",
        "totalPayout": 18180,
        "recoveryRate": "182%",
        "races": [
          {
            "raceNumber": 1,
            "raceName": "1R",
            "strategy": "バランス型",
            "betType": "馬単",
            "betDetails": "12-8",
            "result": "✅ 的中",
            "payout": "¥600"
          }
        ]
      }
    ]
  }
}
```

## 🐛 トラブルシューティング

### エラー: ModuleNotFoundError

```bash
# 依存ライブラリ再インストール
pip3 install -r requirements.txt
```

### エラー: Connection timeout

```bash
# タイムアウト時間延長（scrape-external-results.py内）
response = requests.get(url, timeout=30)  # 10→30秒
```

### データが取得できない

1. 外部サイトURL確認: https://apolon.keibanahibi.com/index.php?kaiinkekka
2. 月別ページURL確認: https://apolon.keibanahibi.com/index.php?kaiinkekka_202510
3. HTML構造変更の可能性（BeautifulSoup解析ロジック要修正）

## 📞 サポート

問題が発生した場合は、クロ（Claude）に以下の情報を提供してください：

1. エラーメッセージ全文
2. 実行環境（macOS/Python バージョン）
3. scraped_archive_results.json の一部（問題のある箇所）

---

**🌟 マコ&クロの最強コンビで、12年分のデータを一気に取り込み！** 🚀✨
