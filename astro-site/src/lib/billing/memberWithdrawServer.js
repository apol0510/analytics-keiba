/**
 * memberWithdrawServer.js — マイページ「退会する」→ 確認 → 確定 の受け口（単一源・2026-10-15 MK 確定）
 *
 * POST（ログイン必須 / ak_session・許可オリジンのみ）{ confirm: true, reason?: string }
 *   → 200 { ok: true, kind }               退会した（契約由来の権限は即時停止・セッション Cookie を消す）
 *   → 400 confirm_required                 確認画面を経ていない
 *   → 401 login_required                   セッションが無い（**メールアドレスでは本人を決めない**）
 *   → 403 forbidden_origin
 *   → 404 record_not_found / not_stripe_subscriber / not_paypal_subscriber
 *   → 409 already_withdrawn（二重退会）/ no_contract（無料会員など止める契約が無い）/ subscription_mismatch
 *   → 502 cancel_failed / stripe_cancel_failed（何も変えていない）/ record_write_failed / withdraw_failed
 *   → 503 busy / not_configured / billing_not_configured
 *
 * 種類の判定は memberWithdrawal.classifyMemberWithdrawal。月額は各社の退会処理（購読を即時解約）へ渡す。
 * 本人のレコード 1 件だけを操作する（セッションの recordId だけ。リクエストの値は使わない）。
 */

import { corsHeaders, readSessionRecordId, isAllowedOrigin, resolveSiteOrigin, getStripe, stripeMode } from './stripeRuntime.js';
import { airtable } from './stripeServer.js';
import { withdrawStripeSubscriber } from './stripeWithdrawal.js';
import { withdrawPaypalSubscriber, resolvePaypalSubscriptionSettleMode } from './paypal/paypalSubscriptionServer.js';
import {
  classifyMemberWithdrawal, withdrawPlainMember, markSessionRevoked, MEMBER_WITHDRAWAL_KIND as KIND,
} from './memberWithdrawal.js';
import { makeRedisCmd } from '../premiumPlus/premiumPlusFunnelServer.js';
import { sendWithdrawalCompleteEmail, sendWithdrawalAdminNotice } from './withdrawalMail.js';

const STATUS = Object.freeze({
  withdrawn: 200,
  already_withdrawn: 409,
  no_contract: 409,
  subscription_mismatch: 409,
  record_not_found: 404,
  not_stripe_subscriber: 404,
  not_paypal_subscriber: 404,
  cancel_failed: 502,
  stripe_cancel_failed: 502,
  record_write_failed: 502,
  busy: 503,
  not_configured: 503,
});

/**
 * @param {object} event Netlify v1 event
 * @param {object} env process.env
 * @param {{ only?: 'stripe'|'paypal'|null, deps?: object }} [opts]
 *   only … 互換の入口（stripe-withdraw / paypal-withdraw）はその種類だけを受ける
 *   deps … テスト用の差し替え口
 */
export async function handleWithdrawRequest(event, env, { only = null, deps = {} } = {}) {
  const headers = corsHeaders(event.headers);
  const reply = (statusCode, body, extra = {}) => ({ statusCode, headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'method_not_allowed' });

  // 他サイトからの送信を受けない
  const reqOrigin = event.headers?.origin || event.headers?.Origin || '';
  if (!isAllowedOrigin(reqOrigin, event.headers?.host || event.headers?.Host || '')) return reply(403, { error: 'forbidden_origin' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }
  // 確認画面を経た送信だけ（ボタン 1 回では確定しない）
  if (body.confirm !== true) return reply(400, { error: 'confirm_required' });
  if (!env.AIRTABLE_API_KEY || !env.AIRTABLE_BASE_ID) return reply(503, { error: 'not_configured' });

  // 本人はセッションだけで決める（メールアドレス・recordId をリクエストから受けない）
  const readSession = deps.readSession || ((ev) => readSessionRecordId(ev.headers?.cookie || ev.headers?.Cookie || '', env));
  const recordId = await readSession(event, body);
  if (!recordId) return reply(401, { error: 'login_required' });

  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;
  const redis = deps.redis !== undefined ? deps.redis : makeRedisCmd(env);
  const now = deps.now || new Date();
  const origin = resolveSiteOrigin(event.headers);

  let record = null;
  try {
    record = deps.readRecord ? await deps.readRecord(recordId) : await airtable(env, deps.fetchImpl).get(recordId);
  } catch (e) {
    if (!/airtable_404/.test(String(e?.message || ''))) {
      console.error(JSON.stringify({ event: 'member_withdraw_read_failed', message: String(e?.message || e).slice(0, 160) }));
      return reply(502, { error: 'withdraw_failed' });
    }
  }
  if (!record) return reply(404, { error: 'record_not_found' });
  const { kind, keeps } = classifyMemberWithdrawal(record.fields || {}, now.getTime());

  if (only && kind !== only && kind !== KIND.ALREADY_WITHDRAWN) {
    return reply(404, { error: only === 'stripe' ? 'not_stripe_subscriber' : 'not_paypal_subscriber' });
  }
  if (kind === KIND.ALREADY_WITHDRAWN) return reply(409, { error: 'already_withdrawn' });
  if (kind === KIND.NONE) return reply(409, { error: 'no_contract' });

  let r;
  try {
    if (kind === KIND.STRIPE) {
      const stripe = deps.stripe || getStripe(env);
      if (!stripe) return reply(503, { error: 'billing_not_configured' });
      r = await (deps.withdrawStripe || withdrawStripeSubscriber)({ stripe, env, recordId, reason, redis, now, fetchImpl: deps.fetchImpl });
    } else if (kind === KIND.PAYPAL) {
      const mode = resolvePaypalSubscriptionSettleMode({ env, origin });
      if (!deps.withdrawPaypal && !mode.ok) return reply(503, { error: 'not_configured' });
      r = await (deps.withdrawPaypal || withdrawPaypalSubscriber)({ env, origin, recordId, reason, redis, now, fetchImpl: deps.fetchImpl });
    } else {
      r = await (deps.withdrawPlain || withdrawPlainMember)({ env, recordId, reason, redis, now, fetchImpl: deps.fetchImpl });
    }
  } catch (e) {
    console.error(JSON.stringify({ event: 'member_withdraw_failed', kind, message: String(e?.message || e).slice(0, 160) }));
    return reply(502, { error: 'withdraw_failed' });
  }
  console.log(JSON.stringify({ event: 'member_withdraw', kind, result: r?.result, cancelled: r?.cancelled === true }));

  const adminNotice = deps.adminNotice || ((d) => sendWithdrawalAdminNotice(env, d));
  if (r?.result === 'record_write_failed') {
    // 月額は購読を止めた後なので、終了の通知が退会状態へ収束させる。管理者へも知らせる
    await adminNotice({ recordId, kind, failed: true, mode: kind === KIND.STRIPE ? stripeMode(env) : null });
  }
  if (!r || !r.ok) return reply(STATUS[r?.result] || 502, { error: r?.result || 'withdraw_failed' });

  // 退会直後のセッション（別の端末・古い Cookie）も有料ページ・API で通さない（paidPageGate が読み直す）
  await markSessionRevoked(redis, recordId, now.getTime());
  // 退会した 1 回だけ（2 回目以降は already_withdrawn で上で返っている）。失敗しても退会は戻さない
  await adminNotice({ recordId, kind });
  await (deps.sendMail || ((email, o) => sendWithdrawalCompleteEmail(env, email, o)))(r.email, { kind, keeps });

  // セッションを消す（以降はログインし直し。退会後も無料会員としてログインできる）
  const { buildLogoutCookie } = await import('../auth/index.js');
  return reply(200, { ok: true, kind }, { 'Set-Cookie': buildLogoutCookie() });
}
