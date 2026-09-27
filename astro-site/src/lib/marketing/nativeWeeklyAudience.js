/**
 * nativeWeeklyAudience.js — 元々の会員へ送る**週次（無料→有料向け）**の対象判定（判定だけ / I/O なし）。
 *
 * 正本: `docs/spec.md`「元々の会員への定期配信（A を SendGrid MC で実現）」（2026-09-27 MK 確定）
 *
 * ⚠️ **まだどこからも呼ばれない**（Phase 2 の宛先づくりで使う）。ここでは判定の意味だけを固定する。
 *
 * 判定の順序（最初に当たった理由を 1 つ返す）:
 *   1. 元々の会員でない（`importCohort.resolveCohort !== 'existing'`）
 *   2. 基本的な送信可否で除外（`audienceSegments.resolveBaseExclusion` の結果をそのまま渡す）
 *   3. 現役の Premium / Light（**当面は対象外**。送信不可の意味ではない）
 *   4. DRM の新規登録育成（`free-signup-onboarding`）の**受信中**
 *      — 進行の単一源 `sequenceProgress.resolveRecipientProgress` の結果で判定する。
 *        **受信歴があるだけでは除外しない**。全通完了・既存正本の停止条件で終わった人は対象に戻る。
 *      — 進行が渡されない（読めなかった）ときは**対象にしない**（fail closed）。
 */

import { resolveCohort, COHORT } from './importCohort.js';
import { SEQ_STATUS } from './sequenceProgress.js';
import { FUNNEL_STAGES } from '../drm/drmFunnel.js';

/** 受信中を判定する育成 campaign（DRM 第 1 段の nurture。直書きしない） */
export const ONBOARDING_CAMPAIGN_ID = FUNNEL_STAGES[0].nurtureCampaignId;

export const NATIVE_WEEKLY_SKIP = Object.freeze({
  NOT_NATIVE: 'not_native',
  BASE_EXCLUDED: 'base_excluded',
  ACTIVE_PAID_MEMBER: 'active_paid_member',
  DRM_ONBOARDING_ACTIVE: 'drm_onboarding_active',
  DRM_PROGRESS_UNKNOWN: 'drm_progress_unknown',
});

/**
 * 育成を**受信中**か。
 * 受信中 = 1 通以上届いていて、まだ次の通が予定されている（`due` / `waiting`）。
 * 完了（`completed`）・停止（`stopped`）・未開始（1 通も届いていない）は受信中ではない。
 *
 * @param {{status?: string, currentStep?: number}|null} progress
 */
export function isOnboardingActive(progress) {
  if (!progress || typeof progress !== 'object') return false;
  const started = Number(progress.currentStep) >= 1;
  const pending = progress.status === SEQ_STATUS.DUE || progress.status === SEQ_STATUS.WAITING;
  return started && pending;
}

/**
 * @param {{
 *   fields?: object,
 *   marketing?: object,               // resolveCustomerMarketing の結果
 *   baseExclusion?: string|null,      // resolveBaseExclusion の結果（null = 基本的に送信可能）
 *   onboardingProgress?: object|null,  // resolveRecipientProgress の結果（未指定は「分からない」）
 * }} [input]
 * @returns {{eligible: boolean, reason: string|null, detail?: string}}
 */
export function resolveNativeWeeklyEligibility({ fields, marketing, baseExclusion, onboardingProgress } = {}) {
  if (resolveCohort(fields) !== COHORT.EXISTING) return { eligible: false, reason: NATIVE_WEEKLY_SKIP.NOT_NATIVE };
  if (baseExclusion) return { eligible: false, reason: NATIVE_WEEKLY_SKIP.BASE_EXCLUDED, detail: String(baseExclusion) };
  const mk = marketing || {};
  if (mk.premiumActive === true || mk.lightActive === true) {
    return { eligible: false, reason: NATIVE_WEEKLY_SKIP.ACTIVE_PAID_MEMBER };
  }
  if (onboardingProgress === undefined || onboardingProgress === null) {
    return { eligible: false, reason: NATIVE_WEEKLY_SKIP.DRM_PROGRESS_UNKNOWN };
  }
  if (isOnboardingActive(onboardingProgress)) {
    return { eligible: false, reason: NATIVE_WEEKLY_SKIP.DRM_ONBOARDING_ACTIVE };
  }
  return { eligible: true, reason: null };
}

export default resolveNativeWeeklyEligibility;
