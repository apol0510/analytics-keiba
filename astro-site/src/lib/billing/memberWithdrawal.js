/**
 * memberWithdrawal.js — 会員の退会（AK 内の退会操作の単一源・2026-10-15 MK 確定）
 *
 * ## 確定仕様（docs/spec.md「退会」・decisions 2026-10-15「退会仕様」）
 * - 退会の入口は**ログイン後のマイページ「退会する」→ 確認 → 確定だけ**。メールアドレスだけで退会できる経路は無い。
 * - 月額（PayPal・Stripe）は自動課金を即時に止める（各社の退会処理へ渡す）。
 * - 支払い済みの期限が残っていても、退会を確定した時点で**契約由来の閲覧権限を即時停止**する（期限を前日へ・退会フラグ）。
 * - 退会後も同じアカウントでログインでき、マイページ・無料予想は使える（退会 ≠ アカウント削除。レコードは消さない）。
 * - **買い切り（Premium の PlanType=Lifetime・三連複の LifetimeSanrenpuku）は退会で消さない**。期限も書き換えない。
 * - 無料会員は止める契約が無いので退会手続きは不要（kind='none'）。
 *
 * ## 種類（classifyMemberWithdrawal）
 * | kind | 対象 | 退会で起きること |
 * |---|---|---|
 * | stripe | Stripe の月額 | 購読を即時解約 → 退会状態（stripeWithdrawal.js） |
 * | paypal | PayPal の月額 | 購読を即時解約 → 退会状態（paypalSubscriptionServer.js） |
 * | contract | 年払い・Light 等の期間のある有料契約（銀行振込） | 退会状態（期限を前日へ・退会フラグ）。買い切りがあればそれは残る |
 * | lifetime_only | 買い切りだけ | 退会フラグだけ（期限は書き換えない＝買い切りはそのまま使える） |
 * | none | 無料・期限切れ・入金待ち | 何もしない（退会は不要） |
 * | already_withdrawn | 退会済み | 何もしない（二重退会） |
 */

import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { isStripeSubscriber, withdrawalFields } from './stripeSubscriptionSync.js';
import { isPaypalSubscriber } from './paypal/paypalSubscriptionCore.js';
import { airtable, withSubscriptionLock } from './stripeServer.js';

export const MEMBER_WITHDRAWAL_KIND = Object.freeze({
  STRIPE: 'stripe',
  PAYPAL: 'paypal',
  CONTRACT: 'contract',
  LIFETIME_ONLY: 'lifetime_only',
  NONE: 'none',
  ALREADY_WITHDRAWN: 'already_withdrawn',
});

export const MEMBER_WITHDRAWAL_RESULT = Object.freeze({
  WITHDRAWN: 'withdrawn',
  ALREADY_WITHDRAWN: 'already_withdrawn',
  NO_CONTRACT: 'no_contract',           // 無料会員など、止める契約が無い（退会は不要）
  RECORD_NOT_FOUND: 'record_not_found',
  RECORD_WRITE_FAILED: 'record_write_failed',
  BUSY: 'busy',
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
  const termContract = !lifetimePlan
    && (ent.paidPremiumActive === true || ent.paidPremiumVenueActive === true || ent.paidLightActive === true);
  if (termContract) return { kind: MEMBER_WITHDRAWAL_KIND.CONTRACT, keeps };
  if (keeps.premiumLifetime || keeps.sanrenpukuLifetime) return { kind: MEMBER_WITHDRAWAL_KIND.LIFETIME_ONLY, keeps };
  return { kind: MEMBER_WITHDRAWAL_KIND.NONE, keeps };
}

/**
 * 退会状態のフィールド（月額以外）。期間のある契約は withdrawalFields（期限を前日へ・退会フラグ）。
 * **買い切り（PlanType=Lifetime）は期限を書き換えない**（退会で買い切りを消さない）。三連複の買い切りの列には触らない。
 */
export function memberWithdrawalFields({ fields = {}, now = new Date(), reason = null } = {}) {
  const out = withdrawalFields({ fields, now, reason });
  if (planTypeOf(fields) === 'lifetime') delete out['有効期限'];
  return out;
}

/**
 * 月額以外（銀行振込の年払い・Light・買い切り）の退会。本人のレコード 1 件だけを書く。
 * @returns {Promise<{ ok: boolean, result: string, fields?: object, email?: string, kind?: string }>}
 */
export async function withdrawPlainMember({ env, recordId, reason = null, now = new Date(), fetchImpl, redis = null }) {
  if (!recordId) return { ok: false, result: MEMBER_WITHDRAWAL_RESULT.RECORD_NOT_FOUND };
  const at = airtable(env, fetchImpl);
  const locked = await withSubscriptionLock(redis, `member-withdraw-${recordId}`, async () => {
    // ロックの中で読み直す（二重クリックの 2 本目はここで退会済みを見る）
    const record = await getRecord(at, recordId);
    if (!record) return { ok: false, result: MEMBER_WITHDRAWAL_RESULT.RECORD_NOT_FOUND };
    const fields = record.fields || {};
    const { kind } = classifyMemberWithdrawal(fields, now.getTime());
    if (kind === MEMBER_WITHDRAWAL_KIND.ALREADY_WITHDRAWN) return { ok: false, result: MEMBER_WITHDRAWAL_RESULT.ALREADY_WITHDRAWN };
    if (kind !== MEMBER_WITHDRAWAL_KIND.CONTRACT && kind !== MEMBER_WITHDRAWAL_KIND.LIFETIME_ONLY) {
      // 月額は各社の退会処理へ（ここで退会フラグだけ立てると課金が続く）。無料は退会不要。
      return { ok: false, result: MEMBER_WITHDRAWAL_RESULT.NO_CONTRACT, kind };
    }
    const out = memberWithdrawalFields({ fields, now, reason });
    try {
      await at.patch(recordId, out);
    } catch {
      return { ok: false, result: MEMBER_WITHDRAWAL_RESULT.RECORD_WRITE_FAILED };
    }
    return { ok: true, result: MEMBER_WITHDRAWAL_RESULT.WITHDRAWN, fields: out, email: String(fields.Email || ''), kind };
  });
  if (locked && locked.action === 'busy') return { ok: false, result: MEMBER_WITHDRAWAL_RESULT.BUSY };
  return locked;
}

async function getRecord(at, recordId) {
  try {
    return await at.get(recordId);
  } catch (e) {
    if (/airtable_404/.test(String(e?.message || ''))) return null;
    throw e;
  }
}

// 退会直後のセッション無効化は auth/sessionRevocation.js（権利判定側からも使うため auth 層に置く）
export { markSessionRevoked, isSessionRevoked, SESSION_REVOKED_PREFIX, SESSION_REVOKED_TTL_SEC } from '../auth/sessionRevocation.js';
