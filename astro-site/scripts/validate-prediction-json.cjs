#!/usr/bin/env node

/**
 * allRacesPrediction.json 構文検証スクリプト
 * GitHubコミット前にローカルでJSON検証を実行
 */

const fs = require('fs');
const path = require('path');

const PREDICTION_JSON_PATH = path.join(__dirname, '../src/data/allRacesPrediction.json');

console.log('🔍 allRacesPrediction.json 構文検証開始...\n');

try {
    // ファイル読み込み
    const fileContent = fs.readFileSync(PREDICTION_JSON_PATH, 'utf8');

    // JSON パース試行
    const data = JSON.parse(fileContent);

    console.log('✅ JSON構文: 正常');
    console.log('✅ パース成功\n');

    // データ構造検証
    console.log('📊 データ統計:');
    console.log(`   日付: ${data.raceDate || '未設定'}`);
    console.log(`   競馬場: ${data.track || '未設定'}`);
    console.log(`   総レース数: ${data.totalRaces || 0}R`);

    if (data.races && Array.isArray(data.races)) {
        console.log(`   レースデータ: ${data.races.length}レース分`);

        // メインレース確認
        const mainRace = data.races.find(r => r.isMainRace === true);
        if (mainRace) {
            console.log(`   メインレース: ${mainRace.raceNumber} (${mainRace.raceName})`);
        } else {
            console.warn('   ⚠️ メインレースが設定されていません');
        }

        // tierの分布確認
        const tierCounts = {
            premium: 0,
            standard: 0,
            free: 0
        };

        data.races.forEach(race => {
            if (tierCounts[race.tier] !== undefined) {
                tierCounts[race.tier]++;
            }
        });

        console.log(`   tier分布: Premium ${tierCounts.premium}R / Standard ${tierCounts.standard}R / Free ${tierCounts.free}R`);
    }

    console.log('\n✅ allRacesPrediction.json は正常です！');
    process.exit(0);

} catch (error) {
    console.error('❌ JSON構文エラー検出:\n');

    if (error instanceof SyntaxError) {
        console.error(`   エラー箇所: ${error.message}`);

        // エラー位置を特定
        const lines = fs.readFileSync(PREDICTION_JSON_PATH, 'utf8').split('\n');
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
        console.error('   1. カンマ不足: 配列要素やオブジェクトの間にカンマがない');
        console.error('   2. カンマ余剰: 最後の要素の後にカンマがある');
        console.error('   3. 括弧不一致: { } [ ] の開閉が合っていない');
        console.error('   4. 引用符エラー: " の閉じ忘れ');
        console.error('   5. コメント残存: JSONにはコメント（//）は書けません');

    } else {
        console.error(error);
    }

    console.error('\n❌ GitHubコミット前に修正してください\n');
    process.exit(1);
}
