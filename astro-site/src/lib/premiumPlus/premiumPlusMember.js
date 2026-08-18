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
 *   - PremiumPlusReleaseOverride … 段階公開を飛ばす明示 override（空 or 'phase4'）
 *   - PremiumPlusEligibleAt     … 販売許可日（anchor mode 'later' で使う）
 *
 * ⚠️ anchor に使うのは `PremiumPlusEligibleAt` **だけ**。監査用の
 *    `PremiumPlusEligibilityUpdatedAt` は phase 判定に使わない（内部メモの編集や
 *    同じ資格の再保存で更新されるため、anchor に使うと phase が Day 0 へ戻る）。
 *
 * fields が無い / 読めない場合は全て安全側（route 対象外・review）へ倒す。
 */

import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import {
  PP_ELIGIBILITY_FIELDS,
  PP_SALE_PAUSE_FIELDS,
  normalizeEligibility,
  normalizeReleaseOverride,
  normalizeSalePaused,
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
 *   releaseOverride: 'phase4'|null,
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
      releaseOverride: null,
      // fields を読めないときは「停止していない」。ここを true にすると
      // Airtable 障害で全会員の販売が止まる（可用性の事故）。
      // 停止は**明示されたときだけ**（premiumPlusRelease.js の設計コメント参照）。
      salePaused: false,
      anchorSource: 'none',
    };
  }

  // ── STEP 1: 会員状態（既存正本）──────────────────────────────
  const ent = resolveEntitlements(fromAirtableFields(f), nowMs);

  const srp = resolveSanrenpukuPaidAt({ fields: f, fallbackAnchor });

  return {
    // 三連複を保有しているか（買い切り永久権 or 移行期の旧 tier）
    hasSanrenpuku: ent.canViewSanrenpuku === true,
    // 通常 Premium 契約が現在有効か（ROUTE B の前提）。
    // ⚠️ `canViewPremium` ではなく **paidPremiumActive**（有料契約のみ）を使う。
    //    カムバック特典（Premium 30日無料）は閲覧権であって課金実績ではないため、
    //    これで Premium Plus の販売資格・ROUTE B が動いてはいけない。
    premiumActive: ent.paidPremiumActive === true,
    sanrenpukuPaidAtMs: srp.paidAtMs,
    premiumPaidAtMs: toPaidAtMs(f['PaidAt']),
    eligibility: normalizeEligibility(f[PP_ELIGIBILITY_FIELDS.STATUS]),
    // anchor は EligibleAt のみ。UpdatedAt（監査）は読まない。
    eligibleAtMs: toPaidAtMs(f[PP_ELIGIBILITY_FIELDS.ELIGIBLE_AT]),
    // フィールド未作成なら undefined → normalize が null（override なし）にする（fail closed）
    releaseOverride: normalizeReleaseOverride(f[PP_ELIGIBILITY_FIELDS.OVERRIDE]),
    // 会員単位の販売 一時停止。フィールド未作成 / 未チェックは false（＝停止していない）。
    // 読み取りに gate は不要（未設定 = 従来どおりの挙動）。
    salePaused: normalizeSalePaused(f[PP_SALE_PAUSE_FIELDS.PAUSED]),
    anchorSource: srp.source,
  };
}
