/**
 * premiumPlusOrderDeps.js — 注文操作が使う外部 I/O の本番実装（Redis 計測・クーポン予約台帳）
 *
 * `premiumPlusOrderService.js` はこれを注入で受け取る（テストでは差し替える）。
 * どの関数も**例外を投げず** outcome 文字列／結果オブジェクトを返す。
 */
import { recordPlusPurchase, revokePlusPurchase } from './premiumPlusFunnelServer.js';
import {
  findActiveReservation, findRedeemedReservation, buildReservationRedeemFields, buildReservationRevokeFields,
} from './premiumPlusCouponReservation.js';
import { listReservationsFor, patchReservation } from './premiumPlusCouponReservationStore.js';

/**
 * クーポン予約を使用済みにする（confirm-bank-payment の Step 4.6 と同じ判定）。
 * @returns {Promise<string>} 'redeemed' | 'skipped:already_redeemed' | 'no_reservation' | 'ledger_unavailable:…' | 'skipped:…' | 'failed_…'
 */
export async function redeemPlusCoupon({ env, recordId, nowMs }) {
  try {
    const ledger = await listReservationsFor({ env, customerRecordId: recordId });
    // 「読めなかった」を「予約なし」に丸めない
    if (!ledger.available) return `ledger_unavailable:${ledger.reason}`;
    const active = findActiveReservation({ records: ledger.records, customerRecordId: recordId });
    if (!active) {
      return findRedeemedReservation({ records: ledger.records, customerRecordId: recordId })
        ? 'skipped:already_redeemed' : 'no_reservation';
    }
    const built = buildReservationRedeemFields({ record: active, nowMs });
    if (built.skipped) return `skipped:${built.skipped}`;
    const patched = await patchReservation({ env, recordId: active.id, fields: built.fields });
    return patched.outcome;
  } catch {
    return 'failed_error';
  }
}

/**
 * 注文取消でクーポン予約を解除する（Customers の取得済みは消さない＝申し込み直せる）。
 * @returns {Promise<string>} 'released' | 'no_reservation' | 'ledger_unavailable:…' | 'skipped:…' | 'failed_…'
 */
export async function releasePlusCoupon({ env, recordId, nowMs, reason }) {
  try {
    const ledger = await listReservationsFor({ env, customerRecordId: recordId });
    if (!ledger.available) return `ledger_unavailable:${ledger.reason}`;
    const active = findActiveReservation({ records: ledger.records, customerRecordId: recordId });
    if (!active) return 'no_reservation';
    const built = buildReservationRevokeFields({ record: active, nowMs, reason: `plus order cancelled: ${reason}` });
    if (built.skipped) return `skipped:${built.skipped}`;
    const patched = await patchReservation({ env, recordId: active.id, fields: built.fields });
    return patched.outcome === 'redeemed' ? 'released' : patched.outcome; // patchReservation は成功時 'redeemed' を返す
  } catch {
    return 'failed_error';
  }
}

/** 本番の依存一式 */
export function makeOrderDeps(env) {
  return {
    recordPurchase: ({ recordId, orderKey, productPlan, nowMs }) => recordPlusPurchase({
      recordId, orderKey, productPlan, nowMs, env,
    }),
    revokePurchase: ({ recordId, orderKey }) => revokePlusPurchase({ recordId, orderKey, env }),
    redeemCoupon: ({ recordId, nowMs }) => redeemPlusCoupon({ env, recordId, nowMs }),
    releaseCoupon: ({ recordId, nowMs, reason }) => releasePlusCoupon({ env, recordId, nowMs, reason }),
  };
}
