/**
 * promotionalGrants.js — 無料で付与した閲覧権（promotional grant）の単一源（純粋・I/O なし）
 *
 * ── 4 つの概念を混同しない ───────────────────────────────────────────
 *   A. entitlement        実際に何を閲覧できるか（resolveEntitlements の出力）
 *   B. paid contract      通常購入による契約（プラン / PlanType / 有効期限 / PaidAt / PaymentConfirmed）
 *   C. promotional grant  **このモジュール**。無料で付与した閲覧権
 *   D. promotional offer  割引価格・特別価格など「購入条件」（promotions/promotionOfferCatalog.js）
 *
 * C は権利そのもの、D は購入の条件。**D を作っても権利は 1 ミリも増えない**（支払い完了後に
 * 既存の入金確認フローが B を更新して初めて権利になる）。
 *
 * ── なぜ課金フィールドに詰め込まないのか ───────────────────────────────
 * 無料権利を `有効期限` / `プラン` に書くと、
 *   - 無料なのに「支払済み」に見える（PaidAt / PaymentConfirmed と矛盾）
 *   - 既存の有料期限を上書きして**課金済みの権利を短縮**しうる
 *   - 期限切れ通知・再契約導線・売上集計が無料特典を課金として数える
 * が同時に起きる。専用フィールドへ完全分離する。
 *
 * ── grant は「ティア × 期間」の汎用モデル ─────────────────────────────
 * 種別を `light_lifetime` / `premium_trial_30d` のように固定しない。
 *   ティア（light / premium）× 期間（日数指定 or 無期限）
 * の組み合わせだけで、Light 永久無料 / Light 30日無料 / Premium 30日無料 /
 * Premium 年相当 / Premium 買い切り相当（無期限）まで全部表現する。
 *
 * ⚠️ Light は「Premium 終了後の fallback」ではない。**メイン買い目のみ閲覧できる独立した
 *    低位プラン**であり、カムバック施策では最初から無料開放するベース特典。
 *    Premium はその上に**追加で**乗る上位オファー。両方の権利が同時に存在し、
 *    resolveEntitlements が強い方を採用する（期限到来時に書き込みは発生しない）。
 *
 * ── 取り消し（revoke）の表現 ───────────────────────────────────────
 * grant 値そのものを消し（Lifetime=false / Until を null に）、RevokedAt / RevokeReason を残す。
 * runtime を「値が無ければ権利が無い」という最も壊れにくい判定に保つため。
 * 値が残ったまま RevokedAt が新しい壊れたレコードは fail closed で権利なしと解釈する。
 *
 * ── 日時フィールドは Airtable の dateTime 型・クリアは `null` ─────────────
 * `*GrantUntil` / `*GrantRevokedAt` / `*GrantedAt` は **dateTime 型**で作る
 * （期限フィルタ・並べ替え・管理画面表示・将来の集計を正しく保つため）。
 * dateTime 列を空にするときは **`null`** を送る。空文字 `''` は日付として解釈できず
 * 422 になり得るうえ、同じ PATCH の他フィールドまで巻き添えで落ちる。
 * 読み取り側 `toMs()` は `null` / `undefined` / `''` / ISO 文字列 / Date / 数値をすべて
 * 安全に扱う（旧データに `''` が入っていても壊れない）。
 * ⚠️ テキスト列（`*GrantRevokeReason` / `*GrantedBy` / `*GrantOp` / `ComebackGrantSource`）は
 *    従来どおり `''` でクリアする。null 化を課金フィールドや既存列へ波及させない。
 */

/** 無料付与できるティア（三連複は対象外。買い切り三連複とは別権利） */
export const PROMO_TIER = Object.freeze({
  LIGHT: 'light',
  PREMIUM: 'premium',
  /**
   * 三連複（Premium Sanrenpuku）。
   *
   * ⚠️ **割引購入条件（`OFFER_KIND.PURCHASE`）専用**。無料付与の対象にはしない。
   *    `isValidTier()` が false を返すので、付与の経路には構造的に乗らない
   *    （三連複を無料開放する運用は無い。付けたいときは明示的に足すこと）。
   */
  SANRENPUKU: 'sanrenpuku',
});

export const PROMO_TIER_LABEL = Object.freeze({
  light: 'Light',
  premium: 'Premium',
  sanrenpuku: 'Premium Sanrenpuku',
});

/**
 * Airtable Customers に追加するフィールド名（正本）。
 * ⚠️ 本番 Airtable には**未作成**。作成するまで書き込みは env gate で閉じる
 *    （存在しないフィールドへ PATCH すると 422 で同じ PATCH の他の更新も巻き添えで落ちる）。
 */
export const PROMO_FIELDS = Object.freeze({
  light: Object.freeze({
    LIFETIME: 'LightGrantLifetime',
    UNTIL: 'LightGrantUntil',
    GRANTED_AT: 'LightGrantedAt',
    GRANTED_BY: 'LightGrantedBy',
    OP: 'LightGrantOp',
    REVOKED_AT: 'LightGrantRevokedAt',
    REVOKE_REASON: 'LightGrantRevokeReason',
  }),
  premium: Object.freeze({
    LIFETIME: 'PremiumGrantLifetime',
    UNTIL: 'PremiumGrantUntil',
    GRANTED_AT: 'PremiumGrantedAt',
    GRANTED_BY: 'PremiumGrantedBy',
    OP: 'PremiumGrantOp',
    REVOKED_AT: 'PremiumGrantRevokedAt',
    REVOKE_REASON: 'PremiumGrantRevokeReason',
  }),
  /** 施策名（どのカムバック施策で付与したか。ティア共通で 1 つ） */
  SOURCE: 'ComebackGrantSource',
});

/** このモジュールが Customers へ書いてよいフィールド（これ以外は構造的に禁止） */
export const PROMO_WRITABLE_FIELDS = Object.freeze([
  ...Object.values(PROMO_FIELDS.light),
  ...Object.values(PROMO_FIELDS.premium),
  PROMO_FIELDS.SOURCE,
]);

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

/** 無料付与できる最長日数（暴走防止。無期限は lifetime フラグで表現する） */
export const MAX_GRANT_DAYS = 3650;

const WRITABLE = new Set(PROMO_WRITABLE_FIELDS);
const DAY_MS = 24 * 60 * 60 * 1000;

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

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function isTier(tier) {
  return tier === PROMO_TIER.LIGHT || tier === PROMO_TIER.PREMIUM;
}

/**
 * 無料期間の終了時刻。
 *
 * **付与時刻 + N 日（実時間）** で計算する。`有効期限`（JST 暦日の日付）とは別物なので
 * JST 丸めをしない ―― 丸めると「23:50 に付与した人だけ 1 日短い/長い」が生まれ、
 * 課金側の暦日計算（addOneYearJst）とも紛らわしくなる。ISO 時刻をそのまま持つ。
 */
export function computeGrantUntilMs(grantedAtMs, days) {
  if (!Number.isFinite(grantedAtMs)) return null;
  if (!Number.isInteger(days) || days < 1 || days > MAX_GRANT_DAYS) return null;
  return grantedAtMs + days * DAY_MS;
}

/** 1 ティア分の状態を解く（内部） */
function resolveTierGrant(fields, tier, now) {
  const F = PROMO_FIELDS[tier];
  const lifetimeRaw = isTruthyFlag(fields[F.LIFETIME]);
  const untilMs = toMs(fields[F.UNTIL]);
  const grantedAtMs = toMs(fields[F.GRANTED_AT]);
  const revokedAtMs = toMs(fields[F.REVOKED_AT]);
  // 取り消し後に再付与した場合は GrantedAt > RevokedAt になるので有効のまま
  const revokedAfter = revokedAtMs !== null && (grantedAtMs === null || revokedAtMs >= grantedAtMs);
  const hasValue = lifetimeRaw || untilMs !== null;
  const inconsistent = hasValue && revokedAfter;
  const usable = hasValue && !revokedAfter;
  const active = usable && (lifetimeRaw || untilMs > now);

  return {
    tier,
    active,
    lifetime: usable && lifetimeRaw,
    untilMs: usable && !lifetimeRaw ? untilMs : null,
    /** 期間が終わった（無期限ではない grant の期限切れ） */
    expired: usable && !lifetimeRaw && untilMs !== null && untilMs <= now,
    daysRemaining: active && !lifetimeRaw && untilMs !== null
      ? Math.ceil((untilMs - now) / DAY_MS) : null,
    grantedAtMs,
    grantedBy: text(fields[F.GRANTED_BY]),
    operationId: text(fields[F.OP]),
    revokedAtMs,
    revokeReason: text(fields[F.REVOKE_REASON]),
    inconsistent,
  };
}

/**
 * Customers fields → 現在の無料権利（純粋・読み取りのみ）。
 *
 * fail closed の原則:
 *   - フィールドが無い / 読めない → 権利なし
 *   - 値が残っているのに RevokedAt の方が新しい → **権利なし**として扱い inconsistent で可視化
 *
 * @param {object|null} fields
 * @param {number} [nowMs]
 */
export function resolvePromotionalGrants(fields, nowMs = Date.now()) {
  const f = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const light = resolveTierGrant(f, PROMO_TIER.LIGHT, now);
  const premium = resolveTierGrant(f, PROMO_TIER.PREMIUM, now);
  return {
    light,
    premium,
    source: text(f[PROMO_FIELDS.SOURCE]),
    hasAny: light.active || premium.active,
    inconsistent: light.inconsistent || premium.inconsistent,
  };
}

/**
 * 新しい付与が既存より強いか。
 * 「強い方を採用する（権利を減らさない）」ため、弱い付与は skip して既存を維持する。
 */
export function isStrongerGrant(current, next) {
  if (!current || !current.active) return true;
  if (current.lifetime) return false;            // 無期限より強いものは無い
  if (next.lifetime) return true;                // 期限付き → 無期限は強化
  if (!Number.isFinite(next.untilMs)) return false;
  if (!Number.isFinite(current.untilMs)) return false;
  return next.untilMs > current.untilMs;         // 終了日が後ろへ伸びるときだけ強化
}

/**
 * 無料権利を**付与**するときに書くフィールド。
 *
 * 冪等性:
 *   - 同じ operationId が既にそのティアへ入っていれば `skipped: 'already_applied'`
 *   - 既存の方が強い / 同等なら `skipped: 'already_granted'`（弱い付与で権利を縮めない）
 *   - 強化になる場合だけ書く（`effect.upgrade = true`）
 *
 * @param {{
 *   tier: string, lifetime?: boolean, durationDays?: number,
 *   fields?: object|null, now: Date|number,
 *   operationId: string, actor?: string, source?: string,
 * }} input
 * @returns {{ fields: object, effect: object }|{ skipped: string }|null}
 */
export function buildGrantFields({
  tier, lifetime = false, durationDays, fields, now, operationId, actor, source,
}) {
  if (!isTier(tier)) return null;
  const nowMs = toMs(now);
  const op = text(operationId);
  if (nowMs === null || !op) return null;

  const isLifetime = lifetime === true;
  const untilMs = isLifetime ? null : computeGrantUntilMs(nowMs, durationDays);
  if (!isLifetime && untilMs === null) return null; // 日数が不正なら組み立てない（fail closed）

  const f = fields && typeof fields === 'object' ? fields : {};
  const current = resolvePromotionalGrants(f, nowMs)[tier];

  if (current.operationId === op && (current.lifetime || current.untilMs !== null)) {
    return { skipped: 'already_applied' };
  }
  const next = { lifetime: isLifetime, untilMs };
  if (!isStrongerGrant(current, next)) return { skipped: 'already_granted' };

  const F = PROMO_FIELDS[tier];
  const nowIso = new Date(nowMs).toISOString();
  const out = {
    [F.LIFETIME]: isLifetime,
    // 無期限のときは終了時刻を持たない（両方に値があると解釈が割れる）。
    // dateTime 列のクリアは null（'' は日付として解釈できず 422 になり得る）
    [F.UNTIL]: isLifetime ? null : new Date(untilMs).toISOString(),
    [F.GRANTED_AT]: nowIso,
    [F.GRANTED_BY]: String(actor || 'admin').slice(0, 64),
    [F.OP]: op,
    // 再付与時に古い取り消し記録を残さない（RevokedAt が新しいままだと fail closed で無効化される）
    [F.REVOKED_AT]: null,
    [F.REVOKE_REASON]: '',
  };
  const src = String(source || '').slice(0, PROMO_TEXT_MAX_LENGTH);
  if (src) out[PROMO_FIELDS.SOURCE] = src;

  if (!assertOnlyGrantFields(out)) return null;
  return {
    fields: out,
    effect: { tier, lifetime: isLifetime, untilMs, upgrade: current.active === true },
  };
}

/**
 * 無料権利を**取り消す**ときに書くフィールド。
 * 取り消せるのは promotional grant だけ。paid contract / LifetimeSanrenpuku は
 * allowlist により構造的に触れない。
 *
 * @returns {{ fields: object }|{ skipped: string }|null}
 */
export function buildRevokeFields({ tier, fields, now, actor, reason }) {
  if (!isTier(tier)) return null;
  const nowMs = toMs(now);
  if (nowMs === null) return null;
  const f = fields && typeof fields === 'object' ? fields : {};
  const current = resolvePromotionalGrants(f, nowMs)[tier];

  // 値も取り消し記録も無ければ書くことが無い（期限切れの残骸は掃除できる）
  const hasValue = current.lifetime || current.untilMs !== null || current.inconsistent;
  if (!hasValue) return { skipped: 'not_granted' };

  const F = PROMO_FIELDS[tier];
  const by = String(actor || 'admin').slice(0, 64);
  const why = String(reason || '').slice(0, PROMO_TEXT_MAX_LENGTH);
  const out = {
    [F.LIFETIME]: false,
    // dateTime 列のクリアは null（'' を送らない）
    [F.UNTIL]: null,
    [F.REVOKED_AT]: new Date(nowMs).toISOString(),
    [F.REVOKE_REASON]: why ? `${why}（${by}）` : `取り消し（${by}）`,
  };
  if (!assertOnlyGrantFields(out)) return null;
  return { fields: out };
}

/** 1 ティア分の説明（管理画面の「現在」「付与後」表示に使う） */
export function describeTierGrant(g) {
  if (!g || !g.active) {
    if (g && g.expired) return `${PROMO_TIER_LABEL[g.tier]} 無料 終了（${fmtDay(g.untilMs)}）`;
    return '';
  }
  const label = PROMO_TIER_LABEL[g.tier];
  return g.lifetime
    ? `${label} 永久無料`
    : `${label} 無料（〜${fmtDay(g.untilMs)}・残り ${g.daysRemaining} 日）`;
}

/** 特典状態の短い説明 */
export function describeGrantState(grants) {
  const g = grants || resolvePromotionalGrants(null);
  const parts = [describeTierGrant(g.premium), describeTierGrant(g.light)].filter(Boolean);
  if (g.inconsistent) parts.push('⚠️ 特典データ不整合');
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
