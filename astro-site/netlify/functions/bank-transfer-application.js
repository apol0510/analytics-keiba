/**
 * 銀行振込申し込みフォーム処理
 * Premium Plus (¥68,000) の銀行振込申請を受け付け、確認メールを送信
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
    // フォームデータ取得
    const formData = JSON.parse(event.body);
    const {
      fullName,
      email,
      transferDate,
      transferTime,
      transferAmount,
      transferName,
      remarks,
      productName,
      timestamp
    } = formData;

    // 必須項目チェック
    if (!fullName || !email || !transferDate || !transferTime || !transferAmount || !transferName) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: '必須項目が入力されていません' })
      };
    }

    // 日本時間表示用
    const japanTime = new Date(timestamp).toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    // SendGrid API設定
    const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
    // FROM_EMAIL, ADMIN_EMAIL は email-config.js からインポート済み

    if (!SENDGRID_API_KEY) {
      throw new Error('SendGrid API key not configured');
    }

    // 管理者向けメール内容
    const adminEmailData = {
      personalizations: [{
        to: [{ email: ADMIN_EMAIL }],
        bcc: [{ email: process.env.MAKE_MAILHOOK_EMAIL || '' }].filter(item => item.email), // Make Mailhook転送
        subject: `【銀行振込申請】${email} - ${productName}`
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
    .header { background-color: #3b82f6; background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
    .section { background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 15px; border-left: 4px solid #3b82f6; }
    .info-row { padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
    .label { font-weight: bold; color: #475569; display: inline-block; width: 150px; }
    .value { color: #1e293b; }
    .alert { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; border-radius: 8px; margin: 20px 0; }
    .footer { text-align: center; color: #64748b; font-size: 0.9rem; margin-top: 30px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin: 0;">🏦 銀行振込申請通知</h2>
      <p style="margin: 10px 0 0 0; font-size: 0.95rem;">${productName} 購入申請が届きました</p>
    </div>

    <div class="section">
      <h3 style="margin-top: 0; color: #1e293b;">📋 申請情報</h3>
      <div class="info-row">
        <span class="label">申請日時:</span>
        <span class="value">${japanTime}</span>
      </div>
      <div class="info-row">
        <span class="label">お名前:</span>
        <span class="value">${fullName}</span>
      </div>
      <div class="info-row">
        <span class="label">メールアドレス:</span>
        <span class="value">${email}</span>
      </div>
      <div class="info-row">
        <span class="label">商品:</span>
        <span class="value">${productName}</span>
      </div>
    </div>

    <div class="section">
      <h3 style="margin-top: 0; color: #1e293b;">💰 振込情報</h3>
      <div class="info-row">
        <span class="label">振込完了日:</span>
        <span class="value">${transferDate}</span>
      </div>
      <div class="info-row">
        <span class="label">振込金額:</span>
        <span class="value">¥${Number(transferAmount).toLocaleString()}</span>
      </div>
      <div class="info-row">
        <span class="label">振込名義人:</span>
        <span class="value">${transferName}</span>
      </div>
      ${remarks ? `
      <div class="info-row" style="border-bottom: none;">
        <span class="label">備考:</span>
        <div class="value" style="margin-top: 10px; white-space: pre-wrap;">${remarks}</div>
      </div>
      ` : ''}
    </div>

    <div class="alert">
      <h4 style="margin: 0 0 10px 0; color: #92400e;">⚠️ 対応必要事項</h4>
      <ol style="margin: 0; padding-left: 20px; color: #78350f;">
        <li>振込確認（三井住友銀行 洲本支店 普通 5338892）</li>
        <li>入金確認後、${email} へアクセス情報を送信</li>
        <li>Airtableに顧客情報を登録（${productName}）</li>
      </ol>
    </div>

    <div class="footer">
      <p>NANKANアナリティクス 管理システム</p>
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

    // 申請者向けメール内容
    const userEmailData = {
      personalizations: [{
        to: [{ email: email }],
        subject: `【銀行振込申請受付】NANKANアナリティクス ${productName}`
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
    .header { background-color: #3b82f6; background: linear-gradient(135deg, #3b82f6, #2563eb); color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; text-align: center; }
    .section { background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 15px; border-left: 4px solid #10b981; }
    .info-row { padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
    .label { font-weight: bold; color: #475569; display: inline-block; width: 150px; }
    .value { color: #1e293b; }
    .highlight { background: #dbeafe; padding: 15px; border-radius: 8px; border-left: 4px solid #3b82f6; margin: 20px 0; }
    .footer { text-align: center; color: #64748b; font-size: 0.9rem; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin: 0;">✅ お申し込みありがとうございます</h2>
      <p style="margin: 10px 0 0 0; font-size: 0.95rem;">銀行振込申請を受け付けました</p>
    </div>

    <div class="section">
      <h3 style="margin-top: 0; color: #1e293b;">📋 ご申請内容</h3>
      <div class="info-row">
        <span class="label">申請日時:</span>
        <span class="value">${japanTime}</span>
      </div>
      <div class="info-row">
        <span class="label">お名前:</span>
        <span class="value">${fullName}</span>
      </div>
      <div class="info-row">
        <span class="label">メールアドレス:</span>
        <span class="value">${email}</span>
      </div>
      <div class="info-row">
        <span class="label">商品:</span>
        <span class="value">${productName}</span>
      </div>
      <div class="info-row">
        <span class="label">振込完了日:</span>
        <span class="value">${transferDate}</span>
      </div>
      <div class="info-row">
        <span class="label">振込金額:</span>
        <span class="value">¥${Number(transferAmount).toLocaleString()}</span>
      </div>
      <div class="info-row">
        <span class="label">振込名義人:</span>
        <span class="value">${transferName}</span>
      </div>
    </div>

    <div class="highlight">
      <h4 style="margin: 0 0 15px 0; color: #1e40af;">📌 今後の流れ</h4>
      <ol style="margin: 0; padding-left: 20px; color: #1e293b;">
        <li style="margin-bottom: 10px;">
          <strong>振込先口座</strong><br>
          三井住友銀行 洲本支店<br>
          普通 5338892<br>
          ﾏ-ｸｱﾂﾌﾟｴ-ｱｲｻ-ﾋﾞｽ ｱｻｲ ﾄｼﾋﾛ
        </li>
        <li style="margin-bottom: 10px;">
          <strong>入金確認</strong><br>
          入金確認取れ次第、即時にログイン情報をメールでお送りいたします
        </li>
        <li style="margin-bottom: 10px;">
          <strong>アクセス情報送付</strong><br>
          ${productName} のアクセス方法をメールでお送りいたします
        </li>
      </ol>
    </div>

    <div class="section">
      <p style="margin: 0; color: #475569;">
        <strong>ご不明な点がございましたら、お気軽にお問い合わせください。</strong><br>
        📧 <a href="mailto:${SUPPORT_EMAIL}" style="color: #3b82f6;">${SUPPORT_EMAIL}</a>
      </p>
    </div>

    <div class="footer">
      <p><strong>NANKANアナリティクス</strong></p>
      <p>AI・機械学習で勝つ。南関競馬の次世代予想プラットフォーム</p>
      <p><a href="https://nankan-analytics.keiba.link" style="color: #3b82f6; text-decoration: none;">https://nankan-analytics.keiba.link</a></p>
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

    // SendGrid APIでメール送信（管理者向け）
    const adminResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(adminEmailData)
    });

    if (!adminResponse.ok) {
      const errorText = await adminResponse.text();
      console.error('SendGrid admin email error:', errorText);
      throw new Error(`Failed to send admin email: ${adminResponse.status}`);
    }

    // SendGrid APIでメール送信（申請者向け）
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

    // ========================================
    // Airtable登録（Premium Plus以外の月額プラン）
    // ========================================
    if (!productName.includes('Premium Plus')) {
      // プラン名から料金部分を削除（Airtable Single select用）
      // 例: "Premium Lifetime (¥78,000（永久アクセス）)" → "Premium Lifetime"
      // 例: "Premium Annual (¥68,000/年)" → "Premium Annual"
      // 例: "Premium Monthly (¥18,000/月)" → "Premium Monthly"
      const fullPlanName = productName
        .replace(/\s*\(.*\)$/, '')  // 最後の(...)を完全削除
        .trim();

      // PlanTypeを判定（Lifetime, Annual, Monthly）
      let planType = 'Monthly';  // デフォルト
      if (fullPlanName.includes('Lifetime') || fullPlanName.includes('買い切り')) {
        planType = 'Lifetime';
      } else if (fullPlanName.includes('Annual') || fullPlanName.includes('年払い')) {
        planType = 'Annual';
      } else if (fullPlanName.includes('Monthly') || fullPlanName.includes('30日')) {
        planType = 'Monthly';
      }

      // プラン名を正規化（Airtable Single select用）
      // "Premium Lifetime" → "Premium"
      // "Premium 買い切り" → "Premium"
      // "Premium 年払い (Standard Upgrade)" → "Premium"
      // "Premium 30日 (Standard Upgrade)" → "Premium"
      // "Premium Sanrenpuku Lifetime" → "Premium Sanrenpuku"
      // "Standard (ライト) - Campaign" → "Standard"
      const planName = fullPlanName
        .replace(/\s*\(Standard Upgrade\)/, '')  // (Standard Upgrade)を削除
        .replace(/\s*-\s*Campaign/, '')  // - Campaignを削除
        .replace(/\s*\(ライト\)/, '')  // (ライト)を削除
        .replace(/\s+(Lifetime|Annual|Monthly|買い切り|年払い|30日)$/, '')  // 末尾のプラン種別を削除
        .trim();

      // 有効期限計算（2026-02-09価格体系）
      const today = new Date();
      let expirationDate = null;

      if (planType === 'Lifetime') {
        // 買い切りプラン: 2099年12月31日（永久）
        expirationDate = '2099-12-31';
      } else if (planType === 'Annual') {
        // 年払いプラン: 1年後
        const expDate = new Date(today);
        expDate.setFullYear(expDate.getFullYear() + 1);
        expirationDate = expDate.toISOString().split('T')[0];
      } else if (planType === 'Monthly') {
        // 月払いプラン: 1ヶ月後
        const expDate = new Date(today);
        expDate.setMonth(expDate.getMonth() + 1);
        expirationDate = expDate.toISOString().split('T')[0];
      }

      console.log('📅 計算された有効期限:', {
        productName,
        fullPlanName,
        planName,
        planType,
        expirationDate
      });

      // Airtable登録処理
      try {
        const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
        const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

        if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
          console.error('❌ Airtable credentials not configured - CRITICAL ERROR');
          throw new Error('Airtable credentials missing');
        }

        // 既存顧客チェック
        const searchFormula = `{Email} = "${email}"`;
        const searchUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers?filterByFormula=${encodeURIComponent(searchFormula)}`;

        const searchResponse = await fetch(searchUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        if (!searchResponse.ok) {
          throw new Error(`Airtable search failed: ${searchResponse.status}`);
        }

        const searchData = await searchResponse.json();
        const existingRecords = searchData.records || [];

        if (existingRecords.length > 0) {
          // 既存顧客 - Update
          const recordId = existingRecords[0].id;
          const updateUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers/${recordId}`;

          const updatePayload = {
            fields: {
              '氏名': fullName,
              'プラン': planName,
              'PlanType': planType,
              'Status': 'pending',
              'PaymentMethod': 'Bank Transfer',
              '有効期限': expirationDate,
              // 🔧 2026-03-02追加: 新規プラン購入時に退会フラグをリセット
              'WithdrawalRequested': false,
              'WithdrawalDate': null,
              'WithdrawalReason': null
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

          if (!updateResponse.ok) {
            const errorText = await updateResponse.text();
            console.error('❌ Airtable update error details:', errorText);
            throw new Error(`Airtable update failed: ${updateResponse.status} - ${errorText}`);
          }

          console.log('✅ Airtable updated (existing customer):', email);
        } else {
          // 新規顧客 - Create
          const createUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Customers`;

          const createPayload = {
            fields: {
              'Email': email,
              '氏名': fullName,
              'プラン': planName,
              'PlanType': planType,
              'Status': 'pending',
              'PaymentMethod': 'Bank Transfer',
              '有効期限': expirationDate,
              'Source': 'nankan-analytics'  // 登録元サイト
            }
          };

          console.log('📤 Airtable create payload:', JSON.stringify(createPayload, null, 2));

          const createResponse = await fetch(createUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(createPayload)
          });

          if (!createResponse.ok) {
            const errorText = await createResponse.text();
            console.error('❌ Airtable create error details:', errorText);
            throw new Error(`Airtable create failed: ${createResponse.status} - ${errorText}`);
          }

          console.log('✅ Airtable created (new customer):', email);
        }
      } catch (airtableError) {
        console.error('❌ Airtable registration error:', airtableError);
        // Airtableエラーでも処理は続行（メール送信は成功しているため）
      }
    } else {
      console.log('ℹ️ Premium Plus - Airtable registration skipped');
    }

    // ========================================
    // BlastMail読者登録（Premium Plus以外の月額プラン）
    // ========================================
    if (!productName.includes('Premium Plus')) {
      try {
        const BLASTMAIL_USERNAME = process.env.BLASTMAIL_USERNAME;
        const BLASTMAIL_PASSWORD = process.env.BLASTMAIL_PASSWORD;
        const BLASTMAIL_API_KEY = process.env.BLASTMAIL_API_KEY;

        if (!BLASTMAIL_USERNAME || !BLASTMAIL_PASSWORD || !BLASTMAIL_API_KEY) {
          console.warn('⚠️ BlastMail credentials not configured, skipping reader registration');
        } else {
          // Step 1: ログイン（access_token取得）
          const loginUrl = 'https://api.bme.jp/rest/1.0/authenticate/login';
          const loginParams = new URLSearchParams({
            username: BLASTMAIL_USERNAME,
            password: BLASTMAIL_PASSWORD,
            api_key: BLASTMAIL_API_KEY,
            format: 'json'
          });

          const loginResponse = await fetch(loginUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: loginParams.toString()
          });

          if (!loginResponse.ok) {
            throw new Error(`BlastMail login failed: ${loginResponse.status}`);
          }

          const loginData = await loginResponse.json();
          const accessToken = loginData.accessToken;

          if (!accessToken) {
            throw new Error('BlastMail access token not returned');
          }

          // Step 2: 読者登録
          const registerUrl = 'https://api.bme.jp/rest/1.0/contact/detail/create';
          const registerParams = new URLSearchParams({
            access_token: accessToken,
            format: 'json',
            c15: email,                    // E-Mail（必須）
            c0: fullName,                  // 氏名
            c19: 'nankan-analytics'        // 登録元サイト（registration_source）
          });

          const registerResponse = await fetch(registerUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: registerParams.toString()
          });

          if (!registerResponse.ok) {
            const errorText = await registerResponse.text();
            console.log('⚠️ BlastMail registration response (not ok):', registerResponse.status, errorText);

            // 重複登録エラーは成功として扱う
            if (errorText.includes('Has already been registered') ||
                errorText.includes('already registered') ||
                errorText.includes('既に登録')) {
              console.log('ℹ️ BlastMail reader already registered:', email);
              console.log('ℹ️ Error details:', errorText);
            } else {
              throw new Error(`BlastMail reader registration failed: ${registerResponse.status} - ${errorText}`);
            }
          } else {
            const registerData = await registerResponse.json();
            console.log('✅ BlastMail reader registered:', email, 'ContactID:', registerData.contactID);
          }
        }
      } catch (blastMailError) {
        console.error('❌ BlastMail registration error:', blastMailError);
        // BlastMailエラーでも処理は続行（メール送信・Airtable登録は成功しているため）
      }
    } else {
      console.log('ℹ️ Premium Plus - BlastMail registration skipped');
    }

    console.log('✅ Bank transfer application submitted:', {
      email,
      fullName,
      transferDate,
      transferTime,
      transferAmount,
      timestamp: japanTime
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: '銀行振込申請を受け付けました。確認メールをお送りしましたのでご確認ください。'
      })
    };

  } catch (error) {
    console.error('Bank transfer application error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'サーバーエラーが発生しました。時間をおいて再度お試しください。',
        details: error.message
      })
    };
  }
};
