/**
 * paypal-withdraw — PayPal 月額会員の退会（即時退会・2026-10-07 の月額退会の仕様を PayPal に適用）
 *
 * POST（ログイン必須 / ak_session・許可オリジンのみ）{ confirm: true, reason?: string }
 *   → 200 { ok: true }（有料権限は即時停止・セッション Cookie を消す）
 *   → 400 confirm_required / 401 login_required / 403 forbidden_origin
 *   → 404 not_paypal_subscriber / record_not_found
 *   → 409 already_withdrawn / subscription_mismatch
 *   → 502 cancel_failed（何も変えていない）/ record_write_failed（PayPal は解約済み・解約の通知で収束）
 *   → 503 busy / not_configured
 * 判定と状態遷移は paypalSubscriptionServer.withdrawPaypalSubscriber。メールアドレスだけで呼べる process-withdrawal からは購読を操作しない。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'paypal-withdraw' });
import { corsHeaders, readSessionRecordId, isAllowedOrigin, resolveSiteOrigin } from '../../src/lib/billing/stripeRuntime.js';
import { withdrawPaypalSubscriber, WITHDRAWAL_STATUS, resolvePaypalSubscriptionSettleMode } from '../../src/lib/billing/paypal/paypalSubscriptionServer.js';
import { makeCardNotifier } from '../../src/lib/billing/cardNotify.js';
import { e2eRecordIdFor } from '../../src/lib/billing/cardE2E.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';
import { sendWithdrawalCompleteEmail } from '../../src/lib/billing/withdrawalMail.js';

exports.handler = async (event) => {
  const env = process.env;
  const headers = corsHeaders(event.headers);
  const reply = (statusCode, body, extra = {}) => ({ statusCode, headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method_not_allowed' });
  const reqOrigin = event.headers?.origin || event.headers?.Origin || '';
  if (!isAllowedOrigin(reqOrigin, event.headers?.host || event.headers?.Host || '')) return reply(403, { error: 'forbidden_origin' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  if (body.confirm !== true) return reply(400, { error: 'confirm_required' });
  const origin = resolveSiteOrigin(event.headers);
  const mode = resolvePaypalSubscriptionSettleMode({ env, origin });
  if (!mode.ok || !env.AIRTABLE_API_KEY || !env.AIRTABLE_BASE_ID) return reply(503, { error: 'not_configured' });
  const recordId = await readSessionRecordId(event.headers?.cookie || event.headers?.Cookie || '', env)
    || await e2eRecordIdFor({ event, env, body, testMode: mode.mode === 'test' });
  if (!recordId) return reply(401, { error: 'login_required' });
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
  const notify = makeCardNotifier(env, { mode: mode.mode, provider: 'paypal' });
  let r;
  try {
    r = await withdrawPaypalSubscriber({ env, origin, recordId, reason, redis: makeRedisCmd(env) });
  } catch (e) {
    console.error(JSON.stringify({ event: 'paypal_withdraw_failed', message: String(e?.message || e).slice(0, 160) }));
    return reply(502, { error: 'withdraw_failed' });
  }
  console.log(JSON.stringify({ event: 'paypal_withdraw', result: r.result, cancelled: r.cancelled === true }));
  if (r.result === 'record_write_failed') await notify('subscription_withdraw_write_failed', { recordId });
  if (!r.ok) return reply(WITHDRAWAL_STATUS[r.result] || 502, { error: r.result });
  await notify('subscription_withdrawn', { recordId });
  await sendWithdrawalCompleteEmail(env, r.email);
  const { buildLogoutCookie } = await import('../../src/lib/auth/index.js');
  return reply(200, { ok: true }, { 'Set-Cookie': buildLogoutCookie() });
};
