/**
 * cardRefund.js — カード決済（決済会社共通）の返金時に「付与前へ戻す」判定（純粋・I/O なし）
 * entitlementLedger.applyCardRefund が使う。決済会社ごとに作らない。
 */

/** 付与前の状態（返金時に戻すため）。権限に関わる列だけ */
export const SNAPSHOT_FIELDS = Object.freeze(['プラン', 'PlanType', 'Status', '有効期限', 'PaidAt', 'PaymentMethod', 'VenueAccess', 'WithdrawalRequested', 'WithdrawalDate', 'WithdrawalReason']);

export function snapshotFields(fields = {}) {
  const out = {};
  for (const k of SNAPSHOT_FIELDS) out[k] = Object.prototype.hasOwnProperty.call(fields, k) ? fields[k] : null;
  return out;
}

/**
 * 返金（取消）→ 付与前に戻す値。
 * 付与後に別の変更（別の購入・管理者の変更）が入っていたら戻さない（conflict・管理者へ）。
 * @returns {{ action: 'revert', fields } | { action: 'conflict', reason } | { action: 'noop', reason }}
 */
export function decideRefundRevert({ current = {}, applied }) {
  if (!applied || !applied.grantFields || !applied.before) return { action: 'noop', reason: 'not_applied' };
  if (applied.reverted) return { action: 'noop', reason: 'already_reverted' };
  for (const [k, v] of Object.entries(applied.grantFields)) {
    if (k === 'PaidAt') continue;
    const cur = current[k] === undefined ? null : current[k];
    const norm = (x) => (x === '' || x === undefined ? null : x);
    if (norm(cur) !== norm(v) && !(typeof v === 'boolean' && Boolean(cur) === v)) {
      return { action: 'conflict', reason: `changed_after_grant:${k}` };
    }
  }
  return { action: 'revert', fields: { ...applied.before } };
}
