import { withLambda } from '@netlify/aws-lambda-compat';
/**
 * stripe-withdraw — 互換の入口（Stripe 月額会員の退会だけを受ける）。
 *
 * 2026-10-15 から退会の入口は member-withdraw に統一（マイページはそちらを呼ぶ）。
 * ここは同じ単一源（memberWithdrawServer.handleWithdrawRequest）で Stripe の月額だけを受ける。
 * POST・ログイン必須（ak_session）・許可オリジンのみ・confirm:true 必須。メールアドレスで本人を決めない。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
installAirtableCallMeter({ source: 'stripe-withdraw' });
import { handleWithdrawRequest } from '../../src/lib/billing/memberWithdrawServer.js';

const __lambdaHandler = async (event) => handleWithdrawRequest(event, process.env, { only: 'stripe' });

export default withLambda(__lambdaHandler);
