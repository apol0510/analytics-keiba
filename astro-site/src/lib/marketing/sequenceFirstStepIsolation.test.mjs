/**
 * sequenceFirstStepIsolation.test.mjs — step1 未送信者が **step2 以降を巻き添えにしない**
 *   node --test src/lib/marketing/sequenceFirstStepIsolation.test.mjs
 *
 * ## 何を固定するか（2026-09-08 の障害）
 *
 * `selectNextDueStep` は「いちばん小さい due step」を返す。step1 未送信の人が
 * **1 人でも**混ざると step が 1 になり、`planSequenceTick` が
 * `first_step_manual` で **tick 全体を中止**していた。
 *
 * 本番では prospect 11,976 名のうち **328 名が step1 未送信**だったため、
 * step2 を待っていた **11,648 名が 1 通も進まなかった**（エラーも警告も出ない）。
 *
 * 直した形: step1 の人は**候補から外す**だけ。step1 しか居ないときだけ
 * 従来どおり `first_step_manual` で止まる（初回接触は自動で撃たない、は不変）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planSequenceTick, readSequenceGates, SEQUENCE_ENV, TICK_ABORT } from './sequenceAutomation.js';
import { buildSequenceProgress, selectNextDueStep } from './sequenceProgress.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { resolveCustomerMarketing, MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 1, 3, 0);
const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';

const mkStep = (n) => ({
  stepNumber: n, delayDays: n === 1 ? 0 : 5,
  subject: `件名${n}`, preheader: `p${n}`, body: `本文${n}`,
  ctaLabel: `CTA${n}`, ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'discount', benefitDescription: '割引価格でご案内します',
});
const CAMPAIGN = Object.freeze({
  campaignId: 'seq-first-step-test', version: 1, name: 'テスト',
  subject: '既定', body: '既定本文', ctaLabel: 'CTA', ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'discount', benefitDescription: '割引価格でご案内します',
  audienceRule: { contracts: [MK_CONTRACT.NONE], plans: [MK_PLAN.FREE], enforce: true },
  enabled: true, sequence: { maxSends: 3, steps: [mkStep(1), mkStep(2), mkStep(3)] },
});

const OPEN_ENV = {
  [SEQUENCE_ENV.SCHEDULER]: 'true',
  [SEQUENCE_ENV.ENQUEUE]: 'true',
  [SEQUENCE_ENV.DISPATCH]: 'true',
};

function customer(email) {
  const fields = { Email: email, Status: 'active' };
  return { recordId: `rec-${email}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
}
const delivered = (email, n, atMs = NOW - 7 * DAY) => ({
  fields: {
    EmailType: 'campaign',
    DeliveryKey: computeCampaignDeliveryKey({
      campaign: resolveSequenceStep(CAMPAIGN, n), recipientEmail: email, brand: BRAND, fromEmail: FROM,
    }),
    RecipientEmail: email, Status: 'sent', SentAt: new Date(atMs).toISOString(),
  },
});
const progressOf = (selected, deliveries) => buildSequenceProgress({
  campaign: CAMPAIGN, selected, deliveries, brand: BRAND, fromEmail: FROM, nowMs: NOW,
  providerSuppressed: new Set(), softBounced: new Set(),
});

/** 本番と同じ形: step1 未送信が少数、step1 済みが多数 */
function mixedCohort({ notStarted, atStep1 }) {
  const selected = [];
  const deliveries = [];
  for (let i = 0; i < notStarted; i += 1) selected.push(customer(`new${i}@example.com`));
  for (let i = 0; i < atStep1; i += 1) {
    const email = `step1-${i}@example.com`;
    selected.push(customer(email));
    deliveries.push(delivered(email, 1));
  }
  return progressOf(selected, deliveries);
}

test('【再現→修正】step1 未送信が 1 人混ざっても step2 が進む', () => {
  const p = mixedCohort({ notStarted: 1, atStep1: 3 });
  // 除外しなければ最小 due step は 1（＝旧実装が中止していた状態）
  assert.equal(selectNextDueStep(p).step, 1, '前提が変わっている（step1 が最小でない）');

  const plan = planSequenceTick({ progress: p, gates: readSequenceGates(OPEN_ENV, NOW) });
  assert.equal(plan.ok, true, `step2 が進まない: ${plan.abort}`);
  assert.equal(plan.step, 2);
  assert.equal(plan.recipients, 3, 'step1 未送信の人が対象に混ざっている');
});

test('【規模】328 名の step1 未送信が 11,648 名の step2 を止めない', () => {
  const p = mixedCohort({ notStarted: 328, atStep1: 1164 });
  const plan = planSequenceTick({ progress: p, gates: readSequenceGates(OPEN_ENV, NOW) });
  assert.equal(plan.ok, true, `本番と同じ形で止まっている: ${plan.abort}`);
  assert.equal(plan.step, 2);
  assert.equal(plan.dueTotal, 1164);
});

test('【不変】step1 の人しか居なければ従来どおり撃たない', () => {
  const p = mixedCohort({ notStarted: 5, atStep1: 0 });
  const plan = planSequenceTick({ progress: p, gates: readSequenceGates(OPEN_ENV, NOW) });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.FIRST_STEP_MANUAL, '初回接触が自動で撃たれている');
});

test('【不変】誰も居なければ NO_DUE（「除外の結果ゼロ」と区別する）', () => {
  const p = progressOf([customer('a@example.com')], [delivered('a@example.com', 1, NOW)]);
  const plan = planSequenceTick({ progress: p, gates: readSequenceGates(OPEN_ENV, NOW) });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.NO_DUE);
});

test('【明示】allowFirstStep: true なら従来どおり step1 を選べる（手動経路）', () => {
  const p = mixedCohort({ notStarted: 2, atStep1: 2 });
  const plan = planSequenceTick({
    progress: p, gates: readSequenceGates(OPEN_ENV, NOW), allowFirstStep: true,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.step, 1);
  assert.equal(plan.recipients, 2);
});

test('selectNextDueStep の除外は「そもそもゼロ」と区別できる', () => {
  const only1 = mixedCohort({ notStarted: 2, atStep1: 0 });
  const picked = selectNextDueStep(only1, { excludeSteps: [1] });
  assert.equal(picked.step, null);
  assert.equal(picked.excludedOnly, true, '除外の結果ゼロだと分からない');

  const none = progressOf([customer('a@example.com')], [delivered('a@example.com', 1, NOW)]);
  assert.equal(selectNextDueStep(none, { excludeSteps: [1] }).excludedOnly, false);
});

test('1 回の tick で送るのは 1 ステップだけ（混ぜない）', () => {
  const selected = [customer('a@example.com'), customer('b@example.com')];
  const deliveries = [
    delivered('a@example.com', 1),
    delivered('b@example.com', 1),
    delivered('b@example.com', 2),
  ];
  const plan = planSequenceTick({
    progress: progressOf(selected, deliveries), gates: readSequenceGates(OPEN_ENV, NOW),
  });
  assert.equal(plan.step, 2, '最小の due step から進めていない');
  assert.equal(plan.recipients, 1);
});
