/**
 * premiumRenewalPolicy.js — Premium 月払い 期限前・失効後リマインドの判定（純粋・I/O なし）
 *
 * ## MK 決定（2026-09-29 / ①）
 *
 * Light 月払い（`lightRenewal/`）で実装済みの考え方を Premium 月払いへ適用する。
 *   - 対象: **実際に Premium 月払いを支払った人**（PaidAt あり）だけ
 *   - 時期: 期限の 1〜7 日前（PRE）と、失効後 3〜30 日（POST）。周期（有効期限）ごとに各 1 回
 *   - 更新・再開（有効期限が延びた）・年払い等への切り替え（PlanType が変わった）の後は送らない
 *   - 配信停止・バウンス・suppression・退会申請・停止中は送らない
 *   - 料金・権利・販売条件は変えない（本文は /pricing/ に出ている Premium 月払い ¥18,000／30日 だけを書く）
 *
 * 時期・周期・送信直前の再判定の考え方は Light と同じ（共通の日付関数を再利用する）。
 */
import { createHash } from 'node:crypto';
import { normalizePlan } from '../../auth/planNormalization.js';
import {
  STAGE, STEP_NUMBER, PRE_WINDOW, POST_WINDOW, EXCLUDED_STATUSES, jstDate, parseCycle, daysBetween, addDays,
} from '../lightRenewal/lightRenewalPolicy.js';

export {
  STAGE, STEP_NUMBER, PRE_WINDOW, POST_WINDOW, jstDate, parseCycle, daysBetween, addDays,
} from '../lightRenewal/lightRenewalPolicy.js';

export const PREMIUM_RENEWAL_CAMPAIGN_ID = 'premium-renewal';
export const PREMIUM_RENEWAL_VERSION = 1;
export const PREMIUM_RENEWAL_CAMPAIGN_TYPE = `${PREMIUM_RENEWAL_CAMPAIGN_ID}:v${PREMIUM_RENEWAL_VERSION}`;

/** 失効後に案内する日数（POST の窓の上限と同じ）。この日を過ぎた周期は「失効」として数える */
export const PREMIUM_POST_DAYS = POST_WINDOW.max;
/** /pricing/ の Premium 月払い（openBankModal('Premium Monthly', 18000, 'monthly')）。ずれはテストで検知する */
export const PREMIUM_MONTHLY_YEN = 18000;

export const SKIP = Object.freeze({
  NOT_PREMIUM: 'not_premium',
  NOT_MONTHLY: 'not_monthly',
  NOT_PAID: 'not_paid',
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

/** 対象者か（周期・時期は見ない）。{ok, reason} */
export function isPaidPremiumMonthly(fields = {}) {
  const f = fields || {};
  if (normalizePlan(f['プラン']) !== 'premium') return { ok: false, reason: SKIP.NOT_PREMIUM };
  if (String(f.PlanType || '').trim().toLowerCase() !== 'monthly') return { ok: false, reason: SKIP.NOT_MONTHLY };
  if (isBlank(f.PaidAt)) return { ok: false, reason: SKIP.NOT_PAID };
  if (EXCLUDED_STATUSES.includes(String(f.Status || '').trim().toLowerCase())) return { ok: false, reason: SKIP.EXCLUDED_STATUS };
  if (isTrue(f.ForceLogout)) return { ok: false, reason: SKIP.FORCE_LOGOUT };
  if (isTrue(f.WithdrawalRequested)) return { ok: false, reason: SKIP.WITHDRAWAL };
  if (isTrue(f.UnsubscribedAnalyticsKeiba)) return { ok: false, reason: SKIP.UNSUBSCRIBED };
  if (!EMAIL_RE.test(String(f.Email || '').trim())) return { ok: false, reason: SKIP.INVALID_EMAIL };
  return { ok: true, reason: null };
}

/** 周期と今日から、今日送るべき段（無ければ null） */
export function stageFor(cycle, today) {
  if (!cycle || !today) return null;
  const toExpiry = daysBetween(today, cycle);
  if (toExpiry >= PRE_WINDOW.min && toExpiry <= PRE_WINDOW.max) return STAGE.PRE;
  const since = daysBetween(cycle, today);
  if (since >= POST_WINDOW.min && since <= POST_WINDOW.max) return STAGE.POST;
  return null;
}

export function evaluateCandidate(fields, nowMs = Date.now()) {
  const who = isPaidPremiumMonthly(fields);
  if (!who.ok) return { eligible: false, reason: who.reason };
  const cycle = parseCycle((fields || {})['有効期限']);
  if (!cycle) return { eligible: false, reason: SKIP.NO_EXPIRY };
  const today = jstDate(nowMs);
  const stage = stageFor(cycle, today);
  if (!stage) return { eligible: false, reason: SKIP.OUT_OF_WINDOW, cycle };
  return { eligible: true, reason: null, cycle, stage, daysToExpiry: daysBetween(today, cycle) };
}

/** 送信直前の再判定（更新・再開・年払い等への切り替え・停止の後は送らない） */
export function stillSendable(planned, freshFields, nowMs = Date.now()) {
  if (!freshFields) return { ok: false, reason: 'record_missing' };
  const who = isPaidPremiumMonthly(freshFields);
  if (!who.ok) return { ok: false, reason: who.reason };
  const cycle = parseCycle(freshFields['有効期限']);
  if (cycle !== planned.cycle) return { ok: false, reason: 'cycle_changed' };
  const now = evaluateCandidate(freshFields, nowMs);
  if (!now.eligible) return { ok: false, reason: now.reason };
  if (now.stage !== planned.stage) return { ok: false, reason: 'stage_changed' };
  return { ok: true, reason: null };
}

/** 1 通の識別子（周期 × 段ごとに 1 つ。Light とは名前空間が違う） */
export function deliveryKeyFor({ recordId, cycle, stage }) {
  return createHash('sha256')
    .update(`ak|${PREMIUM_RENEWAL_CAMPAIGN_TYPE}|${recordId}|${cycle}|${stage}`, 'utf8')
    .digest('hex');
}

export const claimKeyFor = (deliveryKey) => `ak:premium-renewal:v${PREMIUM_RENEWAL_VERSION}:claim:${deliveryKey}`;

/** 失効後の案内の最終日（有効期限 + 30 日） */
export const postDeadlineFor = (cycle) => addDays(cycle, PREMIUM_POST_DAYS);
