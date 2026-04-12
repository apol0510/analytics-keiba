#!/bin/bash

# 🎯 premium-plus.astro 画像自動更新スクリプト
# 使い方: bash scripts/update-premium-plus-images.sh

set -e

echo "🔍 最新5枚の画像を検索中..."

# public/upsell-images/ 内の最新5枚を取得
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
IMAGE_DIR="$PROJECT_ROOT/public/upsell-images"
TARGET_FILE="$PROJECT_ROOT/src/pages/premium-plus.astro"

# 最新5枚のファイル名（日付降順）
# Mac対応: basenameで確実にファイル名のみ取得
cd "$IMAGE_DIR"
IMAGES=($(ls -1 upsell-*.png 2>/dev/null | grep -v "^Mobile" | sort -r | head -5))
cd - > /dev/null

if [ ${#IMAGES[@]} -lt 5 ]; then
  echo "❌ エラー: 画像が5枚未満です（${#IMAGES[@]}枚）"
  exit 1
fi

echo "✅ 最新5枚の画像:"
for i in "${!IMAGES[@]}"; do
  echo "  $((i+1)). ${IMAGES[$i]}"
done

echo ""
echo "📝 premium-plus.astro を更新中..."

# 現在の日付を抽出（Mac対応: sedを使用）
CURRENT_DATES=($(grep 'upsell-[0-9]\{8\}\.png' "$TARGET_FILE" | sed -E 's/.*upsell-([0-9]{8})\.png.*/\1/' | head -5))

echo ""
echo "🔄 更新内容:"
for i in {0..4}; do
  OLD_DATE="${CURRENT_DATES[$i]}"
  NEW_IMAGE="${IMAGES[$i]}"
  NEW_DATE=$(echo "$NEW_IMAGE" | sed -E 's/upsell-([0-9]{8})\.png/\1/')

  if [ "$OLD_DATE" != "$NEW_DATE" ]; then
    echo "  📅 行$((472 + i*3)): $OLD_DATE → $NEW_DATE"
    # Mac対応: -i '' でバックアップなし
    sed -i '' "s/upsell-$OLD_DATE\.png/upsell-$NEW_DATE.png/g" "$TARGET_FILE"
  else
    echo "  ✓ 行$((472 + i*3)): $NEW_DATE (変更なし)"
  fi
done

echo ""
echo "✅ 更新完了！"
echo ""
echo "📋 次のステップ:"
echo "  1. git add astro-site/src/pages/premium-plus.astro"
echo "  2. git commit -m '📸 premium-plus画像更新・$(date +%Y%m%d)反映'"
echo "  3. git push origin main"
echo ""
echo "🎉 デプロイ後、約1-2分で本番反映されます！"
