#!/usr/bin/env node

/**
 * archiveResults.json 構文検証スクリプト
 * GitHubコミット前にローカルでJSON検証を実行
 */

const fs = require('fs');
const path = require('path');

const ARCHIVE_JSON_PATH = path.join(__dirname, '../src/data/archiveResults.json');

console.log('🔍 archiveResults.json 構文検証開始...\n');

try {
    // ファイル読み込み
    const fileContent = fs.readFileSync(ARCHIVE_JSON_PATH, 'utf8');

    // JSON パース試行
    const data = JSON.parse(fileContent);

    console.log('✅ JSON構文: 正常');
    console.log('✅ パース成功\n');

    // データ構造検証
    console.log('📊 データ統計:');

    if (data['2025']) {
        const months = Object.keys(data['2025']);
        console.log(`   年: 2025`);
        console.log(`   月数: ${months.length}`);

        months.forEach(month => {
            const days = Object.keys(data['2025'][month]);
            console.log(`   ${month}月: ${days.length}日分のデータ`);
        });
    }

    console.log('\n✅ archiveResults.json は正常です！');
    process.exit(0);

} catch (error) {
    console.error('❌ JSON構文エラー検出:\n');

    if (error instanceof SyntaxError) {
        console.error(`   エラー箇所: ${error.message}`);

        // エラー位置を特定
        const lines = fs.readFileSync(ARCHIVE_JSON_PATH, 'utf8').split('\n');
        const errorMatch = error.message.match(/position (\d+)/);

        if (errorMatch) {
            const position = parseInt(errorMatch[1]);
            let currentPos = 0;
            let errorLine = 0;

            for (let i = 0; i < lines.length; i++) {
                currentPos += lines[i].length + 1; // +1 for newline
                if (currentPos >= position) {
                    errorLine = i + 1;
                    break;
                }
            }

            console.error(`   おそらく ${errorLine} 行目付近にエラーがあります`);
            console.error(`\n   該当行:\n   ${lines[errorLine - 1]}`);
        }

        console.error('\n💡 よくあるエラー原因:');
        console.error('   1. カンマ不足: 前のデータブロックの } 後にカンマがない');
        console.error('   2. カンマ余剰: 最後のデータブロックの } 後にカンマがある');
        console.error('   3. 括弧不一致: { } の開閉が合っていない');
        console.error('   4. 引用符エラー: " の閉じ忘れ');

    } else {
        console.error(error);
    }

    console.error('\n❌ GitHubコミット前に修正してください\n');
    process.exit(1);
}
