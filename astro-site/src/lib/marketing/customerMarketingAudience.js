/**
 * customerMarketingAudience.js — AK 顧客の「マーケティング対象状態」の単一源（純粋・I/O なし）
 *
 * ── premiumPlusAdminAudience.js との関係（混ぜないこと）────────────────────
 * AK には性質の違う 3 つの判定があり、**それぞれ別モジュール**で管理する。
 *
 *   1. 公開判定          `premiumPlus/premiumPlusRelease.js`      顧客に Premium Plus を見せるか
 *   2. Plus レビュー候補  `premiumPlus/premiumPlusAdminAudience.js` Plus 販売画面に名前を出すか
 *   3. **マーケティング対象（このモジュール）**                    キャンペーンメールの母集団
 *
 * `premiumPlusAdminAudience` を万能顧客抽出ロジックへ膨らませてはいけない。あちらは
 * 「Premium Plus を売ってよい候補か」だけを見る。こちらは期限切れ・Free・Light まで含む
 * **販売とは独立した連絡先の母集団**で、Plus 販売資格へは一切影響しない。
 *
 * ── 絶対条件 ──────────────────────────────────────────────────────
 * - 会員契約状態は既存正本 `entitlements/resolveEntitlements.js` を再利用する（再実装しない）
 * - legacy レコードの契約状態を**推測で書き換えない**。判定材料が無ければ `unknown` を返す
 * - このモジュールは判定しか返さない。Airtable へ書く値・権限・販売資格を一切返さない
 * - マーケティング対象になっても Premium Plus 販売資格は変わらない（別概念）
 */

import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { normalizePlan } from '../auth/planNormalization.js';

/** 契約状態（有料契約についての状態。Free は契約が無いので `none`） */
export const MK_CONTRACT = Object.freeze({
  ACTIVE: 'active',
  EXPIRING_SOON: 'expiring_soon',
  EXPIRED: 'expired',
  /** 有料契約が無い（Free） */
  NONE: 'none',
  /** 有料 tier だが期限・Status から状態を確定できない legacy レコード（推測しない） */
  UNKNOWN: 'unknown',
});

/** プラン区分（「何を買った人か」。現在の閲覧権限ではなく購入実績で分ける） */
export const MK_PLAN = Object.freeze({
  PREMIUM_SANRENPUKU: 'premium_sanrenpuku',
  PREMIUM: 'premium',
  LIGHT: 'light',
  FREE: 'free',
});

/** 送信可否 */
export const MK_SEND = Object.freeze({
  SENDABLE: 'sendable',
  SUPPRESSED: 'suppressed',
});

/**
 * 送信除外の理由。**すべて fail closed**（1 つでも該当したら送らない）。
 * 理由は preview / dry-run で必ず件数表示する（黙って落とさない）。
 *
 * ⚠️ **退会（Status='withdrawn' / WithdrawalRequested=true）は除外理由に含めない**（2026-07-30）。
 *    退会は**クレジット継続課金を停止するための契約上の状態**であって、メール配信の拒否ではない。
 *    根拠（`netlify/functions/process-withdrawal.js`）:
 *      - 退会受付メールが会員本人に「**メルマガは引き続き配信されます。配信停止をご希望の場合は
 *        こちらから配信停止手続きを行ってください**」と案内している
 *      - 退会処理が書くのは `WithdrawalRequested` / `WithdrawalDate` / `WithdrawalReason` /
 *        `有効期限` のみで、**`UnsubscribedAnalyticsKeiba` を書かない**
 *      - 処理内容も「Stripe 定期支払いの停止」「契約期間終了後は Free へ切替」＝課金・契約のみ
 *    退会者をマーケティングから外すことは、AK 自身が本人へ伝えた内容と矛盾する。
 *    メールを止める意思表示は `UnsubscribedAnalyticsKeiba`（＋ provider suppression）が担う。
 */
export const MK_SUPPRESSION = Object.freeze({
  NO_EMAIL: 'no_email',
  INVALID_EMAIL: 'invalid_email',
  /** ブランド別 配信停止（UnsubscribedAnalyticsKeiba）＝**唯一の明示的なメール拒否** */
  UNSUBSCRIBED: 'unsubscribed',
  /** EmailBlacklist（HARD_BOUNCE / COMPLAINT） */
  BLACKLIST: 'blacklist',
  /** アカウント停止（suspended / banned 等。AK 側が意図的に止めた相手） */
  SUSPENDED: 'suspended',
  /** テスト用アカウント（Status=test / プラン=Test） */
  TEST_ACCOUNT: 'test_account',
});

/** 除外理由の表示名（管理画面用・顧客には出さない） */
export const MK_SUPPRESSION_LABEL = Object.freeze({
  no_email: 'メールアドレス未登録',
  invalid_email: 'メールアドレス不正',
  unsubscribed: '配信停止',
  blacklist: 'バウンス/苦情リスト',
  suspended: 'アカウント停止',
  test_account: 'テストアカウント',
});

/** 「期限間近」とみなす残日数（JST 暦日）。ここだけで調整する。 */
export const EXPIRING_SOON_DAYS = 14;

/** 「最近送信済み」とみなす日数（JST 暦日）。 */
export const RECENTLY_SENT_DAYS = 30;

/** ブランド別 配信停止フィールド（newsletter 側 BRAND_TO_UNSUBSCRIBE_FIELD と同じ値） */
export const MK_UNSUBSCRIBE_FIELD = 'UnsubscribedAnalyticsKeiba';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 期限なしとみなす PlanType（Lifetime は期限で切れない） */
const LIFETIME_PLAN_TYPE = 'lifetime';

/**
 * 契約を終了した Status（**課金・契約の状態であってメール拒否ではない**）。
 * 送信可否には使わず、`withdrawn` フラグとして表示にだけ使う。
 */
const WITHDRAWN_STATUS = new Set(['withdrawn', 'cancelled', 'canceled', 'closed', '退会', '解約']);
/** アカウント停止系 Status（AK 側が意図的に止めた相手。こちらは送信除外を維持する） */
const SUSPENDED_STATUS = new Set(['suspended', 'inactive', 'banned', 'disabled', '停止', '無効']);

function jstDayNumber(ms) {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS);
}

/** JST 暦日の差（to − from）。同じ日なら 0。 */
export function jstDayDiff(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return jstDayNumber(toMs) - jstDayNumber(fromMs);
}

/** 'YYYY-MM-DD' は JST 0:00 として解釈する（UTC 解釈だと深夜に 1 日ズレる）。 */
export function toMs(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const t = Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isFinite(t) ? t - JST_OFFSET_MS : null;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return v;
  }
  return null;
}

/** Email 正規化（newsletter 側 resolveEmail と同一基準: trim + lowercase） */
export function normalizeEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * プラン区分を決める。「現在の閲覧権限」ではなく「何を買った人か」で分ける。
 * 三連複買い切り（LifetimeSanrenpuku）保有者は、プラン欄が Premium でも premium_sanrenpuku。
 */
export function resolvePlanGroup(fields) {
  const f = fields || {};
  const tier = normalizePlan(String(firstNonEmpty(f['プラン'], f.Plan) ?? '').trim()) ?? 'free';
  const lifetime = f.LifetimeSanrenpuku === true || f['三連複Lifetime'] === true;
  if (lifetime || tier === 'premium-sanrenpuku' || tier === 'premium-combo') return MK_PLAN.PREMIUM_SANRENPUKU;
  if (tier === 'premium' || tier === 'premium-predictions') return MK_PLAN.PREMIUM;
  if (tier === 'light') return MK_PLAN.LIGHT;
  return MK_PLAN.FREE;
}

/**
 * 契約状態を決める。
 *
 * - Free（有料 tier でない）→ `none`
 * - 有効期限が読めて期限内 → `active`（残り EXPIRING_SOON_DAYS 日以内なら `expiring_soon`）
 * - 有効期限が読めて期限切れ → `expired`
 * - Status が expired / unpaidrefunded → `expired`（日付が無くても契約切れは確定している）
 * - PlanType=Lifetime → `active`（期限で切れない）
 * - 有料 tier なのに期限も Status も手掛かりが無い → **`unknown`**（推測しない）
 *
 * ⚠️ resolveEntitlements は「期限が空＝期限なし＝有効」と解釈する（誤って弾かないため）。
 *    マーケティング画面ではその曖昧さを `unknown` として**可視化**する。判定を書き換えはしない。
 */
export function resolveContractState({ fields, entitlements, nowMs }) {
  const f = fields || {};
  const ent = entitlements || {};
  const planGroup = resolvePlanGroup(f);
  if (planGroup === MK_PLAN.FREE) return { contract: MK_CONTRACT.NONE, daysToExpiry: null, expiryMs: null };

  const status = String(firstNonEmpty(f.AccountStatus, f.Status) ?? '').trim().toLowerCase();
  const planType = String(f.PlanType ?? '').trim().toLowerCase();
  const expiryMs = toMs(firstNonEmpty(f['有効期限'], f.ValidUntil, f.ExpiryDate, f.ExpirationDate));
  const daysToExpiry = expiryMs === null ? null : jstDayDiff(nowMs, expiryMs);

  if (status === 'expired' || status === 'unpaidrefunded') {
    return { contract: MK_CONTRACT.EXPIRED, daysToExpiry, expiryMs };
  }
  if (planType === LIFETIME_PLAN_TYPE) {
    return { contract: MK_CONTRACT.ACTIVE, daysToExpiry, expiryMs };
  }
  if (expiryMs !== null) {
    if (daysToExpiry < 0) return { contract: MK_CONTRACT.EXPIRED, daysToExpiry, expiryMs };
    if (daysToExpiry <= EXPIRING_SOON_DAYS) return { contract: MK_CONTRACT.EXPIRING_SOON, daysToExpiry, expiryMs };
    return { contract: MK_CONTRACT.ACTIVE, daysToExpiry, expiryMs };
  }
  // 有効期限が無い有料 tier。pending は入金待ちで契約未確定、active は根拠が無い。
  if (status === 'pending' || status === '入金待ち' || status === '未入金') {
    return { contract: MK_CONTRACT.UNKNOWN, daysToExpiry: null, expiryMs: null };
  }
  // entitlement 側は「期限なし＝有効」と見るが、こちらは根拠不足として unknown に落とす。
  if (ent.canViewPremium === true || ent.canViewLight === true) {
    return { contract: MK_CONTRACT.UNKNOWN, daysToExpiry: null, expiryMs: null };
  }
  return { contract: MK_CONTRACT.UNKNOWN, daysToExpiry: null, expiryMs: null };
}

/**
 * 送信可否と除外理由を決める（fail closed）。
 * @param {{ fields?: object, blacklistEmails?: Set<string> }} input
 */
export function resolveSendability({ fields, blacklistEmails }) {
  const f = fields || {};
  const reasons = [];
  const email = normalizeEmail(f.Email ?? f.email);

  if (!email) reasons.push(MK_SUPPRESSION.NO_EMAIL);
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) reasons.push(MK_SUPPRESSION.INVALID_EMAIL);

  if (f[MK_UNSUBSCRIBE_FIELD] === true) reasons.push(MK_SUPPRESSION.UNSUBSCRIBED);
  if (email && blacklistEmails instanceof Set && blacklistEmails.has(email)) reasons.push(MK_SUPPRESSION.BLACKLIST);

  const status = String(firstNonEmpty(f.AccountStatus, f.Status) ?? '').trim().toLowerCase();
  // ⚠️ 退会（Status='withdrawn' / WithdrawalRequested=true）は**除外しない**。
  //    課金停止の契約状態であってメール拒否ではない（詳細は MK_SUPPRESSION の注記）。
  //    表示用に withdrawn フラグだけ返す。
  if (SUSPENDED_STATUS.has(status)) reasons.push(MK_SUPPRESSION.SUSPENDED);

  const planRaw = String(firstNonEmpty(f['プラン'], f.Plan) ?? '').trim().toLowerCase();
  if (status === 'test' || planRaw === 'test') reasons.push(MK_SUPPRESSION.TEST_ACCOUNT);

  return {
    sendable: reasons.length === 0,
    sendState: reasons.length === 0 ? MK_SEND.SENDABLE : MK_SEND.SUPPRESSED,
    suppressionReasons: reasons,
    /** 契約上の退会（表示専用。送信可否には影響しない） */
    withdrawn: f.WithdrawalRequested === true || WITHDRAWN_STATUS.has(status),
  };
}

/**
 * 1 顧客のマーケティング属性をまとめて解決する（純粋・読み取りのみ）。
 *
 * @param {{
 *   fields: object,
 *   nowMs: number,
 *   blacklistEmails?: Set<string>,
 *   history?: { lastSentAtMs?: number|null, lastCampaignId?: string|null, sentCount?: number },
 * }} input
 * @returns {{
 *   email: string, plan: string, contract: string, daysToExpiry: number|null,
 *   hasSanrenpuku: boolean, premiumActive: boolean, sendable: boolean, sendState: string,
 *   suppressionReasons: string[], history: object, segments: string[],
 * }}
 */
export function resolveCustomerMarketing({ fields, nowMs, blacklistEmails, history } = {}) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ent = resolveEntitlements(fromAirtableFields(f), now);

  const plan = resolvePlanGroup(f);
  const { contract, daysToExpiry } = resolveContractState({ fields: f, entitlements: ent, nowMs: now });
  const send = resolveSendability({ fields: f, blacklistEmails });

  const h = history || {};
  const lastSentAtMs = Number.isFinite(h.lastSentAtMs) ? h.lastSentAtMs : null;
  const daysSinceLastSent = lastSentAtMs === null ? null : jstDayDiff(lastSentAtMs, now);
  const hist = {
    lastSentAtMs,
    lastCampaignId: h.lastCampaignId || null,
    sentCount: Number.isFinite(h.sentCount) ? h.sentCount : 0,
    daysSinceLastSent,
  };

  const segments = [
    `contract:${contract}`,
    `plan:${plan}`,
    `mk:${send.sendState}`,
    `pp:${String(f.PremiumPlusEligibility || 'unset').trim().toLowerCase()}`,
    hist.sentCount > 0 ? 'history:sent' : 'history:never',
  ];
  // 契約上の退会は**送信可否とは別軸**。絞り込み・表示のためにセグメントとして持つ。
  if (send.withdrawn) segments.push('withdrawn:yes');
  if (daysSinceLastSent !== null && daysSinceLastSent <= RECENTLY_SENT_DAYS) segments.push('history:recent');
  for (const r of send.suppressionReasons) segments.push(`suppression:${r}`);

  return {
    email: normalizeEmail(f.Email ?? f.email),
    plan,
    contract,
    daysToExpiry,
    hasSanrenpuku: ent.canViewSanrenpuku === true,
    premiumActive: ent.canViewPremium === true,
    lightActive: ent.canViewLight === true && ent.canViewPremium !== true,
    ...send,
    history: hist,
    segments,
  };
}

/**
 * 管理画面のフィルタ条件に一致するか（すべて AND / 未指定は素通し）。
 *
 * @param {object} m resolveCustomerMarketing の戻り値
 * @param {{ contract?: string, plan?: string, marketing?: string, premiumPlus?: string, history?: string }} filter
 */
export function matchesMarketingFilter(m, filter = {}) {
  if (!m) return false;
  const f = filter || {};
  const eq = (v, expected) => !expected || expected === 'all' || v === expected;

  if (!eq(m.contract, f.contract)) return false;
  if (!eq(m.plan, f.plan)) return false;
  if (f.marketing && f.marketing !== 'all') {
    if (f.marketing === MK_SEND.SENDABLE && !m.sendable) return false;
    if (f.marketing === MK_SEND.SUPPRESSED && m.sendable) return false;
  }
  if (f.premiumPlus && f.premiumPlus !== 'all') {
    if (!m.segments.includes(`pp:${f.premiumPlus}`)) return false;
  }
  if (f.history && f.history !== 'all') {
    if (f.history === 'recent' && !m.segments.includes('history:recent')) return false;
    if (f.history === 'never' && !m.segments.includes('history:never')) return false;
    if (f.history === 'sent' && !m.segments.includes('history:sent')) return false;
  }
  return true;
}

/** 顧客配列 → セグメント別件数（PII を含まない集計だけを返す）。 */
export function summarizeSegments(list) {
  const counts = {
    total: 0, contract: {}, plan: {}, marketing: {}, premiumPlus: {}, suppression: {},
    // 契約上の退会者（送信可否とは別軸。うち何名が送信可能かも数える）
    withdrawn: { total: 0, sendable: 0, suppressed: 0 },
  };
  for (const m of list || []) {
    counts.total += 1;
    if (m.withdrawn) {
      counts.withdrawn.total += 1;
      counts.withdrawn[m.sendable ? 'sendable' : 'suppressed'] += 1;
    }
    counts.contract[m.contract] = (counts.contract[m.contract] || 0) + 1;
    counts.plan[m.plan] = (counts.plan[m.plan] || 0) + 1;
    counts.marketing[m.sendState] = (counts.marketing[m.sendState] || 0) + 1;
    const pp = (m.segments.find((s) => s.startsWith('pp:')) || 'pp:unset').slice(3);
    counts.premiumPlus[pp] = (counts.premiumPlus[pp] || 0) + 1;
    for (const r of m.suppressionReasons) counts.suppression[r] = (counts.suppression[r] || 0) + 1;
  }
  return counts;
}

export default resolveCustomerMarketing;
