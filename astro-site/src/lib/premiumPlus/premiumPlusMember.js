/**
 * premiumPlusMember.js — Airtable Customers fields → Premium Plus 判定の入力（純粋・I/O なし）
 *
 * 会員状態（STEP 1）の判定は **既存の権限正本 `entitlements/resolveEntitlements.js` を再利用**する。
 * Premium Plus 用に会員判定を再実装しない（プラン・期限・Status・LifetimeSanrenpuku の
 * 解釈が二重化すると必ずズレる）。
 *
 * ここが追加で読むのは Premium Plus 専用フィールドだけ:
 *   - SanrenpukuPaidAt          … ROUTE A の anchor（三連複の購入確定日時）
 *   - PaidAt                    … ROUTE B の anchor（通常 Premium の入金確認日時）
 *   - PremiumPlusEligibility    … 販売資格（eligible / review / blocked）
 *   - PremiumPlusEligibilityUpdatedAt … 販売許可日（anchor mode 'later' で使う）
 *
 * fields が無い / 読めない場合は全て安全側（route 対象外・review）へ倒す。
 */

import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import {
  PP_ELIGIBILITY_FIELDS,
  normalizeEligibility,
  resolveSanrenpukuPaidAt,
  toPaidAtMs,
} from './premiumPlusRelease.js';

/**
 * @param {object|null} fields Airtable Customers の fields
 * @param {{ nowMs?: number, fallbackAnchor?: unknown }} [opts]
 *   fallbackAnchor … env PREMIUM_PLUS_FUNNEL_ANCHOR（会員別 SanrenpukuPaidAt が無い間の暫定）
 * @returns {{
 *   hasSanrenpuku: boolean,
 *   premiumActive: boolean,
 *   sanrenpukuPaidAtMs: number|null,
 *   premiumPaidAtMs: number|null,
 *   eligibility: string,
 *   eligibleAtMs: number|null,
 *   anchorSource: 'field'|'anchor'|'none',
 * }}
 */
export function resolvePlusMemberFromFields(fields, opts = {}) {
  const { nowMs = Date.now(), fallbackAnchor } = opts;
  const f = fields && typeof fields === 'object' ? fields : null;

  if (!f) {
    return {
      hasSanrenpuku: false,
      premiumActive: false,
      sanrenpukuPaidAtMs: null,
      premiumPaidAtMs: null,
      eligibility: normalizeEligibility(undefined), // = review（fail closed）
      eligibleAtMs: null,
      anchorSource: 'none',
    };
  }

  // ── STEP 1: 会員状態（既存正本）──────────────────────────────
  const ent = resolveEntitlements(fromAirtableFields(f), nowMs);

  const srp = resolveSanrenpukuPaidAt({ fields: f, fallbackAnchor });

  return {
    // 三連複を保有しているか（買い切り永久権 or 移行期の旧 tier）
    hasSanrenpuku: ent.canViewSanrenpuku === true,
    // 通常 Premium 契約が現在有効か（ROUTE B の前提）
    premiumActive: ent.canViewPremium === true,
    sanrenpukuPaidAtMs: srp.paidAtMs,
    premiumPaidAtMs: toPaidAtMs(f['PaidAt']),
    eligibility: normalizeEligibility(f[PP_ELIGIBILITY_FIELDS.STATUS]),
    eligibleAtMs: toPaidAtMs(f[PP_ELIGIBILITY_FIELDS.UPDATED_AT]),
    anchorSource: srp.source,
  };
}
