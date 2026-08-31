// 有効期限1週間前通知システム（銀行振込ユーザー限定）
// 実行タイミング: 毎日午前9時（cron-expiry-check.jsから呼び出し）

const Airtable = require('airtable');
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

import { SUPPORT_EMAIL, ADMIN_EMAIL, FROM_EMAIL } from './config/email-config.js';
exports.handler = async (event, context) => {
  // 🛡️ 止血ガード（2026-05-18 追加）
  // 期限通知は NEWSLETTER_AUTOMATION_ENABLED の対象外で別系統として
  // 毎日18時に SendGrid 送信されていた（safety audit D3）。
  // cron-expiry-check.js のガードに加え、直接呼び出された場合の二重防御。
  // ここで早期 return することで、Airtable / SendGrid に一切到達しない。
  // 本番配信を再開する際は、設計・dry-run・test を整備してから明示的にフラグを立てる。
  if (process.env.NEWSLETTER_AUTOMATION_ENABLED !== 'true') {
    console.log('🛡️ newsletter automation disabled (NEWSLETTER_AUTOMATION_ENABLED !== "true") - expiry-warning-notification is a no-op');
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        skipped: true,
        reason: 'newsletter automation disabled',
        flag: 'NEWSLETTER_AUTOMATION_ENABLED',
        flagValue: process.env.NEWSLETTER_AUTOMATION_ENABLED ?? null,
        timestamp: new Date().toISOString()
      })
    };
  }

  console.log('⚠️ 有効期限1週間前通知システム開始');

  try {
    // Airtable設定
    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
      .base(process.env.AIRTABLE_BASE_ID);

    // 7日後の日付取得（YYYY-MM-DD）
    const sevenDaysLater = new Date();
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
    const sevenDaysLaterStr = sevenDaysLater.toISOString().split('T')[0];

    console.log(`📅 7日後の日付: ${sevenDaysLaterStr}`);

    // 7日後に期限切れユーザー検索（銀行振込ユーザーのみ）
    const records = await base('Customers')
      .select({
        filterByFormula: `AND(
          DATESTR({有効期限}) = '${sevenDaysLaterStr}',
          {プラン} != 'Free',
          {PaymentMethod} = 'Bank Transfer',
          NOT({ExpiryWarningNotificationSent})
        )`,
        maxRecords: 100
      })
      .firstPage();

    console.log(`📊 7日後期限切れユーザー（銀行振込）: ${records.length}件`);

    let notifications = [];

    for (const record of records) {
      const email = record.get('Email');
      const fullName = record.get('氏名') || 'お客様';
      const plan = record.get('プラン');
      const expiryDate = record.get('有効期限') || record.get('ExpiryDate');

      console.log(`📧 1週間前通知送信: ${email} (${plan}, 期限: ${expiryDate})`);

      // 配信停止 URL（brand 別 unsubscribe フィールドに書き込む）
      const unsubscribeUrl = `https://analytics.keiba.link/.netlify/functions/unsubscribe?email=${encodeURIComponent(email)}&brand=analytics-keiba`;

      // お客様への通知メール（D4 統一: KEIBA Analytics ブランド + RFC 8058 List-Unsubscribe）
      const customerEmail = {
        to: email,
        from: { email: FROM_EMAIL, name: 'KEIBA Analytics' },
        replyTo: { email: FROM_EMAIL, name: 'KEIBA Analytics' },
        subject: '【重要】プランの有効期限まで残り7日 - 特別割引のご案内',
        html: generateCustomerEmail(fullName, email, plan, expiryDate, unsubscribeUrl),
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          open_tracking: { enable: false },
          subscription_tracking: { enable: false },
          ganalytics: { enable: false }
        },
        // RFC 8058 準拠の List-Unsubscribe ヘッダー（Gmail 等が要求）
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:unsubscribe@keiba.link?subject=Unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      };

      // 管理者向け通知メール（宛先・from/reply_to すべて単一源 email-config.js）
      const adminEmail = {
        to: ADMIN_EMAIL,
        from: { email: FROM_EMAIL, name: 'KEIBA Analytics' },
        replyTo: { email: FROM_EMAIL, name: 'KEIBA Analytics' },
        subject: `[管理者通知] ${email} 様に1週間前通知を送信しました`,
        html: generateAdminEmail(email, fullName, plan, expiryDate),
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          open_tracking: { enable: false },
          subscription_tracking: { enable: false },
          ganalytics: { enable: false }
        }
      };

      try {
        // お客様への通知
        await sgMail.send(customerEmail);
        console.log(`✅ お客様通知送信成功: ${email}`);

        // マコさんへの通知
        await sgMail.send(adminEmail);
        console.log(`✅ 管理者通知送信成功: ${email}`);

        // Airtableに通知済みフラグを設定
        await base('Customers').update(record.id, {
          'ExpiryWarningNotificationSent': true,
          'ExpiryWarningNotificationDate': new Date().toISOString().split('T')[0]
        });

        notifications.push({
          email,
          fullName,
          plan,
          expiryDate,
          status: 'success'
        });

      } catch (emailError) {
        console.error(`❌ メール送信エラー (${email}):`, emailError);
        notifications.push({
          email,
          fullName,
          plan,
          expiryDate,
          status: 'error',
          error: emailError.message
        });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: `1週間前通知処理完了: ${notifications.length}件`,
        notifications
      }, null, 2)
    };

  } catch (error) {
    console.error('🚨 1週間前通知システムエラー:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        details: error.message
      })
    };
  }
};

// お客様向けメール本文生成（30%OFF + アップセル案内）
function generateCustomerEmail(fullName, email, plan, expiryDate, unsubscribeUrl) {
  const planInfo = getPlanDiscountInfo(plan);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Hiragino Sans', 'Yu Gothic', sans-serif; line-height: 1.8; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #f59e0b; background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
    .expiry-box { background: white; border: 2px solid #f59e0b; border-radius: 8px; padding: 20px; margin: 20px 0; }
    .discount-card { background-color: #10b981; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border-radius: 8px; padding: 25px; margin: 20px 0; text-align: center; }
    .discount-price { font-size: 2rem; font-weight: bold; margin: 15px 0; }
    .original-price { text-decoration: line-through; color: #d1d5db; font-size: 1.2rem; }
    .upsell-card { background: white; border: 2px solid #3b82f6; border-radius: 8px; padding: 20px; margin: 15px 0; }
    .btn { display: inline-block; background-color: #3b82f6; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: #ffffff; padding: 15px 40px; text-decoration: none; border-radius: 8px; margin: 10px 0; font-weight: bold; }
    .footer { text-align: center; color: #6b7280; font-size: 14px; margin-top: 30px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⏰ 有効期限まで残り7日です</h1>
      <p style="font-size: 1.2rem; margin: 10px 0;">特別割引でプランを継続しませんか？</p>
    </div>
    <div class="content">
      <p>いつもKEIBA Analyticsをご利用いただきありがとうございます。</p>
      <p><strong>${fullName} 様</strong>のプランが間もなく有効期限を迎えます。</p>

      <div class="expiry-box">
        <h3>🔔 有効期限情報</h3>
        <p><strong>現在のプラン:</strong> ${plan}会員</p>
        <p><strong>有効期限:</strong> ${expiryDate}</p>
        <p style="color: #f59e0b; font-weight: bold;">残り7日で無料会員に戻ります</p>
      </div>

      <div class="discount-card">
        <h2 style="margin: 0 0 15px 0;">🎉 期間限定！ 特別割引</h2>
        <p style="margin: 0 0 10px 0;">同じプランを継続する場合</p>
        <div class="original-price">通常価格: ${planInfo.currentPrice}</div>
        <div class="discount-price">${planInfo.discountPrice} <span style="font-size: 1rem;">(30% OFF)</span></div>
        <p style="margin: 15px 0 0 0; font-size: 0.95rem;">この割引は期限切れまでの7日間限定です</p>
      </div>

      ${planInfo.upsellHtml}

      <h3 style="margin-top: 30px;">📞 継続をご希望の場合</h3>
      <p>下記の口座に振り込み後、お知らせください。</p>

      <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h4 style="margin: 0 0 15px 0;">🏦 振込先口座</h4>
        <p style="margin: 5px 0;"><strong>PayPay銀行 本店営業部</strong></p>
        <p style="margin: 5px 0;"><strong>普通 8307337</strong></p>
        <p style="margin: 5px 0;">ｳｴﾌﾞｹｲﾊﾞ</p>
      </div>

      <div style="text-align: center; margin: 30px 0;">
        <a href="mailto:${SUPPORT_EMAIL}?subject=【プラン継続】${plan} - ${email}&body=お名前: ${fullName}%0Aメールアドレス: ${email}%0A希望プラン: ${plan}%0A振込金額: ${planInfo.discountPrice}%0A振込完了日: （ご記入ください）" class="btn" style="display: inline-block; background-color: #3b82f6; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: #ffffff !important; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold;">
          継続を申し込む（メールで連絡）
        </a>
      </div>

      <div class="footer">
        <p>KEIBA Analytics<br>
        お問い合わせ: <a href="mailto:${SUPPORT_EMAIL}" style="color: #6b7280;">${SUPPORT_EMAIL}</a></p>
        <p style="font-size: 0.85rem; color: #94a3b8; margin-top: 15px;">
          ※このメールは有効期限7日前に自動送信されています
        </p>
        <p style="font-size: 0.85rem; margin-top: 12px;">
          <a href="${unsubscribeUrl}" style="color: #dc2626; text-decoration: underline;">🚫 配信停止はこちら</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>
  `;
}

// 管理者向けメール本文生成
function generateAdminEmail(email, fullName, plan, expiryDate) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: monospace; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; background: #f3f4f6; }
    .info-box { background: white; border-left: 4px solid #f59e0b; padding: 15px; margin: 10px 0; }
    h2 { color: #1f2937; }
  </style>
</head>
<body>
  <div class="container">
    <h2>⏰ 1週間前通知送信（管理者用）</h2>

    <div class="info-box">
      <p><strong>お名前:</strong> ${fullName}</p>
      <p><strong>メールアドレス:</strong> ${email}</p>
      <p><strong>プラン:</strong> ${plan}</p>
      <p><strong>有効期限:</strong> ${expiryDate}</p>
      <p><strong>通知日時:</strong> ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</p>
      <p><strong>割引内容:</strong> 30% OFF（7日間限定）</p>
    </div>

    <h3>送信内容</h3>
    <ul>
      <li>✅ 有効期限7日前の警告通知</li>
      <li>✅ 30%OFF 特別割引案内（同プラン継続）</li>
      <li>✅ 上位プラン30%OFF アップセル案内</li>
      <li>✅ 銀行振込口座情報</li>
    </ul>

    <h3>対応事項</h3>
    <ul>
      <li>お客様に1週間前通知メールを自動送信しました</li>
      <li>Airtableの ExpiryWarningNotificationSent フィールドをTRUEに更新しました</li>
      <li>振込連絡があった場合は入金確認後、Status を "active" に変更してください</li>
    </ul>

    <p>---<br>
    KEIBA Analytics 期限管理システム</p>
  </div>
</body>
</html>
  `;
}

// プラン別の割引情報を取得
function getPlanDiscountInfo(plan) {
  const planPrices = {
    'Standard': { current: 5980, name: 'Standard', upsell: 'Premium' },
    'Premium': { current: 9980, name: 'Premium', upsell: 'Premium Sanrenpuku' },
    'Premium Sanrenpuku': { current: 19820, name: 'Premium Sanrenpuku', upsell: 'Premium Combo' },
    'Premium Combo': { current: 24800, name: 'Premium Combo', upsell: null }
  };

  const planKey = Object.keys(planPrices).find(key => plan.includes(key)) || 'Premium';
  const info = planPrices[planKey];

  const discountPrice = Math.round(info.current * 0.7);
  const currentPrice = `¥${info.current.toLocaleString()}/月`;
  const discountPriceStr = `¥${discountPrice.toLocaleString()}/月`;

  // アップセル案内HTML生成
  let upsellHtml = '';
  if (info.upsell) {
    const upsellInfo = planPrices[info.upsell];
    const upsellDiscountPrice = Math.round(upsellInfo.current * 0.7);

    upsellHtml = `
      <div class="upsell-card">
        <h3 style="margin: 0 0 15px 0; color: #1e293b;">✨ さらに上のプランはいかがですか？</h3>
        <p style="margin: 0 0 10px 0;"><strong>${info.upsell}会員</strong> にアップグレード</p>
        <p style="color: #64748b; margin: 0 0 15px 0; font-size: 0.95rem;">
          ${getUpsellDescription(info.upsell)}
        </p>
        <div style="text-align: center;">
          <span style="text-decoration: line-through; color: #6b7280;">¥${upsellInfo.current.toLocaleString()}/月</span>
          <span style="font-size: 1.5rem; font-weight: bold; color: #10b981; margin-left: 10px;">¥${upsellDiscountPrice.toLocaleString()}/月</span>
          <span style="color: #10b981; font-weight: bold; margin-left: 5px;">(30% OFF)</span>
        </div>
      </div>
    `;
  }

  return {
    currentPrice: currentPrice,
    discountPrice: discountPriceStr,
    upsellHtml: upsellHtml
  };
}

// アップセルの説明文を取得
function getUpsellDescription(upsellPlan) {
  const descriptions = {
    'Premium': '全レース（1R〜12R）の予想データにアクセス可能になります',
    'Premium Sanrenpuku': '全レース + 三連複予想データ（高精度買い目）にアクセス可能になります',
    'Premium Combo': '全レース + 三連複予想 + Combo会員限定コンテンツにアクセス可能になります'
  };
  return descriptions[upsellPlan] || '';
}
