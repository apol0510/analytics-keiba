// Queue方式メルマガ配信システム - 失敗分再送Function
// failed → pending に戻して再送可能にする

export default async function handler(request, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers });
  }

  try {
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      throw new Error('Missing configuration');
    }

    // リクエストボディ解析
    const body = await request.json();
    const { jobId } = body;

    if (!jobId) {
      throw new Error('Missing required field: jobId');
    }

    console.log('🔄 失敗分再送設定開始:', jobId);

    const queueUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/NewsletterQueue`;

    // failed レコードを取得
    const filterFormula = `AND({JobId} = "${jobId}", {Status} = "failed")`;
    const fetchUrl = `${queueUrl}?filterByFormula=${encodeURIComponent(filterFormula)}`;

    const fetchResponse = await fetch(fetchUrl, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`
      }
    });

    if (!fetchResponse.ok) {
      throw new Error(`Failed fetch failed: ${fetchResponse.status}`);
    }

    const fetchData = await fetchResponse.json();
    const failedRecords = fetchData.records || [];

    console.log(`📊 失敗レコード数: ${failedRecords.length}件`);

    if (failedRecords.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: '再送対象がありません',
          retryCount: 0
        }),
        { status: 200, headers }
      );
    }

    // failed → pending に更新（バッチ処理・10件ずつ）
    const batches = chunkArray(failedRecords, 10);
    let retryCount = 0;

    for (const batch of batches) {
      const updatePayload = {
        records: batch.map(record => ({
          id: record.id,
          fields: {
            'Status': 'pending',
            'LastError': '' // エラーメッセージクリア
          }
        }))
      };

      const updateResponse = await fetch(queueUrl, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updatePayload)
      });

      if (updateResponse.ok) {
        retryCount += batch.length;
        console.log(`✅ ${batch.length}件を再送待ちに変更`);
      } else {
        console.error('❌ バッチ更新失敗:', updateResponse.status);
      }

      // Airtableレート制限対策（5rps）
      await sleep(200);
    }

    console.log(`✅ 再送設定完了: ${retryCount}件`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `${retryCount}件を再送待ちに変更しました`,
        retryCount
      }),
      { status: 200, headers }
    );

  } catch (error) {
    console.error('❌ 再送設定エラー:', error);

    return new Response(
      JSON.stringify({
        error: error.message || 'Unknown error',
        success: false
      }),
      { status: 500, headers }
    );
  }
}

// ヘルパー関数: 配列を指定サイズのチャンクに分割
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// ヘルパー関数: Sleep
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
