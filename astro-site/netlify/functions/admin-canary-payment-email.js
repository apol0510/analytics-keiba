/**
 * admin-canary-payment-email.js — カナリア専用（v2 検証）。
 *
 * テストレコード 1 件だけを worker 本体に通す。通常 worker と分離し、誤って全 pending を
 * 処理しないための独立経路。cutover S6 で「テスト用レコード 1 件」の検証に使う。
 *
 * 安全ガード（fail closed・多重）:
 * - PAYMENT_CANARY_SECRET 未設定 or 不一致なら 403（env 未設定の現状は全 403）
 * - PAYMENT_EMAIL_CANARY_RECORD_IDS は **ちょうど 1 件（exactly one）をコードで強制**。
 *   0 件・2 件以上はいずれも 403（複数許容の includes 判定は廃止）。
 * - リクエストの recordId が **その唯一の許可 ID と完全一致**しない場合のみ通す。403 応答に
 *   呼び出し入力の recordId をエコーしない（識別子を応答・ログへ出さない）。
 * - **カナリア専用 Base/Table（PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID / _TABLE_ID）のみ**を使い、
 *   本番 Customers へは絶対に fallback しない。未設定なら 503（fail closed）。
 * - 1 回だけ（worker が attempt 上限・lease で多重を抑止）
 */

import { runWorkerOnce } from '../../src/lib/payments/paymentEmailWorker.js';
import { makeCanaryWorkerDeps } from '../../src/lib/payments/paymentEmailDeps.js';
import { authorizeCanaryRequest } from '../../src/lib/payments/canaryAuth.js';

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

  // 認可は単一源 authorizeCanaryRequest（secret / allowlist exactly-one / recordId 完全一致）。
  // 拒否理由には recordId・secret・Base/Table を含まない（識別子を応答・ログへ出さない）。
  const authz = authorizeCanaryRequest({
    configuredSecret: process.env.PAYMENT_CANARY_SECRET,
    providedSecret: event.headers?.['x-canary-secret'] || event.headers?.['X-Canary-Secret'],
    allowlistRaw: process.env.PAYMENT_EMAIL_CANARY_RECORD_IDS,
    recordId: body.recordId,
  });
  if (!authz.ok) return json(authz.status, { error: authz.error });
  const recordId = authz.recordId;

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
