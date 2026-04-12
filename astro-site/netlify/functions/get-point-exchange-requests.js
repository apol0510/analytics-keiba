// ポイント交換申請データ取得（管理画面用）

const Airtable = require('airtable');

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

exports.handler = async (event, context) => {
  // CORSヘッダー設定
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  // OPTIONSリクエスト（プリフライト）対応
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // GETリクエストのみ受付
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    console.log('📊 ポイント交換申請データ取得開始');

    // Airtableから全レコード取得
    const records = await base('PointExchangeRequests').select({
      sort: [{ field: 'RequestDate', direction: 'desc' }]
    }).all();

    console.log(`✅ ${records.length}件の申請データを取得`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        requests: records,
        count: records.length
      })
    };

  } catch (error) {
    console.error('❌ Airtableデータ取得エラー:', error);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'データ取得に失敗しました',
        details: error.message
      })
    };
  }
};
