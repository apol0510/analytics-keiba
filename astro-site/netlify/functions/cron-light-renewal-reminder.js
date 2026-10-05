/**
 * cron-light-renewal-reminder.js — Light 月払い 期限前・失効後リマインド（毎日 JST 10:00）
 *
 * 仕様の正本: docs/spec.md「Light 月払い 期限前・失効後リマインド」/ MK 決定 2026-09-29（1-B）。
 * 判定・送信は `src/lib/marketing/lightRenewal/` が単一源。ここは env を読んで呼ぶだけ。
 *
 * ゲート: `LIGHT_RENEWAL_REMINDER_MODE`
 *   - 未設定 / off … 何もしない（既定）
 *   - dry-run      … 対象の件数だけログに出す（送信・書き込み 0）
 *   - live         … 送信直前の再判定を通った相手へ送る（1 回 20 通まで）
 * ⚠️ 既存の自動化（cron-marketing-automation / cron-expiry-check）のゲートには一切触れない。
 */
import { checkStripeLiveSales, gateModeOnStripeSales } from '../../src/lib/billing/stripeSalesGate.js';
import { installAirtableCallMeter } from '../../src/lib/ops/airtableCallMeter.js';
// Airtable API の呼び出し回数を Function 別に数える（月 100,000 回の上限管理 / docs/AIRTABLE_CAPACITY.md）
installAirtableCallMeter({ source: 'cron-light-renewal-reminder' });
import { runLightRenewal, resolveMode } from '../../src/lib/marketing/lightRenewal/lightRenewalRunner.js';
import { makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';

export default async function handler() {
  // 2026-10-02: 本文は Stripe 月額（Premium ¥4,980 等）を案内する。live 決済が無効な間は送らない（dry-run に落とす）
  const sales = await checkStripeLiveSales(process.env);
  const mode = gateModeOnStripeSales(resolveMode(process.env), sales);
  if (mode !== resolveMode(process.env)) console.log('[light-renewal] Stripe live 決済が無効のため送信しない（dry-run）:', sales.reason);
  let redisCmd = null;
  try { redisCmd = makeRedisCmd(process.env); } catch { redisCmd = null; }
  try {
    const r = await runLightRenewal({ mode, env: process.env, nowMs: Date.now(), redisCmd });
    // 件数と理由だけ（アドレスは載せない）
    console.log('[light-renewal]', JSON.stringify({
      mode: r.mode, today: r.today, candidates: r.candidates, planned: r.planned,
      sent: r.sent, failed: r.failed, excludedByReason: r.excludedByReason, skippedByReason: r.skippedByReason,
    }));
    return new Response(JSON.stringify({ ok: true, mode: r.mode, sent: r.sent }), { status: 200 });
  } catch (e) {
    console.error('[light-renewal] 中止（1 通も送っていないか、途中まで）:', e && e.code ? e.code : 'error');
    return new Response(JSON.stringify({ ok: false, error: e && e.code ? e.code : 'error' }), { status: 500 });
  }
}

// ⚠️ cron は UTC。`0 1 * * *` = 毎日 JST 10:00
export const config = { schedule: '0 1 * * *' };
