/**
 * paypal-withdraw — 互換の入口（PayPal 月額会員の退会だけを受ける）。
 *
 * 2026-10-15 から退会の入口は member-withdraw に統一（マイページはそちらを呼ぶ）。
 * ここは同じ単一源（memberWithdrawServer.handleWithdrawRequest）で PayPal の月額だけを受ける。
 * Sandbox の E2E（テストモード・e2e 鍵・+card-e2e レコード）だけはセッションの代わりに e2eRecordId を使える。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'paypal-withdraw' });
import { handleWithdrawRequest } from '../../src/lib/billing/memberWithdrawServer.js';
import { readSessionRecordId, resolveSiteOrigin } from '../../src/lib/billing/stripeRuntime.js';
import { resolvePaypalSubscriptionSettleMode } from '../../src/lib/billing/paypal/paypalSubscriptionServer.js';
import { e2eRecordIdFor } from '../../src/lib/billing/cardE2E.js';

exports.handler = async (event) => {
  const env = process.env;
  const readSession = async (ev, body) => {
    const fromSession = await readSessionRecordId(ev.headers?.cookie || ev.headers?.Cookie || '', env);
    if (fromSession) return fromSession;
    const mode = resolvePaypalSubscriptionSettleMode({ env, origin: resolveSiteOrigin(ev.headers) });
    return mode.ok ? e2eRecordIdFor({ event: ev, env, body, testMode: mode.mode === 'test' }) : null;
  };
  return handleWithdrawRequest(event, env, { only: 'paypal', deps: { readSession } });
};
