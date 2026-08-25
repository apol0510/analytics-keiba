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
import { resolvePromotionalGrants } from '../entitlements/promotionalGrants.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { RESTART_GRANT_SOURCE } from '../entitlements/legacySanrenpukuNormalization.js';

/** 追加条件の識別子（campaignCatalog の `extraAudience` に書く値） */
export const EXTRA_AUDIENCE = Object.freeze({
  /** Premium Plus の商品ページを実際に閲覧できる会員だけ（eligible かつ PHASE 3 以上） */
  PREMIUM_PLUS_RELEASE: 'premium_plus_release',
  /**
   * 運用テスト専用: `NEWSLETTER_TEST_RECIPIENTS` に登録されたアドレスだけ。
   * 一般顧客には**構造的に**送れない（管理者が一覧で誰を選んでも通らない）。
   */
  MARKETING_CANARY_RECIPIENT: 'marketing_canary_recipient',
  /**
   * 旧三連複会員の **Light 永久無料化に本番で成功した会員だけ**（2026-08-25）。
   *
   * 判定材料は**そのレコード自身に書かれた正規化の痕跡**だけ:
   *   - `ComebackGrantSource` が正規化の施策名と一致
   *   - Light の無料権利が **lifetime かつ有効**（取り消されていない）
   *
   * よって **正規化に失敗した会員・未実施の会員には構造的に送れない**。
   * 名簿を別に持たないので、名簿とレコードがズレて誤送信することも起きない。
   */
  LIGHT_LIFETIME_RESTART: 'light_lifetime_restart',
});

/** 追加条件で外れたときの除外理由 */
export const CAMPAIGN_MISMATCH = 'campaign_mismatch';

/**
 * キャンペーン固有の追加条件を評価する。
 *
 * ⚠️ このモジュールは**純粋**（`process.env` を読まない）。env 由来の値は Function 層で読み、
 *    `context` として渡すこと（例: テスト受信者ホワイトリスト）。
 *
 * @param {{
 *   campaign: object,
 *   fields: object|null,   Airtable Customers の fields（Premium Plus 系フィールドを読む）
 *   nowMs: number,
 *   context?: { testRecipients?: Set<string>|null },
 * }} input
 * @returns {{ ok: boolean, reason: string|null, detail: string|null }}
 *   追加条件が無いキャンペーンは常に ok:true
 */
export function evaluateExtraAudience({ campaign, fields, nowMs, context } = {}) {
  const key = campaign && campaign.extraAudience;
  if (!key) return { ok: true, reason: null, detail: null };

  if (key === EXTRA_AUDIENCE.PREMIUM_PLUS_RELEASE) {
    return evaluatePremiumPlusRelease({ fields, nowMs });
  }
  if (key === EXTRA_AUDIENCE.MARKETING_CANARY_RECIPIENT) {
    return evaluateCanaryRecipient({ fields, context });
  }
  if (key === EXTRA_AUDIENCE.LIGHT_LIFETIME_RESTART) {
    return evaluateLightLifetimeRestart({ fields, nowMs });
  }

  // 未知の追加条件は通さない（定義ミスで全員へ送るのを防ぐ）
  return { ok: false, reason: CAMPAIGN_MISMATCH, detail: `unknown_extra_audience:${key}` };
}

/**
 * 運用テスト専用カナリアの対象か。
 *
 * 正本は **env `NEWSLETTER_TEST_RECIPIENTS`**（Function 層が
 * `newsletter/test-recipients.js` の `parseTestRecipientsEnv` で正規化して渡す）。
 *
 * fail closed の徹底:
 *   - env 未設定 / 空 / Set でない → **全員除外**（誰にも送れない）
 *   - Customers 側に email が無い → 除外
 *   - ホワイトリストに無い一般顧客 → 除外
 *
 * これにより管理者が一覧で誰を選んでも、テスト受信者以外へは構造的に送れない。
 * **アドレスは戻り値にも入れない**（detail は理由の種別のみ）。
 */
function evaluateCanaryRecipient({ fields, context }) {
  const allow = context && context.testRecipients;
  if (!(allow instanceof Set) || allow.size === 0) {
    return { ok: false, reason: CAMPAIGN_MISMATCH, detail: 'test_recipients_unset' };
  }
  const f = fields && typeof fields === 'object' ? fields : null;
  const email = f ? String(f.Email ?? f.email ?? '').trim().toLowerCase() : '';
  if (!email) return { ok: false, reason: CAMPAIGN_MISMATCH, detail: 'no_email' };
  if (!allow.has(email)) return { ok: false, reason: CAMPAIGN_MISMATCH, detail: 'not_test_recipient' };
  return { ok: true, reason: null, detail: null };
}

/**
 * Light 永久無料への再スタートを**本番で完了した**会員か。
 *
 * fail closed の徹底:
 *   - fields を読めない → 除外
 *   - `ComebackGrantSource` が正規化の施策名でない → 除外（別施策の無料付与に当たらない）
 *   - Light の無料権利が lifetime でない / 期限付き / 取り消し済み → 除外
 *     （＝正規化が途中で失敗した会員には送れない）
 *   - 三連複を見られる / 有料 Premium が有効 → 除外
 *     （「Light を無料にしました」が事実と食い違う相手へ送らない）
 */
function evaluateLightLifetimeRestart({ fields, nowMs }) {
  const f = fields && typeof fields === 'object' ? fields : null;
  if (!f) return { ok: false, reason: CAMPAIGN_MISMATCH, detail: 'customer_fields_unavailable' };
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  const source = String(f.ComebackGrantSource ?? '').trim();
  if (source !== RESTART_GRANT_SOURCE) {
    return { ok: false, reason: CAMPAIGN_MISMATCH, detail: 'not_restart_cohort' };
  }
  const light = resolvePromotionalGrants(f, now).light;
  if (light.lifetime !== true) return { ok: false, reason: CAMPAIGN_MISMATCH, detail: 'not_lifetime_grant' };
  if (light.active !== true) return { ok: false, reason: CAMPAIGN_MISMATCH, detail: 'grant_not_active' };

  const ent = resolveEntitlements(fromAirtableFields(f), now);
  if (ent.canViewSanrenpuku === true) {
    return { ok: false, reason: CAMPAIGN_MISMATCH, detail: 'has_sanrenpuku' };
  }
  if (ent.paidPremiumActive === true) {
    return { ok: false, reason: CAMPAIGN_MISMATCH, detail: 'paid_premium_active' };
  }
  return { ok: true, reason: null, detail: null };
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
