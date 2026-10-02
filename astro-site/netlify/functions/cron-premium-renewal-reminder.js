/**
 * cron-premium-renewal-reminder.js — Premium 月払い 期限前・失効後リマインド（毎日 JST 10:05）
 *
 * 仕様の正本: docs/spec.md「Premium 月払い 期限前・失効後リマインド」/ MK 決定 2026-09-29（①）。
 * 判定は `src/lib/marketing/premiumRenewal/`、送信の流れは Light と共通（`runRenewalReminder`）。
 *
 * ゲート: `PREMIUM_RENEWAL_REMINDER_MODE`（Light の `LIGHT_RENEWAL_REMINDER_MODE` とは別）
 *   - 未設定 / off … 何もしない（既定）
 *   - dry-run      … 対象の件数だけログに出す（送信・書き込み 0）
 *   - live         … 送信直前の再判定を通った相手へ送る（1 回 20 通まで）
 * ⚠️ Light のリマインド（10:00）と時刻をずらす。同じ人への横断 24 時間上限は共通の送信前判定が持つ。
 */
import { checkStripeLiveSales, gateModeOnStripeSales } from '../../src/lib/billing/stripeSalesGate.js';
import { runPremiumRenewal, resolveMode } from '../../src/lib/marketing/premiumRenewal/premiumRenewalRunner.js';
import { makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';

export default async function handler() {
  // 2026-10-02: 本文は Stripe 月額（Premium ¥4,980 等）を案内する。live 決済が無効な間は送らない（dry-run に落とす）
  const sales = await checkStripeLiveSales(process.env);
  const mode = gateModeOnStripeSales(resolveMode(process.env), sales);
  if (mode !== resolveMode(process.env)) console.log('[premium-renewal] Stripe live 決済が無効のため送信しない（dry-run）:', sales.reason);
  let redisCmd = null;
  try { redisCmd = makeRedisCmd(process.env); } catch { redisCmd = null; }
  try {
    const r = await runPremiumRenewal({ mode, env: process.env, nowMs: Date.now(), redisCmd });
    console.log('[premium-renewal]', JSON.stringify({
      mode: r.mode, today: r.today, candidates: r.candidates, planned: r.planned,
      sent: r.sent, failed: r.failed, excludedByReason: r.excludedByReason, skippedByReason: r.skippedByReason,
    }));
    return new Response(JSON.stringify({ ok: true, mode: r.mode, sent: r.sent }), { status: 200 });
  } catch (e) {
    console.error('[premium-renewal] 中止（1 通も送っていないか、途中まで）:', e && e.code ? e.code : 'error');
    return new Response(JSON.stringify({ ok: false, error: e && e.code ? e.code : 'error' }), { status: 500 });
  }
}

// ⚠️ cron は UTC。`5 1 * * *` = 毎日 JST 10:05（Light の 10:00 とずらす）
export const config = { schedule: '5 1 * * *' };
