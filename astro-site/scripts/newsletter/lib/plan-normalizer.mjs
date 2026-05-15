// プラン値 → AudienceType 正規化（純粋関数、副作用ゼロ）
// 仕様: docs/NEWSLETTER_BRAND_BACKFILL_SPEC.md §6

/**
 * 基本ルール: プラン原文から AudienceType を判定（§6.1）
 * @param {string|null|undefined} planRaw
 * @returns {{ audienceType: string|null, reason: string|null }}
 */
function baseRule(planRaw) {
  if (planRaw === null || planRaw === undefined || String(planRaw).trim() === '') {
    return { audienceType: 'free', reason: 'plan-empty-default-free' };
  }
  const raw = String(planRaw).trim();
  const lower = raw.toLowerCase();

  // premium-combo を premium より先に判定（順序重要）
  if (lower.includes('premium combo') || lower.includes('premium-combo')) {
    return { audienceType: 'premium-combo', reason: 'plan-matched:premium-combo' };
  }
  if (lower.includes('premium')) {
    return { audienceType: 'premium', reason: 'plan-matched:premium' };
  }
  if (lower === 'free' || raw === 'フリー' || raw === '無料' || raw === '無料会員') {
    return { audienceType: 'free', reason: 'plan-matched:free' };
  }
  if (lower === 'light' || raw === 'ライト') {
    return { audienceType: 'light', reason: 'plan-matched:light' };
  }
  if (lower === 'standard' || raw === 'スタンダード') {
    return { audienceType: 'standard', reason: 'plan-matched:standard' };
  }
  if (lower.includes('test') || raw.includes('テスト')) {
    return { audienceType: 'admin-test', reason: 'plan-matched:admin-test' };
  }
  return { audienceType: null, reason: null };
}

/**
 * AudienceType を補正ロジック込みで正規化する
 * 優先順（後勝ち上書き）: 平常 → 期限切れ → 未入金 → 退会
 *
 * @param {string|null|undefined} planRaw
 * @param {object} [options]
 * @param {string|null} [options.status] - Customers.Status 現在値
 * @param {string|null} [options.expiryDate] - ISO 形式の期限日 (YYYY-MM-DD)
 * @param {string|null} [options.today] - 比較基準日 (YYYY-MM-DD)、未指定なら今日(UTC)
 * @param {boolean} [options.withdrawn] - 退会判定（true で SuggestedStatus は別途 withdrawn 提案）
 * @returns {{ audienceType: string|null, planResolvedLabel: string|null, reasons: string[], warning: string }}
 */
export function normalizeAudienceType(planRaw, options = {}) {
  const { status = null, expiryDate = null, today = null } = options;
  const reasons = [];
  let warning = '';

  // §6.1 base rule
  const base = baseRule(planRaw);
  let audienceType = base.audienceType;
  const planResolvedLabel = base.audienceType; // 元判定を保持
  if (base.reason) {
    reasons.push(base.reason);
  } else {
    warning = `unknown plan: ${String(planRaw).trim()}`;
  }

  // §6.2 expired correction
  if (audienceType && ['premium', 'premium-combo', 'standard', 'light'].includes(audienceType)) {
    if (expiryDate && today) {
      // ISO 日付の文字列比較で十分（同じ YYYY-MM-DD 形式前提）
      if (String(expiryDate) < String(today)) {
        reasons.push(`plan-expired: original=${audienceType}, expiry=${expiryDate}`);
        audienceType = 'expired';
      }
    }
  }

  // §6.3 unpaid correction
  if (status === 'pending') {
    if (audienceType !== 'unpaid') {
      reasons.push(`status-pending: original=${audienceType ?? 'null'}`);
      audienceType = 'unpaid';
    }
  }

  // §6.4 withdrawal は status-resolver 側で suggestedStatus に反映する
  // ここでは AudienceType に退会を表さない

  return { audienceType, planResolvedLabel, reasons, warning };
}
