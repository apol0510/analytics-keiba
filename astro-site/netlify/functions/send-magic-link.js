/**
 * マジックリンク送信API（analytics-keiba）
 *
 * - Airtable Customers テーブルでメール検証
 * - AuthTokens テーブルに使い捨てトークン保存（15分有効）
 * - SendGrid でログインリンクを送信
 *
 * 参照する Airtable Base は nankan-analytics 側の既存 Base。
 * テーブル: Customers / AuthTokens
 *   AuthTokens がまだ無い場合は Airtable で新規作成すること
 *   （フィールド: Token, Email, CreatedAt, ExpiresAt, Used, Ip_Address, User_Agent）
 *
 * 環境変数:
 *   AIRTABLE_API_KEY        nankan-analytics と同じ値
 *   AIRTABLE_BASE_ID        nankan-analytics と同じ値
 *   SENDGRID_API_KEY        SendGrid 送信キー
 *   SENDGRID_FROM_EMAIL     送信元メール（例: noreply@analytics.keiba.link）
 *   MAGIC_LINK_BASE_URL     マジックリンクのベース（任意、既定 https://analytics.keiba.link）
 */

const { v4: uuidv4 } = require('uuid');
const Airtable = require('airtable');
const sgMail = require('@sendgrid/mail');

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'noreply@analytics.keiba.link';
const SITE_BASE = (process.env.MAGIC_LINK_BASE_URL || 'https://analytics.keiba.link').replace(/\/$/, '');

if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

const ALLOWED_ORIGINS = [
  'https://analytics.keiba.link',
  'https://analytics-keiba.netlify.app',
  'http://localhost:4321',
  'http://localhost:3000',
];

function corsHeaders(event) {
  const origin = event.headers?.origin || '';
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Content-Type': 'application/json',
  };
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Airtable env not configured' }) };
  }
  if (!SENDGRID_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'SendGrid env not configured' }) };
  }

  try {
    const { email } = JSON.parse(event.body || '{}');
    if (!email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email is required' }) };
    }

    const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
    const customersTable = base('Customers');
    const authTokensTable = base('AuthTokens');

    // 1. Customers テーブルで既存ユーザー確認
    const customers = await customersTable
      .select({ filterByFormula: `{Email} = "${email.replace(/"/g, '\\"')}"`, maxRecords: 1 })
      .firstPage();

    if (customers.length === 0) {
      // セキュリティ: 存在しないメールでも 200 を返して enumeration を防ぐ
      console.warn('[send-magic-link] Customer not found:', email);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: '該当するアカウントが存在する場合、ログインリンクを送信しました。',
        }),
      };
    }

    const customer = customers[0].fields;

    // ステータスが明示的に inactive の場合は弾く（active / undefined は OK）
    if (customer.Status && String(customer.Status).toLowerCase() === 'inactive') {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'Account is not active' }),
      };
    }

    // 2. トークン生成 (15分有効)
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await authTokensTable.create([
      {
        fields: {
          Token: token,
          Email: email,
          CreatedAt: new Date().toISOString(),
          ExpiresAt: expiresAt.toISOString(),
          Used: false,
          Ip_Address: event.headers['x-forwarded-for'] || 'unknown',
          User_Agent: event.headers['user-agent'] || 'unknown',
        },
      },
    ]);

    // 3. メール送信
    const magicLink = `${SITE_BASE}/auth/verify?token=${encodeURIComponent(token)}`;
    const customerName = customer.Name || customer['お名前'] || 'お客様';

    await sgMail.send({
      to: email,
      from: FROM_EMAIL,
      subject: '【KEIBA Analytics】ログインリンク',
      html: `
<div style="font-family: 'Noto Sans JP', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f8fafc;">
  <div style="background-color: #ffffff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <h2 style="color: #1e40af; margin-top: 0; font-size: 24px;">ログインリンク</h2>
    <p style="color: #334155; font-size: 16px; line-height: 1.6;">${customerName} 様</p>
    <p style="color: #334155; font-size: 16px; line-height: 1.6;">以下のボタンをクリックしてログインしてください。</p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${magicLink}" style="display: inline-block; background-color: #3b82f6; color: #ffffff !important; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; border: 2px solid #3b82f6;">
        ログインする
      </a>
    </div>
    <div style="background-color: #f1f5f9; border-left: 4px solid #3b82f6; padding: 16px; margin: 24px 0; border-radius: 4px;">
      <p style="color: #475569; font-size: 14px; margin: 0; line-height: 1.6;">ボタンが動作しない場合は、以下のURLをコピーしてブラウザに貼り付けてください。</p>
      <p style="margin: 8px 0 0 0;"><a href="${magicLink}" style="color: #3b82f6; word-break: break-all; font-size: 13px;">${magicLink}</a></p>
    </div>
    <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 16px; margin: 24px 0; border-radius: 4px;">
      <p style="color: #991b1b; font-size: 14px; margin: 0; line-height: 1.6;">⚠️ このリンクは15分間有効です。<br>心当たりがない場合は、このメールを無視してください。</p>
    </div>
    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
    <p style="color: #64748b; font-size: 14px; margin: 0;">KEIBA Analytics チーム</p>
  </div>
</div>
`,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'ログインリンクを送信しました。メールをご確認ください。',
      }),
    };
  } catch (error) {
    console.error('❌ [send-magic-link] error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal Server Error', details: error.message }),
    };
  }
};
