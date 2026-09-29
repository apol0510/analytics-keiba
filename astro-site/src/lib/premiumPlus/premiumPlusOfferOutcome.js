/**
 * premiumPlusOfferOutcome.js — Premium Plus 案内メールの成果（純粋・件数だけ・識別子を返さない）
 *
 * 2026-09-29 に購入可能な会員へ `premium-plus-offer` を送った（MK 決定）。
 * 送信 → 配信 → 開封 → Plus ページ到達 → 決済開始（振込報告）→ 注文 → 入金確認 → 新系列の購入 を
 * **送信後に起きたか**で数える（click 計測は無いので「メール経由」とは断定しない＝相関）。
 *
 * 入力は呼び出し側が読んだもの:
 *   deliveries … CampaignDeliveries の配信行（Status / SentAt / CustomerRecordId / DeliveryKey）
 *   events     … 配信ごとのイベント索引（DeliveryKey → { deliveredAtMs, firstOpenAtMs }）。読めなければ null
 *   funnel     … Plus ファネル（recordId → { page, checkout, purchase }）。読めなければ null
 *   orders     … Plus 注文台帳（全件。テスト注文は除く）
 */
import { ORDER_STATUS, METRIC_STATE } from './premiumPlusOrders.js';

const after = (cell, sentAtMs) => Boolean(cell && Number(cell.lastAtMs) >= sentAtMs);

export function summarizeOfferOutcome({ deliveries, events, funnel, orders }) {
  const sent = (deliveries || []).filter((d) => String(d.Status || '').toLowerCase() === 'sent' && d.SentAt);
  const people = new Map(); // recordId → 最初の送信時刻
  for (const d of sent) {
    const t = Date.parse(d.SentAt);
    const rid = String(d.CustomerRecordId || '');
    if (!rid || !Number.isFinite(t)) continue;
    if (!people.has(rid) || t < people.get(rid)) people.set(rid, t);
  }
  let delivered = null; let opened = null;
  if (events) {
    delivered = 0; opened = 0;
    for (const d of sent) {
      const e = events.get(d.DeliveryKey);
      if (e && Number.isFinite(e.deliveredAtMs)) delivered += 1;
      if (e && Number.isFinite(e.firstOpenAtMs)) opened += 1;
    }
  }
  let reached = null; let checkout = null; let purchasedS2 = null;
  if (funnel) {
    reached = 0; checkout = 0; purchasedS2 = 0;
    for (const [rid, t] of people) {
      const row = funnel.get(rid) || {};
      if (after(row.page, t)) reached += 1;
      if (after(row.checkout, t)) checkout += 1;
      if (after(row.purchase, t)) purchasedS2 += 1;
    }
  }
  const real = (orders || []).filter((o) => o && o.canary !== true && people.has(o.recordId)
    && Number(o.receivedAt) >= people.get(o.recordId));
  return {
    recipients: people.size,
    sent: sent.length,
    delivered,               // null = 計測を読めない（0 ではない）
    opened,
    reachedPlusPage: reached,
    checkoutStarted: checkout,
    orders: real.length,
    ordersConfirmed: real.filter((o) => o.status === ORDER_STATUS.CONFIRMED && o.metricState === METRIC_STATE.COUNTED).length,
    purchasedNewSeries: purchasedS2,
    attribution: 'correlated',
    note: '送信後に起きたかで数えています（click 計測が無いため「メール経由」とは断定しません）。',
  };
}
