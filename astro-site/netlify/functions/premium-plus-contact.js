/**
 * Premium Plusお問い合わせフォーム処理
 * Premium Plus専用のお問い合わせを受け付け、確認メールを送信
 */

import Airtable from 'airtable';
import { SUPPORT_EMAIL, ADMIN_EMAIL, FROM_EMAIL } from './config/email-config.js';
import { buildAdminContactSubject } from '../../src/lib/contact/contactSubject.js';

/**
 * email から Airtable Customers の会員種別（プラン）を引く。fail-open:
 * env 未設定 / 未登録 / エラーは null を返し、問い合わせ送信は止めない（ラベルは formType でフォールバック）。
 */
async function lookupPlanByEmail(email) {
  try {
    if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) return null;
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return null;
    const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
    const escaped = normalized.replace(/'/g, "\\'");
    const records = await base('Customers')
      .select({ filterByFormula: `LOWER(TRIM({Email})) = '${escaped}'`, maxRecords: 1 })
      .firstPage();
    if (!records || records.length === 0) return null;
    const f = records[0].fields || {};
    return f['プラン'] ?? f['Plan'] ?? null;
  } catch (error) {
    console.error('Premium contact plan lookup failed:', (error && error.name) || 'Error');
    return null; // fail-open（問い合わせ自体は継続）
  }
}

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
      name,
      email,
      subject,
      message,
      formType,
      timestamp
    } = formData;

    // 必須項目チェック
    if (!name || !email || !subject || !message) {
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
    // FROM_EMAIL は email-config.js からインポート済み
    // ADMIN_EMAIL は email-config.js からインポート済み

    if (!SENDGRID_API_KEY) {
      throw new Error('SendGrid API key not configured');
    }

    // 会員種別（Airtable プラン）に応じた件名・見出しラベルを決める。
    // plan 取得不可でも formType でフォールバックし、Premium Plus 固定にはしない。
    const plan = await lookupPlanByEmail(email);
    const { heading: memberHeading, adminSubject } = buildAdminContactSubject({ plan, formType, subject, email });

    // 管理者向けメール内容
    const adminEmailData = {
      personalizations: [{
        to: [{ email: ADMIN_EMAIL }],
        subject: adminSubject
      }],
      from: { email: FROM_EMAIL, name: 'KEIBA Analytics サポート' },
      reply_to: { email: email, name: name },  // 🔧 2025-11-26追加: ユーザーへの返信設定
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
    .label { font-weight: bold; color: #475569; display: inline-block; width: 120px; }
    .value { color: #1e293b; }
    .message-box { background: white; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; margin-top: 10px; white-space: pre-wrap; }
    .footer { text-align: center; color: #64748b; font-size: 0.9rem; margin-top: 30px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin: 0;">📧 ${memberHeading}</h2>
      <p style="margin: 10px 0 0 0; font-size: 0.95rem;">新しいお問い合わせが届きました</p>
    </div>

    <div class="section">
      <h3 style="margin-top: 0; color: #1e293b;">📋 お問い合わせ情報</h3>
      <div class="info-row">
        <span class="label">受信日時:</span>
        <span class="value">${japanTime}</span>
      </div>
      <div class="info-row">
        <span class="label">お名前:</span>
        <span class="value">${name}</span>
      </div>
      <div class="info-row">
        <span class="label">メールアドレス:</span>
        <span class="value">${email}</span>
      </div>
      <div class="info-row">
        <span class="label">件名:</span>
        <span class="value">${subject}</span>
      </div>
    </div>

    <div class="section">
      <h3 style="margin-top: 0; color: #1e293b;">💬 お問い合わせ内容</h3>
      <div class="message-box">${message}</div>
    </div>

    <div class="footer">
      <p>KEIBA Analytics 管理システム</p>
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

    // お問い合わせ者向けメール内容
    const userEmailData = {
      personalizations: [{
        to: [{ email: email }],
        subject: '【お問い合わせ受付】KEIBA Analytics'
      }],
      from: { email: FROM_EMAIL, name: 'KEIBA Analytics サポート' },
      reply_to: { email: SUPPORT_EMAIL, name: 'KEIBA Analytics サポート' },  // ユーザー宛メールにも返信先設定（単一源）
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
    .label { font-weight: bold; color: #475569; display: inline-block; width: 120px; }
    .value { color: #1e293b; }
    .message-box { background: white; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0; margin-top: 10px; white-space: pre-wrap; }
    .highlight { background: #dbeafe; padding: 15px; border-radius: 8px; border-left: 4px solid #3b82f6; margin: 20px 0; }
    .footer { text-align: center; color: #64748b; font-size: 0.9rem; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2 style="margin: 0;">✅ お問い合わせありがとうございます</h2>
      <p style="margin: 10px 0 0 0; font-size: 0.95rem;">お問い合わせを受け付けました</p>
    </div>

    <div class="section">
      <h3 style="margin-top: 0; color: #1e293b;">📋 お問い合わせ内容の確認</h3>
      <div class="info-row">
        <span class="label">受付日時:</span>
        <span class="value">${japanTime}</span>
      </div>
      <div class="info-row">
        <span class="label">お名前:</span>
        <span class="value">${name}</span>
      </div>
      <div class="info-row">
        <span class="label">メールアドレス:</span>
        <span class="value">${email}</span>
      </div>
      <div class="info-row">
        <span class="label">件名:</span>
        <span class="value">${subject}</span>
      </div>
      <div style="margin-top: 15px;">
        <span class="label">お問い合わせ内容:</span>
        <div class="message-box">${message}</div>
      </div>
    </div>

    <div class="highlight">
      <h4 style="margin: 0 0 10px 0; color: #1e40af;">📌 今後の流れ</h4>
      <p style="margin: 0;">
        AI開発者が内容を確認の上、<strong>2営業日以内</strong>にご返信いたします。<br>
        お急ぎの場合は、直接 <a href="mailto:${SUPPORT_EMAIL}" style="color: #3b82f6;">${SUPPORT_EMAIL}</a> までご連絡ください。
      </p>
    </div>

    <div class="footer">
      <p><strong>KEIBA Analytics</strong></p>
      <p>AI・機械学習で勝つ。南関競馬の次世代予想プラットフォーム</p>
      <p><a href="https://analytics.keiba.link" style="color: #3b82f6; text-decoration: none;">https://analytics.keiba.link</a></p>
      <p style="font-size:0.9rem;color:#64748b;margin-top:20px;">
        このメールはお問い合わせフォームにご入力いただいた内容の控えとして自動送信されています。<br>
        心当たりがない場合は、このメールを破棄してください。
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

    // SendGrid APIでメール送信（お問い合わせ者向け）
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

    console.log('✅ Premium Plus contact form submitted:', {
      email,
      name,
      subject,
      timestamp: japanTime
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'お問い合わせを受け付けました。確認メールをお送りしましたのでご確認ください。'
      })
    };

  } catch (error) {
    console.error('Premium Plus contact form error:', error);
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
