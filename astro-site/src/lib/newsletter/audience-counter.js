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

import { normalizeAudienceType } from '../../../scripts/newsletter/lib/plan-normalizer.mjs';
import { resolveStatus } from '../../../scripts/newsletter/lib/status-resolver.mjs';
import {
  resolvePlanRaw,
  resolveExpiryDate,
  resolveWithdrawalFlag,
  resolveEmail,
  resolveUnsubscribed,
} from '../../../scripts/newsletter/lib/customer-field-resolver.mjs';

/**
 * brand → Airtable Base 名のマッピング
 *   - analytics-keiba ブランドの Customers は analytics-keiba Base に存在
 *   - keiba-intelligence ブランドの Customers は keiba-intelligence Base に存在
 */
export const BRAND_TO_BASE_NAME = {
  'analytics-keiba': 'analytics-keiba',
  'keiba-intelligence': 'keiba-intelligence',
};

/**
 * 除外ポリシーの説明（レスポンスに含めて運用透明性を確保）
 * UI / 監査ログ用、計算には使わない
 */
export const EXCLUSION_POLICY = {
  withdrawn: 'SuggestedStatus=withdrawn を除外',
  unsubscribe: 'brand 別 UnsubscribedAnalyticsKeiba / UnsubscribedKeibaIntelligence = true を除外',
  blacklist: 'EmailBlacklist Status が HARD_BOUNCE / COMPLAINT の email を除外',
  blacklistCriteria: ['HARD_BOUNCE', 'COMPLAINT'],
  order: ['withdrawn', 'unsubscribe', 'blacklist', 'audienceTypeFilter'],
};

/**
 * Airtable records を分類して集計（純粋関数）
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
export function countAudience({
  records,
  brand,
  audienceTypeFilter,
  today,
  blacklistEmails = new Set(),
}) {
  if (!Array.isArray(records)) {
    throw new Error('records must be an array');
  }
  const baseName = BRAND_TO_BASE_NAME[brand];
  if (!baseName) {
    throw new Error(`unknown brand: ${brand}`);
  }
  if (!(blacklistEmails instanceof Set)) {
    throw new Error('blacklistEmails must be a Set');
  }
  const isAnalyticsKeiba = baseName === 'analytics-keiba';
  const filterAll = audienceTypeFilter === '*' || audienceTypeFilter === 'all';

  const audienceTypeBreakdown = {};
  const matchedStatusBreakdown = {};
  let matchedCount = 0;
  let withdrawnExcluded = 0;
  let unsubscribeExcluded = 0;
  let blacklistExcluded = 0;

  for (const record of records) {
    const f = record?.fields || {};
    const planRaw = resolvePlanRaw(f);
    const expiryDate = resolveExpiryDate(f, baseName);
    const withdrawalFlag = resolveWithdrawalFlag(f, baseName);
    const currentStatus = (f.Status ?? null) || null;

    const { audienceType } = normalizeAudienceType(planRaw, {
      status: currentStatus,
      expiryDate,
      today,
    });
    const statusResult = resolveStatus({
      currentStatus,
      withdrawalRequested: withdrawalFlag,
      expiryDate,
      today,
      isAnalyticsKeiba,
    });

    // AudienceType 全件 breakdown（除外前、参考情報）
    const atKey = audienceType ?? '(null/unknown)';
    audienceTypeBreakdown[atKey] = (audienceTypeBreakdown[atKey] || 0) + 1;

    // 排他カウント（優先順固定）
    // 1. 退会候補
    if (statusResult.suggestedStatus === 'withdrawn') {
      withdrawnExcluded += 1;
      continue;
    }
    // 2. 配信停止（brand 別）
    if (resolveUnsubscribed(f, brand)) {
      unsubscribeExcluded += 1;
      continue;
    }
    // 3. EmailBlacklist (HARD_BOUNCE / COMPLAINT)
    if (blacklistEmails.size > 0) {
      const normalizedEmail = resolveEmail(f);
      if (normalizedEmail && blacklistEmails.has(normalizedEmail)) {
        blacklistExcluded += 1;
        continue;
      }
    }
    // 4. AudienceType フィルタ（不一致はどこにもカウントしない）
    const matches = filterAll
      ? audienceType !== null
      : audienceType === audienceTypeFilter;
    if (!matches) continue;

    // 5. matched
    matchedCount += 1;
    const sKey = currentStatus || '(null/unknown)';
    matchedStatusBreakdown[sKey] = (matchedStatusBreakdown[sKey] || 0) + 1;
  }

  return {
    totalCustomers: records.length,
    matchedCount,
    withdrawnExcluded,
    unsubscribeExcluded,
    blacklistExcluded,
    audienceTypeBreakdown,
    matchedStatusBreakdown,
  };
}
