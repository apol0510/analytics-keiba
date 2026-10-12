/**
 * fincode-create-session — カード決済（fincode・リダイレクト型）の決済画面を作る
 *
 * POST { product: 'premium-annual'|'premium-annual-light'|'premium-lifetime' }（ak_session 必須）
 *   → 200 { url }     fincode の決済画面へ
 *   → 400 invalid_product / 401 login_required
 *   → 409 already_lifetime / stripe_subscription_active / not_eligible（二重課金・資格なしを作らない）
 *   → 503 card_sales_not_open / test_key_on_production / live_key_outside_production / fincode_key_missing
 *
 * 2026-10-11 MK 確定: 本番サイトでは CARD_SALES_OPEN（コード）が true になるまで受け付けない。
 * Deploy Preview はテストキーだけ。E2E 用の経路（テストモード限定・専用秘密・+fincode-e2e のレコードだけ）は下記。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'fincode-create-session' });
import { corsHeaders, resolveSiteOrigin, readSessionRecordId, isAllowedOrigin } from '../../src/lib/billing/stripeRuntime.js';
import { createCardSession } from '../../src/lib/billing/fincode/fincodeServer.js';
import { resolveFincodeMode, verifyWebhookSignature } from '../../src/lib/billing/fincode/fincodeCore.js';
import { airtable } from '../../src/lib/billing/stripeServer.js';

const json = (statusCode, headers, body) => ({ statusCode, headers, body: JSON.stringify(body) });

/** E2E（テストモードだけ）: 専用秘密が一致し、対象レコードのメールが +fincode-e2e のときだけ recordId を受け取る */
async function e2eRecordId(event, env, origin, body) {
  const mode = resolveFincodeMode({ key: env.FINCODE_SECRET_KEY, origin });
  if (!mode.ok || mode.mode !== 'test') return null;
  const secret = env.FINCODE_E2E_SECRET || '';
  const got = event.headers?.['x-ak-e2e-secret'] || '';
  if (secret.length < 24 || !verifyWebhookSignature(got, secret)) return null;
  const id = String(body.e2eRecordId || '');
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) return null;
  try {
    const rec = await airtable(env).get(id);
    return /\+fincode-e2e[^@]*@/i.test(String(rec?.fields?.Email || '')) ? id : null;
  } catch { return null; }
}

exports.handler = async (event) => {
  const env = process.env;
  const headers = corsHeaders(event.headers);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return json(405, headers, { error: 'method_not_allowed' });
  const reqOrigin = event.headers?.origin || event.headers?.Origin || '';
  if (reqOrigin && !isAllowedOrigin(reqOrigin, event.headers?.host || event.headers?.Host || '')) return json(403, headers, { error: 'forbidden_origin' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, headers, { error: 'invalid_json' }); }
  const origin = resolveSiteOrigin(event.headers);
  try {
    const recordId = await readSessionRecordId(event.headers?.cookie || event.headers?.Cookie || '', env)
      || await e2eRecordId(event, env, origin, body);
    const r = await createCardSession({ env, origin, recordId, productId: String(body.product || '') });
    if (!r.ok) return json(r.status, headers, { error: r.code });
    console.log(JSON.stringify({ event: 'fincode_session_created', product: String(body.product || '') }));
    return json(200, headers, { url: r.url, order: r.orderId });
  } catch (e) {
    console.error(JSON.stringify({ event: 'fincode_session_failed', message: String(e?.message || e).slice(0, 120) }));
    return json(502, headers, { error: 'session_failed' });
  }
};
