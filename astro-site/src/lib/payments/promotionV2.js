/**
 * promotionV2.js — v2 の昇格 PATCH フィールドを組み立てる純粋関数。
 *
 * legacy の buildConfirmationFields（bankPaymentFlow.js）は昇格情報 +
 * PaymentEmailSent=true を返す。v2 では:
 * - PaymentEmailSent は書かない（worker が accepted 到達時に互換出力として書く）
 * - 代わりに PaymentEmailStatus='pending' + IdempotencyKey + AttemptCount=0 を同梱する
 *   （昇格成功と送信対象生成を「同一 PATCH」で原子化する）
 *
 * confirm-bank-payment（自動）と admin-promote-customer（手動）が共有する単一源。
 */

import { buildConfirmationFields } from './bankPaymentFlow.js';
import { buildPendingEmailFields } from './paymentEmailState.js';

/**
 * v2 の入金確認 昇格フィールド。legacy と同じ昇格情報から PaymentEmailSent を外し、
 * pending 系フィールドを同梱する。判定不能なら null（fail closed）。
 *
 * @param {object} p
 * @param {string|null} p.requestedPlan
 * @param {string|null} p.requestedPlanType
 * @param {Date} p.confirmedAt 入金確認日時（有効期限と PaidAt の基準）
 * @param {string} p.recordId 冪等キーの導出に使う
 * @returns {{fields: Record<string, unknown>, expiration: string}|null}
 */
export function buildV2ConfirmationFields({ requestedPlan, requestedPlanType, confirmedAt, recordId }) {
  const base = buildConfirmationFields({ requestedPlan, requestedPlanType, confirmedAt });
  if (!base) return null; // fail closed: 推測で昇格しない

  const paidAtIso = base.fields.PaidAt; // = confirmedAt.toISOString()
  const fields = { ...base.fields };
  delete fields.PaymentEmailSent; // v2 では立てない

  Object.assign(fields, buildPendingEmailFields({ recordId, paidAtIso }));
  return { expiration: base.expiration, fields };
}

/**
 * 手動昇格（admin-promote-customer）の PATCH フィールド。
 * v2 昇格フィールド + 操作者 / 理由 / 日時（監査）。
 * 「Status だけ active にして別処理でメール job を作る」設計にはしない。
 *
 * @param {object} p
 * @param {string|null} p.requestedPlan
 * @param {string|null} p.requestedPlanType
 * @param {Date} p.confirmedAt
 * @param {string} p.recordId
 * @param {string} p.operator 操作者（必須。空なら null=fail closed）
 * @param {string} [p.reason]
 * @returns {{fields: Record<string, unknown>, expiration: string}|null}
 */
export function buildManualPromotionFields({ requestedPlan, requestedPlanType, confirmedAt, recordId, operator, reason }) {
  if (!operator || !String(operator).trim()) return null; // 監査のため操作者必須
  const v2 = buildV2ConfirmationFields({ requestedPlan, requestedPlanType, confirmedAt, recordId });
  if (!v2) return null;
  return {
    expiration: v2.expiration,
    fields: {
      ...v2.fields,
      PromotedBy: String(operator).trim(),
      PromotionReason: reason ? String(reason).trim() : '',
      PromotedAt: confirmedAt.toISOString(),
    },
  };
}
