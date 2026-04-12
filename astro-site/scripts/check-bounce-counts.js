// バウンス数の更新を確認するスクリプト
import 'dotenv/config';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

const blacklistUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/EmailBlacklist`;

async function checkBounceUpdates() {
  console.log('🔍 EmailBlacklistテーブルのバウンス数確認...');
  
  try {
    const response = await fetch(blacklistUrl, {
      headers: {
        'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`EmailBlacklist取得失敗: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`📊 EmailBlacklistレコード: ${data.records.length}件`);

    // 各レコードの詳細表示
    data.records.forEach(record => {
      const fields = record.fields;
      console.log('📧 バウンス情報:', {
        Email: fields.Email,
        Status: fields.Status,
        BounceType: fields.BounceType,
        BounceCount: fields.BounceCount,
        LastBounceDate: fields.LastBounceDate,
        Notes: fields.Notes
      });
    });

  } catch (error) {
    console.error('❌ Airtableアクセスエラー:', error.message);
  }
}

async function main() {
  console.log('🎯 バウンス検出テスト結果確認');
  
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    console.error('❌ Airtable認証情報が設定されていません');
    process.exit(1);
  }

  await checkBounceUpdates();
}

main().catch(console.error);