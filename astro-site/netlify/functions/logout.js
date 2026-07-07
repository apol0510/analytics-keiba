/**
 * ログアウトAPI（analytics-keiba / PR-B）
 *
 * POST /.netlify/functions/logout
 *   - 有料セッション Cookie `ak_session` を Max-Age=0・同一属性で削除する。
 *   - Airtable / secret には触れない。SessionVersion 更新は今回不要
 *     （全端末強制失効は SessionVersion 導入後の別運用）。
 *   - クライアント側の旧 localStorage は画面側で消してよいが、
 *     サーバー Cookie 削除（本 Function）を必須とする。
 */

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

  try {
    const { buildLogoutCookie } = await import('../../src/lib/auth/index.js');
    const cookie = buildLogoutCookie();
    return {
      statusCode: 200,
      headers: { ...headers, 'Set-Cookie': cookie },
      body: JSON.stringify({ success: true }),
    };
  } catch (error) {
    console.error('❌ [logout] error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal Server Error' }) };
  }
};
