/**
 * マジックリンク検証API（analytics-keiba）
 *
 * - GET /.netlify/functions/verify-magic-link?token=...
 * - AuthTokens テーブルでトークン検証（未使用 / 期限内）
 * - 使用済みフラグを立て、Customers から会員情報を取得
 * - クライアント保存用のセッション JSON を返す
 *   AccessControl が読む localStorage 'user-plan' 形式に整形済み
 *
 * 環境変数:
 *   AIRTABLE_API_KEY / AIRTABLE_BASE_ID    nankan-analytics 側と同じ値
 */

const Airtable = require('airtable');

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Content-Type': 'application/json',
  };
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Airtable env not configured' }) };
  }

  try {
    const { token } = event.queryStringParameters || {};
    if (!token) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Token is required' }) };
    }

    // セキュリティ: token はログに全文出さず先頭8文字のみ表示
    const tokenPrefix = String(token).slice(0, 8);
    const nowIso = new Date().toISOString();
    console.log(`🔐 [verify-magic-link] verify start: tokenPrefix=${tokenPrefix}... now=${nowIso}`);

    const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
    const authTokensTable = base('AuthTokens');
    const customersTable = base('Customers');

    // 1. AuthTokens でトークン検証
    const tokens = await authTokensTable
      .select({ filterByFormula: `{Token} = "${token.replace(/"/g, '\\"')}"`, maxRecords: 1 })
      .firstPage();

    console.log(`🔍 [verify-magic-link] AuthTokens hits: ${tokens.length} (tokenPrefix=${tokenPrefix})`);
    if (tokens.length === 0) {
      console.warn(`❌ [verify-magic-link] Token not found: tokenPrefix=${tokenPrefix}`);
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Token not found' }) };
    }

    const tokenRecord = tokens[0];
    const tokenData = tokenRecord.fields;

    if (tokenData.Used) {
      console.warn(`❌ [verify-magic-link] Token already used: tokenPrefix=${tokenPrefix}, email=${tokenData.Email}`);
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Token already used' }) };
    }
    const expiresAt = new Date(tokenData.ExpiresAt);
    const now = new Date();
    if (now > expiresAt) {
      console.warn(`❌ [verify-magic-link] Token expired: tokenPrefix=${tokenPrefix}, email=${tokenData.Email}, expiresAt=${tokenData.ExpiresAt}, now=${nowIso}`);
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Token expired' }) };
    }

    // 2. トークンを使用済みに更新（再使用防止）
    await authTokensTable.update([
      { id: tokenRecord.id, fields: { Used: true } },
    ]);
    console.log(`✅ [verify-magic-link] Token marked as used: tokenPrefix=${tokenPrefix}`);

    // 3. Customers から会員情報を取得（Email 正規化 + LOWER(TRIM()) 比較）
    const tokenEmail = String(tokenData.Email || '').trim().toLowerCase();
    const escapedTokenEmail = tokenEmail.replace(/'/g, "\\'");
    const customers = await customersTable
      .select({
        filterByFormula: `LOWER(TRIM({Email})) = '${escapedTokenEmail}'`,
        maxRecords: 5  // 重複検出のため複数取得
      })
      .firstPage();

    console.log(`🔍 [verify-magic-link] Customer hits: ${customers.length} (email=${tokenEmail})`);
    if (customers.length > 1) {
      console.warn(`⚠️ [verify-magic-link] 同一 Email で複数 Customer 検出: ${tokenEmail} / recordIds=${customers.map(r => r.id).join(',')}`);
    }
    if (customers.length === 0) {
      console.warn(`❌ [verify-magic-link] Customer not found: email=${tokenEmail}`);
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Customer not found' }) };
    }

    const customer = customers[0].fields;
    const customerRecordId = customers[0].id;
    const planType = customer.PlanType || 'free-registered';
    const venueAccess = customer.VenueAccess || 'all';
    const planExpiresAt = customer.ExpirationDate || customer['有効期限'] || null;
    const lifetimeSanrenpuku = !!(customer.LifetimeSanrenpuku || customer['三連複Lifetime']);
    const currentStatus = customer.Status || null;
    const currentPlan = customer['プラン'] || customer.Plan || null;

    console.log(`👤 [verify-magic-link] Customer found: recordId=${customerRecordId}, email=${tokenEmail}, status=${currentStatus}, plan=${currentPlan}, planType=${planType}`);

    // ─────────────────────────────────────────────
    // 🚨 2026-05-12 重大修正: 認証時の Status / PlanType の上書きを禁止
    // 旧コードは Status='active' を強制更新していたため、入金待ち（Status='pending'）
    // の顧客がログインリンクをクリックすると Airtable Automation が誤発火し、
    // send-payment-confirmation-auto が走って PaymentEmailSent=true になり、
    // 後の正式な「入金確認 → active」での再送信が二重送信防止ガードに阻まれていた。
    //
    // ログイン認証は本人確認の手段でしかなく、決済ステータスを変更するべきではない。
    // よって Status / PlanType / Plan / PaymentEmailSent はここで触らない。
    // ─────────────────────────────────────────────
    console.log(`🔒 [verify-magic-link] Status/PlanType の上書きはスキップ（決済ステータスは保持）: status=${currentStatus}, planType=${planType}`);

    // 4. 既存 AccessControl 互換のセッション JSON を返す
    //    AccessControl は localStorage 'user-plan' を {email, plan, planType, lifetimeSanrenpuku} 形で読む
    const userPlan = {
      email: customer.Email,
      name: customer.Name || customer['お名前'] || '',
      plan: String(planType).toLowerCase(),
      planType: planType,
      planExpiresAt,
      venueAccess,
      lifetimeSanrenpuku,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    // 5. ログイン後リダイレクト先（プラン別）
    const lower = String(planType).toLowerCase();
    let redirectTo = '/free-prediction/nankan/';
    if (['pro', 'pro-plus', 'premium', 'premium-plus', 'standard', 'light'].some(p => lower.includes(p))) {
      redirectTo = venueAccess === 'jra' ? '/premium-prediction/jra/' : '/premium-prediction/nankan/';
    }

    console.log(`✅ [verify-magic-link] 認証成功: email=${tokenEmail}, redirectTo=${redirectTo}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, redirectTo, userPlan }),
    };
  } catch (error) {
    console.error('❌ [verify-magic-link] error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal Server Error', details: error.message }),
    };
  }
};
