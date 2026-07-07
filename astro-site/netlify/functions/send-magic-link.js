/**
 * マジックリンク送信API（analytics-keiba / PR-B: 有料会員のみ対象）
 *
 * - Airtable Customers でメール検証 → 会員判定（resolveMembership）
 * - **paid の場合だけ** AuthTokens に使い捨てトークンを作成し SendGrid で送信
 * - free / denied / 未登録 は送らず、常に一定の 200 応答（会員情報を列挙しない）
 * - token は uuid v4・15分有効・単回使用（従来どおり）
 *
 * テーブル: Customers / AuthTokens（Token, Email, CreatedAt, ExpiresAt, Used, Ip_Address, User_Agent）
 * 環境変数: AIRTABLE_API_KEY / AIRTABLE_BASE_ID / SENDGRID_API_KEY / SENDGRID_FROM_EMAIL / MAGIC_LINK_BASE_URL
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

// free / denied / 未登録 で返す共通応答（会員の有無・種別を漏らさない）
function genericOk(headers) {
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      message: '有料会員のアカウントが存在する場合、ログインリンクを送信しました。',
    }),
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
    const { email: rawEmail } = JSON.parse(event.body || '{}');
    if (!rawEmail) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email is required' }) };
    }
    const email = String(rawEmail).trim().toLowerCase();

    const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
    const customersTable = base('Customers');
    const authTokensTable = base('AuthTokens');

    const escapedEmail = email.replace(/'/g, "\\'");
    const customers = await customersTable
      .select({ filterByFormula: `LOWER(TRIM({Email})) = '${escapedEmail}'`, maxRecords: 5 })
      .firstPage();

    if (customers.length === 0) {
      console.warn(`[send-magic-link] Customer not found (generic 200): email=${email}`);
      return genericOk(headers);
    }

    // 会員判定: paid だけ送信対象（free / denied には送らない）
    const record = customers[0];
    const { resolveMembership, shouldSendMagicLink } = await import('../../src/lib/auth/index.js');
    const membership = resolveMembership({ fields: record.fields, recordId: record.id, now: Date.now() });
    if (!shouldSendMagicLink(membership)) {
      console.log(`[send-magic-link] not paid → 送信しない (generic 200): reason=${membership.reason}`);
      return genericOk(headers);
    }

    // トークン生成 (15分有効・単回使用)
    const token = uuidv4();
    const tokenPrefix = token.slice(0, 8);
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
    console.log(`🎫 [send-magic-link] Token issued (paid): tokenPrefix=${tokenPrefix}, email=${email}`);

    const magicLink = `${SITE_BASE}/auth/verify?token=${encodeURIComponent(token)}`;
    const customerName = record.fields.Name || record.fields['お名前'] || 'お客様';

    try {
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
      console.log(`✅ [send-magic-link] SendGrid 送信成功: email=${email}, tokenPrefix=${tokenPrefix}`);
    } catch (sgError) {
      const errorDetails = sgError?.response?.body || sgError?.message || String(sgError);
      console.error(`❌ [send-magic-link] SendGrid 送信失敗: email=${email}, error=`, errorDetails);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Failed to send login email' }),
      };
    }

    return genericOk(headers);
  } catch (error) {
    console.error('❌ [send-magic-link] error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal Server Error' }) };
  }
};
