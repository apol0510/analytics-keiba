// Status の SuggestedStatus 算出（純粋関数）
// 仕様: docs/NEWSLETTER_BRAND_BACKFILL_SPEC.md §7
//
// 基本方針:
//   - 既存 Status (active / pending / cancelled / suspended / expired / withdrawn / 等) は
//     原則そのまま保持
//   - 例外:
//     - 退会候補 (WithdrawalRequested=true) → SuggestedStatus=withdrawn（候補）
//     - active かつ 期限切れ → SuggestedStatus=expired（候補、2026-05-16 改訂）
//   - 自動 PATCH はせず Reason 列で候補値を提示、NeedsManualReview=true で人間判断に投げる
//
// 2026-05-16 改訂:
//   - active かつ期限切れ → SuggestedStatus を 'active' から 'expired' に変更（候補として）
//     plan-normalizer の AudienceType=expired と整合させる
//   - Status が既に expired / cancelled / suspended / withdrawn の場合は active-but-expired
//     を発火させない（過度な警告を出さない）

/**
 * @param {object} options
 * @param {string|null} options.currentStatus
 * @param {boolean|null} options.withdrawalRequested - analytics-keiba のみ意味あり。
 *                                                     keiba-intelligence では null
 * @param {string|null} options.expiryDate - ISO 形式の期限日 (YYYY-MM-DD or ISO 8601)
 * @param {string|null} options.today - 比較基準日 (YYYY-MM-DD)
 * @param {boolean} options.isAnalyticsKeiba - true なら analytics-keiba Base のロジック
 * @returns {{ suggestedStatus: string|null, reasons: string[], needsManualReview: boolean }}
 */
export function resolveStatus({
  currentStatus = null,
  withdrawalRequested = null,
  expiryDate = null,
  today = null,
  isAnalyticsKeiba = false,
} = {}) {
  const reasons = [];
  let suggestedStatus = currentStatus ?? null;
  let needsManualReview = false;

  // §7.2 退会候補 (最優先)
  const isWithdrawnSignal =
    (isAnalyticsKeiba && withdrawalRequested === true) || currentStatus === 'withdrawn';

  if (isWithdrawnSignal) {
    if (currentStatus !== 'withdrawn') {
      reasons.push('withdrawal-flag-set-but-status-not-withdrawn');
      suggestedStatus = 'withdrawn';
      needsManualReview = true;
    } else {
      suggestedStatus = 'withdrawn';
    }
    // withdrawal はここで決定。expired / pending チェックはスキップ
    return { suggestedStatus, reasons, needsManualReview };
  }

  // §7.4 active + 期限切れ → SuggestedStatus=expired 候補（2026-05-16 改訂）
  //   currentStatus が active 以外（pending / cancelled / suspended / expired 等）の場合は発火しない
  //   = 過度な警告を出さず、AudienceType=expired での分類で完結させる
  if (currentStatus === 'active' && expiryDate != null && today != null) {
    if (String(expiryDate) < String(today)) {
      reasons.push(`active-but-expired: expiry=${expiryDate}`);
      suggestedStatus = 'expired'; // 旧: active のまま → 新: expired 候補
      needsManualReview = true;
    }
  }

  // §7.3 pending → unpaid 候補（自動変更せず Reason に記録）
  if (currentStatus === 'pending') {
    reasons.push("status-pending may be 'unpaid' (manual review)");
    needsManualReview = true;
    // suggestedStatus は pending のまま（人間判断）
  }

  return { suggestedStatus, reasons, needsManualReview };
}
