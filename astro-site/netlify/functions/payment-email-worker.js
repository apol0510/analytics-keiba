/**
 * payment-email-worker.js — 送信 worker の Netlify ラッパー（薄い）。
 *
 * ロジック本体は src/lib/payments/paymentEmailWorker.js（テスト済み）。ここは実 deps 配線のみ。
 *
 * 安全ガード（すべて fail closed）:
 * - gate が v2-worker / v2-full 以外なら 403（未設定の本番＝legacy では絶対に動かない）
 * - PAYMENT_EMAIL_WORKER_SECRET 未設定 or 不一致なら 403（env 未設定の現状は全 403）
 * - まだ何からも呼ばれない（Scheduled/Automation 未配線）。cutover S7 で配線する。
 */

import { runWorkerOnce } from '../../src/lib/payments/paymentEmailWorker.js';
import { parseGatesFromEnv, validateEmailGates } from '../../src/lib/payments/paymentEmailState.js';
import { makeWorkerDeps } from '../../src/lib/payments/paymentEmailDeps.js';

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const secret = process.env.PAYMENT_EMAIL_WORKER_SECRET;
  if (!secret) return json(503, { error: 'worker secret not configured' });
  const provided = event.headers?.['x-worker-secret'] || event.headers?.['X-Worker-Secret'];
  if (provided !== secret) return json(403, { error: 'Forbidden' });

  const gate = validateEmailGates(parseGatesFromEnv(process.env));
  if (!gate.ok || (gate.mode !== 'v2-worker' && gate.mode !== 'v2-full')) {
    return json(403, { error: 'worker disabled', mode: gate.mode, violations: gate.violations });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const recordId = body.recordId;
  if (!recordId) return json(400, { error: 'recordId required' });

  try {
    const result = await runWorkerOnce({ recordId, now: Date.now(), deps: makeWorkerDeps() });
    return json(200, result);
  } catch (e) {
    console.error('[payment-email-worker] error:', e);
    return json(500, { error: String(e && e.message) });
  }
};
