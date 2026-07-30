/**
 * promotionalGrants.js — カムバック特典（無料 entitlement）の単一源（純粋・I/O なし）
 *
 * ── なぜ課金フィールドに詰め込まないのか ───────────────────────────────
 * AK の有料契約は `プラン` / `PlanType` / `有効期限` / `Status` / `PaidAt` /
 * `PaymentConfirmed` が正本で、入金確認フロー（bankPaymentFlow.js）と
 * 決済メール v2 の状態機械がこれらを読み書きする。
 * 「無料で Premium を 30 日」を表現するために `有効期限` を書くと、
 *   - 無料なのに「支払済み」に見える（PaidAt / PaymentConfirmed と整合しない）
 *   - 既存の有料期限を上書きして**課金済みの権利を短縮**しうる
 *   - 期限切れ通知・再契約導線・回収レポートが無料特典を課金として数える
 * が同時に起きる。そこで **paid entitlement と promotional entitlement を別フィールドに
 * 完全分離**し、runtime では「強い方を採用する（減らさない）」だけにする。
 *
 * ── 表現する特典は 2 種類だけ ─────────────────────────────────────
 *   light_lifetime     … Light 永久無料（期限なし・課金なし）
 *   premium_trial_30d  … Premium 30 日無料（付与時刻 + 30 日）
 * 複合オファー（Premium 30日 → その後 Light 永久）は **2 つの独立 grant** であり、
 * 新しい 3 つ目の種別を作らない。「その後 Light」は runtime の優先順位から自然に導かれる
 * （trial 終了で premium が落ち、light_lifetime が残る）。専用の状態遷移を持たせない。
 *
 * ── 取り消し（revoke）の表現 ───────────────────────────────────────
 * grant 値そのものを消し（Granted=false / Until を空に）、RevokedAt / RevokeReason を残す。
 * 「granted のまま revoked フラグを立てる」方式にしないのは、runtime 側が
 * **「値が無ければ権利が無い」**という最も壊れにくい判定でいられるようにするため。
 * それでも整合が崩れた（値が残ったまま RevokedAt が新しい）レコードは fail closed で
 * 権利なしと解釈する。
 *
 * ── 絶対に書かないフィールド ───────────────────────────────────────
 * PROMO_FORBIDDEN_FIELDS を参照。allowlist（PROMO_WRITABLE_FIELDS）で構造的に強制し、
 * PATCH 直前にも assertOnlyGrantFields で再確認する。
 */

/** 特典の種別（これ以外は作らない） */
export const PROMO_GRANT = Object.freeze({
  LIGHT_LIFETIME: 'light_lifetime',
  PREMIUM_TRIAL_30D: 'premium_trial_30d',
});

/** 特典の表示名（管理画面用。顧客向け文面はキャンペーン側が持つ） */
export const PROMO_GRANT_LABEL = Object.freeze({
  light_lifetime: 'Light 永久無料',
  premium_trial_30d: 'Premium 30日無料',
});

/** Premium 無料期間の日数（変更はここだけ。呼び出し側に数値を書かない） */
export const PREMIUM_TRIAL_DAYS = 30;

/**
 * Airtable Customers に追加するフィールド名（正本）。
 * ⚠️ 本番 Airtable には**未作成**。作成するまで書き込みは env gate で閉じる
 *    （存在しないフィールドへ PATCH すると 422 で同じ PATCH の他の更新も巻き添えで落ちる）。
 */
export const PROMO_FIELDS = Object.freeze({
  /** Light 永久無料を保有しているか（checkbox） */
  LIGHT_GRANTED: 'LightLifetimeGranted',
  LIGHT_GRANTED_AT: 'LightLifetimeGrantedAt',
  LIGHT_GRANTED_BY: 'LightLifetimeGrantedBy',
  /** 付与オペレーション ID（冪等性の鍵） */
  LIGHT_GRANT_OP: 'LightLifetimeGrantOp',
  LIGHT_REVOKED_AT: 'LightLifetimeRevokedAt',
  LIGHT_REVOKE_REASON: 'LightLifetimeRevokeReason',

  /** Premium 無料期間の終了時刻（ISO。空 = 特典なし） */
  TRIAL_UNTIL: 'PremiumTrialUntil',
  TRIAL_GRANTED_AT: 'PremiumTrialGrantedAt',
  TRIAL_GRANTED_BY: 'PremiumTrialGrantedBy',
  TRIAL_GRANT_OP: 'PremiumTrialGrantOp',
  TRIAL_REVOKED_AT: 'PremiumTrialRevokedAt',
  TRIAL_REVOKE_REASON: 'PremiumTrialRevokeReason',

  /** 施策名（どのカムバック施策で付与したか。共通 1 つ） */
  SOURCE: 'ComebackGrantSource',
});

/** このモジュールが Customers へ書いてよいフィールド（これ以外は構造的に禁止） */
export const PROMO_WRITABLE_FIELDS = Object.freeze(Object.values(PROMO_FIELDS));

/**
 * 絶対に触れてはいけないフィールド。
 * 課金・契約・決済メール v2・三連複買い切り・Premium Plus 販売資格のすべて。
 */
export const PROMO_FORBIDDEN_FIELDS = Object.freeze([
  'プラン', 'Plan', 'PlanType', 'Status', 'AccountStatus',
  '有効期限', 'ValidUntil', 'ExpiryDate', 'ExpirationDate',
  'PaidAt', 'PaymentConfirmed', 'PaymentMethod',
  'PaymentEmailSent', 'PaymentEmailStatus', 'PaymentEmailIdempotencyKey',
  'PaymentEmailProviderMessageId', 'PaymentEmailAttemptCount', 'PaymentEmailLeaseUntil',
  'LifetimeSanrenpuku', '三連複Lifetime', 'SanrenpukuPaidAt',
  'PremiumPlusEligibility', 'PremiumPlusEligibleAt', 'PremiumPlusEligibilityReason',
  'PremiumPlusEligibilityUpdatedAt', 'PremiumPlusEligibilityUpdatedBy',
  'PremiumPlusReleaseOverride',
  'WithdrawalRequested', 'WithdrawalDate', 'WithdrawalReason', 'ForceLogout',
  'RequestedPlan', 'RequestedPlanType', 'RequestedAmount',
  'SessionVersion', 'UnsubscribedAnalyticsKeiba', 'Email', '氏名',
]);

/** 内部メモ（取り消し理由・施策名）の最大長 */
export const PROMO_TEXT_MAX_LENGTH = 200;

const WRITABLE = new Set(PROMO_WRITABLE_FIELDS);

/**
 * 特典フィールドへの書き込みが有効か（本番 Airtable にフィールドを作るまで false）。
 * Premium Plus の `PREMIUM_PLUS_FIELDS_READY` と同じ考え方。
 */
export function isGrantFieldsEnabled(env) {
  return !!env && env.COMEBACK_GRANT_FIELDS_READY === '1';
}

/**
 * 実付与（Customers への書き込み）が有効か。**既定は無効**。
 * フィールドが存在するだけでは付与できない。運用承認後に env を立てて初めて有効になる。
 */
export function isGrantWriteEnabled(env) {
  return isGrantFieldsEnabled(env) && env.COMEBACK_GRANT_ENABLED === 'true';
}

/** fields が特典専用フィールドだけで構成されているか（PATCH 直前の最終防衛） */
export function assertOnlyGrantFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  if (keys.length === 0) return false;
  return keys.every((k) => WRITABLE.has(k));
}

function isTruthyFlag(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'checked' || s === '✓' || s === 'on';
  }
  return false;
}

/** ISO / Date / ms → ms（解釈できなければ null） */
export function toMs(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? null : t;
}

function toIso(value) {
  const ms = toMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Premium 無料期間の終了時刻。
 *
 * **付与時刻 + 30 日（実時間）** で計算する。`有効期限`（JST 暦日の日付）とは別物なので
 * JST 丸めをしない ―― 丸めると「23:50 に付与した人だけ 1 日短い/長い」が生まれ、
 * かつ課金側の暦日計算（addOneYearJst）と紛らわしくなる。ISO 時刻をそのまま持つ。
 */
export function computeTrialUntilMs(grantedAtMs, days = PREMIUM_TRIAL_DAYS) {
  if (!Number.isFinite(grantedAtMs)) return null;
  return grantedAtMs + days * 24 * 60 * 60 * 1000;
}

/**
 * Customers fields → 現在の特典状態（純粋・読み取りのみ）。
 *
 * fail closed の原則:
 *   - フィールドが無い / 読めない → 特典なし
 *   - 値が残っているのに RevokedAt の方が新しい（取り消しの書き込みが途中で落ちた等）
 *     → **特典なし**として扱い、inconsistent フラグで可視化する
 *
 * @param {object|null} fields
 * @param {number} [nowMs]
 * @returns {{
 *   lightLifetime: { active: boolean, grantedAtMs: number|null, grantedBy: string, operationId: string,
 *                    revokedAtMs: number|null, revokeReason: string, inconsistent: boolean },
 *   premiumTrial: { active: boolean, untilMs: number|null, grantedAtMs: number|null, grantedBy: string,
 *                   operationId: string, revokedAtMs: number|null, revokeReason: string,
 *                   inconsistent: boolean, expired: boolean, daysRemaining: number|null },
 *   source: string,
 *   hasAny: boolean,
 * }}
 */
export function resolvePromotionalGrants(fields, nowMs = Date.now()) {
  const f = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  // ── Light 永久無料 ──
  const lightRaw = isTruthyFlag(f[PROMO_FIELDS.LIGHT_GRANTED]);
  const lightGrantedAtMs = toMs(f[PROMO_FIELDS.LIGHT_GRANTED_AT]);
  const lightRevokedAtMs = toMs(f[PROMO_FIELDS.LIGHT_REVOKED_AT]);
  // 取り消し後に再付与した場合は GrantedAt > RevokedAt になるので有効のまま
  const lightRevokedAfter = lightRevokedAtMs !== null
    && (lightGrantedAtMs === null || lightRevokedAtMs >= lightGrantedAtMs);
  const lightInconsistent = lightRaw && lightRevokedAfter;
  const lightActive = lightRaw && !lightRevokedAfter;

  // ── Premium 無料期間 ──
  const trialUntilMs = toMs(f[PROMO_FIELDS.TRIAL_UNTIL]);
  const trialGrantedAtMs = toMs(f[PROMO_FIELDS.TRIAL_GRANTED_AT]);
  const trialRevokedAtMs = toMs(f[PROMO_FIELDS.TRIAL_REVOKED_AT]);
  const trialRevokedAfter = trialRevokedAtMs !== null
    && (trialGrantedAtMs === null || trialRevokedAtMs >= trialGrantedAtMs);
  const trialInconsistent = trialUntilMs !== null && trialRevokedAfter;
  const trialUsable = trialUntilMs !== null && !trialRevokedAfter;
  const trialActive = trialUsable && trialUntilMs > now;

  return {
    lightLifetime: {
      active: lightActive,
      grantedAtMs: lightGrantedAtMs,
      grantedBy: text(f[PROMO_FIELDS.LIGHT_GRANTED_BY]),
      operationId: text(f[PROMO_FIELDS.LIGHT_GRANT_OP]),
      revokedAtMs: lightRevokedAtMs,
      revokeReason: text(f[PROMO_FIELDS.LIGHT_REVOKE_REASON]),
      inconsistent: lightInconsistent,
    },
    premiumTrial: {
      active: trialActive,
      untilMs: trialUsable ? trialUntilMs : null,
      grantedAtMs: trialGrantedAtMs,
      grantedBy: text(f[PROMO_FIELDS.TRIAL_GRANTED_BY]),
      operationId: text(f[PROMO_FIELDS.TRIAL_GRANT_OP]),
      revokedAtMs: trialRevokedAtMs,
      revokeReason: text(f[PROMO_FIELDS.TRIAL_REVOKE_REASON]),
      inconsistent: trialInconsistent,
      expired: trialUsable && trialUntilMs <= now,
      daysRemaining: trialActive ? Math.ceil((trialUntilMs - now) / (24 * 60 * 60 * 1000)) : null,
    },
    source: text(f[PROMO_FIELDS.SOURCE]),
    hasAny: lightActive || trialActive,
  };
}

/**
 * 特典を**付与**するときに書くフィールド。
 *
 * 冪等性:
 *   - 同じ operationId が既にそのフィールドへ入っていれば `skipped: 'already_applied'`
 *   - 既に有効な特典があれば `skipped: 'already_granted'`（Light は永久なので再付与しない）
 *   - どちらでもなければ fields を返す
 *
 * ⚠️ Premium trial は「既に有効な trial があるなら延長しない」。延長したい場合は
 *    先に revoke してから付与する（暗黙の延長で終了日が動く事故を防ぐ）。
 *
 * @param {{
 *   grantType: string, fields?: object|null, now: Date|number,
 *   operationId: string, actor?: string, source?: string, trialDays?: number,
 * }} input
 * @returns {{ fields: object, effect: object }|{ skipped: string }|null}
 */
export function buildGrantFields({ grantType, fields, now, operationId, actor, source, trialDays }) {
  const nowMs = toMs(now);
  const op = text(operationId);
  if (nowMs === null || !op) return null;
  const nowIso = new Date(nowMs).toISOString();
  const f = fields && typeof fields === 'object' ? fields : {};
  const current = resolvePromotionalGrants(f, nowMs);
  const by = String(actor || 'admin').slice(0, 64);
  const src = String(source || '').slice(0, PROMO_TEXT_MAX_LENGTH);

  if (grantType === PROMO_GRANT.LIGHT_LIFETIME) {
    if (current.lightLifetime.operationId === op && current.lightLifetime.active) {
      return { skipped: 'already_applied' };
    }
    if (current.lightLifetime.active) return { skipped: 'already_granted' };
    const out = {
      [PROMO_FIELDS.LIGHT_GRANTED]: true,
      [PROMO_FIELDS.LIGHT_GRANTED_AT]: nowIso,
      [PROMO_FIELDS.LIGHT_GRANTED_BY]: by,
      [PROMO_FIELDS.LIGHT_GRANT_OP]: op,
      // 再付与時に古い取り消し記録を残さない（RevokedAt が新しいままだと fail closed で無効化される）
      [PROMO_FIELDS.LIGHT_REVOKED_AT]: '',
      [PROMO_FIELDS.LIGHT_REVOKE_REASON]: '',
    };
    if (src) out[PROMO_FIELDS.SOURCE] = src;
    if (!assertOnlyGrantFields(out)) return null;
    return { fields: out, effect: { grantType, untilMs: null } };
  }

  if (grantType === PROMO_GRANT.PREMIUM_TRIAL_30D) {
    if (current.premiumTrial.operationId === op && current.premiumTrial.untilMs !== null) {
      return { skipped: 'already_applied' };
    }
    if (current.premiumTrial.active) return { skipped: 'already_granted' };
    const untilMs = computeTrialUntilMs(nowMs, Number.isFinite(trialDays) ? trialDays : PREMIUM_TRIAL_DAYS);
    if (untilMs === null) return null;
    const out = {
      [PROMO_FIELDS.TRIAL_UNTIL]: new Date(untilMs).toISOString(),
      [PROMO_FIELDS.TRIAL_GRANTED_AT]: nowIso,
      [PROMO_FIELDS.TRIAL_GRANTED_BY]: by,
      [PROMO_FIELDS.TRIAL_GRANT_OP]: op,
      [PROMO_FIELDS.TRIAL_REVOKED_AT]: '',
      [PROMO_FIELDS.TRIAL_REVOKE_REASON]: '',
    };
    if (src) out[PROMO_FIELDS.SOURCE] = src;
    if (!assertOnlyGrantFields(out)) return null;
    return { fields: out, effect: { grantType, untilMs } };
  }

  return null; // 未知の種別は丸めずに拒否
}

/**
 * 特典を**取り消す**ときに書くフィールド。
 * 取り消せるのは promotional grant だけ。paid entitlement / LifetimeSanrenpuku は
 * allowlist により構造的に触れない。
 *
 * @returns {{ fields: object }|{ skipped: string }|null}
 */
export function buildRevokeFields({ grantType, fields, now, actor, reason }) {
  const nowMs = toMs(now);
  if (nowMs === null) return null;
  const nowIso = new Date(nowMs).toISOString();
  const f = fields && typeof fields === 'object' ? fields : {};
  const current = resolvePromotionalGrants(f, nowMs);
  const why = String(reason || '').slice(0, PROMO_TEXT_MAX_LENGTH);
  const by = String(actor || 'admin').slice(0, 64);

  if (grantType === PROMO_GRANT.LIGHT_LIFETIME) {
    // 値も取り消し記録も無ければ書くことが無い
    if (!current.lightLifetime.active && !current.lightLifetime.inconsistent) {
      return { skipped: 'not_granted' };
    }
    const out = {
      [PROMO_FIELDS.LIGHT_GRANTED]: false,
      [PROMO_FIELDS.LIGHT_REVOKED_AT]: nowIso,
      [PROMO_FIELDS.LIGHT_REVOKE_REASON]: why ? `${why}（${by}）` : `取り消し（${by}）`,
    };
    if (!assertOnlyGrantFields(out)) return null;
    return { fields: out };
  }

  if (grantType === PROMO_GRANT.PREMIUM_TRIAL_30D) {
    // 期限切れの trial も「値が残っている」なら掃除できる（active でなくても可）
    if (current.premiumTrial.untilMs === null && !current.premiumTrial.inconsistent) {
      return { skipped: 'not_granted' };
    }
    const out = {
      [PROMO_FIELDS.TRIAL_UNTIL]: '',
      [PROMO_FIELDS.TRIAL_REVOKED_AT]: nowIso,
      [PROMO_FIELDS.TRIAL_REVOKE_REASON]: why ? `${why}（${by}）` : `取り消し（${by}）`,
    };
    if (!assertOnlyGrantFields(out)) return null;
    return { fields: out };
  }

  return null;
}

/** 特典状態の短い説明（管理画面の「現在」「付与後」表示に使う） */
export function describeGrantState(grants) {
  const g = grants || resolvePromotionalGrants(null);
  const parts = [];
  if (g.premiumTrial.active) {
    parts.push(`Premium 無料（〜${fmtDay(g.premiumTrial.untilMs)}・残り ${g.premiumTrial.daysRemaining} 日）`);
  } else if (g.premiumTrial.expired) {
    parts.push(`Premium 無料 終了（${fmtDay(g.premiumTrial.untilMs)}）`);
  }
  if (g.lightLifetime.active) parts.push('Light 永久無料');
  if (g.lightLifetime.inconsistent || g.premiumTrial.inconsistent) parts.push('⚠️ 特典データ不整合');
  return parts.length ? parts.join(' / ') : '特典なし';
}

/** ms → 'YYYY-MM-DD'（JST 暦日。表示専用） */
export function fmtDay(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export default resolvePromotionalGrants;
