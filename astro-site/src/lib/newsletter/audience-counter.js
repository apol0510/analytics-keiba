// メルマガ配信オーディエンスの件数集計（純粋関数、副作用ゼロ）
//
// 目的: newsletter-preview の audienceMode='real-count-only' で利用する。
//       PII（email / name / AirtableRecordId）を一切返さず、件数のみを返す。
//
// 仕様: docs/NEWSLETTER_BRAND_BACKFILL_SPEC.md §6 / §7
//   - SuggestedAudienceType は plan-normalizer の計算結果を使う
//     （backfill-customers.mjs と同一ロジック）
//   - SuggestedStatus === 'withdrawn' は matched から除外（退会済みには送らない）

import { normalizeAudienceType } from '../../../scripts/newsletter/lib/plan-normalizer.mjs';
import { resolveStatus } from '../../../scripts/newsletter/lib/status-resolver.mjs';
import {
  resolvePlanRaw,
  resolveExpiryDate,
  resolveWithdrawalFlag,
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
 * Airtable records を分類して集計（純粋関数）
 *
 * @param {object} options
 * @param {Array<{id: string, fields: object}>} options.records - Airtable records
 * @param {string} options.brand - 'analytics-keiba' | 'keiba-intelligence'
 * @param {string} options.audienceTypeFilter - 'free' | 'light' | ... | '*'(全AudienceType合算)
 * @param {string} options.today - YYYY-MM-DD
 * @returns {{
 *   totalCustomers: number,
 *   matchedCount: number,
 *   withdrawnExcluded: number,
 *   audienceTypeBreakdown: Record<string, number>,
 *   matchedStatusBreakdown: Record<string, number>,
 * }}
 */
export function countAudience({ records, brand, audienceTypeFilter, today }) {
  if (!Array.isArray(records)) {
    throw new Error('records must be an array');
  }
  const baseName = BRAND_TO_BASE_NAME[brand];
  if (!baseName) {
    throw new Error(`unknown brand: ${brand}`);
  }
  const isAnalyticsKeiba = baseName === 'analytics-keiba';
  const filterAll = audienceTypeFilter === '*' || audienceTypeFilter === 'all';

  const audienceTypeBreakdown = {};
  const matchedStatusBreakdown = {};
  let matchedCount = 0;
  let withdrawnExcluded = 0;

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

    // AudienceType 全件 breakdown（参考情報、フィルタ前）
    const atKey = audienceType ?? '(null/unknown)';
    audienceTypeBreakdown[atKey] = (audienceTypeBreakdown[atKey] || 0) + 1;

    // 退会候補は matched から除外
    if (statusResult.suggestedStatus === 'withdrawn') {
      withdrawnExcluded += 1;
      continue;
    }

    // AudienceType フィルタ
    const matches = filterAll
      ? audienceType !== null
      : audienceType === audienceTypeFilter;
    if (!matches) continue;

    matchedCount += 1;

    const sKey = currentStatus || '(null/unknown)';
    matchedStatusBreakdown[sKey] = (matchedStatusBreakdown[sKey] || 0) + 1;
  }

  return {
    totalCustomers: records.length,
    matchedCount,
    withdrawnExcluded,
    audienceTypeBreakdown,
    matchedStatusBreakdown,
  };
}
