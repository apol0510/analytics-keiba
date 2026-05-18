// メルマガ配信オーディエンスの件数集計（純粋関数、副作用ゼロ）
//
// 目的: newsletter-preview の audienceMode='real-count-only' で利用する。
//       PII（email / name / AirtableRecordId）を一切返さず、件数のみを返す。
//
// 仕様: docs/NEWSLETTER_BRAND_BACKFILL_SPEC.md §6 / §7
//   - SuggestedAudienceType は plan-normalizer の計算結果を使う
//     （backfill-customers.mjs と同一ロジック）
//
// 2026-05-17 改訂: 除外ロジックを 3 段階に拡張（排他カウント、優先順固定）
//   1. withdrawn  (SuggestedStatus=withdrawn)            → withdrawnExcluded
//   2. unsubscribe (brand 別 Unsubscribed* checkbox=true) → unsubscribeExcluded
//   3. blacklist  (EmailBlacklist Status ∈ HARD_BOUNCE/COMPLAINT) → blacklistExcluded
//   4. audienceType フィルタ不一致                        → どこにもカウントしない
//   5. 全て通過                                            → matched
//   => matched + 全 excluded + filter 不一致 = totalCustomers
//
// 2026-05-19 改訂: resolveAudienceRecipients への薄いラッパーに変更。
//   preview の matchedCount と実送信の対象件数を **同一の関数** から導出することで、
//   D2（preview/send 件数ズレ）を構造的に解消する。
//   matchedCount は dedupe + email 妥当性チェック後の値（= 実送信件数）になる。

// 定数は実ロジック側（audience-resolver.js）から re-export して所在を統一。
// 既存 caller（newsletter-preview.js）は audience-counter.js から import しているため、
// 互換性のためここで re-export を維持する。
import {
  BRAND_TO_BASE_NAME,
  EXCLUSION_POLICY,
  resolveAudienceRecipients,
} from './audience-resolver.js';

export { BRAND_TO_BASE_NAME, EXCLUSION_POLICY };

/**
 * Airtable records を分類して集計（純粋関数）
 *
 * 内部実装: resolveAudienceRecipients を呼んで emails を捨て、counts のみを返す。
 *   - matchedCount は dedupe + email 妥当性チェック後の値（= 実送信件数）
 *   - 旧仕様（matchedCount = 重複・無効 email を含む生件数）からの軽微な差分あり
 *
 * @param {object} options
 * @param {Array<{id: string, fields: object}>} options.records - Airtable records
 * @param {string} options.brand - 'analytics-keiba' | 'keiba-intelligence'
 * @param {string} options.audienceTypeFilter - 'free' | 'light' | ... | '*'(全AudienceType合算)
 * @param {string} options.today - YYYY-MM-DD
 * @param {Set<string>} [options.blacklistEmails] - normalized email (lowercase + trim) の Set
 * @returns {{
 *   totalCustomers: number,
 *   matchedCount: number,
 *   withdrawnExcluded: number,
 *   unsubscribeExcluded: number,
 *   blacklistExcluded: number,
 *   audienceTypeBreakdown: Record<string, number>,
 *   matchedStatusBreakdown: Record<string, number>,
 * }}
 */
export function countAudience(options) {
  const r = resolveAudienceRecipients(options);
  return {
    totalCustomers: r.counts.totalCustomers,
    matchedCount: r.counts.matchedCount,
    withdrawnExcluded: r.counts.withdrawnExcluded,
    unsubscribeExcluded: r.counts.unsubscribeExcluded,
    blacklistExcluded: r.counts.blacklistExcluded,
    audienceTypeBreakdown: r.audienceTypeBreakdown,
    matchedStatusBreakdown: r.matchedStatusBreakdown,
  };
}
