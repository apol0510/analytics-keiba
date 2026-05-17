// Customers フィールドのフォールバック取得（純粋関数、副作用ゼロ）
// 仕様: docs/NEWSLETTER_BRAND_BACKFILL_SPEC.md §4 / §5
//
// 2026-05-17 改訂:
//   - `??` 連鎖は null/undefined のみフォールスルーするため、`Plan=""` のような
//     空文字フィールドで停止し、後続の `プラン="Light"` まで届かない問題があった。
//   - これにより AK の Light 会員が free / expired に誤分類されていた（admin
//     real-count-only で matchedCount=0 を返す事象で発覚）。
//   - 全 resolver を `firstNonEmpty()` 経由に統一。null / undefined / 空白のみ /
//     空配列を「無効値」として扱い、最初に有効な値を採用する。

/**
 * 複数候補から最初の「有効値」を返す。
 *  - null / undefined / 空白のみの文字列 / 空配列 → 無効（次へフォールスルー）
 *  - 配列が非空なら先頭要素を文字列化して採用（Airtable Multi Select の典型形）
 *  - boolean / number など文字列以外はそのまま採用
 * @param  {...any} candidates
 * @returns {any|null}
 */
function firstNonEmpty(...candidates) {
  for (const v of candidates) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      const first = v[0];
      if (first === null || first === undefined) continue;
      const s = String(first).trim();
      if (s === '') continue;
      return s;
    }
    if (typeof v === 'string') {
      const s = v.trim();
      if (s === '') continue;
      return s;
    }
    return v;
  }
  return null;
}

/**
 * Email を lowercase + trim で正規化
 * @param {object} fields - Airtable record.fields
 * @returns {string} 正規化された email（空文字あり得る）
 */
export function resolveEmail(fields) {
  const v = firstNonEmpty(fields?.Email, fields?.email);
  if (v === null) return '';
  return String(v).trim().toLowerCase();
}

/**
 * 名前: Name → 名前 のフォールバック
 * @param {object} fields
 * @returns {string|null}
 */
export function resolveName(fields) {
  const v = firstNonEmpty(fields?.Name, fields?.['名前']);
  if (v === null) return null;
  return String(v).trim() || null;
}

/**
 * プラン原文の優先順:
 *   1. プラン  ← 日本語、analytics-keiba の現在の canonical（legacy admin もこれを最優先）
 *   2. PlanType ← keiba-intelligence の英語フィールド命名
 *   3. plan_type ← 同上の snake_case 変種
 *   4. Plan ← 旧フィールド（AK で空文字レコードが多数存在することが判明）
 *
 * 2026-05-17 改訂で順序を「日本語プラン優先」に変更。これにより AK で
 * Plan="" / プラン="Light" のレコードが正しく light に分類される。
 * keiba-intelligence は プラン フィールドを持たないため、PlanType 等が
 * 引き続き採用される（KI light=3 等の既存挙動を維持）。
 *
 * @param {object} fields
 * @returns {string|null}
 */
export function resolvePlanRaw(fields) {
  const v = firstNonEmpty(
    fields?.['プラン'],
    fields?.PlanType,
    fields?.plan_type,
    fields?.Plan,
  );
  if (v === null) return null;
  return typeof v === 'string' ? v : String(v).trim() || null;
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
    v = firstNonEmpty(fields?.['有効期限'], fields?.ExpiryDate);
  } else if (base === 'keiba-intelligence') {
    v = firstNonEmpty(fields?.['有効期限'], fields?.ExpirationDate);
  }
  if (v === null) return null;
  return typeof v === 'string' ? v : String(v).trim() || null;
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
