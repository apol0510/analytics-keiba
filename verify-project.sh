#!/bin/bash

# ========================================
# プロジェクト確認スクリプト
# ========================================
# 目的: Claudeセッション開始時に正しいプロジェクトで作業していることを確認
# 作成日: 2025-12-03
# ========================================

echo "========================================="
echo "🔍 プロジェクト確認開始"
echo "========================================="

# 期待値
EXPECTED_PROJECT="nankan-analytics"
EXPECTED_DIR="/Users/apolon/Library/Mobile Documents/com~apple~CloudDocs/WorkSpace/nankan-analytics/astro-site"
EXPECTED_GIT="apol0510/nankan-analytics.git"

# 現在のディレクトリ
CURRENT_DIR=$(pwd)
echo "📂 現在のディレクトリ: $CURRENT_DIR"

# Gitリポジトリ確認
if [ -d ".git" ] || git rev-parse --git-dir > /dev/null 2>&1; then
    GIT_REMOTE=$(git remote get-url origin 2>/dev/null)
    echo "📦 Gitリポジトリ: $GIT_REMOTE"
else
    echo "⚠️  警告: Gitリポジトリが見つかりません"
    GIT_REMOTE=""
fi

# プロジェクト名確認
PROJECT_NAME=$(basename $(dirname $(pwd)))
echo "🏷️  プロジェクト名: $PROJECT_NAME"

echo "========================================="

# 検証
ERROR=0

# ディレクトリチェック
if [[ "$CURRENT_DIR" != *"$EXPECTED_PROJECT"* ]]; then
    echo "❌ エラー: 間違ったプロジェクトです"
    echo "   期待: *$EXPECTED_PROJECT*"
    echo "   実際: $CURRENT_DIR"
    ERROR=1
fi

# Gitリポジトリチェック
if [[ "$GIT_REMOTE" != *"$EXPECTED_GIT"* ]]; then
    echo "❌ エラー: 間違ったGitリポジトリです"
    echo "   期待: *$EXPECTED_GIT*"
    echo "   実際: $GIT_REMOTE"
    ERROR=1
fi

# 結果
if [ $ERROR -eq 0 ]; then
    echo "✅ 確認完了: 正しいプロジェクト（nankan-analytics）で作業中です"
    echo "========================================="
    exit 0
else
    echo "========================================="
    echo "⚠️  警告: 今すぐ正しいディレクトリに移動してください"
    echo ""
    echo "移動コマンド:"
    echo "cd \"$EXPECTED_DIR\""
    echo "========================================="
    exit 1
fi
