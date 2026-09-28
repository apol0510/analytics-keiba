/**
 * premiumConversion.js — Light → Premium 転換履歴（Customers の正本側に残す・純粋）
 *
 * ## なぜ要るか（2026-09-28 MK 確定）
 *
 * 昇格すると `プラン` / `PlanType` が上書きされ、元が Light だったことが残らない。
 * そのため「Light から Premium に何人上がったか」を後から数えられなかった
 * （`docs/spec.md`「AK の商品・価格の事業境界」是正 4）。
 *
 * ## 最小の履歴（既存の命名 `PaidAt` / `SanrenpukuPaidAt` に合わせる）
 *
 * | フィールド | 型 | 中身 |
 * |---|---|---|
 * | `PremiumConvertedFrom` | 1 行テキスト | 転換前のプラン。例 `Light/Monthly`。期限切れだったら `Light/Monthly（期限切れ）` |
 * | `PremiumConvertedAt` | 日時（PaidAt と同じ形式）| Premium へ転換した日時（入金確認の日時）|
 *
 * ## 書く条件（どれか 1 つでも外れたら何も書かない）
 *   - 昇格後のプランが **Premium**（canonical `premium`。三連複・Plus 等は対象外）
 *   - 昇格前のプランが **Light**（canonical `light`。旧 Standard も Light 扱い）
 *   - **`PremiumConvertedAt` がまだ空**（最初の転換だけを残す。再実行・後日の更新・再購入で上書きしない）
 *
 * ⚠️ 顧客レコードのそれ以外の項目・料金・権利・販売条件には一切触れない。
 * ⚠️ 書き込みは昇格 PATCH の**後に別 PATCH**（best effort。失敗しても昇格は巻き戻さない）。
 */
import { normalizePlan } from '../auth/planNormalization.js';

export const PREMIUM_CONVERTED_FROM_FIELD = 'PremiumConvertedFrom';
export const PREMIUM_CONVERTED_AT_FIELD = 'PremiumConvertedAt';
export const PREMIUM_CONVERSION_FIELDS = Object.freeze([PREMIUM_CONVERTED_FROM_FIELD, PREMIUM_CONVERTED_AT_FIELD]);
export const PREMIUM_CONVERSION_TAG = '[premium-conversion]';

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

/** 有効期限（'YYYY-MM-DD' か ISO）が確定時刻より前なら期限切れ */
function isExpiredAt(expiration, confirmedAt) {
  if (isBlank(expiration)) return false;
  const s = String(expiration).trim();
  const endMs = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T23:59:59+09:00`) : Date.parse(s);
  if (!Number.isFinite(endMs)) return false;
  return endMs < confirmedAt.getTime();
}

/**
 * 転換履歴として書くフィールド。書かないときは null。
 *
 * @param {{ previousFields: object, confirmationFields: object, confirmedAt: Date }} args
 *   previousFields: 昇格 PATCH **前**に読んだ Customers の fields
 *   confirmationFields: 昇格 PATCH で書いた fields（`プラン` を見る）
 */
export function buildPremiumConversionFields({ previousFields, confirmationFields, confirmedAt } = {}) {
  const prev = previousFields || {};
  const next = confirmationFields || {};
  if (!(confirmedAt instanceof Date) || !Number.isFinite(confirmedAt.getTime())) return null;
  if (normalizePlan(next['プラン']) !== 'premium') return null;
  if (normalizePlan(prev['プラン']) !== 'light') return null;
  if (!isBlank(prev[PREMIUM_CONVERTED_AT_FIELD])) return null; // 最初の転換だけを残す（冪等）

  const planType = isBlank(prev.PlanType) ? '不明' : String(prev.PlanType).trim();
  const expired = isExpiredAt(prev['有効期限'] ?? prev.ExpirationDate, confirmedAt);
  return {
    [PREMIUM_CONVERTED_FROM_FIELD]: `Light/${planType}${expired ? '（期限切れ）' : ''}`,
    [PREMIUM_CONVERTED_AT_FIELD]: confirmedAt.toISOString(),
  };
}

/** 別 PATCH に載せてよいのは転換履歴の 2 項目だけ（他の項目を巻き込まない）*/
export function assertOnlyConversionFields(fields) {
  const keys = Object.keys(fields || {});
  return keys.length > 0 && keys.every((k) => PREMIUM_CONVERSION_FIELDS.includes(k));
}
