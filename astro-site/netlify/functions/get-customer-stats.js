// 顧客統計取得Function
export default async function handler(request, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers });
  }

  if (request.method !== 'GET') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }), 
      { status: 405, headers }
    );
  }

  try {
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      throw new Error('Airtable configuration missing');
    }

    // Customersテーブルから全顧客データを取得（ページング対応）
    let allRecords = [];
    let offset = null;
    
    do {
      const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers`);
      if (offset) {
        url.searchParams.set('offset', offset);
      }
      
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Airtable API error: ${response.status}`);
      }

      const data = await response.json();
      allRecords.push(...data.records);
      offset = data.offset;
      
    } while (offset);

    console.log(`Total records fetched: ${allRecords.length}`);
    
    // 15,000件対応：処理時間をログに記録
    const startTime = Date.now();
    
    // プラン別統計を集計
    const stats = {
      total: 0,
      free: 0,
      standard: 0,
      premium: 0,
      test: 0
    };

    allRecords.forEach(record => {
      const plan = (record.fields['プラン'] || record.fields.Plan || 'Free').toLowerCase();
      stats.total++;
      
      if (plan === 'free') {
        stats.free++;
      } else if (plan === 'standard') {
        stats.standard++;
      } else if (plan === 'premium') {
        stats.premium++;
      } else if (plan === 'test') {
        stats.test++;
      } else {
        stats.free++; // デフォルトはFree
      }
    });

    const endTime = Date.now();
    console.log(`Processing time: ${endTime - startTime}ms for ${allRecords.length} records`);
    
    return new Response(
      JSON.stringify({
        success: true,
        ...stats,
        processingTime: endTime - startTime,
        recordCount: allRecords.length
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('Customer stats error:', error);
    
    return new Response(
      JSON.stringify({ 
        success: false,
        error: error.message,
        // フォールバック値
        total: 0,
        free: 0,
        standard: 0,
        premium: 0,
        test: 0
      }),
      { status: 200, headers } // エラーでも200を返してUIが壊れないようにする
    );
  }
}