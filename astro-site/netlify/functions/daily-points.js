// デイリーポイント付与Function（ESModule版）
import Airtable from 'airtable';

export const handler = async (event, context) => {
  console.log('デイリーポイント付与開始');
  
  // 環境変数チェック（エラー防止）
  if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
    console.error('環境変数が設定されていません');
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: '環境変数が未設定です'
      })
    };
  }
  
  try {
    // Airtable接続
    const base = new Airtable({
      apiKey: process.env.AIRTABLE_API_KEY
    }).base(process.env.AIRTABLE_BASE_ID);
    
    // 更新成功カウンタ
    let successCount = 0;
    let errorCount = 0;
    const errors = [];
    
    // 全顧客を取得（ページネーション対応）
    const allRecords = [];
    await base('Customers').select({
      pageSize: 100
    }).eachPage(async (records, fetchNextPage) => {
      allRecords.push(...records);
      fetchNextPage();
    });
    
    console.log(`${allRecords.length}件の顧客データを取得`);
    
    // 各顧客のポイント更新（エラーハンドリング付き）
    for (const record of allRecords) {
      try {
        const currentPoints = record.get('ポイント') || 0;
        const plan = record.get('プラン') || 'free';
        const email = record.get('Email');
        
        // プラン別ポイント計算（大文字小文字対応）
        const planLower = plan ? plan.toLowerCase() : 'free';
        let pointsToAdd = 1; // free
        if (planLower === 'standard') pointsToAdd = 10;
        if (planLower === 'premium') pointsToAdd = 30;
        
        // 更新実行
        await base('Customers').update(record.id, {
          'ポイント': currentPoints + pointsToAdd
        });
        
        successCount++;
        console.log(`✅ ${email}: ${pointsToAdd}pt追加（合計: ${currentPoints + pointsToAdd}pt）`);
        
      } catch (error) {
        errorCount++;
        errors.push({
          recordId: record.id,
          error: error.message
        });
        console.error(`❌ エラー: ${error.message}`);
        // エラーがあっても続行
        continue;
      }
    }
    
    // 結果レポート
    const result = {
      success: true,
      timestamp: new Date().toISOString(),
      summary: {
        total: allRecords.length,
        success: successCount,
        error: errorCount
      }
    };
    
    if (errors.length > 0) {
      result.errors = errors;
    }
    
    console.log('デイリーポイント付与完了:', result);
    
    return {
      statusCode: 200,
      body: JSON.stringify(result)
    };
    
  } catch (error) {
    console.error('重大なエラー:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        timestamp: new Date().toISOString()
      })
    };
  }
};