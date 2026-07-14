#!/bin/bash

# 🖼️ withdrawal-upsell.astro の画像更新（最新1枚）+ git push
#
# ⚠️ premium-plus は対象外になりました（2026-07 刷新）。
#    Premium Plus の実績画像は git ではなく Netlify Blobs で管理し、
#    ビルド不要で即反映されます。以下のどちらかを使ってください:
#      - 管理画面: /admin/premium-plus-images
#      - ターミナル: npm run upload:premium-plus -- --file <画像> --date YYYY-MM-DD ...
#    詳細: docs/PREMIUM_PLUS.md
#
# 使い方: bash scripts/update-all-images.sh

set -e

echo "🖼️  withdrawal-upsell 画像更新"
echo "================================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
IMAGE_DIR="$PROJECT_ROOT/public/upsell-images"
WITHDRAWAL_UPSELL="$PROJECT_ROOT/src/pages/withdrawal-upsell.astro"

cd "$IMAGE_DIR"
ALL_IMAGES=($(ls -1 upsell-*.png 2>/dev/null | grep -v "^Mobile" | sort -r))
cd - > /dev/null

if [ ${#ALL_IMAGES[@]} -lt 1 ]; then
  echo "❌ エラー: 画像がありません"
  exit 1
fi

LATEST_1="${ALL_IMAGES[0]}"
echo "✅ 最新画像: $LATEST_1"
echo ""

echo "📝 withdrawal-upsell.astro を更新中..."
CURRENT_WITHDRAWAL=$(grep 'upsell-[0-9]\{8\}\.png' "$WITHDRAWAL_UPSELL" | sed -E 's/.*upsell-([0-9]{8})\.png.*/\1/' | head -1)
NEW_WITHDRAWAL=$(echo "$LATEST_1" | sed -E 's/upsell-([0-9]{8})\.png/\1/')

if [ "$CURRENT_WITHDRAWAL" != "$NEW_WITHDRAWAL" ]; then
  echo "  📅 更新: $CURRENT_WITHDRAWAL → $NEW_WITHDRAWAL"
  sed -i '' "s/upsell-$CURRENT_WITHDRAWAL\.png/upsell-$NEW_WITHDRAWAL.png/g" "$WITHDRAWAL_UPSELL"
else
  echo "  ✓ $NEW_WITHDRAWAL (変更なし)"
  echo ""
  echo "変更がないため終了します。"
  exit 0
fi

echo ""
echo "🚀 Git コミット・プッシュ..."

cd "$PROJECT_ROOT"
git add public/upsell-images/*.png
git add src/pages/withdrawal-upsell.astro

COMMIT_DATE=$(date +%Y%m%d)
git commit -m "📸 withdrawal-upsell 画像更新・${COMMIT_DATE}反映"
git push origin HEAD:main

echo ""
echo "🎉 完了。Netlify デプロイ後 1-2 分で反映されます"
echo "💡 Premium Plus の画像は別系統（Blobs）です → npm run upload:premium-plus"
echo ""
