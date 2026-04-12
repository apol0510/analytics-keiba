// 期限切れ通知システム（お客様＋マコさんへの自動通知）
// 実行タイミング: 毎日午前9時（cron-expiry-check.jsから呼び出し）

const Airtable = require('airtable');
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

import { SUPPORT_EMAIL, ADMIN_EMAIL, FROM_EMAIL } from './config/email-config.js';
exports.handler = async (event, context) => {
  console.log('🔔 期限切れ通知システム開始');

  try {
    // Airtable設定
    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
      .base(process.env.AIRTABLE_BASE_ID);

    // 今日の日付取得
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];

    console.log(`📅 今日の日付: ${todayStr}`);

    // 期限切れユーザー検索（有効期限が今日以前・銀行振込ユーザーのみ）
    const records = await base('Customers')
      .select({
        filterByFormula: `AND(
          {有効期限},
          NOT(IS_AFTER({有効期限}, TODAY())),
          {プラン} != 'Free',
          {PaymentMethod} = 'Bank Transfer',
          NOT({ExpiryNotificationSent})
        )`,
        maxRecords: 100
      })
      .firstPage();

    console.log(`📊 期限切れユーザー（銀行振込）: ${records.length}件`);

    let notifications = [];

    for (const record of records) {
      const email = record.get('Email');
      const fullName = record.get('氏名') || 'お客様';
      const plan = record.get('プラン');
      const expiryDate = record.get('有効期限') || record.get('ExpiryDate');

      console.log(`📧 期限切れ通知送信: ${email} (${plan}, 期限: ${expiryDate})`);

      // お客様への通知メール
      const customerEmail = {
        to: email,
        from: 'nankan-analytics@keiba.link',
        subject: '【期間限定】特別割引で復帰しませんか？ - NANKANアナリティクス',
        html: generateCustomerEmail(fullName, email, plan, expiryDate),
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          open_tracking: { enable: false },
          subscription_tracking: { enable: false },
          ganalytics: { enable: false }
        }
      };

      // マコさんへの通知メール
      const adminEmail = {
        to: 'nankan-analytics@keiba.link',
        from: 'nankan-analytics@keiba.link',
        subject: `[管理者通知] ${email} 様に期限切れ通知+割引案内を送信しました`,
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
          'ExpiryNotificationSent': true,
          'ExpiryNotificationDate': new Date().toISOString().split('T')[0]
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
        message: `期限切れ通知処理完了: ${notifications.length}件`,
        notifications
      }, null, 2)
    };

  } catch (error) {
    console.error('🚨 期限切れ通知システムエラー:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        details: error.message
      })
    };
  }
};

// お客様向けメール本文生成（3ヶ月40%OFF、6ヶ月50%OFF + アップセル案内）
function generateCustomerEmail(fullName, email, plan, expiryDate) {
  const planInfo = getPlanDiscountInfo(plan);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Hiragino Sans', 'Yu Gothic', sans-serif; line-height: 1.8; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #ef4444; background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
    .expiry-box { background: white; border: 2px solid #ef4444; border-radius: 8px; padding: 20px; margin: 20px 0; }
    .discount-card { background-color: #10b981; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border-radius: 8px; padding: 25px; margin: 20px 0; }
    .discount-option { background: #f0fdfa; border-radius: 8px; padding: 20px; margin: 15px 0; border: 2px solid #5eead4; }
    .discount-price { font-size: 2rem; font-weight: bold; margin: 10px 0; }
    .original-price { text-decoration: line-through; color: #9ca3af; font-size: 1rem; }
    .upsell-card { background: white; border: 2px solid #3b82f6; border-radius: 8px; padding: 20px; margin: 15px 0; }
    .btn { display: inline-block; background-color: #3b82f6; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: #ffffff; padding: 15px 40px; text-decoration: none; border-radius: 8px; margin: 10px 0; font-weight: bold; }
    .footer { text-align: center; color: #6b7280; font-size: 14px; margin-top: 30px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>💔 有効期限が切れました</h1>
      <p style="font-size: 1.1rem; margin: 10px 0;">でも、まだ間に合います！</p>
    </div>
    <div class="content">
      <p>いつもNANKANアナリティクスをご利用いただきありがとうございます。</p>
      <p><strong>${fullName} 様</strong>のプランが有効期限を迎えました。</p>

      <div class="expiry-box">
        <h3>📌 有効期限情報</h3>
        <p><strong>プラン:</strong> ${plan}会員</p>
        <p><strong>有効期限:</strong> ${expiryDate}</p>
        <p style="color: #ef4444; font-weight: bold;">現在は無料会員に戻っています</p>
      </div>

      <div class="discount-card">
        <h2 style="margin: 0 0 15px 0;">🎉 復帰限定！ 特別割引</h2>
        <p style="margin: 0 0 20px 0; font-size: 1.05rem;">この機会にぜひ復帰してください</p>

        <div class="discount-option">
          <h3 style="margin: 0 0 10px 0;">💰 3ヶ月プラン</h3>
          <div class="original-price">通常: ${planInfo.threeMonthOriginal}</div>
          <div class="discount-price">${planInfo.threeMonthDiscount} <span style="font-size: 1rem;">(40% OFF)</span></div>
          <p style="margin: 10px 0 0 0; font-size: 0.9rem;">1ヶ月あたり ${planInfo.threeMonthPerMonth}</p>
        </div>

        <div class="discount-option">
          <h3 style="margin: 0 0 10px 0;">🌟 6ヶ月プラン（お得！）</h3>
          <div class="original-price">通常: ${planInfo.sixMonthOriginal}</div>
          <div class="discount-price">${planInfo.sixMonthDiscount} <span style="font-size: 1rem;">(50% OFF)</span></div>
          <p style="margin: 10px 0 0 0; font-size: 0.9rem;">1ヶ月あたり ${planInfo.sixMonthPerMonth}</p>
        </div>
      </div>

      ${planInfo.upsellHtml}

      <h3 style="margin-top: 30px;">📞 復帰をご希望の場合</h3>
      <p>下記の口座に振り込み後、お知らせください。</p>

      <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h4 style="margin: 0 0 15px 0;">🏦 振込先口座</h4>
        <p style="margin: 5px 0;"><strong>三井住友銀行 洲本支店</strong></p>
        <p style="margin: 5px 0;"><strong>普通 5338892</strong></p>
        <p style="margin: 5px 0;">ﾏ-ｸｱﾂﾌﾟｴ-ｱｲｻ-ﾋﾞｽ ｱｻｲ ﾄｼﾋﾛ</p>
      </div>

      <div style="text-align: center; margin: 30px 0;">
        <a href="mailto:${SUPPORT_EMAIL}?subject=【プラン復帰】${plan} - ${email}&body=お名前: ${fullName}%0Aメールアドレス: ${email}%0A希望プラン: ${plan}%0A希望期間: （3ヶ月 or 6ヶ月）%0A振込金額: （上記の割引価格）%0A振込完了日: （ご記入ください）" class="btn" style="display: inline-block; background-color: #3b82f6; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: #ffffff !important; padding: 15px 40px; text-decoration: none; border-radius: 8px; font-weight: bold;">
          復帰を申し込む（メールで連絡）
        </a>
      </div>

      <div class="footer">
        <p>NANKANアナリティクス<br>
        Email: nankan-analytics@keiba.link</p>
        <p style="font-size: 0.85rem; color: #94a3b8; margin-top: 15px;">
          ※このメールは有効期限切れ時に自動送信されています
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
  const planInfo = getPlanDiscountInfo(plan);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: monospace; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; background: #f3f4f6; }
    .info-box { background: white; border-left: 4px solid #ef4444; padding: 15px; margin: 10px 0; }
    h2 { color: #1f2937; }
  </style>
</head>
<body>
  <div class="container">
    <h2>🚨 期限切れ通知送信（管理者用）</h2>

    <div class="info-box">
      <p><strong>お名前:</strong> ${fullName}</p>
      <p><strong>メールアドレス:</strong> ${email}</p>
      <p><strong>プラン:</strong> ${plan}</p>
      <p><strong>期限切れ日:</strong> ${expiryDate}</p>
      <p><strong>通知日時:</strong> ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</p>
    </div>

    <h3>送信した割引内容</h3>
    <ul>
      <li>✅ <strong>3ヶ月プラン:</strong> ${planInfo.threeMonthDiscount} (40% OFF) - 1ヶ月あたり ${planInfo.threeMonthPerMonth}</li>
      <li>✅ <strong>6ヶ月プラン:</strong> ${planInfo.sixMonthDiscount} (50% OFF) - 1ヶ月あたり ${planInfo.sixMonthPerMonth}</li>
      <li>✅ <strong>上位プランアップセル:</strong> ${planInfo.upsellPlan || 'なし'} (30% OFF)</li>
    </ul>

    <h3>対応事項</h3>
    <ul>
      <li>✅ お客様に期限切れ通知メール（割引案内付き）を自動送信しました</li>
      <li>✅ Airtableの ExpiryNotificationSent フィールドをTRUEに更新しました</li>
      <li>⚠️ 振込連絡があった場合は、入金確認後 Status を "active" に変更してください</li>
      <li>💡 復帰率を高めるため、数日後にフォローアップをご検討ください</li>
    </ul>

    <p>---<br>
    NANKANアナリティクス 期限管理システム</p>
  </div>
</body>
</html>
  `;
}

// プラン別の割引情報を取得（3ヶ月40%OFF、6ヶ月50%OFF）
function getPlanDiscountInfo(plan) {
  const planPrices = {
    'Standard': { current: 5980, name: 'Standard', upsell: 'Premium' },
    'Premium': { current: 9980, name: 'Premium', upsell: 'Premium Sanrenpuku' },
    'Premium Sanrenpuku': { current: 19820, name: 'Premium Sanrenpuku', upsell: 'Premium Combo' },
    'Premium Combo': { current: 24800, name: 'Premium Combo', upsell: null }
  };

  const planKey = Object.keys(planPrices).find(key => plan.includes(key)) || 'Premium';
  const info = planPrices[planKey];

  // 3ヶ月プラン（40% OFF）
  const threeMonthOriginal = info.current * 3;
  const threeMonthDiscount = Math.round(threeMonthOriginal * 0.6);
  const threeMonthPerMonth = Math.round(threeMonthDiscount / 3);

  // 6ヶ月プラン（50% OFF）
  const sixMonthOriginal = info.current * 6;
  const sixMonthDiscount = Math.round(sixMonthOriginal * 0.5);
  const sixMonthPerMonth = Math.round(sixMonthDiscount / 6);

  // アップセル案内HTML生成
  let upsellHtml = '';
  let upsellPlan = null;
  if (info.upsell) {
    upsellPlan = info.upsell;
    const upsellInfo = planPrices[info.upsell];
    const upsellThreeMonthOriginal = upsellInfo.current * 3;
    const upsellThreeMonthDiscount = Math.round(upsellThreeMonthOriginal * 0.7);
    const upsellSixMonthOriginal = upsellInfo.current * 6;
    const upsellSixMonthDiscount = Math.round(upsellSixMonthOriginal * 0.7);

    upsellHtml = `
      <div class="upsell-card">
        <h3 style="margin: 0 0 15px 0; color: #1e293b;">✨ さらに上のプランはいかがですか？</h3>
        <p style="margin: 0 0 10px 0;"><strong>${info.upsell}会員</strong> にアップグレード（30% OFF）</p>
        <p style="color: #64748b; margin: 0 0 15px 0; font-size: 0.95rem;">
          ${getUpsellDescription(info.upsell)}
        </p>
        <div style="display: flex; gap: 20px; justify-content: center; flex-wrap: wrap;">
          <div style="text-align: center;">
            <p style="margin: 0; font-weight: bold; color: #1e293b;">3ヶ月</p>
            <p style="margin: 5px 0; font-size: 1.3rem; font-weight: bold; color: #10b981;">¥${upsellThreeMonthDiscount.toLocaleString()}</p>
            <p style="margin: 0; font-size: 0.85rem; color: #6b7280;">(通常 ¥${upsellThreeMonthOriginal.toLocaleString()})</p>
          </div>
          <div style="text-align: center;">
            <p style="margin: 0; font-weight: bold; color: #1e293b;">6ヶ月</p>
            <p style="margin: 5px 0; font-size: 1.3rem; font-weight: bold; color: #10b981;">¥${upsellSixMonthDiscount.toLocaleString()}</p>
            <p style="margin: 0; font-size: 0.85rem; color: #6b7280;">(通常 ¥${upsellSixMonthOriginal.toLocaleString()})</p>
          </div>
        </div>
      </div>
    `;
  }

  return {
    threeMonthOriginal: `¥${threeMonthOriginal.toLocaleString()}`,
    threeMonthDiscount: `¥${threeMonthDiscount.toLocaleString()}`,
    threeMonthPerMonth: `¥${threeMonthPerMonth.toLocaleString()}`,
    sixMonthOriginal: `¥${sixMonthOriginal.toLocaleString()}`,
    sixMonthDiscount: `¥${sixMonthDiscount.toLocaleString()}`,
    sixMonthPerMonth: `¥${sixMonthPerMonth.toLocaleString()}`,
    upsellHtml: upsellHtml,
    upsellPlan: upsellPlan
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
