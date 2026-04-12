/**
 * Airtable Customersテーブル: 全レコードのPlanTypeを削除（元に戻す）
 * 全レコードのPlanTypeを空（null）に設定
 *
 * 使い方: ブラウザで以下のURLにアクセス
 * https://nankan-analytics.keiba.link/.netlify/functions/reset-all-plantype
 */

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  // プリフライトリクエスト対応
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // GETメソッドのみ許可
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const AIRTABLE_TABLE_NAME = 'Customers';

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      throw new Error('Airtable credentials not configured');
    }

    console.log('🔄 全レコードのPlanTypeリセット開始...');

    // Airtable APIでCustomersテーブルの全レコードを取得
    let allRecords = [];
    let offset = null;

    do {
      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}${offset ? `?offset=${offset}` : ''}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Airtable API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      allRecords = allRecords.concat(data.records);
      offset = data.offset;

      console.log(`✅ 取得済み: ${allRecords.length}件`);

    } while (offset);

    console.log(`📊 総レコード数: ${allRecords.length}件`);

    // PlanTypeが設定されているレコードをフィルタリング
    const recordsToReset = allRecords.filter(record => record.fields.PlanType);
    console.log(`🔍 リセット対象（PlanType設定あり）: ${recordsToReset.length}件`);

    if (recordsToReset.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: '✅ リセット対象なし（すべてのPlanTypeは既に空です）',
          totalRecords: allRecords.length,
          updatedRecords: 0
        })
      };
    }

    // 10件ずつバッチ更新（Airtable API制限対応）
    let updatedCount = 0;
    for (let i = 0; i < recordsToReset.length; i += 10) {
      const batch = recordsToReset.slice(i, i + 10);

      const updatePayload = {
        records: batch.map(record => ({
          id: record.id,
          fields: {
            'PlanType': null  // 空にする
          }
        }))
      };

      const updateUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_TABLE_NAME}`;
      const updateResponse = await fetch(updateUrl, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(updatePayload)
      });

      if (!updateResponse.ok) {
        const errorText = await updateResponse.text();
        throw new Error(`Airtable update error (${updateResponse.status}): ${errorText}`);
      }

      updatedCount += batch.length;
      console.log(`✅ ${updatedCount}/${recordsToReset.length}件リセット済み`);

      // Airtable API制限対策（5 requests/second）
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log(`🎉 リセット完了: ${updatedCount}件のPlanTypeを削除しました`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: '✅ リセット完了（元に戻しました）',
        totalRecords: allRecords.length,
        updatedRecords: updatedCount,
        details: `${updatedCount}件のレコードのPlanTypeを空に設定しました`
      })
    };

  } catch (error) {
    console.error('❌ リセットエラー:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message,
        details: 'リセット中にエラーが発生しました'
      })
    };
  }
};
