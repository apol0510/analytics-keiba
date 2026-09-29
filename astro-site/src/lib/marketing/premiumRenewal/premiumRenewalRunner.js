/**
 * premiumRenewalRunner.js — Premium 月払い 期限前・失効後リマインドの実行
 *
 * 流れ（読み取り → 送信直前の再判定 → Redis 予約 → 配信行 → SendGrid）は Light と**同じ共通実装**
 * （`runRenewalReminder`）を使う。ここは Premium 月払いの差分（対象・本文・名前空間・モード env）だけ。
 * ⚠️ Customers へは書かない。書くのは CampaignDeliveries と Redis の予約キーだけ。
 */
import { runRenewalReminder, MODE, MAX_SENDS_PER_RUN } from '../lightRenewal/lightRenewalRunner.js';
import {
  PREMIUM_RENEWAL_CAMPAIGN_ID, PREMIUM_RENEWAL_VERSION, PREMIUM_RENEWAL_CAMPAIGN_TYPE,
  evaluateCandidate, stillSendable, deliveryKeyFor, claimKeyFor,
} from './premiumRenewalPolicy.js';
import { renderPremiumRenewalEmail } from './premiumRenewalEmail.js';

export { MODE, MAX_SENDS_PER_RUN };

export class PremiumRenewalError extends Error {
  constructor(code) { super(`premium_renewal:${code}`); this.code = code; }
}

/** env → 実行モード（既定は off。未知の値も off）。Light とは別の env */
export function resolveMode(env = {}) {
  const v = String(env.PREMIUM_RENEWAL_REMINDER_MODE || '').trim().toLowerCase();
  return v === MODE.LIVE || v === MODE.DRY_RUN ? v : MODE.OFF;
}

/** 候補を広めに読む formula（最終判定は evaluateCandidate が JST 暦日で行う） */
export const CANDIDATE_FORMULA = "AND(OR(LOWER({プラン})='premium',{プラン}='プレミアム'),"
  + "LOWER({PlanType})='monthly',NOT({PaidAt}=''),NOT({有効期限}=''),"
  + "IS_AFTER({有効期限},DATEADD(TODAY(),-33,'days')),IS_BEFORE({有効期限},DATEADD(TODAY(),10,'days')))";

export const CUSTOMER_FIELDS = Object.freeze([
  'Email', '氏名', 'プラン', 'PlanType', '有効期限', 'PaidAt', 'Status', 'ForceLogout',
  'WithdrawalRequested', 'UnsubscribedAnalyticsKeiba',
]);

export const PREMIUM_PROFILE = Object.freeze({
  campaignId: PREMIUM_RENEWAL_CAMPAIGN_ID,
  version: PREMIUM_RENEWAL_VERSION,
  campaignType: PREMIUM_RENEWAL_CAMPAIGN_TYPE,
  candidateFormula: CANDIDATE_FORMULA,
  customerFields: CUSTOMER_FIELDS,
  evaluateCandidate,
  stillSendable,
  deliveryKeyFor,
  claimKeyFor,
  render: renderPremiumRenewalEmail,
  jobPrefix: 'pr',
  offNotice: 'off（PREMIUM_RENEWAL_REMINDER_MODE 未設定）。何もしていません。',
  ErrorClass: PremiumRenewalError,
});

export function runPremiumRenewal(input) {
  return runRenewalReminder({ ...input, profile: PREMIUM_PROFILE });
}
