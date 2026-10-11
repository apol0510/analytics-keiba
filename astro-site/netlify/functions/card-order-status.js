/**
 * card-order-status — 決済完了画面の確認（決済会社共通・本人の決済の反映状態だけ）
 * GET ?provider=paddle|paypal|fincode&order=…（ak_session 必須）
 *   → { status: 'pending'|'active'|'refunded'|'needs_support'|'not_found'|'unknown' }
 * ⚠️ 戻り先への遷移は支払いの証明ではない。反映は各 Webhook（と PayPal の capture）だけが API 照会のうえ行う。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'card-order-status' });
import { corsHeaders, readSessionRecordId } from '../../src/lib/billing/stripeRuntime.js';
import { readCardOrderStatus } from '../../src/lib/billing/entitlementLedger.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';

const ORDER_RE = { fincode: /^ak-[a-z-]+-[a-z0-9]+$/i, paddle: /^txn_[a-z0-9]{10,40}$/, paypal: /^[A-Z0-9]{10,24}$/ };

exports.handler = async (event) => {
  const headers = corsHeaders(event.headers);
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: '{"error":"method_not_allowed"}' };
  const provider = String(event.queryStringParameters?.provider || 'fincode');
  const order = String(event.queryStringParameters?.order || '');
  if (!ORDER_RE[provider] || !ORDER_RE[provider].test(order)) return { statusCode: 400, headers, body: '{"error":"invalid_order"}' };
  const recordId = await readSessionRecordId(event.headers?.cookie || event.headers?.Cookie || '', process.env);
  if (!recordId) return { statusCode: 401, headers, body: '{"error":"login_required"}' };
  try {
    const r = await readCardOrderStatus({ redis: makeRedisCmd(process.env), provider, paymentId: order, recordId });
    return { statusCode: 200, headers, body: JSON.stringify(r) };
  } catch {
    return { statusCode: 200, headers, body: JSON.stringify({ status: 'unknown' }) };
  }
};
