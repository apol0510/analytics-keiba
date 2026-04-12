#!/bin/bash

# 復活防止：最終確定状態検証スクリプト
# 実行方法: bash scripts/verify-final-state.sh

echo "🔍 復活防止検証開始..."
echo "================================"

# プログレスバーテキスト確認
echo "📊 1. プログレスバーテキスト確認"
PROGRESS_TEXT=$(grep -r "AI予測{progressConfidence}%" src/components/ProgressBarConfidence.astro)
if [ -n "$PROGRESS_TEXT" ]; then
    echo "✅ PASS: プログレスバーテキスト正常"
else
    echo "❌ FAIL: プログレスバーテキストが変更されています"
fi

# 戦略名確認
echo ""
echo "📊 2. 戦略名「モデル」確認"
STRATEGY_MODELS=$(grep -c "モデル" src/lib/shared-prediction-logic.js)
if [ "$STRATEGY_MODELS" -ge 3 ]; then
    echo "✅ PASS: 戦略名「モデル」統一確認 ($STRATEGY_MODELS個検出)"
else
    echo "❌ FAIL: 戦略名「モデル」が不足しています ($STRATEGY_MODELS個)"
fi

# 重要な禁止パターン検出（プログレスバー関連のみ）
echo ""
echo "📊 3. 重要な禁止パターン検出"
BAD_PATTERN1=$(grep -r "AIモデル予測:" src/components/ProgressBarConfidence.astro 2>/dev/null | wc -l)
BAD_PATTERN2=$(grep -r "的中率.*%" src/components/ProgressBarConfidence.astro 2>/dev/null | wc -l)
BAD_PATTERN3=$(grep -r "（推奨度" src/pages/*predictions.astro 2>/dev/null | wc -l)

if [ "$BAD_PATTERN1" -eq 0 ] && [ "$BAD_PATTERN2" -eq 0 ] && [ "$BAD_PATTERN3" -eq 0 ]; then
    echo "✅ PASS: 重要な禁止パターン未検出"
else
    echo "❌ FAIL: 重要な禁止パターン検出 - AIモデル予測:$BAD_PATTERN1, 的中率%:$BAD_PATTERN2, 推奨度表示:$BAD_PATTERN3"
fi

# プログレスバー透明感デザイン確認
echo ""
echo "📊 4. プログレスバー透明感デザイン確認"
TRANSPARENCY_CHECK=$(grep -c "rgba.*0\.15.*0\.25.*0\.2" src/components/ProgressBarConfidence.astro)
if [ "$TRANSPARENCY_CHECK" -ge 3 ]; then
    echo "✅ PASS: 透明感グラデーション確認 ($TRANSPARENCY_CHECK個)"
else
    echo "❌ FAIL: 透明感グラデーションが変更されています"
fi

# 最終判定
echo ""
echo "================================"
if [ "$BAD_PATTERN1" -eq 0 ] && [ "$BAD_PATTERN2" -eq 0 ] && [ "$BAD_PATTERN3" -eq 0 ] && [ "$STRATEGY_MODELS" -ge 3 ] && [ "$TRANSPARENCY_CHECK" -ge 3 ] && [ -n "$PROGRESS_TEXT" ]; then
    echo "🎉 総合判定: ✅ PASS - 最終確定状態を維持"
    echo "🔒 復活防止対策: 成功"
else
    echo "⚠️  総合判定: ❌ FAIL - 復活が検出されました"
    echo "🔧 対処方法: CLAUDE.mdの復活防止対策を参照"
fi

echo "================================"
echo "🏁 検証完了"