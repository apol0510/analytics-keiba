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
  // free-registered / free registered / free-* は free 扱い
  // （keiba-intelligence の verify-magic-link.js:117 が default に 'free-registered' を使うため
  //  既存運用で頻出する。'free' の前にチェックして prefix 漏れを防ぐ）
  if (lower === 'free-registered' || lower === 'free registered' || lower.startsWith('free-')) {
    return { audienceType: 'free', reason: 'plan-matched:free-registered' };
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
  // pro / pro-plus は keiba-intelligence の verify-magic-link.js:155 で
  // ['pro', 'pro-plus', 'premium', 'premium-plus', 'standard', 'light'] と
  // 同じ paid 扱いされている。当面はメルマガ配信ターゲットとして premium に集約する
  // （AudienceType に 'pro' 枠は作らない。文面差別化が必要になったら別タスクで分離）。
  if (lower === 'pro' || lower === 'pro-plus' || lower === 'pro plus') {
    return { audienceType: 'premium', reason: 'plan-matched:pro-as-premium' };
  }
  // Monthly は「課金サイクル / 支払い区分」であり、プラン種別そのものではない。
  // 現在 Stripe / PayPal は使われておらず、銀行振込ユーザーにも Monthly が入る。
  // よって Monthly = premium とは断定できないため自動分類しない（unknown plan のまま）。
  // - 期限切れ Monthly → §6.2 で expired に分類
  // - pending Monthly → §6.3 で unpaid に分類
  // - active かつ有効期限内 Monthly → unknown plan のまま NeedsManualReview=true で人間判断
  if (lower.includes('test') || raw.includes('テスト')) {
    return { audienceType: 'admin-test', reason: 'plan-matched:admin-test' };
  }
  return { audienceType: null, reason: null };
}

/**
 * AudienceType を補正ロジック込みで正規化する
 *
 * 優先順（後勝ち上書き、AudienceType 値の決定順）:
 *   1. WithdrawalRequested=true / Status=withdrawn → status-resolver で扱う
 *      （ここでは AudienceType を withdrawn にしない、SuggestedStatus を別途出す）
 *   2. 有効期限切れ → AudienceType=expired（全プラン・全 status 共通、最優先）
 *   3. Status=pending → AudienceType=unpaid（expired より弱い）
 *   4. プラン名判定 → free / light / standard / premium / premium-combo / admin-test
 *   5. unknown plan → AudienceType=null + warning（NeedsManualReview=true）
 *
 * 2026-05-16 改訂:
 *   - 期限切れ補正は **全 AudienceType 共通**（旧: paid プランのみ）
 *   - unknown plan でも有効期限切れなら expired に分類（reason: audience-expired-by-date）
 *   - expired 分類時は unknown plan warning を suppress（過度な警告防止）
 *   - 補正順を「pending → expired」に変更（expired 優先のため後勝ち）
 *
 * @param {string|null|undefined} planRaw
 * @param {object} [options]
 * @param {string|null} [options.status] - Customers.Status 現在値
 * @param {string|null} [options.expiryDate] - ISO 形式の期限日 (YYYY-MM-DD or ISO 8601)
 * @param {string|null} [options.today] - 比較基準日 (YYYY-MM-DD)、未指定ならスキップ
 * @returns {{ audienceType: string|null, planResolvedLabel: string|null, reasons: string[], warning: string }}
 */
export function normalizeAudienceType(planRaw, options = {}) {
  const { status = null, expiryDate = null, today = null } = options;
  const reasons = [];
  let warning = '';

  // Step 1: base rule (§6.1) - プラン名から base AudienceType を決定
  const base = baseRule(planRaw);
  let audienceType = base.audienceType;
  const planResolvedLabel = base.audienceType; // 元判定を保持
  if (base.reason) {
    reasons.push(base.reason);
  } else {
    warning = `unknown plan: ${String(planRaw).trim()}`;
  }

  // Step 2: pending → unpaid 補正 (§6.3)
  //   expired 補正より先に実行する（expired が後勝ちで上書きできるように）
  if (status === 'pending') {
    if (audienceType !== 'unpaid' && audienceType !== null) {
      reasons.push(`status-pending: original=${audienceType}`);
      audienceType = 'unpaid';
    } else if (audienceType === null) {
      // unknown plan + pending → unpaid に分類（unknown warning は残す: pending データ品質警告として有効）
      reasons.push('status-pending: original=null');
      audienceType = 'unpaid';
    }
  }

  // Step 3: 期限切れ補正 (§6.2、全 AudienceType 共通)
  //   AudienceType に対して最優先（withdrawn 除く）。free / unpaid / unknown 含む全パターンを expired に寄せる。
  //   unknown plan 由来の warning は expired で分類された時点で suppress
  //   （pending が間に挟まって audienceType=unpaid 経由でも同様）。
  const isExpired = expiryDate != null && today != null && String(expiryDate) < String(today);
  if (isExpired) {
    if (audienceType === null) {
      // unknown plan → 期限切れで分類
      reasons.push(`audience-expired-by-date: expiry=${expiryDate}`);
      audienceType = 'expired';
    } else if (audienceType !== 'expired') {
      reasons.push(`plan-expired: original=${audienceType}, expiry=${expiryDate}`);
      audienceType = 'expired';
    }
    // unknown plan warning は expired 分類で suppress（pending 経由含む）
    if (warning.startsWith('unknown plan')) {
      warning = '';
    }
  }

  // Step 4: withdrawal は status-resolver 側で SuggestedStatus に反映する
  //   ここでは AudienceType を withdrawn にしない。
  //   （AudienceType の値域に withdrawn は含まれない、SuggestedStatus=withdrawn のみ）

  return { audienceType, planResolvedLabel, reasons, warning };
}
