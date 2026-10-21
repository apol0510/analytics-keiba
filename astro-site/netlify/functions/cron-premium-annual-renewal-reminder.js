/**
 * cron-premium-annual-renewal-reminder.js — 銀行振込の Premium 年払い 期限前リマインド（毎日 JST 10:10）
 *
 * 仕様の正本: docs/spec.md「Premium 年払い（銀行振込）期限前リマインド」/ MK 決定 2026-10-21。
 * 判定は `src/lib/marketing/premiumAnnualRenewal/`、送信の流れは Light・Premium 月払いと共通（`runRenewalReminder`）。
 *
 * ゲート: `PREMIUM_ANNUAL_RENEWAL_REMINDER_MODE`（月払いの `PREMIUM_RENEWAL_REMINDER_MODE` とは別）
 *   - 未設定 / off … 何もしない（既定）
 *   - dry-run      … 対象の件数だけログに出す（送信・書き込み 0）
 *   - live         … 送信直前の再判定を通った相手へ送る（1 回 20 通まで）
 * 本文が案内するのは銀行振込の年払い（常に受付中・月額の経路とは無関係）なので、月額の申込経路のゲートは通さない。
 * ⚠️ Light（10:00）・Premium 月払い（10:05）と時刻をずらす。同じ人への横断 24 時間上限は共通の送信前判定が持つ。
 */
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable API の呼び出し回数を Function 別に数える（月 100,000 回の上限管理 / docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'cron-premium-annual-renewal-reminder' });
import { runPremiumAnnualRenewal, resolveMode } from '../../src/lib/marketing/premiumAnnualRenewal/premiumAnnualRenewalRunner.js';
import { makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';

export default async function handler() {
  const mode = resolveMode(process.env);
  let redisCmd = null;
  try { redisCmd = makeRedisCmd(process.env); } catch { redisCmd = null; }
  try {
    const r = await runPremiumAnnualRenewal({ mode, env: process.env, nowMs: Date.now(), redisCmd });
    console.log('[premium-annual-renewal]', JSON.stringify({
      mode: r.mode, today: r.today, candidates: r.candidates, planned: r.planned,
      sent: r.sent, failed: r.failed, excludedByReason: r.excludedByReason, skippedByReason: r.skippedByReason,
    }));
    return new Response(JSON.stringify({ ok: true, mode: r.mode, sent: r.sent }), { status: 200 });
  } catch (e) {
    console.error('[premium-annual-renewal] 中止（1 通も送っていないか、途中まで）:', e && e.code ? e.code : 'error');
    return new Response(JSON.stringify({ ok: false, error: e && e.code ? e.code : 'error' }), { status: 500 });
  }
}

// ⚠️ cron は UTC。`10 1 * * *` = 毎日 JST 10:10（Light 10:00・Premium 月払い 10:05 とずらす）
export const config = { schedule: '10 1 * * *' };
