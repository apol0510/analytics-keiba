/**
 * campaignAudienceRules.js — キャンペーン固有の追加絞り込み（純粋・I/O なし）
 *
 * ── なぜ別モジュールなのか ────────────────────────────────────────────
 * 一部のキャンペーンは「契約状態 × プラン」だけでは対象を決められない。
 * 例: Premium Plus 案内は、**販売資格（eligible）と段階公開の PHASE** を満たす会員だけに
 * 送らないと、CTA 先が 404 になる（`/premium-plus/` は PHASE 3 未満・非 eligible で 404）。
 *
 * その判定を `customerMarketingAudience.js` へ入れると、マーケティング対象判定が
 * Premium Plus の販売判定で汚れる。両者は独立した概念なので、**キャンペーン固有の追加条件は
 * ここに閉じ込める**。`customerMarketingAudience.js` は Premium Plus を一切知らないままにする。
 *
 * ── 絶対条件 ──────────────────────────────────────────────────────
 * - PHASE / eligibility の判定は**既存正本を再利用する**
 *   （`premiumPlusRelease.resolvePremiumPlusRelease` / `premiumPlusMember.resolvePlusMemberFromFields`）。
 *   日数条件・PHASE 計算をここで複製しない
 * - このモジュールは**送信対象から外すかどうか**しか返さない。
 *   Premium Plus の販売資格を読み取るだけで、変更は一切しない
 */

import { resolvePlusMemberFromFields } from '../premiumPlus/premiumPlusMember.js';
import { resolvePremiumPlusRelease } from '../premiumPlus/premiumPlusRelease.js';

/** 追加条件の識別子（campaignCatalog の `extraAudience` に書く値） */
export const EXTRA_AUDIENCE = Object.freeze({
  /** Premium Plus の商品ページを実際に閲覧できる会員だけ（eligible かつ PHASE 3 以上） */
  PREMIUM_PLUS_RELEASE: 'premium_plus_release',
});

/** 追加条件で外れたときの除外理由 */
export const CAMPAIGN_MISMATCH = 'campaign_mismatch';

/**
 * キャンペーン固有の追加条件を評価する。
 *
 * @param {{
 *   campaign: object,
 *   fields: object|null,   Airtable Customers の fields（Premium Plus 系フィールドを読む）
 *   nowMs: number,
 * }} input
 * @returns {{ ok: boolean, reason: string|null, detail: string|null }}
 *   追加条件が無いキャンペーンは常に ok:true
 */
export function evaluateExtraAudience({ campaign, fields, nowMs } = {}) {
  const key = campaign && campaign.extraAudience;
  if (!key) return { ok: true, reason: null, detail: null };

  if (key === EXTRA_AUDIENCE.PREMIUM_PLUS_RELEASE) {
    return evaluatePremiumPlusRelease({ fields, nowMs });
  }

  // 未知の追加条件は通さない（定義ミスで全員へ送るのを防ぐ）
  return { ok: false, reason: CAMPAIGN_MISMATCH, detail: `unknown_extra_audience:${key}` };
}

/**
 * Premium Plus 案内の対象か。
 *
 * 送ってよいのは「商品ページを実際に開ける人」だけ:
 *   - 販売資格 `PremiumPlusEligibility === 'eligible'`
 *   - かつ 段階公開が PHASE 3 以上（= `showProductPage === true`）
 *
 * route が none（三連複を持たない / 期限切れで権限が無い等）、review / blocked、
 * PHASE 1・2 はすべて除外する。判定は単一源へ委譲し、ここで PHASE を計算しない。
 */
function evaluatePremiumPlusRelease({ fields, nowMs }) {
  const f = fields && typeof fields === 'object' ? fields : null;
  if (!f) return { ok: false, reason: CAMPAIGN_MISMATCH, detail: 'customer_fields_unavailable' };

  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const member = resolvePlusMemberFromFields(f, { nowMs: now });
  const release = resolvePremiumPlusRelease({ ...member, nowMs: now });

  if (!release.allowed) {
    // route none / eligible でない → 商品ページは 404
    return {
      ok: false,
      reason: CAMPAIGN_MISMATCH,
      detail: release.eligibility === 'eligible' ? `route_${release.route}` : `eligibility_${release.eligibility}`,
    };
  }
  if (release.showProductPage !== true) {
    // eligible だが PHASE 1 / 2 → まだ商品ページを見せていない
    return { ok: false, reason: CAMPAIGN_MISMATCH, detail: `phase_${release.phase}` };
  }
  return { ok: true, reason: null, detail: null };
}
