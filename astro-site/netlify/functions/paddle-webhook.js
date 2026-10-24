/**
 * paddle-webhook — Paddle の通知（取引の完了・返金/チャージバック）を受けて会員へ反映する
 *
 * - Paddle-Signature（HMAC-SHA256・`ts:rawBody`）を定数時間で照合し、時刻のずれも見る。不一致は 401。
 * - 通知の中身は信じない。取引・adjustment を Paddle API で照会して確かめてから反映（paddleServer → entitlementLedger）。
 * - 応答: 処理済み・無視は 200。再送させたいとき（Redis 無し・ロック待ち・照会失敗）は 500（Paddle が再送）。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'paddle-webhook' });
import { rawBody } from '../../src/lib/billing/stripeRuntime.js';
import { handlePaddleEvent } from '../../src/lib/billing/paddle/paddleServer.js';
import { verifyPaddleSignature, parsePaddleWebhook, resolvePaddleMode } from '../../src/lib/billing/paddle/paddleCore.js';
import { makeCardNotifier } from '../../src/lib/billing/cardNotify.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';
import { webhookSiteOrigin } from '../../src/lib/billing/neutralCheckoutHost.js';

const H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const OK = { statusCode: 200, headers: H, body: '{"received":true}' };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: H, body: '{"error":"method_not_allowed"}' };
  const env = process.env;
  const raw = rawBody(event);
  const header = event.headers?.['paddle-signature'] || event.headers?.['Paddle-Signature'] || '';
  if (!verifyPaddleSignature({ header, rawBody: raw, secret: env.PADDLE_WEBHOOK_SECRET })) {
    return { statusCode: 401, headers: H, body: '{"error":"invalid_signature"}' };
  }
  const parsed = parsePaddleWebhook(raw);
  if (!parsed || parsed.ignored) return OK;
  // 本番の通知は中立ホスト（checkout.tirol.link/hooks/paddle）経由で届く → 本番サイトとして判定
  const origin = webhookSiteOrigin(event.headers?.host || event.headers?.Host || '');
  const mode = resolvePaddleMode({ key: env.PADDLE_API_KEY, origin });
  try {
    const r = await handlePaddleEvent({
      env, origin, parsed, redis: makeRedisCmd(env),
      notify: makeCardNotifier(env, { mode: mode.ok ? mode.mode : 'test', provider: 'paddle' }),
    });
    console.log(JSON.stringify({ event: 'paddle_webhook', type: parsed.eventType, result: r.result }));
    return r.retry ? { statusCode: 500, headers: H, body: JSON.stringify({ error: r.result }) } : OK;
  } catch (e) {
    console.error(JSON.stringify({ event: 'paddle_webhook_failed', type: parsed.eventType, message: String(e?.message || e).slice(0, 120) }));
    return { statusCode: 500, headers: H, body: '{"error":"apply_failed"}' };
  }
};
