/**
 * admin-canary-payment-email.js — カナリア専用（v2 検証）。
 *
 * テストレコード 1 件だけを worker 本体に通す。通常 worker と分離し、誤って全 pending を
 * 処理しないための独立経路。cutover S6 で「テスト用レコード 1 件」の検証に使う。
 *
 * 安全ガード（fail closed・多重）:
 * - PAYMENT_CANARY_SECRET 未設定 or 不一致なら 403（env 未設定の現状は全 403）
 * - recordId は PAYMENT_EMAIL_CANARY_RECORD_IDS（カンマ区切り allowlist）に含まれる 1 件のみ
 * - allowlist が空なら常に 403（=通常顧客は構造的に指定不可）
 * - **カナリア専用 Base/Table（PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID / _TABLE_ID）のみ**を使い、
 *   本番 Customers へは絶対に fallback しない。未設定なら 503（fail closed）。
 * - 1 回だけ（worker が attempt 上限・lease で多重を抑止）
 */

import { runWorkerOnce } from '../../src/lib/payments/paymentEmailWorker.js';
import { makeCanaryWorkerDeps } from '../../src/lib/payments/paymentEmailDeps.js';

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const secret = process.env.PAYMENT_CANARY_SECRET;
  if (!secret) return json(503, { error: 'canary secret not configured' });
  const provided = event.headers?.['x-canary-secret'] || event.headers?.['X-Canary-Secret'];
  if (provided !== secret) return json(403, { error: 'Forbidden' });

  const allowlist = String(process.env.PAYMENT_EMAIL_CANARY_RECORD_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (allowlist.length === 0) return json(403, { error: 'canary allowlist empty（通常顧客は指定不可）' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const recordId = body.recordId;
  if (!recordId) return json(400, { error: 'recordId required' });
  if (!allowlist.includes(recordId)) return json(403, { error: 'recordId not in canary allowlist', recordId });

  // カナリア専用 Base/Table のみ。未設定なら fail closed（本番 Customers へ触れない）。
  let deps;
  try {
    deps = makeCanaryWorkerDeps();
  } catch {
    return json(503, { error: 'canary airtable target not configured（本番 Customers へは fallback しない）' });
  }

  try {
    const result = await runWorkerOnce({ recordId, now: Date.now(), deps });
    return json(200, { canary: true, ...result });
  } catch (e) {
    console.error('[admin-canary-payment-email] error:', String(e && e.message));
    return json(500, { error: String(e && e.message) });
  }
};
