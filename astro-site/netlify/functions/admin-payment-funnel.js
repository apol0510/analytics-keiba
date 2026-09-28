/**
 * admin-payment-funnel.js — 決済ファネル（申込受理 → 入金確認）の集計 API（**読み取り専用**）
 *
 *   POST {action:'summary', days?:number}  … 期間内の申込受理・入金確認の件数（商品別・日別）、
 *                                              報告→入金確認の日数分布、いま入金確認待ちの件数と経過日数
 * 認可: x-admin-secret（admin-marketing と同じ secret）または x-funnel-read-secret（自動確認用・この API 専用）。
 *       識別子・アドレスは返さない。
 * 正本: src/lib/payments/paymentFunnel.js
 */
import { readPaymentFunnelSummary } from '../../src/lib/payments/paymentFunnelServer.js';

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  // 自動確認（scheduled-checks）用の読み取り専用の鍵。**この API の集計値を読むことにしか使えない**
  // （強い管理 secret を GitHub へ置かないため）。未設定なら無効。
  const READ_SECRET = process.env.PAYMENT_FUNNEL_READ_SECRET;
  if (!SECRET && !READ_SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  const providedRead = event.headers?.['x-funnel-read-secret'] || event.headers?.['X-Funnel-Read-Secret'];
  const okAdmin = Boolean(SECRET) && provided === SECRET;
  const okRead = Boolean(READ_SECRET) && providedRead === READ_SECRET;
  if (!okAdmin && !okRead) return json(403, { error: 'Forbidden' });
  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  if (req.action !== 'summary') return json(400, { error: 'action は summary' });
  const days = Number.isInteger(req.days) && req.days >= 1 && req.days <= 365 ? req.days : 30;
  try {
    const summary = await readPaymentFunnelSummary({ env: process.env, days, nowMs: Date.now() });
    // Redis 未設定は「0 件」ではない。計測できないことをそのまま返す
    if (!summary) return json(503, { error: 'measurement_unavailable', sideEffects: 'none' });
    return json(200, { ...summary, sideEffects: 'none' });
  } catch (e) {
    return json(500, { error: 'read_failed', sideEffects: 'none' });
  }
};
