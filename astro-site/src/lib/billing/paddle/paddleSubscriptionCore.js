/**
 * paddleSubscriptionCore.js — Paddle の定期課金（月額 3 本・年額 2 本）の判定（純粋・I/O なし）
 *
 * 2026-11-02 MK 確定（decisions「AK 新規月額・年額決済の Paddle 一本化」）:
 *   新規の月額・年額のクレジット決済は Paddle の定期課金で受ける。既存の PayPal 契約者は PayPal のまま（移行しない）。
 *   価格・商品内容・会員権限・更新条件・即時退会・Light 会員特典は変えない。買い切りは銀行振込だけ。
 *
 * ## 商品（正本は paypalSubscriptionCore.SUBSCRIPTION_PLANS＝月額は stripePlans・年額は ANNUAL_SUBSCRIPTION_PLANS）
 *   金額・会場・PlanType・Light 資格は PayPal の定期課金と同じ表を使う（決済会社ごとに商品を持たない）。
 *   Paddle へ渡す名前は paymentDisplayNames.SUBSCRIPTION_PLAN_NAMES（PayPal と同じ許可リスト・完全一致）。
 *   Paddle の価格は**非カタログ価格**を取引ごとに渡す（一回払いと同じ方式・Live カタログを作らない）。
 *   請求周期は billing_cycle（月額 month×1・年額 year×1）。custom_data は会員 ID と商品コード（A/J/N/Y/L）だけ。
 *
 * ## 権限の持ち方（PayPal の定期課金と同じ形・PaymentMethod だけ Paddle）
 *   プラン=Premium / PlanType=Monthly|Annual / Status=active / PaymentMethod=Paddle / VenueAccess=''|'jra'|'nankan'
 *   有効期限 = 支払い済み期間の終わり（Paddle の current_billing_period.ends_at）の JST 暦日 + 猶予 2 日
 *   **status が active のときだけ**期間を信じる（past_due＝更新の支払い失敗中は期間が先に進むので延ばさない＝fail closed）。
 *
 * ## 会員と購読の対応
 *   購読の custom_data.ak_record（作成時にサーバーが付ける）だけで会員を決める。
 *   その会員の「いまの Paddle 購読」は Redis `ak:paddle:sub:member:{recordId}`（反映時に書く）。
 *
 * ## 書かない（conflict）ケース — PayPal と同じ基準＋決済会社をまたぐ二重契約
 *   duplicate_subscription（別の Paddle 購読・生きている PayPal / Stripe の定期課金）・existing_lifetime・
 *   existing_paid_membership（年額）・not_eligible（Light 特典）・existing_longer_contract・unknown_plan・amount_mismatch・interval_mismatch
 */

import { SUBSCRIPTION_PLANS, subscriptionPlanById, isAnnualPlan, PAYPAL_PLAN_CODES, planIdFromCustomCode, hasLiveStripeMonthly, hasValidPaidPremium, LIFETIME_BANK_ONLY } from '../paypal/paypalSubscriptionCore.js';
import { SUBSCRIPTION_PLAN_NAMES, assertSubscriptionPlanName } from '../paymentDisplayNames.js';
import { venueAccessValue } from '../stripePlans.js';
import { checkMemberOnlyPricing } from '../../pricing/pricingEligibility.js';
import { jstDateString } from '../../payments/bankPaymentFlow.js';
import { normalizePlan } from '../../auth/planNormalization.js';
import { withdrawalFields } from '../stripeSubscriptionSync.js';

export const PROVIDER = 'paddle';
export const PAYMENT_METHOD = 'Paddle';
export { SUBSCRIPTION_PLANS, subscriptionPlanById, LIFETIME_BANK_ONLY };

/** 商品コード（決済会社へ会場名・商品 ID を渡さない。PayPal の custom_id と同じ符号）*/
export const PADDLE_PLAN_CODES = PAYPAL_PLAN_CODES;

/** 購読に関わる Paddle の通知（照会の手がかりにだけ使う）*/
export { PADDLE_SUBSCRIPTION_EVENTS as SUBSCRIPTION_EVENTS } from './paddleCore.js';

const SUB_RE = /^sub_[a-z0-9]{10,40}$/;
const TXN_RE = /^txn_[a-z0-9]{10,40}$/;
const RECORD_RE = /^rec[A-Za-z0-9]{14}$/;
export const isPaddleSubscriptionId = (id) => SUB_RE.test(String(id || ''));
export const isTxnId = (id) => TXN_RE.test(String(id || ''));

/** 二重契約とみなす（まだ課金され得る）状態 */
export const LIVE_STATUSES = Object.freeze(['active', 'trialing', 'past_due', 'paused']);
/** 退会で cancel を呼ぶ状態 */
export const CANCELLABLE_STATUSES = LIVE_STATUSES;

export const memberKey = (recordId) => `ak:paddle:sub:member:${recordId}`;
/** 会員の退会（マイページ）で解約した印。canceled の通知を退会状態へ収束させる（Paddle の cancel は理由を持てない）*/
export const withdrawalMarkKey = (subscriptionId) => `ak:paddle:sub:withdrawn:${subscriptionId}`;
/** 申込（取引）→ 会員・商品。戻り先の状態確認で「本人の申込か」を確かめる（7 日）*/
export const checkoutMarkKey = (transactionId) => `ak:paddle:sub:checkout:${transactionId}`;
/** 取引の反映結果（active / needs_support）。戻り先が読むだけ（7 日）*/
export const txnResultKey = (transactionId) => `ak:paddle:sub:txn:${transactionId}`;
export const MARK_TTL_SECONDS = 7 * 24 * 60 * 60;

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
const PREMIUM_TIERS = ['premium', 'premium-predictions', 'premium-sanrenpuku', 'premium-combo'];
const BILLING_INTERVAL = Object.freeze({ MONTH: 'month', YEAR: 'year' });

/** Paddle に出す名前（許可リストだけ・説明も同じ文字列）*/
export function paddlePlanDisplay(planId) {
  const name = assertSubscriptionPlanName(planId, SUBSCRIPTION_PLAN_NAMES[planId]);
  return { name, description: name };
}

/**
 * 定期課金の取引（POST /transactions）。非カタログ価格・税込・請求周期つき。checkout.url は送らない（一回払いと同じ理由）。
 * custom_data は会員 ID と商品コード（ak_sub）だけ。一回払いの ak_product は付けない（一回払いの付与経路に入らない）。
 */
export function buildSubscriptionTransactionBody({ planId, recordId }) {
  if (String(planId || '') === 'premium-lifetime') throw Object.assign(new Error(LIFETIME_BANK_ONLY), { code: LIFETIME_BANK_ONLY });
  const plan = subscriptionPlanById(planId);
  if (!plan) throw Object.assign(new Error('invalid_plan'), { code: 'invalid_plan' });
  if (!RECORD_RE.test(String(recordId || ''))) throw Object.assign(new Error('invalid_record'), { code: 'invalid_record' });
  const { name, description } = paddlePlanDisplay(plan.id);
  return {
    items: [{
      quantity: 1,
      price: {
        description,
        name,
        unit_price: { amount: String(plan.amountYen), currency_code: 'JPY' },
        tax_mode: 'internal',
        billing_cycle: { interval: BILLING_INTERVAL[plan.interval] || 'month', frequency: 1 },
        product: { name, tax_category: 'standard' },
      },
    }],
    currency_code: 'JPY',
    collection_mode: 'automatic',
    custom_data: { ak_record: String(recordId), ak_sub: PADDLE_PLAN_CODES[plan.id] },
  };
}

/** 取引が定期課金のものか（一回払いの付与経路へ入れない）*/
export function isSubscriptionTransaction(txn) {
  return Boolean(txn && (isPaddleSubscriptionId(txn.subscription_id) || !blank(txn.custom_data?.ak_sub)));
}

const isoOrNull = (v) => {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/**
 * GET /subscriptions/{id} → 判定に要る値だけ（会員 ID・商品・状態・支払い済み期間・価格）。メール等は持たない。
 * 中立サイト（鍵を持つ）が作り、本番の内部付与へ署名付きで渡す。
 */
export function snapshotPaddleSubscription(s) {
  const o = s || {};
  const cd = o.custom_data || {};
  const item = Array.isArray(o.items) ? o.items[0] : null;
  const price = item?.price || {};
  const cbp = o.current_billing_period || null;
  return {
    id: String(o.id || ''),
    status: String(o.status || ''),
    recordId: RECORD_RE.test(String(cd.ak_record || '')) ? String(cd.ak_record) : null,
    planId: planIdFromCustomCode(cd.ak_sub) && PADDLE_PLAN_CODES[planIdFromCustomCode(cd.ak_sub)] === String(cd.ak_sub) ? planIdFromCustomCode(cd.ak_sub) : null,
    itemCount: Array.isArray(o.items) ? o.items.length : 0,
    quantity: Number(item?.quantity ?? 0),
    currency: String(o.currency_code || price.unit_price?.currency_code || ''),
    amount: Number(price.unit_price?.amount),
    interval: String(price.billing_cycle?.interval || ''),
    frequency: Number(price.billing_cycle?.frequency ?? 0),
    periodStartsAt: isoOrNull(cbp?.starts_at),
    periodEndsAt: isoOrNull(cbp?.ends_at),
    canceledAt: isoOrNull(o.canceled_at),
    scheduledCancel: o.scheduled_change?.action === 'cancel',
  };
}

/** 支払い済み期間の終わり → 有効中の `有効期限`（JST 暦日 + 猶予 2 日。PayPal・Stripe と同じ猶予）*/
export function expirationFromPeriodEnd(periodEndsAt) {
  if (!periodEndsAt) return null;
  const t = new Date(periodEndsAt);
  if (Number.isNaN(t.getTime())) return null;
  return plusDays(jstDateString(t), 2);
}

/** 生きている PayPal の定期課金（月額・年額）がある会員か（Customers の値だけで判定・退会済み/期限切れは対象外）*/
export function hasLivePaypalSubscription(fields = {}, now = new Date()) {
  const f = fields || {};
  if (String(f.PaymentMethod || '').trim().toLowerCase() !== 'paypal') return false;
  if (!['monthly', 'annual'].includes(String(f.PlanType || '').trim().toLowerCase())) return false;
  if (isTruthy(f.WithdrawalRequested)) return false;
  const end = endOfJstDayMs(f['有効期限']);
  return end !== null && end >= now.getTime();
}

/** Paddle の定期課金で契約している会員か（マイページの退会＝自動課金を止める手続きの対象）*/
export function isPaddleSubscriber(fields = {}) {
  const f = fields || {};
  return String(f.PaymentMethod || '').trim().toLowerCase() === 'paddle'
    && ['monthly', 'annual'].includes(String(f.PlanType || '').trim().toLowerCase());
}

/** 価格・周期が商品表どおりか（Paddle 側で誰かが変えた・別の取引だった等は権限を付けない）*/
function checkPrice(sub, plan) {
  if (sub.itemCount !== 1 || sub.quantity !== 1) return 'item_mismatch';
  if (sub.currency !== 'JPY' || sub.amount !== plan.amountYen) return 'amount_mismatch';
  if (sub.interval !== (BILLING_INTERVAL[plan.interval] || 'month') || sub.frequency !== 1) return 'interval_mismatch';
  return null;
}

/**
 * @param {{ fields: object, sub: ReturnType<typeof snapshotPaddleSubscription>, ownedSubId?: string|null,
 *           otherSubscriptionLive?: boolean, withdrawalMarked?: boolean, now?: Date }} input
 * @returns {{ action: 'write'|'skip'|'conflict', reason: string, fields?: object, plan?: object, newlyAttached?: boolean, expiration?: string }}
 */
export function decidePaddleSubscriptionSync({ fields = {}, sub, ownedSubId = null, otherSubscriptionLive = false, withdrawalMarked = false, now = new Date() }) {
  if (!sub || !isPaddleSubscriptionId(sub.id)) return { action: 'skip', reason: 'no_subscription' };
  const f = fields || {};
  const owned = String(ownedSubId || '') === sub.id;

  if (sub.status === 'canceled') {
    if (!owned) return { action: 'skip', reason: 'ended_not_owned' };
    if (withdrawalMarked || isTruthy(f.WithdrawalRequested)) {
      const w = withdrawalFields({ fields: f, now });
      return { action: 'write', reason: 'withdrawn', expiration: w['有効期限'], fields: w };
    }
    // 退会以外の終了（Paddle 側での解約・支払い失敗の上限・管理者の解約）: 支払い済み期間の終わりの翌日まで（縮めるだけ）。
    // 終了した購読は期間を持たないことがあるので、そのときは今の期限（最後に払われた期間＋猶予）を延ばさずに残す
    const current = String(f['有効期限'] || '').trim();
    const paidEnd = sub.periodEndsAt ? plusDays(jstDateString(new Date(sub.periodEndsAt)), 1) : null;
    const expiration = paidEnd ? (current && current < paidEnd ? current : paidEnd) : (current || jstDateString(now));
    const out = { '有効期限': expiration };
    if (blank(f.CancelledAt)) out.CancelledAt = (sub.canceledAt || now.toISOString());
    return { action: 'write', reason: 'ended', expiration, fields: out };
  }
  if (sub.status !== 'active') return { action: 'skip', reason: `status_${sub.status || 'unknown'}` };

  const plan = subscriptionPlanById(sub.planId);
  if (!plan) return { action: 'conflict', reason: 'unknown_plan' };
  const priceIssue = checkPrice(sub, plan);
  if (priceIssue) return { action: 'conflict', reason: priceIssue, plan };
  const expiration = expirationFromPeriodEnd(sub.periodEndsAt);
  if (!expiration) return { action: 'skip', reason: 'awaiting_payment' };

  if (!owned) {
    if (otherSubscriptionLive || hasLiveStripeMonthly(f, now) || hasLivePaypalSubscription(f, now)) return { action: 'conflict', reason: 'duplicate_subscription', plan };
    const tier = normalizePlan(String(f['プラン'] || '')) || 'free';
    const isPremiumTier = PREMIUM_TIERS.includes(tier);
    if (isAnnualPlan(plan)) {
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
  } else if (withdrawalMarked || isTruthy(f.WithdrawalRequested)) {
    // 退会済み（即時退会）の購読に、遅れて届いた active の通知で権限を戻さない
    return { action: 'skip', reason: 'withdrawn' };
  }

  const out = {
    'プラン': 'Premium',
    PlanType: plan.planType || 'Monthly',
    Status: 'active',
    '有効期限': expiration,
    VenueAccess: venueAccessValue(plan),
    PaymentMethod: PAYMENT_METHOD,
  };
  if (owned) {
    // 順不同（古い期間の通知が後から届く）でも期限を縮めない
    const current = String(f['有効期限'] || '').trim();
    if (current && current > expiration) out['有効期限'] = current;
  } else {
    out.PaidAt = now.toISOString();
    out.CancelledAt = null;
    out.WithdrawalRequested = false;
    out.WithdrawalDate = null;
    out.WithdrawalReason = null;
  }
  return { action: 'write', reason: owned ? 'renewed' : 'attached', fields: out, plan, newlyAttached: !owned, expiration: out['有効期限'] };
}

/**
 * 申込を作ってよいか（作成前の判定。反映時と同じ基準で先に止める）
 * @returns {{ ok: true, plan } | { ok: false, code }}
 */
export function decidePaddleSubscriptionPurchase({ planId, fields = {}, ownedSubLive = false, now = new Date() }) {
  if (String(planId || '') === 'premium-lifetime') return { ok: false, code: LIFETIME_BANK_ONLY };
  const plan = subscriptionPlanById(planId);
  if (!plan) return { ok: false, code: 'invalid_plan' };
  if (ownedSubLive || hasLiveStripeMonthly(fields, now) || hasLivePaypalSubscription(fields, now)) return { ok: false, code: 'already_subscribed' };
  if (isAnnualPlan(plan)) {
    if (hasValidPaidPremium(fields, now)) return { ok: false, code: 'already_premium' };
    if (plan.memberOnly && !checkMemberOnlyPricing({ productName: plan.bankProductName, fields, nowMs: now.getTime() }).eligible) {
      return { ok: false, code: 'not_eligible' };
    }
  }
  const probeEnd = new Date(now.getTime() + (plan.months || 1) * 30 * 24 * 60 * 60 * 1000).toISOString();
  const probe = decidePaddleSubscriptionSync({
    fields,
    sub: { id: 'sub_probe0000000000', status: 'active', recordId: null, planId: plan.id, itemCount: 1, quantity: 1, currency: 'JPY', amount: plan.amountYen, interval: BILLING_INTERVAL[plan.interval], frequency: 1, periodEndsAt: probeEnd },
    now,
  });
  if (probe.action === 'conflict') return { ok: false, code: 'already_premium' };
  return { ok: true, plan };
}

/** 退会してよいか（純粋）*/
export function decidePaddleWithdrawal({ fields = {}, recordId, ownedSubId, sub }) {
  if (isTruthy(fields?.WithdrawalRequested)) return { ok: false, reason: 'already_withdrawn' };
  if (!isPaddleSubscriber(fields) || !isPaddleSubscriptionId(ownedSubId)) return { ok: false, reason: 'not_paddle_subscriber' };
  if (!sub || sub.id !== ownedSubId || sub.recordId !== recordId) return { ok: false, reason: 'subscription_mismatch' };
  return { ok: true, reason: 'withdraw', cancel: CANCELLABLE_STATUSES.includes(sub.status) };
}

/** 戻り先に返す状態（反映結果の印 → 表示）*/
export function returnStatusOf(result) {
  return result === 'active' || result === 'needs_support' ? result : 'pending';
}

/** 未使用の商品コードを使っていないか（テスト・設定検査用）*/
export const PLAN_IDS = Object.freeze(SUBSCRIPTION_PLANS.map((p) => p.id));
