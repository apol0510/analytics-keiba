/**
 * fincode-webhook — fincode の通知（決済の確定・取消）を受けて会員へ反映する
 *
 * - Fincode-Signature（登録した固定文字列）を定数時間で照合。不一致は 401。
 * - 通知の中身は信じない。order_id で fincode API を照会し、金額・会員・商品・状態を確かめてから反映（fincodeServer）。
 * - 応答: 処理済み・無視は 200 {"receive":"0"}。再送させたいとき（Redis 無し・ロック待ち・照会失敗）は 500。
 *   fincode は 3 秒以内に "0" が返らないと最大 5 回再送する。反映は注文ごとに冪等。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'fincode-webhook' });
import { rawBody } from '../../src/lib/billing/stripeRuntime.js';
import { handleFincodeEvent } from '../../src/lib/billing/fincode/fincodeServer.js';
import { verifyWebhookSignature, parseWebhook, resolveFincodeMode } from '../../src/lib/billing/fincode/fincodeCore.js';
import { makeFincodeNotifier } from '../../src/lib/billing/fincode/fincodeNotify.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';

const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const OK = { statusCode: 200, headers: H, body: JSON.stringify({ receive: '0' }) };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: '{"error":"method_not_allowed"}' };
  const env = process.env;
  const sig = event.headers?.['fincode-signature'] || event.headers?.['Fincode-Signature'] || '';
  if (!verifyWebhookSignature(sig, env.FINCODE_WEBHOOK_SIGNATURE)) return { statusCode: 401, headers: H, body: '{"error":"invalid_signature"}' };
  const parsed = parseWebhook(rawBody(event));
  if (!parsed) return OK; // 対象外の形式は受け取って捨てる（再送させない）
  const host = String(event.headers?.host || event.headers?.Host || '');
  const origin = `https://${host}`;
  const mode = resolveFincodeMode({ key: env.FINCODE_SECRET_KEY, origin });
  try {
    const r = await handleFincodeEvent({
      env, origin, event: parsed.event, orderId: parsed.orderId,
      redis: makeRedisCmd(env),
      notify: makeFincodeNotifier(env, { mode: mode.ok ? mode.mode : 'test' }),
    });
    console.log(JSON.stringify({ event: 'fincode_webhook', type: parsed.event, result: r.result }));
    return r.retry ? { statusCode: 500, headers: H, body: JSON.stringify({ error: r.result }) } : OK;
  } catch (e) {
    console.error(JSON.stringify({ event: 'fincode_webhook_failed', type: parsed.event, message: String(e?.message || e).slice(0, 120) }));
    return { statusCode: 500, headers: H, body: '{"error":"apply_failed"}' };
  }
};
