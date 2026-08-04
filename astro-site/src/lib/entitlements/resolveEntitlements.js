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
 *
 * ── 無料特典（promotional grant）の扱い（2026-07-30 追加）──────────────
 * 無料で付与した閲覧権は **課金契約とは別フィールド**で持つ（promotionalGrants.js）。
 * 合成規則は 1 つだけ:
 *
 *   **強い権利を優先する。特典は権利を増やすだけで、減らさない。**
 *
 *   実効ティア: premium-sanrenpuku > premium > light > free
 *
 *   canViewPremium     = 有料 Premium 有効 **または** Premium 無料権利が有効
 *   canViewLight       = 上記のいずれか **または** 有料 Light 有効 **または** Light 無料権利が有効
 *   canViewSanrenpuku  = 変更なし（三連複買い切りは無料特典の影響を受けない）
 *   canPurchaseSanrenpuku = 変更なし（**有料** Premium 会員だけが購入資格を持つ。
 *                          無料特典で購入資格を配らない）
 *
 * ⚠️ Light は「Premium 終了後の fallback」ではない。**メイン買い目のみ閲覧できる独立した
 *    低位プラン**であり、Light 無料権利と Premium 無料権利は最初から**同時に存在**する。
 *    Premium が終わると、既にある Light 権利が再び最上位になるだけ ―― 
 *    **期限到来時に書き込みは一切発生しない**（純粋な時刻比較）。
 *
 * 特典フィールドが 1 つも無いレコードは従来と完全に同じ判定になる（fail closed）。
 */

import { normalizePlan } from '../auth/planNormalization.js';
import { resolvePromotionalGrants, PROMO_WRITABLE_FIELDS } from './promotionalGrants.js';
import { honorsGrantDespiteWithdrawal } from './comebackPolicy.js';

// アカウント全体を拒否する Status（＝ログインも不可）。memberResolution.js の SUSPENDED_STATUS に
// 揃え、ユーザー要件の明示状態（withdrawn / closed）を加える。'test' は下の isTestAccount で扱う。
// ⚠️ 'expired' / 'unpaidrefunded' は「契約（Premium/Light）だけが無効」であり**アカウント拒否ではない**。
//    Expiry 処理は Status を書かず 有効期限（日付）で判定する（memberResolution も 'expired' を停止扱いにしない）。
//    → 下の CONTRACT_EXPIRED_STATUS で「契約切れ」として扱い、ログイン・LifetimeSanrenpuku は拒否しない。
const SUSPENDED_STATUS = new Set([
  'suspended', 'inactive', 'banned', 'disabled', 'cancelled', 'canceled', 'closed', 'withdrawn',
  '停止', '無効', '解約', '退会',
]);
// 契約（Premium/Light）だけが無効な Status。アカウント全体・三連複永久権(LifetimeSanrenpuku)は拒否しない。
// unpaidrefunded は「未払い/返金済み」で有料契約は無効だが、アカウント拒否とする証拠は無い（コードで一切書かれず
// memberResolution も停止扱いにしない）ため、推測で全拒否にせず契約切れ扱いにする。
const CONTRACT_EXPIRED_STATUS = new Set(['expired', 'unpaidrefunded']);
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
  const statusContractExpired = CONTRACT_EXPIRED_STATUS.has(status);
  const pending = PENDING_STATUS.has(status);
  // テスト用アカウント（Status=test または プラン=Test）は通常顧客権限を与えない。
  const isTestAccount = status === 'test' || rawPlanLower === 'test';

  // アカウントが使えるか（登録済みでログイン可能）。停止・退会・強制ログアウト・テストは不可。
  const accountUsable = !forceLogout && !withdrawal && !suspended && !isTestAccount;
  if (forceLogout) reasons.push('FORCE_LOGOUT');
  if (withdrawal) reasons.push('WITHDRAWAL_REQUESTED');
  if (suspended) reasons.push('STATUS_SUSPENDED');
  if (isTestAccount) reasons.push('TEST_ACCOUNT');

  // ── 退会者でも、**カムバック施策として宣言された**無料特典だけは有効にする ────────
  // 退会は課金停止の状態であって利用禁止ではない（`auth/memberResolution` も同じ判断で
  // 退会者を無料会員としてログインさせている）。ここで特典を無効にすると
  // 「付与したのに使えない」ズレが生まれるため、判定を `comebackPolicy` へ揃える。
  //
  // ⚠️ 開けるのは施策が `allowedEntitlements` に宣言した権利だけ。
  //    **契約由来の権限は 1 つも戻さない**:
  //   - `paidEffective` は `accountUsable` のままなので有料 Premium / Light は無効
  //   - 三連複買い切り・購入資格も下で `accountUsable` に固定
  const withdrawnHonor = (withdrawal && !forceLogout && !suspended && !isTestAccount)
    ? honorsGrantDespiteWithdrawal({ fields: c.promoFields, nowMs })
    : { ok: false, allowedEntitlements: [] };
  const withdrawnPromoHonored = withdrawnHonor.ok === true;
  /** 退会者へ開いてよい権利（施策の宣言そのまま。宣言が無ければ空＝何も開かない） */
  const honoredEntitlements = new Set(withdrawnPromoHonored ? withdrawnHonor.allowedEntitlements : []);
  if (withdrawnPromoHonored) reasons.push('WITHDRAWN_PROMO_GRANT_HONORED');

  const canLogin = accountUsable || withdrawnPromoHonored;
  /** その権利を「いま見てよいか」。退会者は施策の宣言に含まれるものだけ通す。 */
  const mayOpen = (entitlement) => (accountUsable ? true : honoredEntitlements.has(entitlement));

  // pending は登録済みだが有料権限未確定＝Free 扱い（有料判定に入れない）。
  const paidEffective = accountUsable && !pending;
  if (pending) reasons.push('PENDING');

  const planTypeLower = String(c.planType ?? '').trim().toLowerCase();
  const lifetimeBilling = planTypeLower === 'lifetime';
  const forceExpired = isTruthyFlag(c.forceExpired);
  // Status='expired'/'unpaidrefunded' も契約切れ扱い（アカウントは拒否しない）。日付期限切れと同義。
  const expired = !lifetimeBilling && (forceExpired || statusContractExpired || isExpiredAt(c.expiresAt ?? c.validUntil, nowMs));

  const isPremiumTier = PREMIUM_TIERS.has(tier);
  const isLightTier = tier === 'light';
  const premiumActive = paidEffective && isPremiumTier && !expired;
  const lightActive = paidEffective && isLightTier && !expired;
  const premiumExpired = isPremiumTier && expired;
  if (premiumExpired) reasons.push('PREMIUM_EXPIRED');

  // ── カムバック特典（無料。課金状態には一切影響しない）──────────────
  // pending（入金待ち）でも特典は有効。特典は支払いと無関係に成立する権利であり、
  // 逆に停止・退会・テストアカウントでは canLogin=false なので自動的に無効になる。
  const grants = resolvePromotionalGrants(c.promoFields, nowMs);
  // 退会者は施策が宣言した権利だけ（`mayOpen`）。退会していなければ従来どおり。
  const promoPremiumActive = mayOpen('premium') && grants.premium.active;
  const promoLightActive = mayOpen('light') && grants.light.active;
  if (promoPremiumActive) reasons.push('PROMO_PREMIUM_GRANT');
  if (promoLightActive) reasons.push('PROMO_LIGHT_GRANT');

  // ── 閲覧資格 ──────────────────────────────────────────
  const canViewFree = canLogin;
  // Premium（有料 or 無料期間）は Light を包含。Light 永久無料も Light を開ける。
  const canViewLight = canLogin && (lightActive || premiumActive || promoPremiumActive || promoLightActive);
  const canViewPremium = premiumActive || promoPremiumActive;

  // 三連複閲覧: 原則 active AND LifetimeSanrenpuku=true（tier/Premium期限を見ない）。
  // 移行期のみ旧 tier(premium-sanrenpuku/combo) を Premium 有効中に限り許可。
  const legacyView = legacySanrenpukuTierGrantsView && LEGACY_SANRENPUKU_TIERS.has(tier) && premiumActive;
  // ⚠️ 三連複買い切りは**購入した権利**なので、施策の宣言では開けない。
  //    無料特典を認めた退会者にも戻さない（契約由来の権利は復帰させない）。
  const canViewSanrenpuku = mayOpen('sanrenpuku') && (lifetime || legacyView);

  // ── 購入資格 ──────────────────────────────────────────
  // 有効な **有料** Premium 会員 かつ 未所有 のときだけ三連複購入を提示。
  // 無料特典（Premium 30日無料）では購入資格を与えない（無料特典で販売資格を配らない）。
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
    /**
     * **有料**契約だけで見た Premium 有効性（無料特典を含まない）。
     * Premium Plus の販売資格判定など「課金実績が前提」の判定はこちらを使う。
     * canViewPremium を使うと無料特典で販売動線が開いてしまう。
     */
    paidPremiumActive: premiumActive,
    paidLightActive: lightActive,
    /** カムバック特典の内訳（表示・管理画面用） */
    promo: {
      premiumActive: promoPremiumActive,
      premiumLifetime: grants.premium.lifetime,
      premiumUntilMs: grants.premium.untilMs,
      lightActive: promoLightActive,
      lightLifetime: grants.light.lifetime,
      lightUntilMs: grants.light.untilMs,
      inconsistent: grants.inconsistent,
    },
    /**
     * 実効ティア（強い方を採用した結果）。
     * premium-sanrenpuku > premium > light > free。
     * ⚠️ 三連複は買い切り権（LifetimeSanrenpuku）で決まり、無料特典の影響を受けない。
     */
    effectiveTier: canViewSanrenpuku ? 'premium-sanrenpuku'
      : (canViewPremium ? 'premium' : (canViewLight ? 'light' : 'free')),
  };
}

/** Airtable fields から特典フィールドだけを抜き出す（他の値を entitlement 層へ持ち込まない） */
function pickPromoFields(fields) {
  const f = fields || {};
  const out = {};
  for (const k of PROMO_WRITABLE_FIELDS) {
    if (f[k] !== undefined) out[k] = f[k];
  }
  return out;
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
    // カムバック特典（未作成なら空 → 従来と同じ判定）
    promoFields: pickPromoFields(f),
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
    // 互換維持（= showPremiumActiveCard と同義）。同じ条件を複数箇所に書かないため resolver 値を単一源にする。
    showBaCard: e.canViewPremium,
    // Premium 有効カード（中央/南関の予想リンクあり）
    showPremiumActiveCard: e.canViewPremium,
    // Premium 期限切れカード（予想リンクなし・再契約導線）。ログイン可能 かつ Premium 契約が期限切れのとき。
    // premiumExpired は「Premium tier かつ 期限切れ」。Free/Light は tier 非該当で false、
    // withdrawn/suspended/ForceLogout は canLogin=false で false（アクセス拒否側）。
    // ⚠️ **現在 Premium を閲覧できる間は出さない**。無料特典（Premium 無料期間）中は
    //    契約が期限切れでも閲覧できるため、そのままだと「Premium 有効」カードと
    //    「Premium 期限切れ」カードが同時に出て矛盾する。特典が切れれば自動的に復活する。
    showPremiumExpiredCard: e.canLogin && e.premiumExpired && !e.canViewPremium,
    // 三連複カード（独立）
    showSanrenpukuCard: e.canViewSanrenpuku,
    // 三連複購入CTA
    showPurchaseCta: e.canPurchaseSanrenpuku,
    entitlements: e,
  };
}

/**
 * user-plan を保存する際に永続化すべき lifetimeSanrenpuku 値を決める。
 *
 * 権限漏洩防止の要:
 * - 古い localStorage の値を**無条件に継承しない**（別アカウントへ true が残る事故を防ぐ）。
 * - incoming（現在ユーザーの権威源＝サーバーレスポンス由来 customerData）が true/false を
 *   明示していればそれを採用（＝サーバーの true→false 訂正が反映される）。
 * - incoming が未指定のときだけ、**同一ユーザー（email 一致）と証明できる場合に限り**、
 *   直近の user-plan 値を引き継ぐ。別ユーザー / 不明は fail closed で false。
 *
 * @param {object|null} incoming 保存しようとする customerData（email, lifetimeSanrenpuku?）
 * @param {object|null} existing 既存 localStorage user-plan（別ユーザーの可能性がある古い値）
 * @returns {boolean}
 */
export function persistLifetimeForUser(incoming, existing) {
  const inc = incoming || {};
  if (inc.lifetimeSanrenpuku === true) return true;
  if (inc.lifetimeSanrenpuku === false) return false; // サーバーが明示 false → 訂正を反映
  const ex = existing || {};
  const sameUser = inc.email && ex.email
    && String(inc.email).trim().toLowerCase() === String(ex.email).trim().toLowerCase();
  if (sameUser) return ex.lifetimeSanrenpuku === true; // 同一ユーザーのみ直近値を引き継ぐ
  return false; // 別ユーザー / 不明 → 継承しない（fail closed）
}

/**
 * user-plan を保存する際に永続化すべき氏名を決める。
 *
 * 経緯: dashboard は customerData.name に表示用プレースホルダ 'お客様' を入れており、
 * それをそのまま user-plan へ保存していたため、マジックリンク検証で取得した実名を
 * 上書きして消していた。結果、問い合わせフォームの自動入力が「お客様」になり、
 * 管理者宛メールから返信相手を特定できなかった（2026-07-18 報告）。
 *
 * persistLifetimeForUser と同じ「別ユーザーへ引き継がない」原則を適用する:
 * - incoming に実名があればそれを採用
 * - 無いときだけ、**同一ユーザー（email 一致）と証明できる場合に限り** 直近の user-plan 値を引き継ぐ
 * - 別ユーザー / 不明 は空（前ユーザーの氏名を次ユーザーに見せない）
 *
 * @param {object|null} incoming 保存しようとする customerData（email, name?）
 * @param {object|null} existing 既存 localStorage user-plan（別ユーザーの可能性がある古い値）
 * @returns {string}
 */
export function persistNameForUser(incoming, existing) {
  const inc = incoming || {};
  const incName = normalizeCustomerName(inc.name);
  if (incName) return incName;
  const ex = existing || {};
  const sameUser = inc.email && ex.email
    && String(inc.email).trim().toLowerCase() === String(ex.email).trim().toLowerCase();
  return sameUser ? normalizeCustomerName(ex.name) : '';
}

/**
 * 氏名を正規化する。実名ではない表示用プレースホルダは空にする。
 * src/lib/contact-autofill.js の normalizeContactName と同一基準（プレースホルダ 'お客様'）。
 * @param {unknown} v
 * @returns {string}
 */
export function normalizeCustomerName(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s === 'お客様' ? '' : s;
}

export default resolveEntitlements;
