/**
 * premiumAnnualRenewalRunner.js — 銀行振込の Premium 年払い 期限前リマインドの実行
 *
 * 流れ（読み取り → 送信直前の再判定 → Redis 予約 → 配信行 → SendGrid）は Light・Premium 月払いと**同じ共通実装**
 * （`runRenewalReminder`）を使う。ここは年払いの差分（対象・本文・名前空間・モード env）だけ。
 * ⚠️ 顧客レコードへは書かない。書くのは CampaignDeliveries と Redis の予約キーだけ。
 */
import { runRenewalReminder, MODE, MAX_SENDS_PER_RUN } from '../lightRenewal/lightRenewalRunner.js';
import {
  PREMIUM_ANNUAL_RENEWAL_CAMPAIGN_ID, PREMIUM_ANNUAL_RENEWAL_VERSION, PREMIUM_ANNUAL_RENEWAL_CAMPAIGN_TYPE,
  evaluateCandidate, stillSendable, deliveryKeyFor, claimKeyFor,
} from './premiumAnnualRenewalPolicy.js';
import { renderPremiumAnnualRenewalEmail } from './premiumAnnualRenewalEmail.js';

export { MODE, MAX_SENDS_PER_RUN };

export class PremiumAnnualRenewalError extends Error {
  constructor(code) { super(`premium_annual_renewal:${code}`); this.code = code; }
}

/** env → 実行モード（既定は off。未知の値も off）。月払い・Light とは別の env（dry-run から段階的に開ける） */
export function resolveMode(env = {}) {
  const v = String(env.PREMIUM_ANNUAL_RENEWAL_REMINDER_MODE || '').trim().toLowerCase();
  return v === MODE.LIVE || v === MODE.DRY_RUN ? v : MODE.OFF;
}

/**
 * 候補を広めに読む formula（最終判定は evaluateCandidate が JST 暦日で行う）。
 * PaymentMethod は formula で絞らない（空・不明を `payment_method_unknown` として件数に出すため）。
 */
export const CANDIDATE_FORMULA = "AND(OR(LOWER({プラン})='premium',{プラン}='プレミアム'),"
  + "LOWER({PlanType})='annual',NOT({PaidAt}=''),NOT({有効期限}=''),"
  + "IS_AFTER({有効期限},DATEADD(TODAY(),-2,'days')),IS_BEFORE({有効期限},DATEADD(TODAY(),10,'days')))";

export const CUSTOMER_FIELDS = Object.freeze([
  'Email', '氏名', 'プラン', 'PlanType', 'PaymentMethod', '有効期限', 'PaidAt', 'Status', 'ForceLogout',
  'WithdrawalRequested', 'UnsubscribedAnalyticsKeiba', 'RequestedPlan', 'RequestedPlanType', 'PaymentConfirmed',
]);

export const PREMIUM_ANNUAL_PROFILE = Object.freeze({
  campaignId: PREMIUM_ANNUAL_RENEWAL_CAMPAIGN_ID,
  version: PREMIUM_ANNUAL_RENEWAL_VERSION,
  campaignType: PREMIUM_ANNUAL_RENEWAL_CAMPAIGN_TYPE,
  candidateFormula: CANDIDATE_FORMULA,
  customerFields: CUSTOMER_FIELDS,
  evaluateCandidate,
  stillSendable,
  deliveryKeyFor,
  claimKeyFor,
  render: renderPremiumAnnualRenewalEmail,
  jobPrefix: 'par',
  offNotice: 'off（PREMIUM_ANNUAL_RENEWAL_REMINDER_MODE 未設定）。何もしていません。',
  ErrorClass: PremiumAnnualRenewalError,
});

export function runPremiumAnnualRenewal(input) {
  return runRenewalReminder({ ...input, profile: PREMIUM_ANNUAL_PROFILE });
}
