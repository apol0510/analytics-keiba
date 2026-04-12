// PayPal Webhook受信Function（REST API Webhook形式）
// 決済完了時にAirtable登録 + SendGridウェルカムメール送信

const Airtable = require('airtable');

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // OPTIONS対応
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // POSTメソッドのみ許可
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    console.log('🎯 PayPal Webhook受信:', new Date().toISOString());
    console.log('📦 Event body:', event.body);
    console.log('📋 Headers:', JSON.stringify(event.headers, null, 2));

    // PayPal Webhookペイロード解析（JSON形式）
    const webhookData = JSON.parse(event.body || '{}');

    console.log('🔍 Webhook Data:', JSON.stringify(webhookData, null, 2));

    // 必須フィールド確認
    const {
      id: eventId,
      event_type: eventType,
      resource
    } = webhookData;

    if (!eventId || !eventType || !resource) {
      throw new Error('Missing required webhook fields');
    }

    console.log('🔍 Event ID:', eventId);
    console.log('🔍 Event Type:', eventType);

    // Airtable接続
    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
      .base(process.env.AIRTABLE_BASE_ID);

    // 🔒 重複排除チェック（event_idベース・冪等性保証）
    const processedEvents = await base('ProcessedWebhookEvents')
      .select({
        filterByFormula: `{EventId} = "${eventId}"`
      })
      .firstPage()
      .catch(() => []);

    if (processedEvents.length > 0) {
      console.log('⚠️ 重複イベント検出・スキップ:', eventId);
      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Duplicate event ignored',
          eventId
        })
      };
    }

    // イベント記録（重複排除用・処理開始時に即座記録）
    await base('ProcessedWebhookEvents').create([{
      fields: {
        'EventId': eventId,
        'EventType': eventType,
        'ProcessedAt': new Date().toISOString(),
        'Status': 'processing'
      }
    }]);

    // 処理対象のイベントのみ処理
    // 🔧 2026-01-11 本番仕様実装（専門家推奨・ハイブリッドアプローチ）:
    // - CREATED: 仮登録のみ（Status: pending、メール送らない）
    // - ACTIVATED: 本登録（Status: active、AccessEnabled: true、ウェルカムメール送信）
    // - PAYMENT.SALE.COMPLETED: サブスクならPaidAt更新のみ、Premium Plusなら本登録
    // - CANCELLED/SUSPENDED/EXPIRED: 権限剥奪（Status: cancelled/suspended）
    const validEventTypes = [
      'BILLING.SUBSCRIPTION.CREATED',             // サブスク登録（仮登録）
      'BILLING.SUBSCRIPTION.ACTIVATED',           // サブスク有効化（本登録） ✨
      'PAYMENT.SALE.COMPLETED',                   // 単品決済完了 or サブスク入金確認
      'BILLING.SUBSCRIPTION.CANCELLED',           // サブスクキャンセル（権限剥奪）
      'BILLING.SUBSCRIPTION.SUSPENDED',           // サブスク停止（権限剥奪）
      'BILLING.SUBSCRIPTION.EXPIRED'              // サブスク期限切れ（権限剥奪）
    ];

    if (!validEventTypes.includes(eventType)) {
      console.log('⚠️ 処理対象外のイベント:', eventType);

      // イベント記録を更新
      await base('ProcessedWebhookEvents').update(processedEvents[0]?.id || eventId, {
        'Status': 'ignored'
      });

      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Event ignored', eventType })
      };
    }

    // 🔧 2026-01-11 イベントタイプ別処理分岐
    let email, customerName, planId, userPlan, subscriptionId;
    let eventCategory; // 'pending', 'payment', 'cancellation'

    // プラン名マッピング（共通）
    const planMapping = {
      'P-68H748483T318591TNFRBYMQ': 'Standard',
      'P-6US56295GW7958014NFRB2BQ': 'Premium',
      'P-17K19274A7982913DNFRB3KA': 'Premium Sanrenpuku',
      'P-8KU85292CD447891XNFRB4GI': 'Premium Combo'
    };
    const WEBHOOK_SIMULATOR_PLAN_ID = 'P-5ML4271244454362WXNWU5NQ';

    // サブスク系イベント（CREATED/ACTIVATED）
    const isSubscriptionEvent = [
      'BILLING.SUBSCRIPTION.CREATED',
      'BILLING.SUBSCRIPTION.ACTIVATED'
    ].includes(eventType);

    // キャンセル系イベント
    const isCancellationEvent = [
      'BILLING.SUBSCRIPTION.CANCELLED',
      'BILLING.SUBSCRIPTION.SUSPENDED',
      'BILLING.SUBSCRIPTION.EXPIRED'
    ].includes(eventType);

    if (isSubscriptionEvent) {
      // サブスクリプションイベント（仮登録 or 本登録）
      email = resource.subscriber?.email_address;
      customerName = `${resource.subscriber?.name?.given_name || ''} ${resource.subscriber?.name?.surname || ''}`.trim();
      planId = resource.plan_id;
      subscriptionId = resource.id;

      console.log('🔍 DEBUG - email:', email);
      console.log('🔍 DEBUG - planId:', planId);
      console.log('🔍 DEBUG - subscriptionId:', subscriptionId);

      userPlan = planMapping[planId];
      if (!userPlan) {
        if (planId === WEBHOOK_SIMULATOR_PLAN_ID) {
          userPlan = 'Standard';
          console.log('⚠️ Webhook Simulator検出: Standardでテスト実行');
        } else {
          throw new Error(`Unknown plan_id: ${planId}. Please add to planMapping.`);
        }
      }

      // イベントカテゴリ判定（ハイブリッドアプローチ）
      if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED') {
        eventCategory = 'activation'; // サブスク契約開始（アクセス権付与）
      } else if (eventType === 'BILLING.SUBSCRIPTION.CREATED') {
        eventCategory = 'pending'; // 仮登録
      }

    } else if (eventType === 'PAYMENT.SALE.COMPLETED') {
      // PAYMENT.SALE.COMPLETED: サブスク入金確認 or Premium Plus単品決済

      // billing_agreement_id があればサブスク決済、なければ単品決済
      const billingAgreementId = resource.billing_agreement_id;

      if (billingAgreementId) {
        // サブスクリプション決済の場合：PaidAt更新のみ
        subscriptionId = billingAgreementId;
        eventCategory = 'payment_confirmation'; // 入金確認のみ

        // 🔧 2026-01-11専門家推奨: PayPalSubscriptionIDで顧客を引く
        const existingRecords = await base('Customers')
          .select({
            filterByFormula: `{PayPalSubscriptionID} = "${subscriptionId}"`
          })
          .firstPage();

        if (existingRecords.length > 0) {
          email = existingRecords[0].fields.Email;
          userPlan = existingRecords[0].fields['プラン'];
          console.log('✅ サブスク入金確認:', email, '(SubscriptionID:', subscriptionId, ')');
        } else {
          // 🔧 2026-01-11修正: throwせず、ログだけ残して200返す（未知のsale）
          console.log('⚠️ 未知のサブスク入金・顧客特定不可（SubscriptionID:', subscriptionId, '）→ スキップ');
          // emailが無いまま続行 → Line 232のチェックで安全にスキップ
        }
      } else {
        // Premium Plus単品決済の場合：本登録処理
        email = resource.payer?.payer_info?.email;
        customerName = `${resource.payer?.payer_info?.first_name || ''} ${resource.payer?.payer_info?.last_name || ''}`.trim();
        userPlan = 'Premium Plus';
        eventCategory = 'one_time_payment'; // 単品決済（Premium Plus）
      }

    } else if (isCancellationEvent) {
      // キャンセル系イベント（権限剥奪）
      subscriptionId = resource.id;
      eventCategory = 'cancellation';

      // 🔧 メール抽出フォールバック（専門家推奨）
      email = resource.subscriber?.email_address;
      if (!email) {
        // subscription_id で Customers を検索
        console.log('⚠️ メール取得失敗・subscription_idで検索:', subscriptionId);
        const existingRecords = await base('Customers')
          .select({
            filterByFormula: `{PayPalSubscriptionID} = "${subscriptionId}"`
          })
          .firstPage();

        if (existingRecords.length > 0) {
          email = existingRecords[0].fields.Email;
          userPlan = existingRecords[0].fields['プラン'];
          console.log('✅ メール復元成功:', email);
        } else {
          throw new Error(`Email not found for subscription_id: ${subscriptionId}`);
        }
      }
    }

    // 🔧 2026-01-11専門家推奨: payment_confirmationはemail不要（SubscriptionIDで顧客特定）
    if (!email) {
      if (eventCategory === 'payment_confirmation') {
        // 入金確認はemail無しでもOK（SubscriptionIDで特定できなかった場合）
        console.log('⚠️ Email特定不可・入金確認スキップ（SubscriptionID:', subscriptionId, ')');
        // 重複排除記録は残す（再処理防止）
        await base('ProcessedWebhookEvents').update(processedRecord.id, {
          'Status': 'completed'
        });
        return {
          statusCode: 200,
          body: JSON.stringify({ message: 'Unknown subscription sale skipped', eventId })
        };
      } else {
        // その他のイベントはemail必須
        throw new Error('Missing required field: email');
      }
    }

    console.log('📧 Email:', email);
    console.log('📦 User Plan:', userPlan);
    console.log('🏷️ Event Category:', eventCategory);

    // 有効期限計算（Premium Plus以外は1ヶ月後）
    const now = new Date();
    let expiryDate;

    if (userPlan === 'Premium Plus') {
      expiryDate = null; // Premium Plusは無期限
    } else {
      expiryDate = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
    }
    const expiryDateStr = expiryDate ? expiryDate.toISOString().split('T')[0] : '';

    // 既存顧客チェック
    const existingRecords = await base('Customers')
      .select({
        filterByFormula: `{Email} = "${email}"`
      })
      .firstPage();

    let customerRecord;
    let isNewCustomer = false;
    let shouldSendWelcomeEmail = false;

    // 🔧 2026-01-11 イベントカテゴリ別処理
    if (eventCategory === 'pending') {
      // ========================================
      // A. 仮登録（CREATED/ACTIVATED）
      // ========================================
      console.log('📝 仮登録処理:', email);

      if (existingRecords.length > 0) {
        const recordId = existingRecords[0].id;
        customerRecord = await base('Customers').update(recordId, {
          'Status': 'pending',
          'PayPalSubscriptionID': subscriptionId || '',
          'プラン': userPlan
        });
        console.log('✅ 既存顧客を仮登録に更新:', recordId);
      } else {
        customerRecord = await base('Customers').create([{
          fields: {
            'Email': email,
            '氏名': customerName || '',
            'プラン': userPlan,
            'Status': 'pending',
            'PayPalSubscriptionID': subscriptionId || '',
            'WithdrawalRequested': false
          }
        }]);
        console.log('✅ 新規顧客を仮登録:', customerRecord[0].id);
      }

    } else if (eventCategory === 'activation' || eventCategory === 'one_time_payment') {
      // ========================================
      // B. 本登録（activation: サブスク契約開始, one_time_payment: 単品決済）
      // ========================================
      const categoryLabel = eventCategory === 'activation' ? 'サブスク契約開始' : '単品決済（Premium Plus）';
      console.log(`✅ 本登録処理（${categoryLabel}・アクセス権付与）:`, email);

      if (existingRecords.length > 0) {
        const recordId = existingRecords[0].id;
        const welcomeSentAt = existingRecords[0].fields.WelcomeSentAt;

        // ✅ WelcomeSentAt が無い場合のみメール送信
        shouldSendWelcomeEmail = !welcomeSentAt;

        customerRecord = await base('Customers').update(recordId, {
          'Status': 'active',
          'プラン': userPlan,
          '有効期限': expiryDateStr,
          'PayPalSubscriptionID': subscriptionId || '',
          // PaidAt は PAYMENT.SALE.COMPLETED で更新（入金確認時）
          'WithdrawalRequested': false,
          'WithdrawalDate': null,
          'WithdrawalReason': null,
          'AccessEnabled': true
        });
        console.log(`✅ 既存顧客を本登録に更新（${categoryLabel}）:`, recordId);
      } else {
        isNewCustomer = true;
        shouldSendWelcomeEmail = true;

        customerRecord = await base('Customers').create([{
          fields: {
            'Email': email,
            '氏名': customerName || '',
            'プラン': userPlan,
            '有効期限': expiryDateStr,
            'Status': 'active',
            'PayPalSubscriptionID': subscriptionId || '',
            // PaidAt は PAYMENT.SALE.COMPLETED で更新（入金確認時）
            'WithdrawalRequested': false,
            'AccessEnabled': true
          }
        }]);
        console.log(`✅ 新規顧客を本登録（${categoryLabel}）:`, customerRecord[0].id);
      }

    } else if (eventCategory === 'payment_confirmation') {
      // ========================================
      // C. 入金確認（PAYMENT.SALE.COMPLETED for subscriptions）
      // ========================================
      // 🔧 2026-01-11修正: subscriptionIDも併記（顧客特定の透明性向上）
      console.log('💰 入金確認処理（PaidAt更新のみ）:', email, '(SubscriptionID:', subscriptionId, ')');

      if (existingRecords.length > 0) {
        const recordId = existingRecords[0].id;
        customerRecord = await base('Customers').update(recordId, {
          'PaidAt': now.toISOString()
        });
        console.log('✅ PaidAt更新完了:', recordId, '(SubscriptionID:', subscriptionId, ')');
      } else {
        console.log('⚠️ 顧客が見つからない（未登録？）・SubscriptionID:', subscriptionId);
      }

    } else if (eventCategory === 'cancellation') {
      // ========================================
      // D. 権限剥奪（CANCELLED/SUSPENDED/EXPIRED）
      // ========================================
      console.log('⛔ 権限剥奪処理:', email);

      if (existingRecords.length > 0) {
        const recordId = existingRecords[0].id;
        const statusMap = {
          'BILLING.SUBSCRIPTION.CANCELLED': 'cancelled',
          'BILLING.SUBSCRIPTION.SUSPENDED': 'suspended',
          'BILLING.SUBSCRIPTION.EXPIRED': 'cancelled'
        };

        customerRecord = await base('Customers').update(recordId, {
          'Status': statusMap[eventType] || 'cancelled',
          'AccessEnabled': false,
          'CancelledAt': now.toISOString()
        });
        console.log('✅ 顧客権限を剥奪:', recordId);
      } else {
        console.log('⚠️ 顧客が見つからない（既に削除済み？）');
      }
    }

    // 📧 ウェルカムメール送信（本登録かつ未送信の場合のみ）
    if (shouldSendWelcomeEmail) {
      console.log('📧 ウェルカムメール送信開始...');

      const sendGridResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{
            to: [{ email: email }],
            subject: `【NANKANアナリティクス】${userPlan}プラン ご登録ありがとうございます`
          }],
          from: {
            email: 'support@keiba.link',
            name: 'NANKANアナリティクス'
          },
          content: [{
            type: 'text/html',
            value: generateWelcomeEmail(customerName, userPlan, expiryDateStr, email)
          }]
        })
      });

      if (sendGridResponse.ok) {
        console.log('✅ ウェルカムメール送信完了');

        // WelcomeSentAt を記録（重複送信防止）
        const recordId = isNewCustomer ? customerRecord[0].id : existingRecords[0].id;
        await base('Customers').update(recordId, {
          'WelcomeSentAt': now.toISOString()
        });
        console.log('✅ WelcomeSentAt記録完了');
      } else {
        const errorText = await sendGridResponse.text();
        console.error('❌ SendGrid送信失敗:', errorText);
      }
    }

    // イベント記録を更新（処理完了）
    const processedEventRecords = await base('ProcessedWebhookEvents')
      .select({
        filterByFormula: `{EventId} = "${eventId}"`
      })
      .firstPage();

    if (processedEventRecords.length > 0) {
      await base('ProcessedWebhookEvents').update(processedEventRecords[0].id, {
        'Status': 'completed',
        'CustomerEmail': email,
        'UserPlan': userPlan
      });
    }

    // 成功レスポンス
    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        message: 'Webhook processed successfully',
        eventId,
        eventType,
        customerEmail: email,
        plan: userPlan,
        expiryDate: expiryDateStr,
        isNewCustomer,
        timestamp: now.toISOString()
      })
    };

  } catch (error) {
    console.error('❌ Webhook処理エラー:', error);

    return {
      statusCode: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message,
        timestamp: new Date().toISOString()
      })
    };
  }
};

// ウェルカムメールHTML生成（マジックリンク付き）
function generateWelcomeEmail(customerName, plan, expiryDate, email) {
  const planDescriptions = {
    'Standard': '後半3レースの馬単予想',
    'Premium': '全レースの馬単予想',
    'Premium Sanrenpuku': '全レースの三連複予想',
    'Premium Combo': '全レースの馬単+三連複予想',
    'Premium Plus': '超高性能AI予想（1鞍）'
  };

  const description = planDescriptions[plan] || plan;
  const expiryText = expiryDate ? `有効期限: ${expiryDate}` : '無期限';

  // マジックリンク生成（既存のauth-user.js経由）
  const magicLink = `https://nankan-analytics.keiba.link/?email=${encodeURIComponent(email)}`;

  return `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ご登録ありがとうございます</title>
</head>
<body style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background-color: #667eea; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="margin: 0; font-size: 24px;">🎉 ご登録ありがとうございます</h1>
  </div>

  <div style="background: #fff; padding: 30px; border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 10px 10px;">
    <p>${customerName ? customerName + '様' : 'お客様'}</p>

    <p>NANKANアナリティクスへのご登録ありがとうございます。<br>
    以下の内容でご登録が完了しました。</p>

    <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
      <p style="margin: 0 0 10px 0;"><strong>📦 ご契約プラン</strong></p>
      <p style="margin: 0 0 10px 0; font-size: 18px; color: #667eea;"><strong>${plan}</strong></p>
      <p style="margin: 0 0 10px 0; color: #666;">${description}</p>
      <p style="margin: 0; color: #666;">${expiryText}</p>
    </div>

    <div style="background: #e8f4fd; padding: 20px; border-radius: 8px; margin: 20px 0;">
      <p style="margin: 0 0 10px 0;"><strong>🔐 ログイン方法</strong></p>
      <p style="margin: 0 0 15px 0;">下のボタンをクリックすると、自動的にログインできます。<br>
      パスワードは不要です。</p>

      <div style="text-align: center;">
        <a href="${magicLink}"
           style="display: inline-block; background-color: #667eea; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; padding: 15px 40px; border-radius: 25px; font-weight: bold;">
          マジックリンクでログイン
        </a>
      </div>
    </div>

    <div style="text-align: center; margin: 30px 0;">
      <p style="margin: 0 0 15px 0; color: #666;">または、メールアドレスでログインすることもできます：</p>
      <a href="https://nankan-analytics.keiba.link/"
         style="display: inline-block; background: #fff; color: #667eea; text-decoration: none; padding: 12px 30px; border: 2px solid #667eea; border-radius: 25px; font-weight: bold;">
        サイトにアクセス
      </a>
    </div>

    <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">

    <p style="font-size: 12px; color: #999;">
      ※ このメールに心当たりがない場合は、お手数ですが削除してください。<br>
      ※ ご不明な点がございましたら、nankan.analytics@gmail.com までお問い合わせください。
    </p>
  </div>
</body>
</html>
  `;
}
