/**
 * resolveEntitlements.js — AK の権限判定の単一源（純粋関数・I/O なし）。
 *
 * 目的: 「会員ランク（tier）」と「追加 entitlement（三連複買い切り = LifetimeSanrenpuku）」を分離し、
 * 「購入資格」と「閲覧資格」も分離した権限判定を、dashboard / AccessControl / 購入CTA / Functions が
 * **重複実装せず**この 1 関数に集約するためのもの。
 *
 * 正本設計（2026-07-18 確定）:
 *   会員ランク: 未登録 → Free → (Light | Premium)。Premium は購入時に期限（monthly/annual 等）を選ぶ。
 *   Premium Sanrenpuku は会員ランクではなく、有効な Premium 会員だけが買える「買い切りの永久 entitlement」。
 *
 *   canViewSanrenpuku = アカウント有効 AND LifetimeSanrenpuku=true   （tier も Premium 期限も見ない）
 *   canPurchaseSanrenpuku = アカウント有効 AND Premium 契約が現在有効 AND LifetimeSanrenpuku != true
 *
 *   → Premium 期限切れ + LifetimeSanrenpuku=true の人は「ログイン可 / 馬単不可 / 三連複閲覧可 / 購入CTA非表示」。
 *
 * 移行期の後方互換: 旧 Airtable プラン値 'Premium Sanrenpuku' / 'Premium Combo'（canonical
 * premium-sanrenpuku / premium-combo）を持つ既存レコードを、フラグ未設定でも三連複閲覧可とする
 * `legacySanrenpukuTierGrantsView`（既定 true）。データ移行完了後（PR4）に false へ倒して恒久除去できる。
 */

import { normalizePlan } from '../auth/planNormalization.js';

// アカウント拒否扱いにする Status（memberResolution.js の SUSPENDED_STATUS ＋ 実 Status 選択肢に合わせる）。
// 2026-07-18 追加: withdrawn / expired / unpaidrefunded（Airtable の実選択肢）。'test' は下の isTestAccount で扱う。
const SUSPENDED_STATUS = new Set([
  'suspended', 'inactive', 'banned', 'disabled', 'cancelled', 'canceled', 'closed',
  'withdrawn', 'expired', 'unpaidrefunded',
  '停止', '無効', '解約', '退会',
]);
// 入金待ち等（登録済みだが有料権限は未確定＝Free 扱い）
const PENDING_STATUS = new Set(['pending', '入金待ち', '未入金']);

// 馬単(Premium)相当の tier（canonical）。premium-predictions は旧・馬単のみ（廃止予定）。
const PREMIUM_TIERS = new Set(['premium', 'premium-predictions', 'premium-sanrenpuku', 'premium-combo']);
// 旧・三連複込みプラン（会員ランクとしては扱わない移行対象）
const LEGACY_SANRENPUKU_TIERS = new Set(['premium-sanrenpuku', 'premium-combo']);

function isTruthyFlag(v) {
  if (v === true) return true;
  if (v === 1) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'checked' || s === '✓' || s === 'on';
  }
  return false;
}

function toMillis(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  if (typeof now === 'string') { const t = Date.parse(now); return Number.isNaN(t) ? null : t; }
  return null;
}

/** expiresAt が nowMs 以前なら期限切れ。空/未指定/解釈不能は「期限なし＝有効」（誤って弾かない）。 */
function isExpiredAt(expiresAt, nowMs) {
  if (expiresAt === undefined || expiresAt === null || expiresAt === '') return false;
  const t = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (Number.isNaN(t)) return false;
  return t <= nowMs;
}

/**
 * 正規化済み customer から entitlement を判定する。
 *
 * @param {object} customer 正規化済み顧客。フィールド:
 *   tier: プラン文字列（'Premium'/'premium-sanrenpuku'/'ライト' 等・大小/別名可。normalizePlan で正規化）
 *   lifetimeSanrenpuku: boolean 相当（三連複 買い切り永久権）
 *   expiresAt: Premium/Light の有効期限（Date | ISO | 'YYYY-MM-DD'）。無指定=期限なし
 *   accountStatus: 'active'|'pending'|'suspended'|... （Airtable Status / AccountStatus）
 *   withdrawalRequested / forceLogout: boolean 相当（アカウント停止系）
 *   planType: 'monthly'|'annual'|'lifetime'（任意・lifetime なら期限切れにしない補助）
 *   forceExpired: boolean（クライアントの isExpired フラグ由来。true で強制期限切れ）
 * @param {Date|number} [now=Date.now()]
 * @param {{legacySanrenpukuTierGrantsView?: boolean}} [opts]
 */
export function resolveEntitlements(customer, now = Date.now(), opts = {}) {
  const { legacySanrenpukuTierGrantsView = true } = opts;
  const c = customer || {};
  const nowMs = toMillis(now) ?? Date.now();
  const reasons = [];

  const rawPlan = String(c.tier ?? c.plan ?? '').trim();
  const rawPlanLower = rawPlan.toLowerCase();
  const tier = normalizePlan(rawPlan) ?? 'free'; // 不明は fail-closed で free
  const lifetime = isTruthyFlag(c.lifetimeSanrenpuku);
  const status = String(c.accountStatus ?? c.status ?? '').trim().toLowerCase();
  const withdrawal = isTruthyFlag(c.withdrawalRequested);
  const forceLogout = isTruthyFlag(c.forceLogout);
  const suspended = SUSPENDED_STATUS.has(status);
  const pending = PENDING_STATUS.has(status);
  // テスト用アカウント（Status=test または プラン=Test）は通常顧客権限を与えない。
  const isTestAccount = status === 'test' || rawPlanLower === 'test';

  // アカウントが使えるか（登録済みでログイン可能）。停止・退会・強制ログアウト・テストは不可。
  const accountUsable = !forceLogout && !withdrawal && !suspended && !isTestAccount;
  if (forceLogout) reasons.push('FORCE_LOGOUT');
  if (withdrawal) reasons.push('WITHDRAWAL_REQUESTED');
  if (suspended) reasons.push('STATUS_SUSPENDED');
  if (isTestAccount) reasons.push('TEST_ACCOUNT');

  const canLogin = accountUsable;

  // pending は登録済みだが有料権限未確定＝Free 扱い（有料判定に入れない）。
  const paidEffective = accountUsable && !pending;
  if (pending) reasons.push('PENDING');

  const planTypeLower = String(c.planType ?? '').trim().toLowerCase();
  const lifetimeBilling = planTypeLower === 'lifetime';
  const forceExpired = isTruthyFlag(c.forceExpired);
  const expired = !lifetimeBilling && (forceExpired || isExpiredAt(c.expiresAt ?? c.validUntil, nowMs));

  const isPremiumTier = PREMIUM_TIERS.has(tier);
  const isLightTier = tier === 'light';
  const premiumActive = paidEffective && isPremiumTier && !expired;
  const lightActive = paidEffective && isLightTier && !expired;
  const premiumExpired = isPremiumTier && expired;
  if (premiumExpired) reasons.push('PREMIUM_EXPIRED');

  // ── 閲覧資格 ──────────────────────────────────────────
  const canViewFree = canLogin;
  const canViewLight = canLogin && (lightActive || premiumActive); // Premium は Light を包含
  const canViewPremium = premiumActive;

  // 三連複閲覧: 原則 active AND LifetimeSanrenpuku=true（tier/Premium期限を見ない）。
  // 移行期のみ旧 tier(premium-sanrenpuku/combo) を Premium 有効中に限り許可。
  const legacyView = legacySanrenpukuTierGrantsView && LEGACY_SANRENPUKU_TIERS.has(tier) && premiumActive;
  const canViewSanrenpuku = canLogin && (lifetime || legacyView);

  // ── 購入資格 ──────────────────────────────────────────
  // 有効な Premium 会員 かつ 未所有 のときだけ三連複購入を提示。
  const canPurchaseSanrenpuku = premiumActive && !lifetime && !LEGACY_SANRENPUKU_TIERS.has(tier);

  return {
    canLogin,
    canViewFree,
    canViewLight,
    canViewPremium,
    canPurchaseSanrenpuku,
    canViewSanrenpuku,
    premiumExpired,
    reasons,
    // 参考情報（呼び出し側の表示・デバッグ用）
    tier,
    lifetimeSanrenpuku: lifetime,
  };
}

/** Airtable の Customers fields から正規化 customer を作る adapter（サーバー側）。 */
export function fromAirtableFields(fields) {
  const f = fields || {};
  const read = (keys) => {
    for (const k of keys) {
      const v = f[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  };
  return {
    tier: read(['プラン', 'Plan']),
    lifetimeSanrenpuku: read(['LifetimeSanrenpuku', '三連複Lifetime']),
    expiresAt: read(['有効期限', 'ValidUntil', 'ExpiryDate', 'ExpirationDate']),
    accountStatus: read(['AccountStatus', 'Status']),
    withdrawalRequested: read(['WithdrawalRequested']),
    forceLogout: read(['ForceLogout']),
    planType: read(['PlanType']),
  };
}

/**
 * クライアントの localStorage user-plan（+補助フラグ）から正規化 customer を作る adapter。
 * @param {object} userPlan JSON.parse(localStorage['user-plan'])
 * @param {{isExpired?: boolean, validUntil?: string, isWithdrawalRequested?: boolean}} [flags]
 *   （AccessControl が別キーで持つ localStorage.isExpired / validUntil / isWithdrawalRequested）
 */
export function fromClientUserPlan(userPlan, flags = {}) {
  const up = userPlan || {};
  return {
    tier: up.plan,
    lifetimeSanrenpuku: up.lifetimeSanrenpuku,
    expiresAt: flags.validUntil ?? up.validUntil ?? up.expiresAt,
    accountStatus: up.status ?? up.accountStatus ?? 'active',
    withdrawalRequested: flags.isWithdrawalRequested ?? up.withdrawalRequested,
    forceLogout: up.forceLogout,
    planType: up.planType,
    forceExpired: flags.isExpired,
  };
}

/**
 * localStorage['user-plan'] を頑健にパースする。
 * 実データ契約: auth/verify.astro が `JSON.stringify(userPlan オブジェクト)` を書く（lifetimeSanrenpuku 含む）。
 * ただし旧 session / 別経路で生文字列が入っている可能性に備え、object / JSON文字列 / 生プラン名 / null を全て扱う。
 * （`JSON.parse(x||'{}')` は x が生文字列だと throw して false に化けるため、その推測を排除する）
 * @param {unknown} raw
 * @returns {object}
 */
export function parseUserPlan(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  const s = String(raw).trim();
  if (!s) return {};
  if (s[0] === '{' || s[0] === '[') {
    try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
  }
  return { plan: s }; // JSON でない生文字列は旧形式のプラン名として扱う
}

/**
 * ダッシュボード等クライアント表示の単一判定。共通 resolver を呼び出し、
 * カード / CTA の表示可否を返す。判定式をクライアント側で再実装しないための関数。
 *
 * @param {unknown} userPlanRaw localStorage['user-plan']（文字列 or object）
 * @param {{isExpired?: boolean|string, validUntil?: string, isWithdrawalRequested?: boolean|string}} [flags]
 *   AccessControl / dashboard が別キーで持つ localStorage.isExpired / validUntil / isWithdrawalRequested
 * @param {Date|number} [now]
 * @returns {{showBaCard: boolean, showSanrenpukuCard: boolean, showPurchaseCta: boolean, entitlements: object}}
 */
export function resolveClientView(userPlanRaw, flags = {}, now = Date.now()) {
  const up = parseUserPlan(userPlanRaw);
  const customer = fromClientUserPlan(up, {
    isExpired: flags.isExpired === true || flags.isExpired === 'true',
    validUntil: flags.validUntil && flags.validUntil !== 'null' ? flags.validUntil : undefined,
    isWithdrawalRequested: flags.isWithdrawalRequested === true || flags.isWithdrawalRequested === 'true',
  });
  const e = resolveEntitlements(customer, now);
  return {
    showBaCard: e.canViewPremium,          // 馬単カード
    showSanrenpukuCard: e.canViewSanrenpuku, // 三連複カード
    showPurchaseCta: e.canPurchaseSanrenpuku, // 三連複購入CTA
    entitlements: e,
  };
}

export default resolveEntitlements;
