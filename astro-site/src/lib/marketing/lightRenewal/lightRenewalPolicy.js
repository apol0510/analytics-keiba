/**
 * lightRenewalPolicy.js — Light 月払い 期限前・失効後リマインドの判定（純粋・I/O なし）
 *
 * ## MK 決定（2026-09-29 / 1-B）
 *
 * 実際に Light 月払いを支払った会員へ、期限前と失効後に 1 通ずつ案内する。
 * どちらの通にも「① Light を続ける／再開する」「② Premium 年額 ¥44,820 へ乗り換える」の
 * **2 つの導線を分けて**載せる（どちらも `/login/?next=/pricing/`）。
 * 料金・権利・販売条件は変えない。
 *
 * ## 対象（`isPaidLightMonthly`）
 *   - プランが Light（旧 Standard も Light 扱い・`normalizePlan`）かつ PlanType = Monthly
 *   - **PaidAt がある**（＝実際に入金確認された）。無料付与だけの人は対象外
 *   - Status が test / pending / suspended / inactive / banned / disabled でない
 *   - ForceLogout でない・WithdrawalRequested でない（退会申請者へは送らない。保守的）
 *   - 配信停止（UnsubscribedAnalyticsKeiba）でない・PremiumConvertedAt が空・メールが正しい形
 *
 * ## 送る時期（JST 暦日。周期＝有効期限の日付）
 *   - PRE : 期限の 1〜7 日前（期限当日は送らない）
 *   - POST: 期限の 3〜30 日後（¥44,820 の乗り換え特典は失効後 30 日まで。案内が嘘にならない範囲）
 *   - それぞれ**周期ごとに 1 回**（窓の中なら取りこぼし分を後日送る）。窓の外は送らない
 */
import { createHash } from 'node:crypto';
import { normalizePlan } from '../../auth/planNormalization.js';
import { LIGHT_SWITCH_GRACE_DAYS } from '../../pricing/pricingEligibility.js';

export const LIGHT_RENEWAL_CAMPAIGN_ID = 'light-renewal';
export const LIGHT_RENEWAL_VERSION = 1;
/** CampaignDeliveries.CampaignType（`<campaignId>:v<version>`・custom_args の照合形式） */
export const LIGHT_RENEWAL_CAMPAIGN_TYPE = `${LIGHT_RENEWAL_CAMPAIGN_ID}:v${LIGHT_RENEWAL_VERSION}`;

export const STAGE = Object.freeze({ PRE: 'pre', POST: 'post' });
export const STEP_NUMBER = Object.freeze({ pre: 1, post: 2 });
export const PRE_WINDOW = Object.freeze({ min: 1, max: 7 });
export const POST_WINDOW = Object.freeze({ min: 3, max: 30 });

/**
 * 失効後に Premium 年額の乗り換え特典（¥44,820）を使える日数。
 * 単一源は `src/lib/pricing/pricingEligibility.js`（/pricing/ の表示と申込時のサーバー判定が使う値）。
 * ここで再定義しない（D+30 まで対象・D+31 から通常条件）。POST の窓の上限もこの値。
 */
export { LIGHT_SWITCH_GRACE_DAYS } from '../../pricing/pricingEligibility.js';
export const SWITCH_PRICE_YEN = 44820;
export const REGULAR_PREMIUM_ANNUAL_YEN = 49800;
export const LIGHT_MONTHLY_YEN = 4980;

export const EXCLUDED_STATUSES = Object.freeze(['test', 'pending', 'suspended', 'inactive', 'banned', 'disabled']);

export const SKIP = Object.freeze({
  NOT_LIGHT: 'not_light',
  NOT_MONTHLY: 'not_monthly',
  NOT_PAID: 'not_paid',
  EXCLUDED_STATUS: 'excluded_status',
  FORCE_LOGOUT: 'force_logout',
  WITHDRAWAL: 'withdrawal_requested',
  UNSUBSCRIBED: 'unsubscribed',
  CONVERTED: 'already_converted',
  INVALID_EMAIL: 'invalid_email',
  NO_EXPIRY: 'no_expiry',
  OUT_OF_WINDOW: 'out_of_window',
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';
const isTrue = (v) => v === true || String(v).trim().toLowerCase() === 'true';

/** JST の暦日（YYYY-MM-DD） */
export function jstDate(nowMs = Date.now()) {
  return new Date(Number(nowMs) + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 有効期限 → 周期（JST の日付）。日付だけならそのまま・日時なら JST の日付。読めなければ null */
export function parseCycle(raw) {
  if (isBlank(raw)) return null;
  const s = String(raw).trim();
  if (DATE_RE.test(s)) return s;
  const t = Date.parse(s);
  return Number.isFinite(t) ? jstDate(t) : null;
}

const dayNumber = (ymd) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86400000);
/** b − a（日）。どちらも YYYY-MM-DD */
export const daysBetween = (a, b) => dayNumber(b) - dayNumber(a);
export function addDays(ymd, days) {
  return new Date((dayNumber(ymd) + days) * 86400000).toISOString().slice(0, 10);
}

/** 失効後の乗り換え特典の最終日（有効期限 + 30 日・JST 暦日）*/
export const switchDeadlineFor = (cycle) => addDays(cycle, LIGHT_SWITCH_GRACE_DAYS);

/** 対象者か（周期・時期は見ない）。{ok, reason} */
export function isPaidLightMonthly(fields = {}) {
  const f = fields || {};
  if (normalizePlan(f['プラン']) !== 'light') return { ok: false, reason: SKIP.NOT_LIGHT };
  if (String(f.PlanType || '').trim().toLowerCase() !== 'monthly') return { ok: false, reason: SKIP.NOT_MONTHLY };
  if (isBlank(f.PaidAt)) return { ok: false, reason: SKIP.NOT_PAID };
  if (EXCLUDED_STATUSES.includes(String(f.Status || '').trim().toLowerCase())) return { ok: false, reason: SKIP.EXCLUDED_STATUS };
  if (isTrue(f.ForceLogout)) return { ok: false, reason: SKIP.FORCE_LOGOUT };
  if (isTrue(f.WithdrawalRequested)) return { ok: false, reason: SKIP.WITHDRAWAL };
  if (isTrue(f.UnsubscribedAnalyticsKeiba)) return { ok: false, reason: SKIP.UNSUBSCRIBED };
  if (!isBlank(f.PremiumConvertedAt)) return { ok: false, reason: SKIP.CONVERTED };
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

/**
 * 1 人を評価する。
 * @returns {{eligible: boolean, reason: string|null, cycle?: string, stage?: string,
 *            daysToExpiry?: number, switchDeadline?: string}}
 */
export function evaluateCandidate(fields, nowMs = Date.now()) {
  const who = isPaidLightMonthly(fields);
  if (!who.ok) return { eligible: false, reason: who.reason };
  const cycle = parseCycle((fields || {})['有効期限']);
  if (!cycle) return { eligible: false, reason: SKIP.NO_EXPIRY };
  const today = jstDate(nowMs);
  const stage = stageFor(cycle, today);
  if (!stage) return { eligible: false, reason: SKIP.OUT_OF_WINDOW, cycle };
  return {
    eligible: true, reason: null, cycle, stage,
    daysToExpiry: daysBetween(today, cycle),
    switchDeadline: switchDeadlineFor(cycle),
  };
}

/**
 * 送信直前の再判定（**更新・乗り換え・プラン変更の後は送らない**）。
 * 予定した周期・段と、読み直したレコードの評価が一致するときだけ送る。
 */
export function stillSendable(planned, freshFields, nowMs = Date.now()) {
  if (!freshFields) return { ok: false, reason: 'record_missing' };
  const who = isPaidLightMonthly(freshFields);
  if (!who.ok) return { ok: false, reason: who.reason };            // 乗り換え・プラン変更・停止など
  const cycle = parseCycle(freshFields['有効期限']);
  if (cycle !== planned.cycle) return { ok: false, reason: 'cycle_changed' }; // 更新（有効期限が変わった）
  const now = evaluateCandidate(freshFields, nowMs);
  if (!now.eligible) return { ok: false, reason: now.reason };
  if (now.stage !== planned.stage) return { ok: false, reason: 'stage_changed' };
  return { ok: true, reason: null };
}

/** 1 通の識別子（周期 × 段ごとに 1 つ。sha256 hex） */
export function deliveryKeyFor({ recordId, cycle, stage }) {
  return createHash('sha256')
    .update(`ak|${LIGHT_RENEWAL_CAMPAIGN_TYPE}|${recordId}|${cycle}|${stage}`, 'utf8')
    .digest('hex');
}

/** Redis の予約キー（名前空間を分ける） */
export const claimKeyFor = (deliveryKey) => `ak:light-renewal:v${LIGHT_RENEWAL_VERSION}:claim:${deliveryKey}`;
