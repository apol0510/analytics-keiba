/**
 * customerDossier.js — 1 顧客の「カルテ」を組み立てる（純粋・Airtable 非依存）
 *
 * 管理画面が「この人に今なにが起きているか」を 1 画面で判断するための集約。
 * **判定は既存の単一源へ委譲し、ここで再実装しない**:
 *   - ログイン可否   … `auth/memberResolution.js`（`resolveMembership`）
 *   - 閲覧権限・契約 … `entitlements/resolveEntitlements.js`
 *   - 送信可否・区分 … `marketing/customerMarketingAudience.js`
 *   - オファー有効性 … `promotions/offerCampaignLink.js`（`isLiveOffer`）
 *
 * ── 最終ログインは 3 つの出所がある（2026-08-01）────────────────────────
 * AK には長らく「最終ログイン」列が無く、次の 3 つに割れている。
 * どれを見せているかを **必ず `source` 付きで返す**（画面で誤読させないため）。
 *
 * | 出所 | 対象 | 期間 |
 * |---|---|---|
 * | `最終ログイン`（既存列） | 全員 | 2026-08-01 以降（記録開始後）|
 * | `AuthTokens`（Used=true の最新） | 有料会員のみ | 2026-05-21 以降 |
 * | `最終ポイント付与日` | 全員 | 〜2026-07-08（旧ログインポイント運用の副産物）|
 *
 * `最終ログイン` が空でも動く（値が無ければ他の 2 つで埋める）。列名は
 * `auth/lastLoginRecord.js` の `LAST_LOGIN_FIELD` が単一源。
 */

import { resolveMembership, MEMBER_TYPE, MEMBER_REASON } from '../auth/memberResolution.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { resolveCustomerMarketing } from './customerMarketingAudience.js';
import { isLiveOffer } from '../promotions/offerCampaignLink.js';
import { LAST_LOGIN_FIELD } from '../auth/lastLoginRecord.js';
import { buildCustomerTimeline, summarizeEngagement } from './customerTimeline.js';
import { buildRecommendations } from './recommendedActions.js';

const norm = (v) => String(v ?? '').trim().toLowerCase();
const str = (v) => String(v ?? '').trim();
const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const parse = (v) => {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : null;
};

/** 最終ログインの出所（画面に必ず併記する） */
export const LOGIN_SOURCE = Object.freeze({
  /** Customers の既存列 `最終ログイン`（2026-08-01 以降の正規の記録） */
  FIELD: 'last_login_field',
  /** AuthTokens の使用済みトークン（有料会員のマジックリンク） */
  MAGIC_LINK: 'magic_link',
  /** 最終ポイント付与日（〜2026-07-08 の旧運用。日付のみ） */
  LEGACY_POINTS: 'legacy_points',
  /** どこにも記録が無い */
  NONE: 'none',
});

export const LOGIN_SOURCE_LABEL = Object.freeze({
  last_login_field: 'ログイン記録',
  magic_link: 'ログインリンク使用（有料）',
  legacy_points: '旧ポイント履歴（〜2026-07-08）',
  none: '記録なし',
});

/** ログイン可否を人間可読にする（管理者が理由をそのまま顧客へ説明できる粒度） */
export const LOGIN_STATE_LABEL = Object.freeze({
  [MEMBER_REASON.CLEAR_FREE]: '無料会員としてログインできる',
  [MEMBER_REASON.PENDING_PAYMENT_FREE]: '入金待ち（無料会員としてログインできる）',
  [MEMBER_REASON.ACTIVE_PAID]: '有料会員（ログインリンクでログイン）',
  [MEMBER_REASON.LIFETIME_SANRENPUKU]: '三連複 買い切り（ログインリンクでログイン）',
  [MEMBER_REASON.PROMO_PREMIUM_GRANT]: 'Premium 無料特典（ログインリンクでログイン）',
  [MEMBER_REASON.PROMO_LIGHT_GRANT]: 'Light 無料特典（ログインリンクでログイン）',
  [MEMBER_REASON.EXPIRED]: '期限切れ → 無料会員としてログインできる',
  [MEMBER_REASON.WITHDRAWAL_REQUESTED]: '退会申請済み → 無料会員としてログインできる',
  [MEMBER_REASON.FORCE_LOGOUT]: '強制ログアウト中（ログイン不可）',
  [MEMBER_REASON.STATUS_SUSPENDED]: '利用停止（ログイン不可）',
  [MEMBER_REASON.UNKNOWN_PLAN]: 'プラン値が不正（ログイン不可）',
  [MEMBER_REASON.MISSING_PLAN]: 'プラン未設定（ログイン不可）',
  [MEMBER_REASON.PLAN_CONFLICT]: 'プラン設定の矛盾（ログイン不可）',
  [MEMBER_REASON.INVALID_SESSION_VERSION]: 'SessionVersion 異常（ログイン不可）',
  [MEMBER_REASON.UNKNOWN_VENUE]: 'VenueAccess 不正（ログイン不可）',
});

/**
 * 最終ログインを 3 つの出所から解決する。
 * **新しい方を採るのではなく、信頼できる順**（正規の記録 > マジックリンク > 旧ポイント）で選び、
 * 併せて全出所の値も返す（画面で内訳を出せるように）。
 *
 * @param {{ fields: object, magicLinkAtMs?: number|null }} input
 */
export function resolveLastLogin({ fields = {}, magicLinkAtMs = null } = {}) {
  // 列名は lastLoginRecord.js の定数を使う（書き込み側と表示側で必ず一致させる）
  const fieldAt = parse(fields[LAST_LOGIN_FIELD]);
  // 旧運用は「日付のみ」。JST の日付として保存されていたので時刻は 00:00 として扱う
  const legacyAt = parse(fields['最終ポイント付与日']);
  const magicAt = Number.isFinite(magicLinkAtMs) ? magicLinkAtMs : null;

  const sources = {
    [LOGIN_SOURCE.FIELD]: iso(fieldAt),
    [LOGIN_SOURCE.MAGIC_LINK]: iso(magicAt),
    [LOGIN_SOURCE.LEGACY_POINTS]: iso(legacyAt),
  };

  const picked = fieldAt != null ? { at: fieldAt, source: LOGIN_SOURCE.FIELD }
    : magicAt != null ? { at: magicAt, source: LOGIN_SOURCE.MAGIC_LINK }
      : legacyAt != null ? { at: legacyAt, source: LOGIN_SOURCE.LEGACY_POINTS }
        : { at: null, source: LOGIN_SOURCE.NONE };

  return {
    at: iso(picked.at),
    atMs: picked.at,
    source: picked.source,
    sourceLabel: LOGIN_SOURCE_LABEL[picked.source],
    sources,
  };
}

/** 最終ログインからの経過日数（記録が無ければ null） */
export function daysSinceLogin(lastLogin, nowMs) {
  if (!lastLogin || !Number.isFinite(lastLogin.atMs) || !Number.isFinite(nowMs)) return null;
  return Math.floor((nowMs - lastLogin.atMs) / (24 * 60 * 60 * 1000));
}

/** 最終ログインのセグメント（絞り込み用。境界は片側閉区間で重複しない） */
export const LOGIN_SEGMENT = Object.freeze({
  D30: 'login:30d',
  D90: 'login:90d',
  D365: 'login:365d',
  OVER365: 'login:over365',
  NEVER: 'login:never',
});

export function loginSegment(days) {
  if (days === null || days === undefined) return LOGIN_SEGMENT.NEVER;
  if (days <= 30) return LOGIN_SEGMENT.D30;
  if (days <= 90) return LOGIN_SEGMENT.D90;
  if (days <= 365) return LOGIN_SEGMENT.D365;
  return LOGIN_SEGMENT.OVER365;
}

/**
 * 1 顧客のカルテを組み立てる。
 *
 * @param {{
 *   record: { id: string, fields: object, createdTime?: string },
 *   nowMs: number,
 *   magicLinkAtMs?: number|null,
 *   offerRecords?: object[],
 *   deliveryRecords?: object[],
 *   blacklistEmails?: Set<string>,
 *   softBounceEmails?: Set<string>,
 *   providerSuppressed?: Set<string>|null,
 *   history?: object|null,
 * }} input
 */
export function buildCustomerDossier(input = {}) {
  const {
    record, nowMs, magicLinkAtMs = null,
    offerRecords = [], deliveryRecords = [],
    blacklistEmails = new Set(), softBounceEmails = new Set(),
    providerSuppressed = null, history = null,
    tokenRecords = [], activityEvents = null, activityAvailable = false,
  } = input;

  const fields = (record && record.fields) || {};
  const recordId = str(record && record.id);
  const email = norm(fields.Email);

  const membership = resolveMembership({ fields, recordId, now: nowMs });
  const entitlements = resolveEntitlements(fromAirtableFields(fields), nowMs);
  const marketing = resolveCustomerMarketing({
    fields, nowMs, blacklistEmails, history,
  });

  const lastLogin = resolveLastLogin({ fields, magicLinkAtMs });
  const days = daysSinceLogin(lastLogin, nowMs);

  // --- 到達性（送れるか）。provider を確認できない場合は null で「不明」を明示する ---
  const deliverability = {
    sendable: marketing.sendable,
    suppressionReasons: marketing.suppressionReasons,
    unsubscribed: fields.UnsubscribedAnalyticsKeiba === true,
    blacklisted: !!email && blacklistEmails.has(email),
    softBounced: !!email && softBounceEmails.has(email),
    providerSuppressed: providerSuppressed instanceof Set ? providerSuppressed.has(email) : null,
  };

  // --- 送信履歴（このブランドのキャンペーンのみ） ---
  const mine = deliveryRecords
    .filter((r) => norm(r?.fields?.RecipientEmail) === email)
    .map((r) => ({
      campaign: str(r.fields?.CampaignType),
      status: str(r.fields?.Status),
      at: str(r.fields?.SentAt || r.fields?.QueuedAt || ''),
      jobId: str(r.fields?.ScheduledEmailJobId),
    }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));

  // --- 割引オファー（recordId か email が一致するもの） ---
  const offers = offerRecords
    .filter((o) => str(o?.fields?.CustomerRecordId) === recordId
      || (!!email && norm(o?.fields?.Email) === email))
    .map((o) => ({
      offerId: str(o.fields?.OfferId),
      status: str(o.fields?.Status),
      regularPrice: Number(o.fields?.RegularPrice) || null,
      offerPrice: Number(o.fields?.OfferPrice) || null,
      expiresAt: str(o.fields?.ExpiresAt),
      live: isLiveOffer({ record: o, nowMs }),
      operationId: str(o.fields?.OperationId),
    }))
    .sort((a, b) => String(b.expiresAt).localeCompare(String(a.expiresAt)));

  // --- 無料特典（付与の生値ではなく resolveEntitlements の解釈を出す） ---
  const promo = entitlements.promo || {};

  // ── 時系列履歴と推奨（どちらも read-only・判定は既存の単一源に委譲）──
  const timeline = buildCustomerTimeline({
    record, nowMs, offerRecords, deliveryRecords, tokenRecords, activityEvents, activityAvailable,
  });
  const engagement = summarizeEngagement({ events: timeline.events, available: timeline.limits.engagementAvailable });
  const advice = buildRecommendations({
    marketing: { ...marketing, premiumPlusEligibility: str(fields.PremiumPlusEligibility) },
    entitlements, membership, offers,
    engagement, daysSinceLogin: days,
    lastSentAtMs: marketing.history && marketing.history.lastSentAtMs, nowMs,
  });

  return {
    recordId,
    email: fields.Email || '',
    name: fields['氏名'] || '',
    registeredAt: str(fields['登録日']) || str(record?.createdTime) || '',

    /** ① ログイン可否（今回の 403 事故を画面で即判別するための中心情報） */
    login: {
      memberType: membership.memberType,
      canLogin: membership.memberType !== MEMBER_TYPE.DENIED,
      /**
       * ログイン方法。`link` = メールで届くリンクを開く必要がある（有料階層）／
       * `instant` = メールアドレス入力だけで入れる（無料）。
       * ※ 管理画面はログイン手段を**発行しない**ため、ここは表示用の区分でしかない。
       */
      loginMethod: membership.memberType === MEMBER_TYPE.PAID ? 'link' : 'instant',
      reason: membership.reason,
      label: LOGIN_STATE_LABEL[membership.reason] || membership.reason,
      entitlementSource: membership.entitlementSource,
      sessionPlan: membership.normalizedPlan,
      lastLogin,
      daysSinceLogin: days,
      loginSegment: loginSegment(days),
    },

    /** ② メール到達性と送信履歴 */
    reachability: deliverability,
    delivery: {
      lastSentAt: marketing.history?.lastSentAtMs ? iso(marketing.history.lastSentAtMs) : null,
      lastCampaign: marketing.history?.lastCampaignId || '',
      sentCount: marketing.history?.sentCount ?? 0,
      recent: mine.slice(0, 5),
    },

    /** ③ 特典・オファー・Premium Plus */
    grantsAndOffers: {
      promoLight: {
        active: promo.lightActive === true,
        lifetime: promo.lightLifetime === true,
        until: iso(promo.lightUntilMs),
      },
      promoPremium: {
        active: promo.premiumActive === true,
        lifetime: promo.premiumLifetime === true,
        until: iso(promo.premiumUntilMs),
      },
      /** 付与データの矛盾（取り消し済みなのに値が残る等）。true なら手当てが要る */
      promoInconsistent: promo.inconsistent === true,
      offers,
      liveOfferCount: offers.filter((o) => o.live).length,
      premiumPlusEligibility: str(fields.PremiumPlusEligibility),
    },

    /** ④ 契約・決済 */
    contract: {
      plan: str(fields['プラン']),
      planType: str(fields.PlanType),
      status: str(fields.Status),
      expiresAt: str(fields['有効期限'] || fields.ExpirationDate),
      contractState: marketing.contract,
      planGroup: marketing.plan,
      daysToExpiry: marketing.daysToExpiry,
      withdrawn: marketing.withdrawn === true,
      withdrawalDate: str(fields.WithdrawalDate),
      lifetimeSanrenpuku: fields.LifetimeSanrenpuku === true,
      paidAt: str(fields.PaidAt),
      paymentConfirmed: fields.PaymentConfirmed === true,
      paymentMethod: str(fields.PaymentMethod),
      requested: has(fields.RequestedPlan) || has(fields.RequestedPlanType) || has(fields.RequestedAmount)
        ? {
          plan: str(fields.RequestedPlan),
          planType: str(fields.RequestedPlanType),
          amount: Number(fields.RequestedAmount) || null,
        }
        : null,
    },

    /** ⑥ 時系列履歴（出所つき。取得できない情報は limits で明示） */
    timeline: timeline.events,
    timelineUnknownDate: timeline.unknownDateEvents,
    timelineLimits: timeline.limits,

    /** ⑦ 反応（取得できない期間は null。0 と表示しない） */
    engagement,

    /** ⑧ 推奨アクション（提案のみ・自動実行しない） */
    recommendations: advice.recommendations,
    sendableFrom: advice.sendableFrom,

    /** ⑤ 閲覧できるもの（判定の答え合わせ用） */
    access: {
      canViewFree: entitlements.canViewFree === true,
      canViewLight: entitlements.canViewLight === true,
      canViewPremium: entitlements.canViewPremium === true,
      canViewSanrenpuku: entitlements.canViewSanrenpuku === true,
    },
  };
}

/**
 * AuthTokens から「メールごとの最終ログイン（使用済みトークンの最新）」を作る。
 * 未使用トークンは**ログインしていない**ので除外する。
 */
export function summarizeMagicLinkLogins(tokenRecords = []) {
  const byEmail = new Map();
  for (const rec of tokenRecords) {
    const f = (rec && rec.fields) || {};
    if (f.Used !== true) continue;
    const email = norm(f.Email);
    if (!email) continue;
    const at = parse(f.UsedAt) ?? parse(f.CreatedAt) ?? parse(rec.createdTime);
    if (at == null) continue;
    const prev = byEmail.get(email);
    if (prev == null || at > prev) byEmail.set(email, at);
  }
  return byEmail;
}
