/**
 * premiumPlusEligibility.js — Premium Plus 販売資格の**書き込みフィールド**を組み立てる単一源
 *
 * Premium Plus の販売資格は Premium Sanrenpuku 権限・既存 Premium 権限・決済・メール機構とは
 * **完全に独立**している。このモジュールが返す fields には Plus 専用フィールドしか入らない
 * （`assertOnlyPlusFields` で機械的に強制する）。
 *
 * 絶対に書かない（＝ blocked にしても既存権限を一切変えない）:
 *   プラン / PlanType / Status / 有効期限 / PaidAt / LifetimeSanrenpuku /
 *   PaymentEmailSent / PaymentEmailStatus / WithdrawalRequested / Requested*
 *
 * 冪等性:
 *   - SanrenpukuPaidAt は**既に値があれば書き換えない**（初回購入確定日時を保持）
 *   - PremiumPlusEligibility は**未設定のときだけ** review を入れる。
 *     管理者が設定した eligible / blocked を決済 confirm の再実行で上書きしない。
 *
 * ⚠️ これらのフィールドは 2026-07-29 時点で **本番 Airtable に存在しない**。
 *    存在しないフィールドへ PATCH すると Airtable は 422 を返し、同じ PATCH に含まれる
 *    他の更新も落ちる。そのため書き込みは `isPlusFieldsEnabled(env)` で gate し、
 *    フィールド作成後に env を立てて有効化する（docs/PREMIUM_PLUS_STAGED_RELEASE.md）。
 */

import {
  PP_ELIGIBILITY,
  PP_ELIGIBILITY_FIELDS,
  SANRENPUKU_PAID_AT_FIELDS,
  normalizeEligibility,
} from './premiumPlusRelease.js';

/** 三連複購入確定日時の正本フィールド名（書き込みはこの 1 つだけ） */
export const SANRENPUKU_PAID_AT_FIELD = SANRENPUKU_PAID_AT_FIELDS[0]; // 'SanrenpukuPaidAt'

/** このモジュールが書いてよいフィールド（これ以外は構造的に禁止） */
export const PP_WRITABLE_FIELDS = Object.freeze([
  SANRENPUKU_PAID_AT_FIELD,
  PP_ELIGIBILITY_FIELDS.STATUS,
  PP_ELIGIBILITY_FIELDS.REASON,
  PP_ELIGIBILITY_FIELDS.ELIGIBLE_AT,
  PP_ELIGIBILITY_FIELDS.UPDATED_AT,
  PP_ELIGIBILITY_FIELDS.UPDATED_BY,
]);

/** 絶対に触れてはいけないフィールド（テストと実行時の両方で検査する） */
export const PP_FORBIDDEN_FIELDS = Object.freeze([
  'プラン', 'Plan', 'PlanType', 'Status', 'AccountStatus', '有効期限', 'ValidUntil',
  'ExpirationDate', 'PaidAt', 'LifetimeSanrenpuku', '三連複Lifetime',
  'PaymentEmailSent', 'PaymentEmailStatus', 'PaymentConfirmed',
  'WithdrawalRequested', 'WithdrawalDate', 'WithdrawalReason',
  'RequestedPlan', 'RequestedPlanType', 'RequestedAmount',
]);

const WRITABLE = new Set(PP_WRITABLE_FIELDS);

/** 内部メモの最大長（管理者だけが見る。顧客画面には出さない） */
export const PP_REASON_MAX_LENGTH = 200;

/**
 * Plus フィールドへの書き込みが有効か。
 * 本番 Airtable にフィールドを作成し終えるまで false のまま（fail closed）。
 */
export function isPlusFieldsEnabled(env) {
  return !!env && env.PREMIUM_PLUS_FIELDS_READY === '1';
}

/**
 * fields が Plus 専用フィールドだけで構成されているか検査する。
 * 1 つでも許可外があれば false（呼び出し側は PATCH しない）。
 */
export function assertOnlyPlusFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  if (keys.length === 0) return false;
  return keys.every((k) => WRITABLE.has(k));
}

function toIso(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? value.toISOString() : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * 三連複の入金確認（昇格成功）**後**に書く Premium Plus 初期化フィールド。
 *
 * - SanrenpukuPaidAt: 未設定のときだけ入れる（再実行で購入確定日時を更新しない）
 * - PremiumPlusEligibility: 未設定のときだけ review を入れる（管理者判断を上書きしない）
 * - 書くものが何も無ければ null（呼び出し側は PATCH 自体を行わない）
 *
 * ⚠️ ここが失敗しても三連複の昇格・メールを巻き戻してはいけない（呼び出し側の責務）。
 *
 * @param {{ fields?: object|null, confirmedAt: Date|number }} input 現在の Airtable fields と入金確認日時
 * @returns {{ fields: Record<string, unknown> }|null}
 */
export function buildSanrenpukuPlusInitFields({ fields, confirmedAt }) {
  const iso = toIso(confirmedAt);
  if (!iso) return null;
  const f = fields && typeof fields === 'object' ? fields : {};
  const out = {};

  const paidAtExisting = SANRENPUKU_PAID_AT_FIELDS.some((k) => hasValue(f[k]));
  if (!paidAtExisting) out[SANRENPUKU_PAID_AT_FIELD] = iso;

  const eligibilityRaw = f[PP_ELIGIBILITY_FIELDS.STATUS];
  if (!hasValue(eligibilityRaw)) {
    // 新規候補の初期値は review。自動で eligible にしない。
    out[PP_ELIGIBILITY_FIELDS.STATUS] = PP_ELIGIBILITY.REVIEW;
    out[PP_ELIGIBILITY_FIELDS.UPDATED_AT] = iso;
    out[PP_ELIGIBILITY_FIELDS.UPDATED_BY] = 'system:sanrenpuku-confirm';
  }

  if (Object.keys(out).length === 0) return null;
  if (!assertOnlyPlusFields(out)) return null;
  return { fields: out };
}

/**
 * 管理画面からの販売資格変更で書くフィールド。
 * 表示資格だけを変える。課金・昇格・メール・Status は一切変更しない。
 *
 * ── PremiumPlusEligibleAt（段階公開 anchor）の更新規則 ─────────────────
 *   **review / blocked → eligible の実遷移のときだけ** now を書く。
 *   それ以外では **一切 touch しない**（Airtable の既存値がそのまま残る）:
 *     - eligible → eligible の再保存（内部メモだけの変更を含む）
 *     - eligible → blocked / review（解除前の許可日時を消さない）
 *     - blocked → review など eligible を経由しない遷移
 *   これにより「メモを直したら phase が Day 0 に戻る」事故を構造的に防ぐ。
 *   blocked / review から再度 eligible にしたときは、その**再解除日時**へ更新される。
 *
 *   PremiumPlusEligibilityUpdatedAt は純粋な監査日時なので毎回更新する（phase には使わない）。
 *
 * @param {{
 *   next: unknown,
 *   current?: unknown,   変更前の PremiumPlusEligibility 生値（未設定なら review 相当）
 *   reason?: unknown,
 *   actor?: unknown,
 *   now: Date|number,
 * }} input
 * @returns {{ fields: Record<string, unknown>, next: string, eligibleAtUpdated: boolean }|null}
 *   不正な next なら null
 */
export function buildEligibilityUpdateFields({ next, current, reason, actor, now }) {
  const raw = (next == null ? '' : String(next)).trim().toLowerCase();
  // 未知の値を review に丸めない（管理操作は明示的な 3 値のみ受け付ける）
  if (raw !== PP_ELIGIBILITY.ELIGIBLE && raw !== PP_ELIGIBILITY.REVIEW && raw !== PP_ELIGIBILITY.BLOCKED) {
    return null;
  }
  const iso = toIso(now);
  if (!iso) return null;

  const nextStatus = normalizeEligibility(raw);
  const currentStatus = normalizeEligibility(current); // 未設定・不正値は review 相当

  const out = {
    [PP_ELIGIBILITY_FIELDS.STATUS]: nextStatus,
    [PP_ELIGIBILITY_FIELDS.UPDATED_AT]: iso,
    [PP_ELIGIBILITY_FIELDS.UPDATED_BY]: String(actor || 'admin').slice(0, 64),
  };

  // eligible への「実遷移」だけが anchor を動かす
  const isTransitionToEligible =
    nextStatus === PP_ELIGIBILITY.ELIGIBLE && currentStatus !== PP_ELIGIBILITY.ELIGIBLE;
  if (isTransitionToEligible) {
    out[PP_ELIGIBILITY_FIELDS.ELIGIBLE_AT] = iso;
  }

  if (reason !== undefined) {
    out[PP_ELIGIBILITY_FIELDS.REASON] = String(reason ?? '').slice(0, PP_REASON_MAX_LENGTH);
  }

  if (!assertOnlyPlusFields(out)) return null;
  return { fields: out, next: nextStatus, eligibleAtUpdated: isTransitionToEligible };
}
