/**
 * premiumAnnualRenewalPolicy.js — 銀行振込の Premium 年払い 期限前リマインドの判定（純粋・I/O なし）
 *
 * ## MK 決定（2026-10-21）
 *
 * 銀行振込の年払い会員へ、有効期限の前に更新の方法を案内する（/pricing/ の FAQ「銀行振込の年払いは、
 * 有効期限が近づきましたらメールでお知らせいたします」の実装）。
 *   - 対象: プラン Premium・PlanType Annual・**PaymentMethod が Bank Transfer**・PaidAt あり（実際に入金確認された人）
 *     PayPal の年額定期課金（自動更新）・Stripe・PaymentMethod 不明は送らない（fail closed）
 *   - 時期: 期限の 1〜7 日前（PRE）だけ。Premium 月払いと同じ窓（年払い専用の日数は spec / decisions に定めが無い）。
 *     失効後（POST）は送らない（MK 決定は「期限前の案内」）
 *   - 周期（有効期限）ごとに 1 回。更新（有効期限が延びた）・プラン変更・更新の申込済み（入金確認待ち）の後は送らない
 *   - 料金・権利・販売条件は変えない（本文は /pricing/ の Premium 年払い ¥49,800／年・銀行振込の手順だけ）
 *
 * 時期・周期・送信直前の再判定の考え方は Light / Premium 月払いと同じ（共通の日付関数を再利用する）。
 */
import { createHash } from 'node:crypto';
import { normalizePlan } from '../../auth/planNormalization.js';
import {
  STAGE, STEP_NUMBER, PRE_WINDOW, EXCLUDED_STATUSES, REGULAR_PREMIUM_ANNUAL_YEN, jstDate, parseCycle, daysBetween,
} from '../lightRenewal/lightRenewalPolicy.js';

export {
  STAGE, STEP_NUMBER, PRE_WINDOW, jstDate, parseCycle, daysBetween,
} from '../lightRenewal/lightRenewalPolicy.js';

export const PREMIUM_ANNUAL_RENEWAL_CAMPAIGN_ID = 'premium-annual-renewal';
export const PREMIUM_ANNUAL_RENEWAL_VERSION = 1;
export const PREMIUM_ANNUAL_RENEWAL_CAMPAIGN_TYPE = `${PREMIUM_ANNUAL_RENEWAL_CAMPAIGN_ID}:v${PREMIUM_ANNUAL_RENEWAL_VERSION}`;

/**
 * /pricing/ の Premium 年払い（銀行振込 `openBankModal('Premium Annual', 49800, 'annual')`）。
 * 年払いの会員は Premium の tier なので Light 会員の特典価格（¥44,820）は表示されない。ずれはテストで検知する。
 */
export const PREMIUM_ANNUAL_YEN = REGULAR_PREMIUM_ANNUAL_YEN;

export const SKIP = Object.freeze({
  NOT_PREMIUM: 'not_premium',
  NOT_ANNUAL: 'not_annual',
  /** PayPal の年額定期課金・Stripe（自動更新）。期限のお知らせは不要（更新は決済会社が行う） */
  AUTO_RENEW: 'auto_renew',
  /** PaymentMethod が空・不明。銀行振込と確かめられない会員へは送らない（fail closed） */
  PAYMENT_METHOD_UNKNOWN: 'payment_method_unknown',
  NOT_PAID: 'not_paid',
  /** Premium 年払い・買い切りの振込報告を受けて入金確認待ち（RequestedPlan / RequestedPlanType あり・PaymentConfirmed なし）。もう手続き済み */
  RENEWAL_APPLIED: 'renewal_applied',
  EXCLUDED_STATUS: 'excluded_status',
  FORCE_LOGOUT: 'force_logout',
  WITHDRAWAL: 'withdrawal_requested',
  UNSUBSCRIBED: 'unsubscribed',
  INVALID_EMAIL: 'invalid_email',
  NO_EXPIRY: 'no_expiry',
  OUT_OF_WINDOW: 'out_of_window',
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';
const isTrue = (v) => v === true || String(v).trim().toLowerCase() === 'true';
const lower = (v) => String(v || '').trim().toLowerCase();

/**
 * 更新（Premium の年払い・買い切り）の振込報告が済んで入金確認待ちか。承認で Requested* は空に戻る（bankPaymentFlow）。
 * 三連複・Premium Plus など別商品の申込は更新ではないので止めない。
 */
function isRenewalApplied(f) {
  if (isTrue(f.PaymentConfirmed)) return false;
  return normalizePlan(f.RequestedPlan) === 'premium' && ['annual', 'lifetime'].includes(lower(f.RequestedPlanType));
}

/** 対象者か（周期・時期は見ない）。{ok, reason} */
export function isPaidPremiumAnnualBankTransfer(fields = {}) {
  const f = fields || {};
  if (normalizePlan(f['プラン']) !== 'premium') return { ok: false, reason: SKIP.NOT_PREMIUM };
  if (lower(f.PlanType) !== 'annual') return { ok: false, reason: SKIP.NOT_ANNUAL };
  // ⚠️ PayPal の年額定期課金（2026-10-20〜）・Stripe は自動で更新される。ここで拾うと「振込で更新を」と誤案内になる。
  if (['stripe', 'paypal'].includes(lower(f.PaymentMethod))) return { ok: false, reason: SKIP.AUTO_RENEW };
  if (lower(f.PaymentMethod) !== 'bank transfer') return { ok: false, reason: SKIP.PAYMENT_METHOD_UNKNOWN };
  if (isBlank(f.PaidAt)) return { ok: false, reason: SKIP.NOT_PAID };
  if (isRenewalApplied(f)) return { ok: false, reason: SKIP.RENEWAL_APPLIED };
  if (EXCLUDED_STATUSES.includes(lower(f.Status))) return { ok: false, reason: SKIP.EXCLUDED_STATUS };
  if (isTrue(f.ForceLogout)) return { ok: false, reason: SKIP.FORCE_LOGOUT };
  if (isTrue(f.WithdrawalRequested)) return { ok: false, reason: SKIP.WITHDRAWAL };
  if (isTrue(f.UnsubscribedAnalyticsKeiba)) return { ok: false, reason: SKIP.UNSUBSCRIBED };
  if (!EMAIL_RE.test(String(f.Email || '').trim())) return { ok: false, reason: SKIP.INVALID_EMAIL };
  return { ok: true, reason: null };
}

/** 周期と今日から、今日送るべき段（期限前だけ。無ければ null） */
export function stageFor(cycle, today) {
  if (!cycle || !today) return null;
  const toExpiry = daysBetween(today, cycle);
  return toExpiry >= PRE_WINDOW.min && toExpiry <= PRE_WINDOW.max ? STAGE.PRE : null;
}

export function evaluateCandidate(fields, nowMs = Date.now()) {
  const who = isPaidPremiumAnnualBankTransfer(fields);
  if (!who.ok) return { eligible: false, reason: who.reason };
  const cycle = parseCycle((fields || {})['有効期限']);
  if (!cycle) return { eligible: false, reason: SKIP.NO_EXPIRY };
  const today = jstDate(nowMs);
  const stage = stageFor(cycle, today);
  if (!stage) return { eligible: false, reason: SKIP.OUT_OF_WINDOW, cycle };
  return { eligible: true, reason: null, cycle, stage, daysToExpiry: daysBetween(today, cycle) };
}

/** 送信直前の再判定（更新・申込済み・プラン変更・停止の後は送らない） */
export function stillSendable(planned, freshFields, nowMs = Date.now()) {
  if (!freshFields) return { ok: false, reason: 'record_missing' };
  const who = isPaidPremiumAnnualBankTransfer(freshFields);
  if (!who.ok) return { ok: false, reason: who.reason };
  const cycle = parseCycle(freshFields['有効期限']);
  if (cycle !== planned.cycle) return { ok: false, reason: 'cycle_changed' };
  const now = evaluateCandidate(freshFields, nowMs);
  if (!now.eligible) return { ok: false, reason: now.reason };
  if (now.stage !== planned.stage) return { ok: false, reason: 'stage_changed' };
  return { ok: true, reason: null };
}

/** 1 通の識別子（周期 × 段ごとに 1 つ。Light・Premium 月払いとは名前空間が違う） */
export function deliveryKeyFor({ recordId, cycle, stage }) {
  return createHash('sha256')
    .update(`ak|${PREMIUM_ANNUAL_RENEWAL_CAMPAIGN_TYPE}|${recordId}|${cycle}|${stage}`, 'utf8')
    .digest('hex');
}

export const claimKeyFor = (deliveryKey) => `ak:premium-annual-renewal:v${PREMIUM_ANNUAL_RENEWAL_VERSION}:claim:${deliveryKey}`;
