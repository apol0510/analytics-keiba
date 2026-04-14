// マジックリンク検証Function
import Airtable from 'airtable';

export const handler = async (event, context) => {
  console.log('マジックリンク検証処理開始');
  
  // CORSヘッダー設定
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  
  // OPTIONSリクエスト（CORS preflight）
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }
  
  // POSTリクエストのみ許可
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }
  
  try {
    const { token, email } = JSON.parse(event.body || '{}');
    
    if (!token || !email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'トークンとメールアドレスが必要です' })
      };
    }
    
    // 環境変数チェック（Netlify環境変数必須）
    const airtableApiKey = process.env.AIRTABLE_API_KEY;
    const airtableBaseId = process.env.AIRTABLE_BASE_ID;
    if (!airtableApiKey || !airtableBaseId) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Server configuration missing' })
      };
    }
    
    console.log('Airtable接続情報:', {
      hasApiKey: !!airtableApiKey,
      apiKeyPreview: airtableApiKey.substring(0, 20) + '...',
      hasBaseId: !!airtableBaseId,
      baseId: airtableBaseId
    });
    
    // Airtable接続
    const base = new Airtable({
      apiKey: airtableApiKey
    }).base(airtableBaseId);
    
    // 顧客とトークン確認
    const records = await base('Customers').select({
      filterByFormula: `AND({Email} = "${email}", {認証トークン} = "${token}")`
    }).firstPage();
    
    if (records.length === 0) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: '無効なトークンです' })
      };
    }
    
    const customer = records[0];
    // TODO: 有効期限チェックは後で実装
    // const tokenExpiry = customer.get('トークン有効期限');
    // 
    // // トークン有効期限チェック  
    // if (!tokenExpiry || new Date(tokenExpiry) < new Date()) {
    //   return {
    //     statusCode: 401,
    //     headers,
    //     body: JSON.stringify({ error: 'トークンの有効期限が切れています' })
    //   };
    // }
    
    // 顧客データ取得
    const customerData = {
      email: customer.get('Email'),
      name: customer.get('氏名') || 'お客様',
      plan: customer.get('プラン') || 'Free',
      points: customer.get('ポイント') || 0,
      registrationDate: customer.get('登録日'),
      rank: calculateRank(customer.get('ポイント') || 0),
      hasClaimedReward: customer.get('特典申請済み') || false
    };
    
    // トークンクリア（使用済みにする）
    await base('Customers').update(customer.id, {
      '認証トークン': null
      // TODO: '最終ログイン': new Date().toISOString() フィールド追加後に有効化
    });

    console.log(`✅ ログイン成功: ${email}`);

    // SendGrid Marketing Campaigns に upsert（registered_analytics = "true"）
    // 失敗しても認証成功処理は落とさない（関数内で例外を握り潰す）
    await registerToSendGridMarketing(email);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: '認証成功',
        customer: customerData
      })
    };
    
  } catch (error) {
    console.error('マジックリンク検証エラー:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: '一時的にアクセスできません',
        details: error.message
      })
    };
  }
};

// SendGrid Marketing Campaigns に upsert（既存コンタクトは自動更新）
// PUT /v3/marketing/contacts に custom_fields.registered_analytics = "true" を付与
// 失敗しても呼び出し元へ例外を伝播させない（return null）
async function registerToSendGridMarketing(email) {
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
  const CUSTOM_FIELD_ANALYTICS = process.env.SENDGRID_CUSTOM_FIELD_ANALYTICS;

  if (!SENDGRID_API_KEY) {
    console.log('⚠️ SENDGRID_API_KEY未設定、SendGrid Marketing upsertスキップ');
    return null;
  }
  if (!CUSTOM_FIELD_ANALYTICS) {
    console.log('⚠️ SENDGRID_CUSTOM_FIELD_ANALYTICS未設定、SendGrid Marketing upsertスキップ');
    return null;
  }

  try {
    const url = 'https://api.sendgrid.com/v3/marketing/contacts';
    const payload = {
      contacts: [
        {
          email,
          custom_fields: {
            [CUSTOM_FIELD_ANALYTICS]: 'true'
          }
        }
      ]
    };

    console.log('📧 SendGrid Marketing upsert:', email, 'field:', CUSTOM_FIELD_ANALYTICS);

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ SendGrid Marketing upsert失敗:', response.status, errorText);
      return null;
    }

    const result = await response.json();
    console.log('✅ SendGrid Marketing upsert成功:', email, result);
    return result;
  } catch (error) {
    console.error('❌ SendGrid Marketing upsertエラー:', error.message);
    return null;
  }
}

// ポイントからランク計算
function calculateRank(points) {
  if (points >= 10000) return 'ダイヤモンド';
  if (points >= 5000) return 'プラチナ';
  if (points >= 2000) return 'ゴールド';
  if (points >= 1000) return 'シルバー';
  if (points >= 500) return 'ブロンズ';
  return 'ビギナー';
}