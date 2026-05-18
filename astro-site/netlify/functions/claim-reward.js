// 特典申請処理Function
import Airtable from 'airtable';

export const handler = async (event, context) => {
  console.log('特典申請処理開始');
  
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
  
  // 環境変数チェック
  if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: '環境変数が未設定です' })
    };
  }
  
  try {
    // リクエストデータ取得
    const { email } = JSON.parse(event.body || '{}');
    
    if (!email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'メールアドレスが必要です' })
      };
    }
    
    // Airtable接続
    const base = new Airtable({
      apiKey: process.env.AIRTABLE_API_KEY
    }).base(process.env.AIRTABLE_BASE_ID);
    
    // 顧客情報を検索
    const records = await base('Customers').select({
      filterByFormula: `{Email} = "${email}"`
    }).firstPage();
    
    if (records.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: '顧客情報が見つかりません' })
      };
    }
    
    const customer = records[0];
    const currentPoints = customer.get('ポイント') || 0;
    const plan = customer.get('プラン') || 'free';
    const name = customer.get('氏名') || 'お客様';
    const hasClaimedReward = customer.get('特典申請済み') || false;
    
    // ポイント不足チェック
    if (currentPoints < 1000) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'ポイントが不足しています',
          currentPoints,
          required: 1000
        })
      };
    }
    
    // 既に申請済みチェック
    if (hasClaimedReward) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: '既に特典申請済みです' })
      };
    }
    
    // 特典申請記録をAirtableに更新
    await base('Customers').update(customer.id, {
      '特典申請済み': true
    });
    
    // 管理者通知用のデータ準備
    const notificationData = {
      customerName: name,
      customerEmail: email,
      customerPlan: plan,
      currentPoints: currentPoints,
      claimTimestamp: new Date().toISOString(),
      customerPlanJapanese: plan === 'premium' ? 'プレミアム' : 
                           plan === 'standard' ? 'スタンダード' : '無料'
    };
    
    // 管理者にメール通知（Resend使用）
    await sendAdminNotification(notificationData);
    
    // 顧客に確認メール送信
    await sendCustomerConfirmation(email, name);
    
    console.log(`✅ 特典申請完了: ${email} (${currentPoints}pt)`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: '特典申請を受け付けました',
        customerName: name,
        points: currentPoints,
        timestamp: new Date().toISOString()
      })
    };
    
  } catch (error) {
    console.error('特典申請エラー:', error);
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

// 管理者通知メール送信
async function sendAdminNotification(data) {
  if (!process.env.RESEND_API_KEY) {
    console.log('RESEND_API_KEY未設定のため、メール送信をスキップ');
    return;
  }
  
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL || 'noreply@keiba.link',
        to: 'mako@example.com', // ここを実際のメールアドレスに変更
        subject: '🎁 新しい特典申請が届きました',
        html: `
          <h2>特典申請のお知らせ</h2>
          <p>新しい特典申請が届きました。</p>
          
          <table border="1" style="border-collapse: collapse; margin: 20px 0;">
            <tr><td><strong>お客様名</strong></td><td>${data.customerName}</td></tr>
            <tr><td><strong>メールアドレス</strong></td><td>${data.customerEmail}</td></tr>
            <tr><td><strong>プラン</strong></td><td>${data.customerPlanJapanese}</td></tr>
            <tr><td><strong>現在のポイント</strong></td><td>${data.currentPoints}pt</td></tr>
            <tr><td><strong>申請日時</strong></td><td>${new Date(data.claimTimestamp).toLocaleString('ja-JP')}</td></tr>
          </table>
          
          <p>Airtableで詳細を確認し、特典をお送りください。</p>
        `
      })
    });
    
    if (!response.ok) {
      throw new Error(`メール送信失敗: ${response.status}`);
    }
    
    console.log('✅ 管理者通知メール送信完了');
    
  } catch (error) {
    console.error('管理者メール送信エラー:', error);
  }
}

// 顧客確認メール送信
async function sendCustomerConfirmation(email, name) {
  if (!process.env.RESEND_API_KEY) {
    return;
  }
  
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL || 'noreply@keiba.link',
        to: email,
        subject: '特典申請を受け付けました - KEIBA Analytics',
        html: `
          <h2>特典申請ありがとうございます</h2>
          <p>${name}様</p>
          
          <p>特典申請を受け付けました。</p>
          <p>3営業日以内にメールでご連絡いたします。</p>
          
          <p>今後ともKEIBA Analyticsをよろしくお願いいたします。</p>
          
          <hr>
          <p><small>KEIBA Analytics</small></p>
        `
      })
    });
    
    if (response.ok) {
      console.log('✅ 顧客確認メール送信完了');
    }
    
  } catch (error) {
    console.error('顧客メール送信エラー:', error);
  }
}