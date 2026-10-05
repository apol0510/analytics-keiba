import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable API の呼び出し回数を Function 別に数える（月 100,000 回の上限管理 / docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'update-complete-data' });
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
        const body = JSON.parse(event.body || '{}');
        const { completeData } = body;

        if (!completeData) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Complete data is required' })
            };
        }

        // データをログ出力
        console.log('🔄 予想データを受信しました');
        console.log('Received data keys:', Object.keys(completeData));

        let updatedRacesCount = 0;

        // 各レースのデータを確認
        for (const [raceNum, raceData] of Object.entries(completeData)) {
            if (raceData) {
                console.log(`🎯 ${raceNum}R データ受信`);
                updatedRacesCount++;
            }
        }

        console.log(`🎯 ${updatedRacesCount}レースのデータを処理しました`);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                message: 'Complete data received successfully',
                updatedRaces: updatedRacesCount,
                note: 'データは正常に受信されました'
            })
        };

    } catch (error) {
        console.error('Error processing data:', error);
        console.error('Error details:', error.message);
        console.error('Error stack:', error.stack);

        return {
            statusCode: 200, // エラーでも200を返してデバッグ
            headers,
            body: JSON.stringify({
                success: false,
                error: 'Processing error',
                details: error.message || 'Unknown error',
                note: 'エラーが発生しましたが、処理は継続可能です'
            })
        };
    }
}

export default handler;