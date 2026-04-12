#!/bin/bash
# 年次メンテナンススクリプト
# 実行: bash scripts/annual-maintenance.sh 2024
# 目的: 2年以上前の画像削除・容量確認

set -e

if [ $# -eq 0 ]; then
    echo "❌ エラー: 削除対象年を指定してください"
    echo "使用例: bash scripts/annual-maintenance.sh 2024"
    exit 1
fi

TARGET_YEAR=$1
CURRENT_YEAR=$(date +%Y)

# 安全チェック: 2年以上前の年のみ削除可能
if [ $TARGET_YEAR -ge $(($CURRENT_YEAR - 1)) ]; then
    echo "❌ エラー: ${TARGET_YEAR}年は削除できません"
    echo "現在: ${CURRENT_YEAR}年"
    echo "削除可能: $((CURRENT_YEAR - 2))年以前"
    exit 1
fi

echo "🗑️ 年次メンテナンス開始"
echo "============================================================"
echo "削除対象年: ${TARGET_YEAR}年"
echo "現在: ${CURRENT_YEAR}年"
echo ""

# 1. 削除前の容量確認
echo "📊 削除前の容量:"
du -sh public/upsell-images/ || true
IMAGE_COUNT_BEFORE=$(find public/upsell-images/ -name "*.png" | wc -l | xargs)
echo "画像数: ${IMAGE_COUNT_BEFORE}枚"
echo ""

# 2. 対象ファイル確認
echo "🔍 削除対象ファイル:"
TARGET_FILES=$(find public/upsell-images/ -name "upsell-${TARGET_YEAR}*.png")
if [ -z "$TARGET_FILES" ]; then
    echo "✅ ${TARGET_YEAR}年の画像は存在しません（既に削除済み）"
    exit 0
fi

echo "$TARGET_FILES" | while read file; do
    echo "  - $(basename $file)"
done

TARGET_COUNT=$(echo "$TARGET_FILES" | wc -l | xargs)
echo ""
echo "削除予定: ${TARGET_COUNT}枚"
echo ""

# 3. 確認プロンプト
read -p "削除を実行しますか？ (y/N): " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "❌ キャンセルしました"
    exit 0
fi

# 4. 削除実行
echo ""
echo "🗑️ 削除実行中..."
find public/upsell-images/ -name "upsell-${TARGET_YEAR}*.png" -delete

# 5. 削除後の容量確認
echo ""
echo "📊 削除後の容量:"
du -sh public/upsell-images/ || true
IMAGE_COUNT_AFTER=$(find public/upsell-images/ -name "*.png" | wc -l | xargs)
echo "画像数: ${IMAGE_COUNT_AFTER}枚"
echo ""

# 6. データ容量確認
echo "📊 全体データ容量:"
du -sh src/data/ public/data/ public/upsell-images/
echo ""

# 7. ビルド検証
echo "🔨 ビルド検証..."
npm run build > /tmp/build.log 2>&1
if [ $? -eq 0 ]; then
    echo "✅ ビルド成功"
else
    echo "❌ ビルドエラー"
    cat /tmp/build.log
    exit 1
fi

# 8. Gitコミット準備
echo ""
echo "📝 Gitコミット準備:"
git status --short | grep "upsell-images"

echo ""
echo "============================================================"
echo "✅ 年次メンテナンス完了"
echo ""
echo "削除: ${TARGET_COUNT}枚"
echo "残存: ${IMAGE_COUNT_AFTER}枚"
echo ""
echo "次のステップ:"
echo "  1. git add public/upsell-images/"
echo "  2. git commit -m \"🗑️ ${TARGET_YEAR}年画像削除・年次メンテナンス\""
echo "  3. git push origin main"
