/**
 * fincode-order-status — 決済完了画面の確認（本人の注文の反映状態だけ）
 * GET ?order=ak-...（ak_session 必須）→ { status: 'pending'|'active'|'refunded'|'needs_support'|'not_found' }
 * ⚠️ success_url への遷移は支払いの証明ではない。反映は Webhook だけが行う。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'fincode-order-status' });
import { corsHeaders, readSessionRecordId } from '../../src/lib/billing/stripeRuntime.js';
import { readCardOrderStatus } from '../../src/lib/billing/fincode/fincodeServer.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';

exports.handler = async (event) => {
  const headers = corsHeaders(event.headers);
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: '{"error":"method_not_allowed"}' };
  const orderId = String(event.queryStringParameters?.order || '');
  if (!/^ak-[a-z-]+-[a-z0-9]+$/i.test(orderId)) return { statusCode: 400, headers, body: '{"error":"invalid_order"}' };
  const recordId = await readSessionRecordId(event.headers?.cookie || event.headers?.Cookie || '', process.env);
  if (!recordId) return { statusCode: 401, headers, body: '{"error":"login_required"}' };
  try {
    const r = await readCardOrderStatus({ redis: makeRedisCmd(process.env), orderId, recordId });
    return { statusCode: 200, headers, body: JSON.stringify(r) };
  } catch {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'unknown' }) };
  }
};
