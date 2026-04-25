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

    const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
    const authTokensTable = base('AuthTokens');
    const customersTable = base('Customers');

    // 1. AuthTokens でトークン検証
    const tokens = await authTokensTable
      .select({ filterByFormula: `{Token} = "${token.replace(/"/g, '\\"')}"`, maxRecords: 1 })
      .firstPage();

    if (tokens.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Token not found' }) };
    }

    const tokenRecord = tokens[0];
    const tokenData = tokenRecord.fields;

    if (tokenData.Used) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Token already used' }) };
    }
    if (new Date() > new Date(tokenData.ExpiresAt)) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Token expired' }) };
    }

    // 2. トークンを使用済みに更新（再使用防止）
    await authTokensTable.update([
      { id: tokenRecord.id, fields: { Used: true } },
    ]);

    // 3. Customers から会員情報を取得
    const customers = await customersTable
      .select({ filterByFormula: `{Email} = "${String(tokenData.Email).replace(/"/g, '\\"')}"`, maxRecords: 1 })
      .firstPage();

    if (customers.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Customer not found' }) };
    }

    const customer = customers[0].fields;
    const planType = customer.PlanType || 'free-registered';
    const venueAccess = customer.VenueAccess || 'all';
    const planExpiresAt = customer.ExpirationDate || customer['有効期限'] || null;
    const lifetimeSanrenpuku = !!(customer.LifetimeSanrenpuku || customer['三連複Lifetime']);

    // ステータス更新（pending → active）。ただし PlanType は上書きしない
    const updateFields = { Status: 'active', AccessEnabled: true };
    if (!customer.PlanType) updateFields.PlanType = 'free-registered';
    await customersTable.update([{ id: customers[0].id, fields: updateFields }]);

    // 4. 既存 AccessControl 互換のセッション JSON を返す
    //    AccessControl は localStorage 'user-plan' を {email, plan, planType, lifetimeSanrenpuku} 形で読む
    const userPlan = {
      email: customer.Email,
      name: customer.Name || customer['お名前'] || '',
      plan: planType.toLowerCase(),
      planType: planType,
      planExpiresAt,
      venueAccess,
      lifetimeSanrenpuku,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    // 5. ログイン後リダイレクト先（プラン別）
    const lower = planType.toLowerCase();
    let redirectTo = '/free-prediction/nankan/';
    if (['pro', 'pro-plus', 'premium', 'premium-plus', 'standard', 'light'].some(p => lower.includes(p))) {
      redirectTo = venueAccess === 'jra' ? '/premium-prediction/jra/' : '/premium-prediction/nankan/';
    }

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
