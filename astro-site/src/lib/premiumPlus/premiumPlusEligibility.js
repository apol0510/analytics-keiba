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
  PP_RELEASE_OVERRIDE,
  PP_SALE_PAUSE_FIELDS,
  SANRENPUKU_PAID_AT_FIELDS,
  normalizeEligibility,
  normalizeReleaseOverride,
  normalizeSalePaused,
} from './premiumPlusRelease.js';

/** 三連複購入確定日時の正本フィールド名（書き込みはこの 1 つだけ） */
export const SANRENPUKU_PAID_AT_FIELD = SANRENPUKU_PAID_AT_FIELDS[0]; // 'SanrenpukuPaidAt'

/** このモジュールが書いてよいフィールド（これ以外は構造的に禁止） */
export const PP_WRITABLE_FIELDS = Object.freeze([
  SANRENPUKU_PAID_AT_FIELD,
  PP_ELIGIBILITY_FIELDS.STATUS,
  PP_ELIGIBILITY_FIELDS.REASON,
  PP_ELIGIBILITY_FIELDS.ELIGIBLE_AT,
  PP_ELIGIBILITY_FIELDS.OVERRIDE,
  PP_ELIGIBILITY_FIELDS.UPDATED_AT,
  PP_ELIGIBILITY_FIELDS.UPDATED_BY,
  PP_SALE_PAUSE_FIELDS.PAUSED,
  PP_SALE_PAUSE_FIELDS.UPDATED_AT,
  PP_SALE_PAUSE_FIELDS.UPDATED_BY,
  PP_SALE_PAUSE_FIELDS.REASON,
]);

/** 管理画面の操作 */
export const PP_ADMIN_ACTION = Object.freeze({
  /** 段階公開で販売可: eligible ＋ override 解除（PHASE 1 から開始） */
  STAGED: 'staged',
  /** 今すぐ販売可: eligible ＋ override='phase4'（即 PHASE 4） */
  IMMEDIATE: 'immediate',
  /** 保留 */
  REVIEW: 'review',
  /** 販売対象外 */
  BLOCKED: 'blocked',
  /**
   * この会員だけ販売を一時停止する。
   * ⚠️ 資格（eligibility）・override・anchor を**一切変更しない**。再開で元に戻る。
   */
  PAUSE_SALE: 'pauseSale',
  /** 一時停止を解除する（同じ場所から 1 クリックで戻す） */
  RESUME_SALE: 'resumeSale',
});

/** 資格そのものを変える操作（＝ eligibility を書く操作）だけの集合 */
export const PP_ELIGIBILITY_ACTIONS = Object.freeze([
  PP_ADMIN_ACTION.STAGED, PP_ADMIN_ACTION.IMMEDIATE,
  PP_ADMIN_ACTION.REVIEW, PP_ADMIN_ACTION.BLOCKED,
]);

/** 販売の一時停止/再開だけを変える操作 */
export const PP_SALE_PAUSE_ACTIONS = Object.freeze([
  PP_ADMIN_ACTION.PAUSE_SALE, PP_ADMIN_ACTION.RESUME_SALE,
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
 * `PremiumPlusReleaseOverride` フィールドへの書き込みが有効か。
 *
 * このフィールドは PremiumPlusEligibility 系（PREMIUM_PLUS_FIELDS_READY）より**後から**
 * 追加するため、gate を分けている。未作成の本番へ含めて PATCH すると Airtable が 422 を返し、
 * **同じ PATCH の eligibility 更新まで巻き添えで失敗する**ため、独立した gate が必要。
 * 無効の間は override フィールドを PATCH に含めず、「今すぐ販売可」も受け付けない（fail closed）。
 */
export function isReleaseOverrideEnabled(env) {
  return isPlusFieldsEnabled(env) && env.PREMIUM_PLUS_OVERRIDE_READY === '1';
}

/**
 * 販売 一時停止フィールド（`PremiumPlusSalePaused` 系 4 つ）への**書き込み**が有効か。
 *
 * override と同じ理由で gate を分ける: これらは後から追加するフィールドで、
 * 未作成の本番へ含めて PATCH すると Airtable が 422 を返し、**同じ PATCH の
 * 他の更新まで巻き添えで失敗する**。
 *
 * ⚠️ gate が off の間は「停止する」操作を**受け付けない**（fail closed）。
 *    書けないのに画面上だけ停止したように見せると、**止めたつもりで売れ続ける**という
 *    最悪の誤解が生まれる。読み取り（未設定 = 停止していない）に gate は不要。
 */
export function isSalePauseEnabled(env) {
  return isPlusFieldsEnabled(env) && env.PREMIUM_PLUS_SALE_PAUSE_READY === '1';
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

/**
 * 管理画面の 4 操作 → PATCH フィールド。
 *
 * | 操作 | eligibility | override | EligibleAt |
 * |---|---|---|---|
 * | 段階公開で販売可 (staged)   | eligible | **解除** | 非 eligible からの遷移時のみ now |
 * | 今すぐ販売可 (immediate)    | eligible | **phase4** | 同上 |
 * | 保留 (review)              | review  | **解除** | touch しない |
 * | 販売対象外 (blocked)        | blocked | **解除** | touch しない |
 *
 * - override は review / blocked へ落とすとき必ず解除する。残したままだと、後で再び
 *   eligible にした瞬間に「意図しない即時販売」が復活してしまう。
 * - 即時販売 → 段階公開へ戻すときは **override だけ**を消し、EligibleAt は書き換えない
 *   （元の販売許可日から通常の段階公開が再開する）。
 * - override フィールドが未作成（gate off）のときに immediate を要求されたら null を返す
 *   （呼び出し側は 503 にする）。staged / review / blocked は override を PATCH に含めずに続行できる。
 *
 * @param {{
 *   action: string,
 *   current?: unknown,          変更前の PremiumPlusEligibility 生値
 *   currentOverride?: unknown,  変更前の PremiumPlusReleaseOverride 生値
 *   reason?: unknown,
 *   actor?: unknown,
 *   now: Date|number,
 *   overrideFieldEnabled?: boolean, override フィールドが本番に存在するか
 * }} input
 * @returns {{ fields: Record<string, unknown>, next: string, override: string|null,
 *             eligibleAtUpdated: boolean, overrideChanged: boolean }|null}
 */
export function buildAdminActionFields({
  action, current, currentOverride, reason, actor, now, overrideFieldEnabled = false,
}) {
  const a = (action == null ? '' : String(action)).trim().toLowerCase();
  const wantsImmediate = a === PP_ADMIN_ACTION.IMMEDIATE;

  let nextStatus;
  if (a === PP_ADMIN_ACTION.STAGED || wantsImmediate) nextStatus = PP_ELIGIBILITY.ELIGIBLE;
  else if (a === PP_ADMIN_ACTION.REVIEW) nextStatus = PP_ELIGIBILITY.REVIEW;
  else if (a === PP_ADMIN_ACTION.BLOCKED) nextStatus = PP_ELIGIBILITY.BLOCKED;
  else return null; // 未知の操作は丸めずに拒否

  // 「今すぐ販売可」は override フィールドが無ければ成立しない（fail closed）
  if (wantsImmediate && !overrideFieldEnabled) return null;

  const base = buildEligibilityUpdateFields({ next: nextStatus, current, reason, actor, now });
  if (!base) return null;

  const nextOverride = wantsImmediate ? PP_RELEASE_OVERRIDE.PHASE4 : null;
  const prevOverride = normalizeReleaseOverride(currentOverride);
  let overrideChanged = false;

  if (overrideFieldEnabled && nextOverride !== prevOverride) {
    // 解除は空文字で表現する（single select を未選択に戻す）
    base.fields[PP_ELIGIBILITY_FIELDS.OVERRIDE] = nextOverride === null
      ? PP_RELEASE_OVERRIDE.NONE
      : nextOverride;
    overrideChanged = true;
  }

  if (!assertOnlyPlusFields(base.fields)) return null;
  return {
    fields: base.fields,
    next: base.next,
    override: nextOverride,
    eligibleAtUpdated: base.eligibleAtUpdated,
    overrideChanged,
  };
}

/**
 * 会員単位の「販売中 ⇔ 一時停止」で書くフィールド。
 *
 * ── 何を書かないか（ここが肝）─────────────────────────────────
 * `PremiumPlusEligibility` / `PremiumPlusEligibleAt` / `PremiumPlusReleaseOverride` を
 * **一切書かない**。停止は資格と独立した軸なので、
 *   - 停止しても「販売可」の資格はそのまま残る
 *   - 再開しても段階公開の anchor が動かない（PHASE が Day 0 へ戻らない）
 * これが blocked / review で代用できない理由そのもの。
 *
 * ── 冪等 ────────────────────────────────────────────────────
 * 既に同じ状態なら `changed:false` を返し、**PATCH させない**
 * （監査日時だけが無意味に更新され続けるのを防ぐ）。
 *
 * ── 再開時に理由を残すか ────────────────────────────────────
 * 再開では停止理由をクリアする（次に止めたときの理由と混ざらないため）。
 * 監査の日時・操作者は毎回更新する。
 *
 * @param {{
 *   paused: boolean,          これから設定したい状態（true=停止 / false=再開）
 *   current?: unknown,        変更前の PremiumPlusSalePaused 生値
 *   reason?: unknown,         停止理由（停止時のみ意味を持つ）
 *   actor?: unknown,
 *   now: Date|number,
 *   enabled?: boolean,        フィールドが本番に存在するか（isSalePauseEnabled）
 * }} input
 * @returns {{ fields: Record<string, unknown>, paused: boolean, changed: boolean }|null}
 *   フィールド未作成（enabled=false）なら null（呼び出し側は 503。fail closed）
 */
export function buildSalePauseFields({ paused, current, reason, actor, now, enabled = false }) {
  if (typeof paused !== 'boolean') return null;
  // 書けないなら「止めた」と言わせない（画面だけ停止＝売れ続ける事故を防ぐ）
  if (!enabled) return null;
  const iso = toIso(now);
  if (!iso) return null;

  const prev = normalizeSalePaused(current);
  if (prev === paused) {
    return { fields: {}, paused, changed: false };
  }

  const out = {
    [PP_SALE_PAUSE_FIELDS.PAUSED]: paused,
    [PP_SALE_PAUSE_FIELDS.UPDATED_AT]: iso,
    [PP_SALE_PAUSE_FIELDS.UPDATED_BY]: String(actor || 'admin').slice(0, 64),
  };
  // 停止時だけ理由を保存し、再開ではクリアする
  out[PP_SALE_PAUSE_FIELDS.REASON] = paused
    ? String(reason ?? '').slice(0, PP_REASON_MAX_LENGTH)
    : '';

  if (!assertOnlyPlusFields(out)) return null;
  // 資格系を巻き添えで書いていないことを構造的に確認する
  for (const k of [
    PP_ELIGIBILITY_FIELDS.STATUS,
    PP_ELIGIBILITY_FIELDS.ELIGIBLE_AT,
    PP_ELIGIBILITY_FIELDS.OVERRIDE,
  ]) {
    if (k in out) return null;
  }
  return { fields: out, paused, changed: true };
}
