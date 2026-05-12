/**
 * 入金確認後の「ありがとうメール + ログイン情報メール」送信
 * 管理者が入金を確認した後、このFunctionを呼び出して顧客にメール送信
 */

import { SUPPORT_EMAIL, ADMIN_EMAIL, FROM_EMAIL } from './config/email-config.js';
exports.handler = async (event, context) => {
  // CORSヘッダー設定
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // プリフライトリクエスト対応
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // POSTメソッドのみ許可
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    // リクエストデータ取得
    const requestData = JSON.parse(event.body);
    const {
      email,
      fullName,
      productName,
      transferAmount,
      airtableRecordId  // オプション: Airtable Status更新用
    } = requestData;

    // 必須項目チェック
    if (!email || !fullName || !productName) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: '必須項目が入力されていません' })
      };
    }

    // SendGrid API設定
    const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
    // FROM_EMAIL は email-config.js からインポート済み
    // ADMIN_EMAIL は email-config.js からインポート済み

    if (!SENDGRID_API_KEY) {
      throw new Error('SendGrid API key not configured');
    }

    // プラン別のログインURL・説明を生成
    const planInfo = getPlanInfo(productName);

    // 日本時間
    const japanTime = new Date().toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    // ユーザー向けメール（入金ありがとう + ログイン情報）
    const userEmailData = {
      personalizations: [{
        to: [{ email: email }],
        subject: `【入金確認】NANKANアナリティクス ${productName} - アクセス情報`
      }],
      from: { email: FROM_EMAIL, name: 'NANKANアナリティクス' },
      content: [{
        type: 'text/html',
        value: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Hiragino Sans', 'Yu Gothic', sans-serif; line-height: 1.8; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #10b981; background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 30px 20px; border-radius: 8px; margin-bottom: 20px; text-align: center; }
    .section { background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 15px; border-left: 4px solid #10b981; }
    .info-row { padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
    .label { font-weight: bold; color: #475569; display: inline-block; width: 120px; }
    .value { color: #1e293b; }
    .highlight { background: #dbeafe; padding: 20px; border-radius: 8px; border-left: 4px solid #3b82f6; margin: 20px 0; }
    .login-button { display: inline-block; background-color: #3b82f6; background: linear-gradient(135deg, #3b82f6, #2563eb); color: #ffffff; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 15px 0; }
    .login-button:hover { background-color: #2563eb; background: linear-gradient(135deg, #2563eb, #1d4ed8); }
    .access-list { background: #f0fdf4; padding: 15px; border-radius: 8px; border-left: 4px solid #10b981; margin: 15px 0; }
    .footer { text-align: center; color: #64748b; font-size: 0.9rem; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0; font-size: 1.8rem;">🎉 ご入金ありがとうございます</h1>
      <p style="margin: 15px 0 0 0; font-size: 1rem;">入金を確認いたしました</p>
    </div>

    <div class="section">
      <p style="margin: 0 0 15px 0; font-size: 1.1rem;">
        <strong>${fullName} 様</strong>
      </p>
      <p style="margin: 0; color: #475569; line-height: 1.8;">
        この度は <strong>${productName}</strong> をご購入いただき、誠にありがとうございます。<br>
        ${transferAmount ? `ご入金金額 <strong>¥${Number(transferAmount).toLocaleString()}</strong> を確認いたしました。` : 'ご入金を確認いたしました。'}
      </p>
    </div>

    <div class="highlight">
      <h3 style="margin: 0 0 15px 0; color: #1e40af;">🔑 ログイン情報</h3>
      <div class="info-row">
        <span class="label">プラン:</span>
        <span class="value"><strong>${productName}</strong></span>
      </div>
      <div class="info-row" style="border-bottom: none;">
        <span class="label">ログインURL:</span>
        <div class="value" style="margin-top: 10px;">
          <a href="${planInfo.loginUrl}" class="login-button" target="_blank" style="display: inline-block; background-color: #3b82f6; background: linear-gradient(135deg, #3b82f6, #2563eb); color: #ffffff !important; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 15px 0;">
            ${planInfo.buttonText}
          </a>
        </div>
      </div>
    </div>

    ${planInfo.accessDetails ? `
    <div class="access-list">
      <h4 style="margin: 0 0 15px 0; color: #065f46;">📌 アクセス可能なコンテンツ</h4>
      ${planInfo.accessDetails}
    </div>
    ` : ''}

    <div class="section">
      <h4 style="margin: 0 0 15px 0; color: #1e293b;">📋 ご利用方法</h4>
      <ol style="margin: 0; padding-left: 20px; color: #475569;">
        <li style="margin-bottom: 10px;">
          上記の「${planInfo.buttonText}」ボタンをクリック
        </li>
        <li style="margin-bottom: 10px;">
          <strong>ログイン情報入力</strong><br>
          メールアドレス: <strong>${email}</strong><br>
          ${planInfo.passwordInfo || 'パスワードは別途設定が必要です（初回アクセス時に設定画面が表示されます）'}
        </li>
        <li style="margin-bottom: 10px;">
          ${planInfo.usageInstructions}
        </li>
      </ol>
    </div>

    ${planInfo.additionalNotes ? `
    <div class="section">
      <h4 style="margin: 0 0 15px 0; color: #1e293b;">💡 追加情報</h4>
      ${planInfo.additionalNotes}
    </div>
    ` : ''}

    <div class="section">
      <h4 style="margin: 0 0 15px 0; color: #1e293b;">📞 サポート</h4>
      <p style="margin: 0; color: #475569; line-height: 1.8;">
        ご不明な点やログインできない場合は、お気軽にお問い合わせください。<br>
        📧 <a href="mailto:${SUPPORT_EMAIL}" style="color: #3b82f6;">${SUPPORT_EMAIL}</a>
      </p>
    </div>

    <div class="footer">
      <p><strong>NANKANアナリティクス</strong></p>
      <p>AI・機械学習で勝つ。南関競馬の次世代予想プラットフォーム</p>
      <p><a href="https://analytics.keiba.link" style="color: #3b82f6; text-decoration: none;">https://analytics.keiba.link</a></p>
      <p style="margin-top: 15px; font-size: 0.85rem; color: #94a3b8;">
        ※このメールは入金確認後に自動送信されています
      </p>
    </div>
  </div>
</body>
</html>
        `
      }],
      tracking_settings: {
        click_tracking: { enable: false },
        open_tracking: { enable: false }
      }
    };

    // SendGrid APIでメール送信
    const userResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(userEmailData)
    });

    if (!userResponse.ok) {
      const errorText = await userResponse.text();
      console.error('SendGrid user email error:', errorText);
      throw new Error(`Failed to send user email: ${userResponse.status}`);
    }

    console.log('✅ Payment confirmation email sent:', email);

    // ========================================
    // Airtable Status更新（pending → active）
    // ========================================
    if (airtableRecordId && !productName.includes('Premium Plus')) {
      try {
        const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
        const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

        if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
          console.warn('⚠️ Airtable credentials not configured, skipping status update');
        } else {
          const updateUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers/${airtableRecordId}`;
          const updatePayload = {
            fields: {
              'Status': 'active'
            }
          };

          const updateResponse = await fetch(updateUrl, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatePayload)
          });

          if (updateResponse.ok) {
            console.log('✅ Airtable Status updated to active:', airtableRecordId);
          } else {
            const errorText = await updateResponse.text();
            console.error('⚠️ Airtable update failed:', errorText);
          }
        }
      } catch (airtableError) {
        console.error('⚠️ Airtable update error (non-critical):', airtableError.message);
      }
    }

    // 成功レスポンス
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Payment confirmation email sent successfully',
        email: email,
        productName: productName
      })
    };

  } catch (error) {
    console.error('Error sending payment confirmation:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal Server Error',
        message: error.message
      })
    };
  }
};

/**
 * プラン別の情報を取得
 */
function getPlanInfo(productName) {
  const baseUrl = 'https://analytics.keiba.link';

  // Standard (¥5,980/月)
  if (productName.includes('Standard')) {
    return {
      loginUrl: `${baseUrl}/dashboard/`,
      buttonText: 'ダッシュボードにログイン',
      passwordInfo: 'パスワードは登録時に設定したものをご使用ください',
      usageInstructions: '後半3レース（10R、11R、12R）の予想データにアクセス可能です',
      accessDetails: `
        <ul style="margin: 0; padding-left: 20px; color: #065f46;">
          <li>後半3レース（10R、11R、12R）の予想データ</li>
          <li>Standard Predictions ページ</li>
          <li>過去の実績アーカイブ</li>
        </ul>
      `,
      additionalNotes: `
        <p style="margin: 0; color: #475569; line-height: 1.8;">
          ✨ <strong>Premium会員へのアップグレード</strong>も可能です。<br>
          Premium会員になると、全レース（1R〜12R）の予想データにアクセスできます。
        </p>
      `
    };
  }

  // Premium (¥9,980/月)
  if (productName.includes('Premium') && !productName.includes('Sanrenpuku') && !productName.includes('Combo') && !productName.includes('Plus')) {
    return {
      loginUrl: `${baseUrl}/dashboard/`,
      buttonText: 'ダッシュボードにログイン',
      passwordInfo: 'パスワードは登録時に設定したものをご使用ください',
      usageInstructions: '全レース（1R〜12R）の予想データにアクセス可能です',
      accessDetails: `
        <ul style="margin: 0; padding-left: 20px; color: #065f46;">
          <li>全レース（1R〜12R）の予想データ</li>
          <li>Premium Predictions ページ</li>
          <li>過去の実績アーカイブ</li>
          <li>穴馬データ</li>
        </ul>
      `,
      additionalNotes: `
        <p style="margin: 0; color: #475569; line-height: 1.8;">
          ✨ <strong>Premium Sanrenpuku会員へのアップグレード</strong>も可能です。<br>
          三連複予想データと高精度な買い目が利用できます。
        </p>
      `
    };
  }

  // Premium Sanrenpuku (¥19,820/月)
  if (productName.includes('Premium Sanrenpuku') || productName.includes('Sanrenpuku')) {
    return {
      loginUrl: `${baseUrl}/dashboard/`,
      buttonText: 'ダッシュボードにログイン',
      passwordInfo: 'パスワードは登録時に設定したものをご使用ください',
      usageInstructions: '全レース（1R〜12R）の予想データ + 三連複予想にアクセス可能です',
      accessDetails: `
        <ul style="margin: 0; padding-left: 20px; color: #065f46;">
          <li>全レース（1R〜12R）の予想データ</li>
          <li>三連複予想データ（高精度買い目）</li>
          <li>Archive Sanrenpuku ページ（過去の三連複実績）</li>
          <li>穴馬データ</li>
        </ul>
      `,
      additionalNotes: `
        <p style="margin: 0; color: #475569; line-height: 1.8;">
          ✨ <strong>Premium Plus（単品商品）</strong>もご購入いただけます。<br>
          Premium Sanrenpuku会員限定で、さらに高精度な予想データが利用可能です。
        </p>
      `
    };
  }

  // Premium Combo (¥24,800/月)
  if (productName.includes('Premium Combo') || productName.includes('Combo')) {
    return {
      loginUrl: `${baseUrl}/dashboard/`,
      buttonText: 'ダッシュボードにログイン',
      passwordInfo: 'パスワードは登録時に設定したものをご使用ください',
      usageInstructions: '全レース（1R〜12R）の予想データ + 三連複予想にアクセス可能です',
      accessDetails: `
        <ul style="margin: 0; padding-left: 20px; color: #065f46;">
          <li>全レース（1R〜12R）の予想データ</li>
          <li>三連複予想データ（高精度買い目）</li>
          <li>Archive Sanrenpuku ページ（過去の三連複実績）</li>
          <li>穴馬データ</li>
          <li>Combo会員限定コンテンツ</li>
        </ul>
      `,
      additionalNotes: `
        <p style="margin: 0; color: #475569; line-height: 1.8;">
          ✨ <strong>Premium Plus（単品商品）</strong>もご購入いただけます。<br>
          Premium Combo会員限定で、さらに高精度な予想データが利用可能です。
        </p>
      `
    };
  }

  // Premium Plus (¥68,000/単品)
  if (productName.includes('Premium Plus') || productName.includes('Plus')) {
    return {
      loginUrl: `${baseUrl}/premium-plus/`,
      buttonText: 'Premium Plus ページにアクセス',
      passwordInfo: 'ログインは不要です。直接アクセスしてご覧ください',
      usageInstructions: 'Premium Plus専用の高精度予想データにアクセスできます',
      accessDetails: `
        <ul style="margin: 0; padding-left: 20px; color: #065f46;">
          <li>Premium Plus専用の超高精度予想データ</li>
          <li>実績画像（直近5戦）</li>
          <li>単品商品のため、追加料金なしで永久アクセス可能</li>
        </ul>
      `,
      additionalNotes: `
        <p style="margin: 0; color: #475569; line-height: 1.8;">
          💡 <strong>Premium Plus は単品商品です</strong><br>
          月額プランではなく、一度ご購入いただければ永久的にアクセス可能です。<br>
          Premium Sanrenpuku会員・Premium Combo会員のみが購入できる限定商品です。
        </p>
      `
    };
  }

  // デフォルト（プラン不明）
  return {
    loginUrl: `${baseUrl}/dashboard/`,
    buttonText: 'ダッシュボードにログイン',
    passwordInfo: 'パスワードは登録時に設定したものをご使用ください',
    usageInstructions: 'ダッシュボードから各種予想データにアクセスできます',
    accessDetails: null,
    additionalNotes: null
  };
}
