/**
 * payment-email-reconciler.js — Activity reconciler の Netlify ラッパー（薄い）。
 *
 * ロジック本体は src/lib/payments/paymentEmailReconciler.js（テスト済み）。ここは実 deps 配線のみ。
 *
 * dry-run 既定: PAYMENT_EMAIL_RECONCILER_WRITE_ENABLED が真（かつ mode=v2-full）のときだけ書き込む。
 * それ以外は dryRun=true で「何を書くか」だけ返す（S3〜S7 は dry-run）。
 * まだ Scheduled 未配線。cutover S8 で 5 分間隔の Scheduled Function として配線する。
 */

import { reconcileUnknownBatch } from '../../src/lib/payments/paymentEmailReconciler.js';
import { parseGatesFromEnv, validateEmailGates } from '../../src/lib/payments/paymentEmailState.js';
import { makeReconcilerDeps } from '../../src/lib/payments/paymentEmailDeps.js';

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const secret = process.env.PAYMENT_EMAIL_WORKER_SECRET;
  if (!secret) return json(503, { error: 'reconciler secret not configured' });
  const provided = event.headers?.['x-worker-secret'] || event.headers?.['X-Worker-Secret'];
  if (provided !== secret) return json(403, { error: 'Forbidden' });

  const gate = validateEmailGates(parseGatesFromEnv(process.env));
  // flow=v2 でなければ照合対象（v2 の状態）が存在しないので何もしない。
  if (!gate.ok || (gate.mode !== 'v2-dry-run' && gate.mode !== 'v2-worker' && gate.mode !== 'v2-full')) {
    return json(403, { error: 'reconciler disabled', mode: gate.mode, violations: gate.violations });
  }
  // 書き込みは reconcilerWrite が真（=v2-full）のときだけ。それ以外は dry-run。
  const dryRun = gate.mode !== 'v2-full';

  try {
    const result = await reconcileUnknownBatch({ now: Date.now(), dryRun, deps: makeReconcilerDeps() });
    return json(200, { dryRun, ...result });
  } catch (e) {
    console.error('[payment-email-reconciler] error:', e);
    return json(500, { error: String(e && e.message) });
  }
};
