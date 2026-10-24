/**
 * internal-paddle-grant — 分離サイト（checkout.tirol.link の Paddle webhook）からの
 * 「検証済み付与指示」を受けて会員へ反映する本番内部エンドポイント。
 *
 * 設計（分離案 B / 2026-10-24 MK 確定）:
 *  - Paddle API による取引検証は分離サイト側（PADDLE_API_KEY は本番 env に置かない＝4KB 回避）。
 *  - 本番側は Airtable/Redis を持つので、検証済みの apply を entitlementLedger へ反映するだけ。
 *  - 認証は CARD_GRANT_INTERNAL_SECRET による HMAC（ts:rawBody）。provider は paddle に限定。
 *  - 冪等性・二重付与防止は entitlementLedger（Redis キー provider+paymentId）がそのまま担保。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'internal-paddle-grant' });
import { rawBody } from '../../src/lib/billing/stripeRuntime.js';
import { applyPaddleGrant } from '../../src/lib/billing/paddle/paddleServer.js';
import { verifyPaddleSignature } from '../../src/lib/billing/paddle/paddleCore.js';
import { makeCardNotifier } from '../../src/lib/billing/cardNotify.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';

const H = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const json = (statusCode, body) => ({ statusCode, headers: H, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  const env = process.env;
  const secret = env.CARD_GRANT_INTERNAL_SECRET;
  if (!secret) return json(503, { error: 'internal_grant_not_configured' });
  const raw = rawBody(event);
  const header = event.headers?.['x-internal-signature'] || event.headers?.['X-Internal-Signature'] || '';
  if (!verifyPaddleSignature({ header, rawBody: raw, secret })) return json(401, { error: 'invalid_signature' });

  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return json(400, { error: 'invalid_json' }); }
  const apply = body?.apply || null;
  const alert = body?.alert || null;
  const mode = body?.mode === 'test' ? 'test' : 'live';
  // 別 provider の指示は受けない（paddle 専用）
  if (apply && apply.provider !== 'paddle') return json(400, { error: 'invalid_provider' });
  if (!apply && !alert) return json(400, { error: 'nothing_to_do' });

  try {
    const notify = makeCardNotifier(env, { mode, provider: 'paddle' });
    if (alert?.reason) await notify('mismatch', { provider: 'paddle', paymentId: apply?.paymentId || body?.paymentId || '', reason: alert.reason });
    if (!apply) return json(200, { result: `alert_${alert.reason}` });
    const r = await applyPaddleGrant({ env, apply, redis: makeRedisCmd(env), notify });
    console.log(JSON.stringify({ event: 'internal_paddle_grant', kind: apply.kind, result: r.result }));
    return r.retry ? json(500, { error: r.result }) : json(200, { result: r.result });
  } catch (e) {
    console.error(JSON.stringify({ event: 'internal_paddle_grant_failed', message: String(e?.message || e).slice(0, 120) }));
    return json(500, { error: 'apply_failed' });
  }
};
