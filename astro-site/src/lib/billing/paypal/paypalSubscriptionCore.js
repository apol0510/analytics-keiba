/**
 * paypalSubscriptionCore.js — PayPal の月額定期課金（Subscriptions API）の判定（純粋・I/O なし）
 *
 * 2026-10-15 MK 決定: 「PayPal は月額の定期課金で決済を受け付ける。年払い・買い切りは銀行振込を維持。
 * 銀行振込の 1 ヶ月プランは停止のまま」。商品・価格・権利・退会は既存の月額の確定仕様と同じ
 * （spec「Stripe 定期購読」2026-10-02・即時退会 2026-10-07）。商品の正本は stripePlans.STRIPE_PLANS（金額・会場・名称）。
 *
 * ## 権限の持ち方（Stripe 月額と同じ形）
 *   プラン=Premium / PlanType=Monthly / Status=active / PaymentMethod=PayPal / VenueAccess=''|'jra'|'nankan'
 *   有効期限 = 最後に**支払われた**日（JST）+ 1 ヶ月 + 猶予 2 日
 * 期限の根拠は PayPal の `billing_info.last_payment`（支払い済み）だけ。`next_billing_time` は使わない
 * （支払い前に進むことがあり、決済失敗でも延びてしまう＝Stripe 初版と同じ誤りを避ける）。
 * 支払いが止まれば何も書かなくても期限で自然に止まる（fail closed）。
 *
 * ## 会員と購読の対応
 * - 購読の `custom_id` = `recordId:商品コード`（A=全会場・J=中央版・N=南関版。作成時にサーバーが付ける。ログイン必須）。
 *   どの会員かはこれだけで決める。2026-10-15 から会場名を決済会社へ渡さないためコードにした（旧形式 `recordId:premium-jra` も読む）。
 * - その会員の「いまの購読」は Redis `ak:paypal:sub:member:{recordId}`（反映時に書く）。退会・二重契約の判定に使う。
 *   Customers に PayPal 購読 ID の列は無い（Functions の鍵に列追加の権限が無いため・2026-10-15）。
 *
 * ## 書かない（conflict）ケース — 二重課金・権利の縮小を起こさない（Stripe 月額と同じ）
 *   duplicate_subscription（別の PayPal 購読／Stripe 月額が生きている）・existing_lifetime・existing_longer_contract・
 *   unknown_plan・plan_mismatch・amount_mismatch。conflict は管理者へ通知して手で返金・解約する（自動返金しない）。
 *
 * ## 年額の定期課金（2026-10-20 MK 決定・decisions「2026-10-20 — 年払いは PayPal 年額定期課金」）
 * 「年払いは PayPal の年額定期課金（12 か月ごと自動更新）。買い切りは銀行振込だけ。月額・年払いの銀行振込は現状維持。価格・権利は不変」。
 *   - 商品: Premium 年払い ¥49,800（premium-annual）／Light 会員の乗り換え特典 ¥44,820（premium-annual-light・資格はサーバーで判定）
 *   - 権限: プラン=Premium / PlanType=Annual / Status=active / PaymentMethod=PayPal / VenueAccess=''（両会場）
 *     有効期限 = 最後に支払われた日（JST）+ 12 か月 + 猶予 2 日（月額と同じ考え方。next_billing_time は見ない）
 *   - 二重課金防止: 生きている月額・年額の購読（PayPal / Stripe）や、有効な Premium（銀行振込の年払い等）・買い切りがある会員には作らない／反映しない
 *   - 買い切り（premium-lifetime）は定期課金の商品に無い＝申込も反映もできない（fail closed）
 */

import { STRIPE_PLANS, venueAccessValue } from '../stripePlans.js';
import { checkMemberOnlyPricing } from '../../pricing/pricingEligibility.js';
import { PAYMENT_BASE_NAME, PAYPAL_PLAN_NAMES, assertPaypalPlanName } from '../paymentDisplayNames.js';
import { paypalReturnUrls } from '../neutralCheckoutHost.js';
import { addMonthsJst, jstDateString } from '../../payments/bankPaymentFlow.js';
import { normalizePlan } from '../../auth/planNormalization.js';
import { withdrawalFields } from '../stripeSubscriptionSync.js';

export const PROVIDER = 'paypal';
export const PAYMENT_METHOD = 'PayPal';
export const PAYPAL_PRODUCT_NAME = PAYMENT_BASE_NAME;
/** 会員の退会で解約した購読の印（cancel の reason → 購読の status_change_note）*/
export const MEMBER_WITHDRAWAL_NOTE = 'ak_member_withdrawal';

/**
 * PayPal の Plan ID（秘密ではない・env 4KB 枠を使わないためコードに持つ）。
 * scripts/paypal-subscription-setup.mjs が PayPal から読んで一致を検査する。live は Live の鍵を受け取ってから作る。
 */
export const PAYPAL_PLAN_IDS = Object.freeze({
  test: Object.freeze({ // Sandbox（PROD-1DB142038K1860725・2026-10-15 作成）
    'premium': 'P-67290333XA2635522NLIAFTY',
    'premium-jra': 'P-7NF43083F7102171SNLIAFUI',
    'premium-nankan': 'P-55C52460MJ2631844NLIAFUY',
    'premium-annual': 'P-9WM673713N634224FNLLP72Q', // 年額（2026-10-20 作成・YEAR×1・¥49,800）
    'premium-annual-light': 'P-42U66834DF9032109NLLP72Y', // 年額 Light 会員特典（2026-10-20 作成・YEAR×1・¥44,820）
  }),
  live: Object.freeze({ // Live（PROD-3CX00591EL992881E・2026-10-15 作成）
    'premium': 'P-0JC899281X7628327NLIDMPA',
    'premium-jra': 'P-2SA230418U121823UNLIDMPI',
    'premium-nankan': 'P-34226589BA0629739NLIDMPQ',
    'premium-annual': 'P-2H627640LB4938523NLLQSOY', // 年額（2026-10-20 MK が setup --apply で作成・YEAR×1・¥49,800・ACTIVE を read-only で照合）
    'premium-annual-light': 'P-8SC81909AJ476194TNLLQSPA', // 年額 Light 会員特典（同上・YEAR×1・¥44,820）
  }),
});

/**
 * 年額の定期課金で売る商品（2026-10-20 MK 決定）。金額は銀行振込の年払いと同じ（cardOneTime.CARD_PRODUCTS・/pricing/）。
 * 両会場（venues = jra + nankan）。memberOnly は Light 会員の乗り換え特典（checkMemberOnlyPricing と同じ根拠でサーバーが判定）。
 */
export const ANNUAL_SUBSCRIPTION_PLANS = Object.freeze([
  Object.freeze({
    id: 'premium-annual', label: 'Premium 年払い（自動更新）', amountYen: 49800, interval: 'YEAR', months: 12, planType: 'Annual',
    venues: Object.freeze(['jra', 'nankan']), bankProductName: 'Premium Annual',
  }),
  Object.freeze({
    id: 'premium-annual-light', label: 'Premium 年払い・Light 会員特典（自動更新）', amountYen: 44820, interval: 'YEAR', months: 12, planType: 'Annual',
    venues: Object.freeze(['jra', 'nankan']), bankProductName: 'Premium Annual - Campaign', memberOnly: true,
  }),
]);

/** 定期課金で売る全商品（月額 3 本は stripePlans が正本・年額 2 本）。買い切りは含めない（銀行振込だけ） */
export const SUBSCRIPTION_PLANS = Object.freeze([
  ...STRIPE_PLANS.map((p) => Object.freeze({ ...p, interval: 'MONTH', months: 1, planType: 'Monthly' })),
  ...ANNUAL_SUBSCRIPTION_PLANS,
]);
export function subscriptionPlanById(id) {
  return SUBSCRIPTION_PLANS.find((p) => p.id === String(id || '')) || null;
}
export const isAnnualPlan = (plan) => plan?.planType === 'Annual';
/** 買い切りは銀行振込だけ（2026-10-20 MK 決定）。定期課金・カードの申込では必ずこの理由で断る */
export const LIFETIME_BANK_ONLY = 'lifetime_bank_transfer_only';

export const SUBSCRIPTION_EVENTS = Object.freeze([
  'BILLING.SUBSCRIPTION.CREATED', 'BILLING.SUBSCRIPTION.ACTIVATED', 'BILLING.SUBSCRIPTION.UPDATED',
  'BILLING.SUBSCRIPTION.RE-ACTIVATED', 'BILLING.SUBSCRIPTION.CANCELLED', 'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.EXPIRED', 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
]);
export const SALE_EVENTS = Object.freeze(['PAYMENT.SALE.COMPLETED']);
export const SALE_REFUND_EVENTS = Object.freeze(['PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED']);
export const SUBSCRIPTION_WEBHOOK_EVENTS = Object.freeze([...SUBSCRIPTION_EVENTS, ...SALE_EVENTS, ...SALE_REFUND_EVENTS]);

const SUB_RE = /^I-[A-Z0-9]{10,24}$/;
const RECORD_RE = /^rec[A-Za-z0-9]{14}$/;
export const isSubscriptionId = (id) => SUB_RE.test(String(id || ''));

/** 二重契約とみなす（まだ課金され得る）状態 */
export const LIVE_STATUSES = Object.freeze(['APPROVED', 'ACTIVE', 'SUSPENDED']);
const ENDED_STATUSES = new Set(['CANCELLED', 'EXPIRED']);
/** 退会で cancel を呼ぶ状態（既に終わっていれば呼ばない） */
export const CANCELLABLE_STATUSES = Object.freeze(['APPROVED', 'ACTIVE', 'SUSPENDED']);

export const memberKey = (recordId) => `ak:paypal:sub:member:${recordId}`;

/**
 * PayPal に出す Plan の名前・説明（2026-10-15 MK 確定の許可リストだけ。Stripe の productName には依存しない）。
 * 説明も名前と同じ文字列（中立・何も足さない）。
 */
export function paypalPlanDisplay(planId) {
  const name = assertPaypalPlanName(planId, PAYPAL_PLAN_NAMES[planId]);
  return { name, description: name };
}

/** 定期課金の商品 → PayPal の Plan 作成本文。JPY は小数なし。月額は暦の 1 か月ごと・年額は 1 年ごと・無期限・初期費用なし */
export function buildPlanBody({ productId, plan }) {
  const p = subscriptionPlanById(plan?.id) || plan;
  const { name, description } = paypalPlanDisplay(plan.id);
  return {
    product_id: productId,
    name,
    description,
    status: 'ACTIVE',
    billing_cycles: [{
      frequency: { interval_unit: p.interval === 'YEAR' ? 'YEAR' : 'MONTH', interval_count: 1 },
      tenure_type: 'REGULAR',
      sequence: 1,
      total_cycles: 0,
      pricing_scheme: { fixed_price: { value: String(p.amountYen), currency_code: 'JPY' } },
    }],
    payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CANCEL', payment_failure_threshold: 2 },
  };
}

export function paypalPlanIdFor(planId, mode, ids = PAYPAL_PLAN_IDS) {
  return ids[mode]?.[planId] || null;
}

/** PayPal の Plan ID → 商品。登録済みの Plan だけ（PayPal 側で誰かが作った別 Plan では権限を付けない） */
export function planFromPaypalPlanId(paypalPlanId, mode, ids = PAYPAL_PLAN_IDS) {
  const id = String(paypalPlanId || '');
  if (!id) return null;
  return SUBSCRIPTION_PLANS.find((p) => ids[mode]?.[p.id] === id) || null;
}

/** custom_id の商品コード（決済会社へ会場名・商品 ID を渡さない）*/
export const PAYPAL_PLAN_CODES = Object.freeze({ 'premium': 'A', 'premium-jra': 'J', 'premium-nankan': 'N', 'premium-annual': 'Y', 'premium-annual-light': 'L' });
const PLAN_BY_CODE = Object.freeze(Object.fromEntries(Object.entries(PAYPAL_PLAN_CODES).map(([id, c]) => [c, id])));
/** custom_id の後ろ半分 → 内部の商品 ID。旧形式（商品 ID そのまま・2026-10-15 以前の購読）も読む。それ以外は null */
export function planIdFromCustomCode(code) {
  const c = String(code || '');
  if (PLAN_BY_CODE[c]) return PLAN_BY_CODE[c];
  return STRIPE_PLANS.some((p) => p.id === c) ? c : null; // 旧形式は月額だけ
}
export const customIdOf = (recordId, planId) => {
  const code = PAYPAL_PLAN_CODES[planId];
  if (!code) throw Object.assign(new Error('invalid_plan'), { code: 'invalid_plan' });
  return `${recordId}:${code}`;
};

/** 購読の作成本文（POST /v1/billing/subscriptions） */
export function buildSubscriptionBody({ planId, recordId, origin, mode, ids = PAYPAL_PLAN_IDS }) {
  const plan = subscriptionPlanById(planId);
  if (!plan) throw Object.assign(new Error('invalid_plan'), { code: 'invalid_plan' });
  if (!RECORD_RE.test(String(recordId || ''))) throw Object.assign(new Error('invalid_record'), { code: 'invalid_record' });
  const paypalPlanId = paypalPlanIdFor(plan.id, mode, ids);
  if (!paypalPlanId) throw Object.assign(new Error('plan_not_configured'), { code: 'plan_not_configured' });
  return {
    plan_id: paypalPlanId,
    custom_id: customIdOf(recordId, plan.id),
    application_context: {
      brand_name: PAYMENT_BASE_NAME,
      locale: 'ja-JP',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'SUBSCRIBE_NOW',
      ...paypalReturnUrls(origin, 'subscription'),
    },
  };
}

export function approveUrlOf(sub) {
  const l = (Array.isArray(sub?.links) ? sub.links : []).find((x) => x?.rel === 'approve');
  return l?.href && /^https:\/\/(www\.)?(sandbox\.)?paypal\.com\//.test(l.href) ? l.href : null;
}

/** GET /v1/billing/subscriptions/{id} → 判定に要る値だけ */
export function snapshotPaypalSubscription(s) {
  const o = s || {};
  const [recordId, planCode] = String(o.custom_id || '').split(':');
  const planId = planIdFromCustomCode(planCode);
  const lp = o.billing_info?.last_payment || null;
  const at = lp?.time ? new Date(lp.time) : null;
  return {
    id: String(o.id || ''),
    status: String(o.status || ''),
    paypalPlanId: String(o.plan_id || ''),
    recordId: RECORD_RE.test(String(recordId || '')) ? recordId : null,
    planId: planId || null,
    lastPayment: lp && at && !Number.isNaN(at.getTime())
      ? { currency: String(lp.amount?.currency_code || ''), amount: Number(lp.amount?.value), time: at }
      : null,
    memberWithdrawal: String(o.status_change_note || '') === MEMBER_WITHDRAWAL_NOTE,
  };
}

const isTruthy = (v) => v === true || v === 1 || /^(true|1|yes)$/i.test(String(v ?? '').trim());
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const plusDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const endOfJstDayMs = (ymd) => {
  if (blank(ymd)) return null;
  const s = String(ymd).trim();
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T23:59:59+09:00`) : Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
};

/** 最後の支払い → 支払い済みの最終日（JST・次回請求日）。月額は 1 か月・年額は 12 か月 */
export function paidThroughYmd(lastPayment, months = 1) {
  return lastPayment?.time ? addMonthsJst(lastPayment.time, months) : null;
}

/** Stripe の月額がまだ生きている会員か（PayPal で二重に契約させない）*/
export function hasLiveStripeMonthly(fields = {}, now = new Date()) {
  const f = fields || {};
  if (String(f.PaymentMethod || '').trim().toLowerCase() !== 'stripe') return false;
  if (!/^sub_/.test(String(f.StripeSubscriptionId || ''))) return false;
  if (isTruthy(f.WithdrawalRequested)) return false;
  const end = endOfJstDayMs(f['有効期限']);
  return end !== null && end >= now.getTime();
}

/** PayPal の定期課金（月額・年額）で契約している会員か（マイページの退会＝自動課金を止める手続きの対象）*/
export function isPaypalSubscriber(fields = {}) {
  const f = fields || {};
  return String(f.PaymentMethod || '').trim().toLowerCase() === 'paypal'
    && ['monthly', 'annual'].includes(String(f.PlanType || '').trim().toLowerCase());
}

const PREMIUM_TIERS = ['premium', 'premium-predictions', 'premium-sanrenpuku', 'premium-combo'];
/**
 * 年額を作る・反映すると二重課金になる「有効な有料 Premium」があるか（銀行振込の年払い・月払いの残期間など）。
 * 退会済み（即時退会）・期限切れは対象外。Light は対象外（乗り換え特典の対象）。
 */
export function hasValidPaidPremium(fields = {}, now = new Date()) {
  const f = fields || {};
  if (isTruthy(f.WithdrawalRequested)) return false;
  if (!PREMIUM_TIERS.includes(normalizePlan(String(f['プラン'] || '')))) return false;
  if (String(f.Status || '').trim().toLowerCase() !== 'active') return false;
  if (String(f.PlanType || '').trim().toLowerCase() === 'lifetime') return true;
  const end = endOfJstDayMs(f['有効期限']);
  return end !== null && end >= now.getTime();
}

/**
 * @param {{ fields: object, sub: object, mode: 'test'|'live', ownedSubId?: string|null,
 *           otherSubscriptionLive?: boolean, now?: Date, ids?: object }} input
 * @returns {{ action: 'write'|'skip'|'conflict', reason: string, fields?: object, plan?: object, newlyAttached?: boolean, expiration?: string }}
 */
export function decidePaypalSubscriptionSync({ fields = {}, sub, mode, ownedSubId = null, otherSubscriptionLive = false, now = new Date(), ids = PAYPAL_PLAN_IDS }) {
  if (!sub || !isSubscriptionId(sub.id)) return { action: 'skip', reason: 'no_subscription' };
  const f = fields || {};
  const owned = String(ownedSubId || '') === sub.id;

  if (ENDED_STATUSES.has(sub.status)) {
    if (!owned) return { action: 'skip', reason: 'ended_not_owned' };
    if (sub.memberWithdrawal === true || isTruthy(f.WithdrawalRequested)) {
      const w = withdrawalFields({ fields: f, now });
      return { action: 'write', reason: 'withdrawn', expiration: w['有効期限'], fields: w };
    }
    // 退会以外の終了（決済失敗・管理者の解約・PayPal 側での停止）: 支払い済みの最終日の翌日まで。1 円も払われていなければ今日で終わり
    const endedPlan = planFromPaypalPlanId(sub.paypalPlanId, mode, ids) || subscriptionPlanById(sub.planId);
    const paid = paidThroughYmd(sub.lastPayment, endedPlan?.months || 1);
    const endYmd = paid ? plusDays(paid, 1) : jstDateString(now);
    const current = String(f['有効期限'] || '').trim();
    const expiration = current && current < endYmd ? current : endYmd; // 縮めるだけ
    return { action: 'write', reason: 'ended', expiration, fields: { '有効期限': expiration, CancelledAt: now.toISOString() } };
  }
  if (sub.status !== 'ACTIVE') return { action: 'skip', reason: `status_${sub.status.toLowerCase() || 'unknown'}` };

  const plan = planFromPaypalPlanId(sub.paypalPlanId, mode, ids);
  if (!plan) return { action: 'conflict', reason: 'unknown_plan' };
  if (sub.planId !== plan.id) return { action: 'conflict', reason: 'plan_mismatch', plan };
  if (!sub.lastPayment) return { action: 'skip', reason: 'awaiting_payment' };
  if (sub.lastPayment.currency !== 'JPY' || sub.lastPayment.amount !== plan.amountYen) return { action: 'conflict', reason: 'amount_mismatch', plan };
  const expiration = plusDays(paidThroughYmd(sub.lastPayment, plan.months || 1), 2);

  if (!owned) {
    if (otherSubscriptionLive || hasLiveStripeMonthly(f, now)) return { action: 'conflict', reason: 'duplicate_subscription', plan };
    const tier = normalizePlan(String(f['プラン'] || '')) || 'free';
    const isPremiumTier = PREMIUM_TIERS.includes(tier);
    if (isAnnualPlan(plan)) {
      // 年額: 有効な Premium（銀行振込の年払い・買い切り等）に重ねない。Light 特典は資格を反映前にも確かめる
      if (hasValidPaidPremium(f, now)) {
        return { action: 'conflict', reason: String(f.PlanType || '').trim().toLowerCase() === 'lifetime' ? 'existing_lifetime' : 'existing_paid_membership', plan };
      }
      if (plan.memberOnly && !checkMemberOnlyPricing({ productName: plan.bankProductName, fields: f, nowMs: now.getTime() }).eligible) {
        return { action: 'conflict', reason: 'not_eligible', plan };
      }
    }
    const planType = String(f.PlanType || '').trim().toLowerCase();
    const status = String(f.Status || '').trim().toLowerCase();
    if (isPremiumTier && planType === 'lifetime' && status === 'active') return { action: 'conflict', reason: 'existing_lifetime', plan };
    const currentEnd = endOfJstDayMs(f['有効期限']);
    const newEnd = endOfJstDayMs(expiration);
    if (isPremiumTier && status === 'active' && blank(f.VenueAccess) && currentEnd !== null && newEnd !== null && currentEnd > newEnd) {
      return { action: 'conflict', reason: 'existing_longer_contract', plan };
    }
  }

  const out = {
    'プラン': 'Premium',
    PlanType: plan.planType || 'Monthly',
    Status: 'active',
    '有効期限': expiration,
    VenueAccess: venueAccessValue(plan),
    PaymentMethod: PAYMENT_METHOD,
  };
  if (!owned) {
    out.PaidAt = now.toISOString();
    out.CancelledAt = null;
    out.WithdrawalRequested = false;
    out.WithdrawalDate = null;
    out.WithdrawalReason = null;
  }
  return { action: 'write', reason: owned ? 'renewed' : 'attached', fields: out, plan, newlyAttached: !owned, expiration };
}

/**
 * 申込を作ってよいか（作成前の判定。反映時の decidePaypalSubscriptionSync と同じ基準で先に止める）
 * @returns {{ ok: true, plan } | { ok: false, code }}
 */
export function decidePaypalSubscriptionPurchase({ planId, fields = {}, ownedSubLive = false, now = new Date() }) {
  if (String(planId || '') === 'premium-lifetime') return { ok: false, code: LIFETIME_BANK_ONLY };
  const plan = subscriptionPlanById(planId);
  if (!plan) return { ok: false, code: 'invalid_plan' };
  if (ownedSubLive || hasLiveStripeMonthly(fields, now)) return { ok: false, code: 'already_subscribed' };
  if (isAnnualPlan(plan)) {
    if (hasValidPaidPremium(fields, now)) return { ok: false, code: 'already_premium' };
    if (plan.memberOnly && !checkMemberOnlyPricing({ productName: plan.bankProductName, fields, nowMs: now.getTime() }).eligible) {
      return { ok: false, code: 'not_eligible' };
    }
  }
  const probe = decidePaypalSubscriptionSync({
    fields,
    sub: { id: 'I-PROBE00000000', status: 'ACTIVE', paypalPlanId: 'P-PROBE', recordId: null, planId: plan.id, lastPayment: { currency: 'JPY', amount: plan.amountYen, time: now } },
    mode: 'probe',
    now,
    ids: { probe: { [plan.id]: 'P-PROBE' } },
  });
  if (probe.action === 'conflict') return { ok: false, code: 'already_premium' };
  return { ok: true, plan };
}

/** 退会してよいか（純粋）*/
export function decidePaypalWithdrawal({ fields = {}, recordId, ownedSubId, sub }) {
  if (isTruthy(fields?.WithdrawalRequested)) return { ok: false, reason: 'already_withdrawn' };
  if (!isPaypalSubscriber(fields) || !isSubscriptionId(ownedSubId)) return { ok: false, reason: 'not_paypal_subscriber' };
  if (!sub || sub.id !== ownedSubId || sub.recordId !== recordId) return { ok: false, reason: 'subscription_mismatch' };
  return { ok: true, reason: 'withdraw', cancel: CANCELLABLE_STATUSES.includes(sub.status) };
}

/** Webhook 本文 → 照会の手がかり（購読 ID か、売上 ID）*/
export function parseSubscriptionWebhook(event) {
  const t = String(event?.event_type || '');
  const r = event?.resource || {};
  if (SUBSCRIPTION_EVENTS.includes(t)) return isSubscriptionId(r.id) ? { eventType: t, subscriptionId: r.id } : { eventType: t, ignored: true };
  if (SALE_EVENTS.includes(t) || SALE_REFUND_EVENTS.includes(t)) {
    if (isSubscriptionId(r.billing_agreement_id)) return { eventType: t, subscriptionId: r.billing_agreement_id, refund: SALE_REFUND_EVENTS.includes(t) };
    const saleId = r.sale_id || (SALE_EVENTS.includes(t) ? null : r.id);
    return saleId ? { eventType: t, saleId: String(saleId), refund: SALE_REFUND_EVENTS.includes(t) } : { eventType: t, ignored: true };
  }
  return null;
}
