/**
 * stripe-withdraw — Stripe 月額会員の退会（即時退会・2026-10-07 MK 確定）
 *
 * POST（ログイン必須 / ak_session・許可オリジンのみ）{ confirm: true, reason?: string }
 *   → 200 { ok: true }                       退会した（有料権限は即時停止・セッション Cookie を消す）
 *   → 400 confirm_required                   確認画面を経ていない（confirm !== true）
 *   → 401 login_required
 *   → 403 forbidden_origin
 *   → 404 not_stripe_subscriber / record_not_found
 *   → 409 already_withdrawn / subscription_mismatch
 *   → 502 stripe_cancel_failed（何も変えていない）/ record_write_failed（Stripe は解約済み・自動で収束）
 *   → 503 busy / billing_not_configured
 *
 * 判定と状態遷移は src/lib/billing/stripeWithdrawal.js（単一源）。ここは入口だけ。
 * ⚠️ メールアドレスだけで呼べる process-withdrawal からは購読を操作しない（本人確認がセッションでないため）。
 */

import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable API の呼び出し回数を Function 別に数える（月 100,000 回の上限管理 / docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'stripe-withdraw' });
import {
  getStripe, corsHeaders, readSessionRecordId, isAllowedOrigin, stripeMode,
} from '../../src/lib/billing/stripeRuntime.js';
import { withdrawStripeSubscriber, WITHDRAWAL_RESULT } from '../../src/lib/billing/stripeWithdrawal.js';
import { makeStripeNotifier } from '../../src/lib/billing/stripeNotify.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';
import { sendWithdrawalCompleteEmail } from '../../src/lib/billing/withdrawalMail.js';

const STATUS = {
  [WITHDRAWAL_RESULT.WITHDRAWN]: 200,
  [WITHDRAWAL_RESULT.ALREADY_WITHDRAWN]: 409,
  [WITHDRAWAL_RESULT.SUBSCRIPTION_MISMATCH]: 409,
  [WITHDRAWAL_RESULT.NOT_STRIPE_SUBSCRIBER]: 404,
  [WITHDRAWAL_RESULT.RECORD_NOT_FOUND]: 404,
  [WITHDRAWAL_RESULT.STRIPE_CANCEL_FAILED]: 502,
  [WITHDRAWAL_RESULT.RECORD_WRITE_FAILED]: 502,
  [WITHDRAWAL_RESULT.BUSY]: 503,
};

exports.handler = async (event) => {
  const env = process.env;
  const headers = corsHeaders(event.headers);
  const reply = (statusCode, body, extra = {}) => ({ statusCode, headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method_not_allowed' });

  // 他サイトからの送信を受けない（Cookie は SameSite=Lax だが、同一サイトの別オリジンも弾く）
  const origin = event.headers?.origin || event.headers?.Origin || '';
  if (!isAllowedOrigin(origin)) return reply(403, { error: 'forbidden_origin' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  // 確認画面を経た送信だけ（ボタン 1 回では確定しない）
  if (body.confirm !== true) return reply(400, { error: 'confirm_required' });

  const stripe = getStripe(env);
  if (!stripe || !env.AIRTABLE_API_KEY || !env.AIRTABLE_BASE_ID) return reply(503, { error: 'billing_not_configured' });

  const recordId = await readSessionRecordId(event.headers?.cookie || event.headers?.Cookie || '', env);
  if (!recordId) return reply(401, { error: 'login_required' });

  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
  const notify = makeStripeNotifier(env, { mode: stripeMode(env) });
  let r;
  try {
    r = await withdrawStripeSubscriber({ stripe, env, recordId, reason, redis: makeRedisCmd(env) });
  } catch (e) {
    console.error(JSON.stringify({ event: 'stripe_withdraw_failed', message: String(e?.message || e).slice(0, 160) }));
    return reply(502, { error: 'withdraw_failed' });
  }
  console.log(JSON.stringify({ event: 'stripe_withdraw', result: r.result, cancelled: r.cancelled === true }));

  if (r.result === WITHDRAWAL_RESULT.RECORD_WRITE_FAILED) {
    await notify('conflict', { reason: 'withdrawal_record_write_failed', recordId });
  }
  if (!r.ok) return reply(STATUS[r.result] || 502, { error: r.result });

  // 退会した 1 回だけ通知する（2 回目以降は already_withdrawn で上で返っている）。失敗しても退会は戻さない
  await notify('withdrawn', { recordId });
  await sendWithdrawalCompleteEmail(env, r.email);

  // 有料のセッションを消す（以降の閲覧はログインし直し＝無料扱い）
  const { buildLogoutCookie } = await import('../../src/lib/auth/index.js');
  return reply(200, { ok: true }, { 'Set-Cookie': buildLogoutCookie() });
};
