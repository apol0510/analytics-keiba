import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable API の呼び出し回数を Function 別に数える（月 100,000 回の上限管理 / docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'update-betting-data' });
import { promises as fs } from 'fs';
import path from 'path';

export async function handler(event, context) {
    // CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    // Handle preflight request
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const { bettingData } = JSON.parse(event.body);

        if (!bettingData) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Betting data is required' })
            };
        }

        // JSONファイルのパス
        const jsonFilePath = path.join(process.cwd(), 'src', 'data', 'allRacesPrediction.json');

        // 現在のJSONデータを読み込み
        const currentData = JSON.parse(await fs.readFile(jsonFilePath, 'utf8'));

        // 買い目データのみ更新
        currentData.races.forEach((race, index) => {
            const raceNum = index + 1;
            const newRaceData = bettingData[raceNum];

            if (newRaceData && newRaceData.strategies) {
                // 戦略Aの更新
                if (newRaceData.strategies.safe && race.strategies.safe) {
                    race.strategies.safe.bets = newRaceData.strategies.safe;
                    console.log(`Updated ${raceNum}R Safe strategy:`, newRaceData.strategies.safe);
                }

                // 戦略Bの更新
                if (newRaceData.strategies.balance && race.strategies.balance) {
                    race.strategies.balance.bets = newRaceData.strategies.balance;
                    console.log(`Updated ${raceNum}R Balance strategy:`, newRaceData.strategies.balance);
                }

                // 戦略Cの更新
                if (newRaceData.strategies.aggressive && race.strategies.aggressive) {
                    race.strategies.aggressive.bets = newRaceData.strategies.aggressive;
                    console.log(`Updated ${raceNum}R Aggressive strategy:`, newRaceData.strategies.aggressive);
                }
            }
        });

        // JSONファイルに書き戻し
        await fs.writeFile(jsonFilePath, JSON.stringify(currentData, null, 2), 'utf8');

        console.log('🎯 Betting data successfully updated!');

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                message: 'Betting data updated successfully',
                updatedRaces: Object.keys(bettingData).length
            })
        };

    } catch (error) {
        console.error('Error updating betting data:', error);

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'Failed to update betting data',
                details: error.message
            })
        };
    }
}

export { handler as default };