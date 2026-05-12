// ポイント交換申請処理
// Airtableに申請データ保存 + SendGridメール通知
// 最終更新: 2025-10-23 1:00 SendGridメール通知実装（管理者＋申請者）

const Airtable = require('airtable');
const sgMail = require('@sendgrid/mail');

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// SendGrid設定
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

exports.handler = async (event, context) => {
  // CORSヘッダー設定
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // OPTIONSリクエスト（プリフライト）対応
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // POSTリクエストのみ受付
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    // リクエストボディ解析
    const { userEmail, userName, userPlan, currentPoints, requiredPoints, rewardName } = JSON.parse(event.body);

    console.log('📧 ポイント交換申請受付:', {
      userEmail,
      userName,
      userPlan,
      currentPoints,
      requiredPoints,
      rewardName,
      timestamp: new Date().toISOString()
    });

    // バリデーション
    if (!userEmail || !requiredPoints || !rewardName) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: '必須項目が不足しています' })
      };
    }

    // ポイント不足チェック
    if (currentPoints < requiredPoints) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'ポイント不足',
          message: `交換には${requiredPoints}pt必要です（現在: ${currentPoints}pt）`
        })
      };
    }

    // Airtableに申請データを保存
    try {
      // Airtable Date型フィールド対応: YYYY-MM-DD形式で送信
      const today = new Date().toISOString().split('T')[0];

      // Plan値を正規化（大文字始まりに統一: free→Free, premium→Premium, standard→Standard）
      const normalizePlan = (plan) => {
        if (!plan) return 'Free';
        const normalized = plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase();
        return normalized;
      };

      const record = await base('PointExchangeRequests').create({
        Email: userEmail,
        Name: userName || '',
        Plan: normalizePlan(userPlan),
        CurrentPoints: currentPoints,
        RequiredPoints: requiredPoints,
        RewardName: rewardName,
        Status: 'Pending',
        RequestDate: today,
        ProcessedDate: null,
        Notes: ''
      });

      console.log('✅ Airtable申請データ保存成功:', record.id);

      // メール通知送信
      try {
        const requestDate = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

        // 1. 管理者向けメール
        const adminEmail = {
          to: 'nankan.analytics@gmail.com',
          from: 'nankan-analytics@keiba.link',
          subject: `【ポイント交換申請】${userEmail} - ${rewardName}`,
          html: `
            <h2>ポイント交換申請を受け付けました</h2>
            <p><strong>申請ID:</strong> ${record.id}</p>
            <hr>
            <h3>申請者情報</h3>
            <ul>
              <li><strong>メールアドレス:</strong> ${userEmail}</li>
              <li><strong>お名前:</strong> ${userName || '未登録'}</li>
              <li><strong>会員プラン:</strong> ${normalizePlan(userPlan)}</li>
              <li><strong>申請日時:</strong> ${requestDate}</li>
            </ul>
            <hr>
            <h3>交換内容</h3>
            <ul>
              <li><strong>交換特典:</strong> ${rewardName}</li>
              <li><strong>必要ポイント:</strong> ${requiredPoints}pt</li>
              <li><strong>現在の保有ポイント:</strong> ${currentPoints}pt</li>
              <li><strong>交換後残高:</strong> ${currentPoints - requiredPoints}pt</li>
            </ul>
            <hr>
            <p><strong>対応が必要です:</strong></p>
            <ol>
              <li>Airtableで申請内容を確認</li>
              <li>特典メールを${userEmail}宛に送信</li>
              <li>Airtableのステータスを「処理済み」に更新</li>
            </ol>
          `,
          tracking_settings: {
            click_tracking: { enable: false, enable_text: false },
            open_tracking: { enable: false },
            subscription_tracking: { enable: false },
            ganalytics: { enable: false }
          }
        };

        // 2. 申請者向け確認メール
        const userEmail_data = {
          to: userEmail,
          from: 'nankan-analytics@keiba.link',
          subject: '【ポイント交換申請受付】NANKANアナリティクス',
          html: `
            <h2>ポイント交換申請を受け付けました</h2>
            <p>${userName || 'お客様'}、この度はポイント交換をお申し込みいただき、ありがとうございます。</p>
            <hr>
            <h3>申請内容</h3>
            <ul>
              <li><strong>申請ID:</strong> ${record.id}</li>
              <li><strong>交換特典:</strong> ${rewardName}</li>
              <li><strong>必要ポイント:</strong> ${requiredPoints}pt</li>
              <li><strong>申請日時:</strong> ${requestDate}</li>
            </ul>
            <hr>
            <h3>今後の流れ</h3>
            <ol>
              <li>管理者が申請内容を確認いたします</li>
              <li>1営業日以内に、特典をメールでお送りいたします</li>
              <li>特典メール送信後、交換が完了となります</li>
            </ol>
            <p>ご不明な点がございましたら、お気軽にお問い合わせください。</p>
            <hr>
            <p>NANKANアナリティクス<br>
            <a href="https://analytics.keiba.link">https://analytics.keiba.link</a></p>
          `,
          tracking_settings: {
            click_tracking: { enable: false, enable_text: false },
            open_tracking: { enable: false },
            subscription_tracking: { enable: false },
            ganalytics: { enable: false }
          }
        };

        // メール送信
        await sgMail.send(adminEmail);
        console.log('✅ 管理者通知メール送信成功');

        await sgMail.send(userEmail_data);
        console.log('✅ 申請者確認メール送信成功');

      } catch (emailError) {
        console.error('⚠️ メール送信エラー（Airtable保存は成功）:', emailError);
        // メール送信失敗してもAirtableには保存済みなのでエラーにしない
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: 'ポイント交換申請を受け付けました。管理者が確認後、1営業日以内にメールで特典をお送りします。',
          requestId: record.id
        })
      };

    } catch (airtableError) {
      console.error('❌ Airtable保存エラー:', airtableError);

      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: '申請データの保存に失敗しました',
          details: airtableError.message
        })
      };
    }

  } catch (error) {
    console.error('❌ ポイント交換処理エラー:', error);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: '申請処理中にエラーが発生しました',
        details: error.message
      })
    };
  }
};
