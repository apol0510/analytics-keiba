/**
 * member-withdraw — 会員の退会（AK 内の退会操作の唯一の入口・2026-10-15 MK 確定）
 *
 * マイページ「退会する」→ 確認画面 → 「退会を確定する」から呼ぶ。POST・ログイン必須（ak_session）・許可オリジンのみ・confirm:true 必須。
 * 月額（PayPal・Stripe）は購読を即時解約、年払い等は即時に契約由来の権限を停止、買い切りは残す。
 * 応答と判定は src/lib/billing/memberWithdrawServer.js（単一源）。メールアドレスだけでは退会できない。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable API の呼び出し回数を Function 別に数える（月 100,000 回の上限管理 / docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'member-withdraw' });
import { handleWithdrawRequest } from '../../src/lib/billing/memberWithdrawServer.js';

exports.handler = async (event) => handleWithdrawRequest(event, process.env);
