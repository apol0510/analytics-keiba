/**
 * admin-promote-customer.js — 管理者による手動昇格（v2）。
 *
 * 「Airtable で Status だけ active に変更する」運用を置き換える。同一 PATCH で昇格情報 +
 * pending（送信対象）+ 操作者/理由/日時（監査）を確定する。送信は worker が担う。
 *
 * ロジック本体は src/lib/payments/promotionV2.js（buildManualPromotionFields, テスト済み）。
 *
 * 安全ガード（fail closed）:
 * - PAYMENT_ADMIN_SECRET 未設定 or 不一致なら 403（env 未設定の現状は全 403）
 * - operator 必須（監査）。RequestedPlan が空なら昇格しない（fail closed）
 * - まだ管理画面から未配線。cutover で管理画面を差し替える。
 */

import { buildManualPromotionFields } from '../../src/lib/payments/promotionV2.js';
import { getRecord, patchRecord } from '../../src/lib/payments/paymentEmailDeps.js';

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const secret = process.env.PAYMENT_ADMIN_SECRET;
  if (!secret) return json(503, { error: 'admin secret not configured' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== secret) return json(403, { error: 'Forbidden' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const { recordId, operator, reason } = body;
  if (!recordId) return json(400, { error: 'recordId required' });
  if (!operator) return json(400, { error: 'operator required（監査）' });

  try {
    const rec = await getRecord(recordId);
    if (!rec) return json(404, { error: 'Record not found' });
    const f = rec.fields;

    const promotion = buildManualPromotionFields({
      requestedPlan: f['RequestedPlan'],
      requestedPlanType: f['RequestedPlanType'],
      confirmedAt: new Date(),
      recordId,
      operator,
      reason,
    });
    if (!promotion) {
      return json(422, { error: 'RequestedPlan/PlanType 不足で昇格できない（fail closed）', recordId });
    }

    await patchRecord(recordId, promotion.fields);
    return json(200, { ok: true, recordId, expiration: promotion.expiration, promotedBy: operator });
  } catch (e) {
    console.error('[admin-promote-customer] error:', e);
    return json(500, { error: String(e && e.message) });
  }
};
