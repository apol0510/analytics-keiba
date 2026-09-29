/**
 * admin-payment-funnel.js — 決済ファネル（申込受理 → 入金確認）の集計 API（**読み取り専用**）
 *
 *   POST {action:'plusOfferOutcome'}                 … Plus 案内メールの成果（送信→開封→到達→注文→購入・件数のみ）
 *   POST {action:'plusOrdersSummary'}                … Premium Plus 注文と新系列の購入の突き合わせ（件数のみ）
 *   POST {action:'summary', days?:number}  … 期間内の申込受理・入金確認の件数（商品別・日別）、
 *                                              報告→入金確認の日数分布、いま入金確認待ちの件数と経過日数
 * 認可: x-admin-secret（admin-marketing と同じ secret）または x-funnel-read-secret（自動確認用・この API 専用）。
 *       識別子・アドレスは返さない。
 * 正本: src/lib/payments/paymentFunnel.js
 */
import { readPaymentFunnelSummary } from '../../src/lib/payments/paymentFunnelServer.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';
import { createOrderStore } from '../../src/lib/premiumPlus/premiumPlusOrderService.js';
import { FUNNEL_KEY } from '../../src/lib/premiumPlus/premiumPlusFunnelStore.js';
import { summarizePlusOrders } from '../../src/lib/premiumPlus/premiumPlusOrderMonitor.js';
import { summarizeOfferOutcome } from '../../src/lib/premiumPlus/premiumPlusOfferOutcome.js';
import { createFunnelStore } from '../../src/lib/premiumPlus/premiumPlusFunnelStore.js';
import { createDeliveryEventIndex } from '../../src/lib/webhooks/deliveryEventIndex.js';

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
  // Premium Plus 注文の監視用（件数だけ・識別子なし・読み取りのみ）
  if (req.action === 'plusOrdersSummary') {
    const cmd = makeRedisCmd(process.env);
    if (!cmd) return json(503, { error: 'measurement_unavailable', sideEffects: 'none' });
    try {
      const orders = await createOrderStore({ redisCmd: cmd }).list();
      const raw = (await cmd(['HGETALL', FUNNEL_KEY.PURCHASE])) || [];
      const purchaseRows = [];
      for (let i = 0; i + 1 < raw.length; i += 2) {
        try { purchaseRows.push([raw[i], JSON.parse(raw[i + 1])]); } catch { purchaseRows.push([raw[i], null]); }
      }
      return json(200, { ...summarizePlusOrders({ orders, purchaseRows, nowMs: Date.now() }), sideEffects: 'none' });
    } catch {
      return json(500, { error: 'read_failed', sideEffects: 'none' });
    }
  }
  // Premium Plus 案内メール（premium-plus-offer）の成果: 送信→配信→開封→到達→注文→購入（件数だけ）
  if (req.action === 'plusOfferOutcome') {
    const cmd = makeRedisCmd(process.env);
    const KEY = process.env.AIRTABLE_API_KEY; const BASE = process.env.AIRTABLE_BASE_ID;
    if (!cmd || !KEY || !BASE) return json(503, { error: 'measurement_unavailable', sideEffects: 'none' });
    try {
      const deliveries = [];
      let offset;
      let pages = 0;
      do {
        const q = new URLSearchParams({ filterByFormula: "FIND('premium-plus-offer:',{CampaignType}&'')=1", pageSize: '100' });
        for (const f of ['Status', 'SentAt', 'CustomerRecordId', 'DeliveryKey']) q.append('fields[]', f);
        if (offset) q.set('offset', offset);
        const res = await fetch(`https://api.airtable.com/v0/${BASE}/CampaignDeliveries?${q}`, { headers: { Authorization: `Bearer ${KEY}` } });
        if (!res.ok) return json(503, { error: 'deliveries_unreadable', sideEffects: 'none' });
        const data = await res.json();
        for (const r of data.records || []) deliveries.push(r.fields || {});
        offset = data.offset;
        pages += 1;
        if (pages > 20) return json(503, { error: 'deliveries_too_many', sideEffects: 'none' });
      } while (offset);
      const idx = await createDeliveryEventIndex({ cmd }).read(deliveries.map((d) => d.DeliveryKey).filter(Boolean));
      const fr = await createFunnelStore({ redisCmd: cmd }).readMany({ recordIds: deliveries.map((d) => d.CustomerRecordId) });
      const orders = await createOrderStore({ redisCmd: cmd }).list();
      return json(200, {
        ...summarizeOfferOutcome({
          deliveries, events: idx.ok ? idx.byKey : null, funnel: fr.available ? fr.rows : null, orders,
        }),
        sideEffects: 'none',
      });
    } catch {
      return json(500, { error: 'read_failed', sideEffects: 'none' });
    }
  }
  if (req.action !== 'summary') return json(400, { error: 'action は summary / plusOrdersSummary / plusOfferOutcome' });
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
