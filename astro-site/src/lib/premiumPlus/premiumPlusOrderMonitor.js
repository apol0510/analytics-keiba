/**
 * premiumPlusOrderMonitor.js — Plus 注文と新系列の購入の突き合わせ（純粋・識別子を外へ出さない）
 *
 * 2026-09-29: 販売再開後の最初の本物の注文を**人の記憶に頼らず**確認するための集計。
 *   - 監視（毎時・`premium-plus-order-monitor.yml`）: 未確認・要修復・不一致があれば Issue で知らせる
 *   - 自動確認（scheduled-checks `premium-plus-first-order-2026`）: 最初の本物の注文が
 *     入金確認後に新系列へちょうど 1 件入ったことを確かめて完了にする
 *
 * 返すのは件数と「どの種類の不一致か」だけ。recordId・注文 ID・メールは返さない。
 */
import { ORDER_STATUS, METRIC_STATE, COUPON_STATE, purchaseOrderKey } from './premiumPlusOrders.js';

const HOUR = 3600000;

/**
 * @param {{ orders: object[], purchaseRows: Array<[string, object]>, nowMs: number }} input
 *   purchaseRows: 新系列（…:purchase:s2）の [recordId, 記録] の配列
 */
export function summarizePlusOrders({ orders, purchaseRows, nowMs }) {
  const real = (orders || []).filter((o) => o && o.canary !== true);
  const canary = (orders || []).filter((o) => o && o.canary === true);
  const count = (list, st) => list.filter((o) => o.status === st).length;
  const awaiting = real.filter((o) => o.status === ORDER_STATUS.AWAITING);
  const needsRepair = real.filter((o) => o.couponState === COUPON_STATE.NEEDS_REPAIR
    || (o.status === ORDER_STATUS.CONFIRMED && o.metricState !== METRIC_STATE.COUNTED)
    || (o.status === ORDER_STATUS.REVOKED && o.metricState !== METRIC_STATE.REMOVED)).length;

  // 期待される購入（注文側）: 確認済みで計上済みの注文ごとに 1 件（テスト注文も計上中なら含める）
  const expected = new Set((orders || [])
    .filter((o) => o && o.status === ORDER_STATUS.CONFIRMED && o.metricState === METRIC_STATE.COUNTED)
    .map(purchaseOrderKey));
  // 実際の購入（計測側）: 新系列に記録された注文キーと件数
  const actualKeys = [];
  let actualCountSum = 0;
  for (const [, rec] of purchaseRows || []) {
    const keys = Object.keys((rec && rec.orders) || {});
    actualKeys.push(...keys);
    actualCountSum += Number(rec && rec.count) || 0;
  }
  const actual = new Set(actualKeys);
  const missing = [...expected].filter((k) => !actual.has(k)).length;       // 確定したのに計上されていない
  const unexpected = [...actual].filter((k) => !expected.has(k)).length;    // 注文に無い計上（混入・取消漏れ）
  const duplicated = actualCountSum !== actual.size || actualKeys.length !== actual.size; // 同じ注文を 2 回以上

  const oldestAwaitingMs = awaiting.length
    ? Math.min(...awaiting.map((o) => Number(o.receivedAt) || nowMs)) : null;
  return {
    real: {
      total: real.length,
      awaiting: awaiting.length,
      confirmed: count(real, ORDER_STATUS.CONFIRMED),
      cancelled: count(real, ORDER_STATUS.CANCELLED),
      revoked: count(real, ORDER_STATUS.REVOKED),
      needsRepair,
      oldestAwaitingHours: oldestAwaitingMs === null ? null : Math.floor((nowMs - oldestAwaitingMs) / HOUR),
    },
    canaryOrders: canary.length,
    purchase: { expected: expected.size, recorded: actual.size, countSum: actualCountSum, missing, unexpected, duplicated },
    consistent: missing === 0 && unexpected === 0 && !duplicated,
  };
}

/**
 * 運営者が対応すべきことの一覧（空なら対応不要）。監視 Issue の本文と開閉に使う。
 */
export function operatorActions(summary) {
  const out = [];
  const r = summary.real;
  if (r.awaiting > 0) {
    out.push({ key: 'awaiting', text: `未確認の Plus 注文が ${r.awaiting} 件（最も古いもので受付から約 ${r.oldestAwaitingHours} 時間）。入金を確認したら Plus 管理画面「🧾 Premium Plus 注文」で「入金確認」、未入金なら「取消」。` });
  }
  if (r.needsRepair > 0) {
    out.push({ key: 'needs_repair', text: `要修復の注文が ${r.needsRepair} 件。Plus 管理画面で「修復」を押す（未完了の処理だけやり直す・二重には数えない）。` });
  }
  const p = summary.purchase;
  if (!summary.consistent) {
    out.push({ key: 'mismatch', text: `注文と購入件数が一致しません（計上漏れ ${p.missing} / 注文に無い計上 ${p.unexpected} / 二重計上 ${p.duplicated ? 'あり' : 'なし'}）。Claude が調査する。` });
  }
  if (summary.canaryOrders > 0) {
    out.push({ key: 'canary', text: `テスト注文が ${summary.canaryOrders} 件残っています（実操作確認の後片付け漏れ）。` });
  }
  return out;
}

/** Issue を更新すべき変化か（同じ状態なら通知を増やさない） */
export function actionsFingerprint(summary) {
  const r = summary.real;
  return [r.awaiting, r.needsRepair, summary.consistent ? 'ok' : 'ng', summary.canaryOrders, r.confirmed].join('|');
}
