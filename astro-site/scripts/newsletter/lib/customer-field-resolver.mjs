// Customers フィールドのフォールバック取得（純粋関数、副作用ゼロ）
// 仕様: docs/NEWSLETTER_BRAND_BACKFILL_SPEC.md §4 / §5

/**
 * Email を lowercase + trim で正規化
 * @param {object} fields - Airtable record.fields
 * @returns {string} 正規化された email（空文字あり得る）
 */
export function resolveEmail(fields) {
  const raw = fields?.Email ?? fields?.email ?? '';
  return String(raw).trim().toLowerCase();
}

/**
 * 名前: Name → 名前 のフォールバック
 * @param {object} fields
 * @returns {string|null}
 */
export function resolveName(fields) {
  const v = fields?.Name ?? fields?.['名前'] ?? null;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * プラン原文: PlanType → plan_type → Plan → プラン のフォールバック
 * @param {object} fields
 * @returns {string|null}
 */
export function resolvePlanRaw(fields) {
  const v =
    fields?.PlanType ??
    fields?.plan_type ??
    fields?.Plan ??
    fields?.['プラン'] ??
    null;
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * 期限日: Base 別フォールバック
 *  - analytics-keiba: 有効期限 → ExpiryDate
 *  - keiba-intelligence: 有効期限 → ExpirationDate
 *
 * @param {object} fields
 * @param {'analytics-keiba'|'keiba-intelligence'} base
 * @returns {string|null} YYYY-MM-DD 形式（パース不能ならそのまま元値返す）
 */
export function resolveExpiryDate(fields, base) {
  let v = null;
  if (base === 'analytics-keiba') {
    v = fields?.['有効期限'] ?? fields?.ExpiryDate ?? null;
  } else if (base === 'keiba-intelligence') {
    v = fields?.['有効期限'] ?? fields?.ExpirationDate ?? null;
  }
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * 退会フラグ: analytics-keiba のみ WithdrawalRequested を返す
 * keiba-intelligence は存在しないので null
 *
 * @param {object} fields
 * @param {'analytics-keiba'|'keiba-intelligence'} base
 * @returns {boolean|null}
 */
export function resolveWithdrawalFlag(fields, base) {
  if (base === 'analytics-keiba') {
    const v = fields?.WithdrawalRequested;
    if (v === true || v === false) return v;
    return null;
  }
  // keiba-intelligence にこのフィールドは存在しない
  return null;
}

/**
 * Multi-select / Single select の現在値を文字列化
 * @param {string|string[]|null|undefined} v
 * @returns {string}
 */
export function stringifyMultiSelect(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join('|');
  return String(v);
}
