#!/usr/bin/env node

/**
 * 🛡️ 復活防止チェッカー（簡潔版）
 * 実際に問題となる実装のみをチェック
 */

const fs = require('fs');
const path = require('path');

console.log('🔍 復活防止チェック中...\n');

const indexPath = path.join(__dirname, 'src/pages/index.astro');

if (fs.existsSync(indexPath)) {
    const content = fs.readFileSync(indexPath, 'utf8');

    // 実際の問題パターンのチェック
    let hasErrors = false;

    // raceResults.jsonの実際のインポート
    if (/^import.*raceResults.*from.*['"].*raceResults\.json['"];?$/m.test(content)) {
        console.log('🚨 CRITICAL: raceResults.jsonの実際のインポートが検出されました');
        hasErrors = true;
    }

    // yesterdayResultsが正しく使用されているかチェック
    if (!content.includes('const currentResults = yesterdayResults')) {
        console.log('⚠️  WARNING: currentResults = yesterdayResults が見つかりません');
        hasErrors = true;
    }

    // race.result === 'win' の使用をチェック
    if (!content.includes("race.result === 'win'")) {
        console.log('⚠️  WARNING: race.result === "win" が見つかりません');
        hasErrors = true;
    }

    if (hasErrors) {
        console.log('\n❌ 問題が検出されました');
        console.log('📖 NEVER_USE_raceResults.md を確認してください');
    } else {
        console.log('✅ 復活防止チェック完了: 問題なし！');
        console.log('🛡️ admin/results-managerで生成したデータが正しく反映されます');
    }
} else {
    console.log('❌ index.astro が見つかりません');
}