// デバッグ用：すべての顧客レコードを表示

const Airtable = require('airtable');

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  console.log('🔍 全顧客レコード取得開始');

  try {
    // 環境変数確認
    const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

    if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: '環境変数が設定されていません' })
      };
    }

    // Airtable設定
    const base = new Airtable({ apiKey: AIRTABLE_API_KEY })
      .base(AIRTABLE_BASE_ID);

    // すべてのレコードを取得（フィルタなし）
    const allRecords = await base('Customers')
      .select({
        maxRecords: 20,  // 最大20件
        sort: [{ field: '有効期限', direction: 'desc' }]  // 有効期限の降順
      })
      .firstPage();

    console.log(`📊 全レコード数: ${allRecords.length}件`);

    // 詳細情報を取得
    const recordDetails = allRecords.map(record => {
      const fields = record.fields;
      return {
        id: record.id,
        Email: fields.Email || '（空）',
        氏名: fields['氏名'] || '（空）',
        プラン: fields['プラン'] || '（空）',
        Status: fields.Status || '（空）',
        PaymentMethod: fields.PaymentMethod || '（空）',
        有効期限: fields['有効期限'] || '（空）',
        ExpiryWarningNotificationSent: fields.ExpiryWarningNotificationSent || false
      };
    });

    // 今日から7日後の日付
    const sevenDaysLater = new Date();
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
    const sevenDaysLaterStr = sevenDaysLater.toISOString().split('T')[0];

    // 条件に合致するレコードを手動でフィルタ
    const matchingRecords = recordDetails.filter(record => {
      return (
        record['有効期限'] === sevenDaysLaterStr &&
        record['プラン'] !== 'Free' &&
        record.PaymentMethod === 'Bank Transfer' &&
        !record.ExpiryWarningNotificationSent
      );
    });

    console.log('📋 全レコード詳細:', JSON.stringify(recordDetails, null, 2));
    console.log('✅ 条件一致レコード:', JSON.stringify(matchingRecords, null, 2));

    // 結果を返す
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        totalRecords: allRecords.length,
        sevenDaysLaterDate: sevenDaysLaterStr,
        allRecords: recordDetails,
        matchingRecords: matchingRecords,
        matchingCount: matchingRecords.length
      }, null, 2)
    };

  } catch (error) {
    console.error('❌ エラー:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal Server Error',
        message: error.message,
        stack: error.stack
      }, null, 2)
    };
  }
};
