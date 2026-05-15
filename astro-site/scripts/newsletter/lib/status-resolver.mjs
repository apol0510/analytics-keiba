// Status の SuggestedStatus 算出（純粋関数）
// 仕様: docs/NEWSLETTER_BRAND_BACKFILL_SPEC.md §7
//
// 基本方針: 既存 Status は原則そのまま保持。SuggestedStatus は提案値として出すだけ。
// 退会・期限切れ・pending の場合は Reason に出して NeedsManualReview=true にする。

/**
 * @param {object} options
 * @param {string|null} options.currentStatus
 * @param {boolean|null} options.withdrawalRequested - analytics-keiba のみ意味あり。
 *                                                     keiba-intelligence では null
 * @param {string|null} options.expiryDate - ISO 形式の期限日 (YYYY-MM-DD)
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

  // §7.2 退会候補
  const isWithdrawnSignal =
    (isAnalyticsKeiba && withdrawalRequested === true) || currentStatus === 'withdrawn';

  if (isWithdrawnSignal) {
    if (currentStatus !== 'withdrawn') {
      // フラグ立ってるが Status 未反映 → withdrawn 候補として提案
      reasons.push('withdrawal-flag-set-but-status-not-withdrawn');
      suggestedStatus = 'withdrawn';
      needsManualReview = true;
    } else {
      // 既に withdrawn → そのまま保持（manual review 不要）
      suggestedStatus = 'withdrawn';
    }
  }

  // §7.4 期限切れ候補（自動上書きせず Reason に記録）
  if (currentStatus === 'active' && expiryDate && today) {
    if (String(expiryDate) < String(today)) {
      reasons.push(`active-but-expired: expiry=${expiryDate}`);
      needsManualReview = true;
      // suggestedStatus は active のまま（人間判断）
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
