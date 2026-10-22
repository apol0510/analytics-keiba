/**
 * nativeWeeklyAudience.js — 元々の会員へ送る**週次（無料→有料向け）**の対象判定（判定だけ / I/O なし）。
 *
 * 正本: `docs/spec.md`「元々の会員への定期配信（A を SendGrid MC で実現）」（2026-09-27 MK 確定）
 *
 * 呼び出し元: `nativeWeeklySync.buildNativeAudience`（週次の元々の会員 list を作る）。
 *
 * 判定の順序（最初に当たった理由を 1 つ返す）:
 *   1. 元々の会員でない（`importCohort.resolveCohort !== 'existing'`）
 *   2. 基本的な送信可否で除外（`audienceSegments.resolveBaseExclusion` の結果をそのまま渡す）
 *   3. 現役の Premium / Light（**当面は対象外**。送信不可の意味ではない）
 *   4. DRM の新規登録育成（`free-signup-onboarding`）の**受信中**
 *      — 進行の単一源 `sequenceProgress.resolveRecipientProgress` の結果で判定する。
 *        **受信歴があるだけでは除外しない**。全通完了・既存正本の停止条件で終わった人は対象に戻る。
 *      — 進行が渡されない（読めなかった）ときは**対象にしない**（fail closed）。
 *   5. DRM 新規登録育成が**これから始まる**（まだ 1 通も届いていないが、自動開始の窓の中）
 *      — 自動開始の窓は単一源 `campaignSequence.resolveAutoStart(campaign).withinDays`。
 *        週次を送った直後に育成 1 通目が届く（24 時間以内の二重接触）のを防ぐ。
 *        作成時刻が分からないときは**対象にしない**（fail closed）。
 *   6. 既に `ak-drm-engaged`（反応した見込み客の週次 list）に入っている
 *      — 同じ週次 Single Send へ 2 つの list から入ると、SendGrid の重複排除に頼ることになる。
 *        **AK 側で先に外す**（重複排除を未検証の安全仕様にしない）。
 *        判定材料が読めなければ呼び出し側が list 自体を作らない（fail closed）。
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
  DRM_ONBOARDING_PENDING: 'drm_onboarding_pending',
  IN_ENGAGED_LIST: 'in_engaged_list',
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 育成が**これから始まる**か（まだ 1 通も届いていないが、自動開始の窓の中）。
 * 作成時刻・窓が分からなければ **true**（fail closed＝対象にしない）。
 *
 * @param {Partial<{progress: object|null, createdTimeMs: number|null, withinDays: number|null, nowMs: number}>} [input]
 */
export function isOnboardingPending({ progress, createdTimeMs, withinDays, nowMs } = {}) {
  if (!progress || typeof progress !== 'object') return true;
  if (Number(progress.currentStep) >= 1) return false;          // 始まっている（受信中か終了は別判定）
  const pending = progress.status === SEQ_STATUS.DUE || progress.status === SEQ_STATUS.WAITING;
  if (!pending) return false;                                    // 停止（購入等）なら始まらない
  if (!Number.isFinite(createdTimeMs) || !Number.isFinite(withinDays) || !Number.isFinite(nowMs)) return true;
  return Number(nowMs) - Number(createdTimeMs) <= Number(withinDays) * DAY_MS;
}

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
 *   createdTimeMs?: number|null,      // Customers レコードの作成時刻（育成の自動開始の窓）
 *   onboardingWithinDays?: number|null,  // resolveAutoStart(campaign).withinDays
 *   inEngagedList?: boolean,          // 既に ak-drm-engaged に入っているか
 *   nowMs?: number,
 * }} [input]
 * @returns {{eligible: boolean, reason: string|null, detail?: string}}
 */
export function resolveNativeWeeklyEligibility({
  fields, marketing, baseExclusion, onboardingProgress,
  createdTimeMs = null, onboardingWithinDays = null, inEngagedList = false, nowMs = Date.now(),
} = {}) {
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
  if (isOnboardingPending({ progress: onboardingProgress, createdTimeMs, withinDays: onboardingWithinDays, nowMs })) {
    return { eligible: false, reason: NATIVE_WEEKLY_SKIP.DRM_ONBOARDING_PENDING };
  }
  if (inEngagedList === true) return { eligible: false, reason: NATIVE_WEEKLY_SKIP.IN_ENGAGED_LIST };
  return { eligible: true, reason: null };
}

export default resolveNativeWeeklyEligibility;
