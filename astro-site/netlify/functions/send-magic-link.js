// マジックリンク送信Function
import Airtable from 'airtable';
import crypto from 'crypto';

export const handler = async (event, context) => {
  // すぐにログを出力
  console.log('🚀 Function実行開始:', new Date().toISOString());
  console.log('Method:', event.httpMethod);
  console.log('Headers:', JSON.stringify(event.headers));
  
  // CORSヘッダー設定
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  
  // OPTIONSリクエスト（CORS preflight）
  if (event.httpMethod === 'OPTIONS') {
    console.log('OPTIONS request received');
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }
  
  // POSTリクエストのみ許可
  if (event.httpMethod !== 'POST') {
    console.log('Invalid method:', event.httpMethod);
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }
  
  try {
    console.log('POSTリクエスト処理開始');
    const { email } = JSON.parse(event.body || '{}');
    
    if (!email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'メールアドレスが必要です' })
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
    
    // 顧客確認
    const records = await base('Customers').select({
      filterByFormula: `{Email} = "${email}"`
    }).firstPage();
    
    if (records.length === 0) {
      // 新規顧客の場合は Free プランで作成（登録日は自動計算フィールドのため除外）
      const newRecord = await base('Customers').create({
        'Email': email,
        'プラン': 'Free',
        'ポイント': 0
      });
      console.log('新規顧客作成:', email);
    }
    
    // 一時トークン生成（32文字のランダム文字列）
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30分後
    
    // トークンをAirtableまたは一時ストレージに保存
    // ここではAirtableにトークンフィールドを追加して保存
    const customerRecord = records[0] || await base('Customers').select({
      filterByFormula: `{Email} = "${email}"`
    }).firstPage().then(r => r[0]);
    
    if (customerRecord) {
      // とりあえずトークンだけ保存（有効期限は後で対応）
      await base('Customers').update(customerRecord.id, {
        '認証トークン': token
        // TODO: 有効期限フィールドの型を修正後に追加
      });
      console.log(`トークン保存完了: ${email} - ${token.substring(0, 8)}...`);
    }
    
    // マジックリンク生成
    const siteUrl = process.env.SITE_URL || 'https://nankan-analytics.keiba.link';
    const magicLink = `${siteUrl}/dashboard?token=${token}&email=${encodeURIComponent(email)}`;
    
    // メール送信（Resend使用）
    await sendMagicLinkEmail(email, magicLink);
    
    console.log(`✅ マジックリンク送信完了: ${email}`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'マジックリンクをメールで送信しました',
        email: email
      })
    };
    
  } catch (error) {
    console.error('❌ エラー発生:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: '一時的にアクセスできません',
        details: error.message,
        type: error.name
      })
    };
  }
};

// マジックリンクメール送信
async function sendMagicLinkEmail(email, magicLink) {
  // Resend APIキー（環境変数またはハードコード）
  const apiKey = process.env.RESEND_API_KEY || 're_3V2es1rn_9ghDCmQkPGfTQLdyt7vKcGDe';
  
  console.log('📧 メール送信開始:', { 
    to: email,
    hasApiKey: !!apiKey,
    apiKeyPreview: apiKey ? apiKey.substring(0, 10) + '...' : 'なし'
  });
  
  if (!apiKey) {
    console.log('RESEND_API_KEY未設定のため、メール送信をスキップ');
    console.log('マジックリンク:', magicLink); // デバッグ用
    return;
  }
  
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL || 'noreply@nankan-analytics.keiba.link',
        to: email,
        subject: 'ログインリンク - NANKANアナリティクス',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <style>
              body {
                font-family: sans-serif;
                line-height: 1.6;
                color: #333;
                max-width: 600px;
                margin: 0 auto;
                padding: 20px;
              }
              .header {
                background-color: #3b82f6;
                background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
                color: white;
                padding: 30px;
                text-align: center;
                border-radius: 10px 10px 0 0;
              }
              .content {
                background: #f9fafb;
                padding: 30px;
                border-radius: 0 0 10px 10px;
              }
              .button {
                display: inline-block;
                background-color: #3b82f6;
                background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
                color: #ffffff !important;
                padding: 15px 40px;
                text-decoration: none;
                border-radius: 8px;
                font-weight: bold;
                margin: 20px 0;
              }
              .warning {
                background: #fef2f2;
                border-left: 4px solid #ef4444;
                padding: 15px;
                margin: 20px 0;
                border-radius: 5px;
              }
              .footer {
                text-align: center;
                color: #6b7280;
                font-size: 12px;
                margin-top: 30px;
              }
            </style>
          </head>
          <body>
            <div class="header">
              <h1>🎯 NANKANアナリティクス</h1>
              <p>マイページへのログインリンク</p>
            </div>
            
            <div class="content">
              <h2>こんにちは！</h2>
              <p>マイページへのログインリンクをお送りします。</p>
              <p>下記のボタンをクリックして、マイページにアクセスしてください：</p>
              
              <center>
                <a href="${magicLink}" class="button">マイページにログイン</a>
              </center>
              
              <div class="warning">
                ⏰ <strong>このリンクは30分間有効です。</strong><br>
                期限が切れた場合は、再度ログインリンクをリクエストしてください。
              </div>
              
              <p>ボタンが機能しない場合は、以下のURLをコピーしてブラウザに貼り付けてください：</p>
              <p style="word-break: break-all; background: #f3f4f6; padding: 10px; border-radius: 5px;">
                ${magicLink}
              </p>
            </div>
            
            <div class="footer">
              <p>このメールに心当たりがない場合は、無視してください。</p>
              <p>NANKANアナリティクス - AI競馬予想システム</p>
            </div>
          </body>
          </html>
        `
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Resend APIエラー:', {
        status: response.status,
        error: errorText
      });
      throw new Error(`メール送信失敗: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log('✅ マジックリンクメール送信完了:', {
      id: result.id,
      to: email
    });
    
  } catch (error) {
    console.error('メール送信エラー:', error);
    throw error;
  }
}