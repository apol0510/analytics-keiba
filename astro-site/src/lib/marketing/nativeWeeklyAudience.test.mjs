/**
 * 元々の会員の週次（無料→有料向け）対象判定（`nativeWeeklyAudience.js`）。
 *
 * 固定すること:
 *  - 現役 Premium / Light は当面対象外（基本的な送信可否とは別の理由で数える）
 *  - DRM 新規登録育成の**受信中**は対象外
 *  - **受信歴があるだけでは除外しない**。全通完了・停止で終わった人は対象に戻る
 *  - 進行が分からなければ対象にしない（fail closed）
 *  - 進行は既存の単一源 `sequenceProgress.resolveRecipientProgress` の結果で判定する
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveNativeWeeklyEligibility, isOnboardingActive, NATIVE_WEEKLY_SKIP, ONBOARDING_CAMPAIGN_ID,
} from './nativeWeeklyAudience.js';
import { resolveRecipientProgress, indexDeliveries, SEQ_STATUS } from './sequenceProgress.js';
import { resolveSequenceStep, getSequenceSteps } from './campaignSequence.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { getCampaign } from './campaignCatalog.js';
import { resolveCustomerMarketing } from './customerMarketingAudience.js';
import { IMPORT_SOURCE_PREFIX } from './importCohort.js';

const DAY = 86400000;
const NOW = Date.parse('2026-09-27T03:00:00Z');
const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';
const EMAIL = 'member@example.jp';

const PREMIUM = { 'プラン': 'Premium', '有効期限': '2027-06-01', Status: 'active' };
const LIGHT = { 'プラン': 'Light', '有効期限': '2027-06-01', Status: 'active' };

const mk = (fields) => resolveCustomerMarketing({ fields, nowMs: NOW });
const NOT_STARTED = { status: SEQ_STATUS.DUE, currentStep: 0 };

test('育成 campaign は DRM 第 1 段の nurture（free-signup-onboarding・全 6 通）', () => {
  assert.equal(ONBOARDING_CAMPAIGN_ID, 'free-signup-onboarding');
  const c = getCampaign(ONBOARDING_CAMPAIGN_ID, { includeDisabled: true });
  assert.ok(c);
  assert.equal(getSequenceSteps(c).length, 6);
});

test('現役 Premium / Light は対象外（active_paid_member）', () => {
  for (const extra of [PREMIUM, LIGHT]) {
    const fields = { Email: EMAIL, ...extra };
    const r = resolveNativeWeeklyEligibility({ fields, marketing: mk(fields), baseExclusion: null, onboardingProgress: NOT_STARTED });
    assert.deepEqual(r, { eligible: false, reason: NATIVE_WEEKLY_SKIP.ACTIVE_PAID_MEMBER });
  }
});

test('無料会員・期限切れは対象', () => {
  for (const extra of [{}, { 'プラン': 'Premium', '有効期限': '2026-01-01', Status: 'active' }]) {
    const fields = { Email: EMAIL, ...extra };
    const r = resolveNativeWeeklyEligibility({ fields, marketing: mk(fields), baseExclusion: null, onboardingProgress: NOT_STARTED });
    assert.deepEqual(r, { eligible: true, reason: null });
  }
});

test('取り込み由来は元々の会員ではない / 基本的な送信可否の除外はそのまま理由に出す', () => {
  const imported = { Email: EMAIL, Source: `${IMPORT_SOURCE_PREFIX}x` };
  assert.equal(resolveNativeWeeklyEligibility({ fields: imported, marketing: mk(imported), baseExclusion: null, onboardingProgress: NOT_STARTED }).reason,
    NATIVE_WEEKLY_SKIP.NOT_NATIVE);
  const fields = { Email: EMAIL };
  const r = resolveNativeWeeklyEligibility({ fields, marketing: mk(fields), baseExclusion: 'unsubscribed', onboardingProgress: NOT_STARTED });
  assert.deepEqual(r, { eligible: false, reason: NATIVE_WEEKLY_SKIP.BASE_EXCLUDED, detail: 'unsubscribed' });
});

test('進行が分からなければ対象にしない（fail closed）', () => {
  const fields = { Email: EMAIL };
  for (const p of [undefined, null]) {
    assert.equal(resolveNativeWeeklyEligibility({ fields, marketing: mk(fields), baseExclusion: null, onboardingProgress: p }).reason,
      NATIVE_WEEKLY_SKIP.DRM_PROGRESS_UNKNOWN);
  }
});

test('isOnboardingActive: 1 通以上届いて次が予定されている間だけ true', () => {
  assert.equal(isOnboardingActive({ status: SEQ_STATUS.WAITING, currentStep: 1 }), true);
  assert.equal(isOnboardingActive({ status: SEQ_STATUS.DUE, currentStep: 3 }), true);
  assert.equal(isOnboardingActive({ status: SEQ_STATUS.DUE, currentStep: 0 }), false, '未開始');
  assert.equal(isOnboardingActive({ status: SEQ_STATUS.COMPLETED, currentStep: 6 }), false, '完了');
  assert.equal(isOnboardingActive({ status: SEQ_STATUS.STOPPED, currentStep: 2 }), false, '停止');
});

// ─── 実 campaign を単一源 resolveRecipientProgress に通す ─────────────────
//    （ここで進行を別に数えない。受信の事実 → 単一源 → 判定、の順）

const CAMPAIGN = getCampaign(ONBOARDING_CAMPAIGN_ID, { includeDisabled: true });

function deliveredRow(n, atMs) {
  const key = computeCampaignDeliveryKey({
    campaign: resolveSequenceStep(CAMPAIGN, n), recipientEmail: EMAIL, brand: BRAND, fromEmail: FROM,
  });
  return { fields: { EmailType: 'campaign', DeliveryKey: key, RecipientEmail: EMAIL, Status: 'sent', SentAt: new Date(atMs).toISOString() } };
}

function progressFor(steps, fieldsExtra = {}) {
  const fields = { Email: EMAIL, Status: 'active', ...fieldsExtra };
  const rows = steps.map((n, i) => deliveredRow(n, NOW - (steps.length - i) * DAY));
  return {
    fields,
    marketing: mk(fields),
    progress: resolveRecipientProgress({
      campaign: CAMPAIGN,
      customer: { recordId: 'recX', fields, marketing: mk(fields) },
      deliveredIndex: indexDeliveries(rows),
      brand: BRAND, fromEmail: FROM, nowMs: NOW, providerSuppressed: new Set(),
    }),
  };
}

test('DRM 受信中（1 通目のあと）は対象外', () => {
  const { fields, marketing, progress } = progressFor([1]);
  // campaign が使えない状態では進行が停止扱いになり、このテストの前提が崩れる（黙って通さない）
  assert.notEqual(progress.stopReason, 'campaign_disabled', '育成 campaign が停止中');
  assert.equal(isOnboardingActive(progress), true, JSON.stringify(progress));
  assert.equal(resolveNativeWeeklyEligibility({ fields, marketing, baseExclusion: null, onboardingProgress: progress }).reason,
    NATIVE_WEEKLY_SKIP.DRM_ONBOARDING_ACTIVE);
});

test('DRM 6 通完了後は対象に戻る（受信歴だけで永久除外しない）', () => {
  const { fields, marketing, progress } = progressFor([1, 2, 3, 4, 5, 6]);
  assert.notEqual(progress.status, SEQ_STATUS.DUE);
  assert.notEqual(progress.status, SEQ_STATUS.WAITING);
  assert.equal(isOnboardingActive(progress), false);
  assert.deepEqual(resolveNativeWeeklyEligibility({ fields, marketing, baseExclusion: null, onboardingProgress: progress }),
    { eligible: true, reason: null });
});

test('DRM の既存停止条件で終わった人（購入して有料が切れた等）は再評価できる', () => {
  // 停止（stopped）は受信中ではない。停止理由が何であっても週次の判定からは「終わった人」
  const fields = { Email: EMAIL };
  const stopped = { status: SEQ_STATUS.STOPPED, currentStep: 2, stopReason: 'purchased' };
  assert.deepEqual(resolveNativeWeeklyEligibility({ fields, marketing: mk(fields), baseExclusion: null, onboardingProgress: stopped }),
    { eligible: true, reason: null });
});
