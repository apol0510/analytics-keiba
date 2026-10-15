/**
 * memberWithdrawal.js — 会員の退会（AK 内の退会操作の単一源・2026-10-15 MK 確定）
 *
 * ## 確定仕様（docs/spec.md「退会」・decisions 2026-10-15「退会仕様」）
 * - **退会は月額（PayPal・Stripe）の継続課金を止める手続き**。入口はログイン後のマイページ「退会する」→ 確認 → 確定だけ。
 *   メールアドレスだけで退会できる経路は無い。
 * - 退会すると各社の自動課金を即時に止め、支払い済みの期限が残っていても月額由来の閲覧権限を即時停止する（期限を前日へ・退会フラグ）。
 * - 退会後も同じアカウントでログインでき、マイページ・無料予想は使える（退会 ≠ アカウント削除。レコードは消さない）。
 * - **銀行振込（年払い・買い切り）には退会の概念が無い**（MK 確定）。継続課金が無いので止める物が無く、期限まで（買い切りは期限なく）使える。
 * - 月額の会員が別に持つ買い切り（三連複の LifetimeSanrenpuku 等）は退会で消さない（列に触らない）。
 * - 無料会員も退会は不要。
 *
 * ## 種類（classifyMemberWithdrawal）
 * | kind | 対象 | 退会 |
 * |---|---|---|
 * | stripe | Stripe の月額 | 購読を即時解約 → 退会状態（stripeWithdrawal.js） |
 * | paypal | PayPal の月額 | 購読を即時解約 → 退会状態（paypalSubscriptionServer.js） |
 * | bank_transfer | 銀行振込の年払い・Light・買い切り | 退会は無い（期限まで使える・自動更新なし） |
 * | none | 無料・期限切れ・入金待ち | 退会は不要 |
 * | already_withdrawn | 退会済み | 何もしない（二重退会） |
 */

import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { isStripeSubscriber } from './stripeSubscriptionSync.js';
import { isPaypalSubscriber } from './paypal/paypalSubscriptionCore.js';

export const MEMBER_WITHDRAWAL_KIND = Object.freeze({
  STRIPE: 'stripe',
  PAYPAL: 'paypal',
  BANK_TRANSFER: 'bank_transfer',
  NONE: 'none',
  ALREADY_WITHDRAWN: 'already_withdrawn',
});

const isTruthy = (v) => v === true || v === 1 || /^(true|1|yes)$/i.test(String(v ?? '').trim());
const planTypeOf = (f) => String(f?.PlanType || '').trim().toLowerCase();

/**
 * 退会の種類と、退会後も残る買い切りの権利。純粋関数（I/O なし）。
 * @param {object} fields Airtable Customers の fields
 * @param {number} [nowMs]
 * @returns {{ kind: string, keeps: { premiumLifetime: boolean, sanrenpukuLifetime: boolean } }}
 */
export function classifyMemberWithdrawal(fields, nowMs = Date.now()) {
  const f = fields || {};
  const ent = resolveEntitlements(fromAirtableFields(f), nowMs);
  const lifetimePlan = planTypeOf(f) === 'lifetime';
  const keeps = {
    premiumLifetime: lifetimePlan && (ent.paidPremiumActive === true || ent.paidPremiumVenueActive === true || ent.paidLightActive === true),
    sanrenpukuLifetime: isTruthy(f.LifetimeSanrenpuku) || isTruthy(f['三連複Lifetime']),
  };
  if (isTruthy(f.WithdrawalRequested)) return { kind: MEMBER_WITHDRAWAL_KIND.ALREADY_WITHDRAWN, keeps };
  if (isStripeSubscriber(f)) return { kind: MEMBER_WITHDRAWAL_KIND.STRIPE, keeps };
  if (isPaypalSubscriber(f)) return { kind: MEMBER_WITHDRAWAL_KIND.PAYPAL, keeps };
  // 銀行振込（年払い・Light・買い切り）は継続課金が無いので退会の概念が無い（2026-10-15 MK 確定）
  const prepaid = ent.paidPremiumActive === true || ent.paidPremiumVenueActive === true || ent.paidLightActive === true
    || keeps.premiumLifetime || keeps.sanrenpukuLifetime;
  if (prepaid) return { kind: MEMBER_WITHDRAWAL_KIND.BANK_TRANSFER, keeps };
  return { kind: MEMBER_WITHDRAWAL_KIND.NONE, keeps };
}

// 退会直後のセッション無効化は auth/sessionRevocation.js（権利判定側からも使うため auth 層に置く）
export { markSessionRevoked, isSessionRevoked, SESSION_REVOKED_PREFIX, SESSION_REVOKED_TTL_SEC } from '../auth/sessionRevocation.js';
