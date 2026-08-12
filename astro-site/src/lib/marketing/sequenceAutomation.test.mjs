/**
 * sequenceAutomation.test.mjs — 自動で次ステップを queue する計画とゲート
 *   node --test src/lib/marketing/sequenceAutomation.test.mjs
 *
 * 重点:
 *   - **ゲートが 1 つでも欠ければ何もしない**（副作用ゼロ）
 *   - 1 回の実行で進めるのは 1 ステップだけ
 *   - **step1（初回接触）は自動で撃たない**
 *   - 上限超過は切り捨てず中止（部分送信の曖昧さを作らない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readSequenceGates, readSequenceAutoState, planSequenceTick, summarizeSequenceTick,
  SEQUENCE_ENV, TICK_ABORT, MAX_RECIPIENTS_PER_TICK,
} from './sequenceAutomation.js';
import { buildSequenceProgress } from './sequenceProgress.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { resolveCustomerMarketing, MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';
import { jstDateString } from './campaignSend.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 20, 3, 0);
const TODAY = jstDateString(NOW);
const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';

const mkStep = (n) => ({
  stepNumber: n, delayDays: n === 1 ? 0 : 3,
  subject: `件名${n}`, preheader: `p${n}`, body: `本文${n}`,
  ctaLabel: `CTA${n}`, ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock', benefitDescription: '無料で見られる予想を開放してご案内します',
});
const CAMPAIGN = Object.freeze({
  campaignId: 'seq-test', version: 1, name: 'テスト',
  subject: '既定', body: '既定本文', ctaLabel: 'CTA', ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock', benefitDescription: '無料で見られる予想を開放してご案内します',
  audienceRule: { contracts: [MK_CONTRACT.NONE], plans: [MK_PLAN.FREE], enforce: true },
  enabled: true, sequence: { maxSends: 3, steps: [mkStep(1), mkStep(2), mkStep(3)] },
});

const OPEN_ENV = {
  [SEQUENCE_ENV.SCHEDULER]: 'true',
  [SEQUENCE_ENV.ARMED]: TODAY,
  [SEQUENCE_ENV.ENQUEUE]: 'true',
  [SEQUENCE_ENV.DISPATCH]: 'true',
};

function customer(email, over = {}) {
  const fields = { Email: email, Status: 'active', ...over };
  return { recordId: `rec-${email}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
}
function delivered(email, n, atMs = NOW - 10 * DAY) {
  const key = computeCampaignDeliveryKey({
    campaign: resolveSequenceStep(CAMPAIGN, n), recipientEmail: email, brand: BRAND, fromEmail: FROM,
  });
  return { fields: { EmailType: 'campaign', DeliveryKey: key, RecipientEmail: email, Status: 'sent', SentAt: new Date(atMs).toISOString() } };
}
const progressOf = (selected, deliveries) => buildSequenceProgress({
  campaign: CAMPAIGN, selected, deliveries, brand: BRAND, fromEmail: FROM, nowMs: NOW,
  providerSuppressed: new Set(), softBounced: new Set(),
});

// ── ゲート ──────────────────────────────────────────────────
test('4 つ揃って初めて開く', () => {
  assert.equal(readSequenceGates(OPEN_ENV, NOW).allOpen, true);
  for (const key of Object.values(SEQUENCE_ENV)) {
    const env = { ...OPEN_ENV };
    delete env[key];
    const g = readSequenceGates(env, NOW);
    assert.equal(g.allOpen, false, `${key} が無くても開いてしまう`);
    assert.ok(g.missing.includes(key));
  }
});

test('武装は当日の JST 日付のみ有効（置きっぱなしは翌日閉じる）', () => {
  const stale = { ...OPEN_ENV, [SEQUENCE_ENV.ARMED]: jstDateString(NOW - DAY) };
  assert.equal(readSequenceGates(stale, NOW).allOpen, false);
});

test('表示用の状態に env の値を出さない', () => {
  const s = readSequenceAutoState({ ...OPEN_ENV }, NOW);
  assert.equal(s.enabled, true);
  const json = JSON.stringify(s);
  assert.equal(json.includes('true"'), false);
  assert.ok(!json.includes(FROM));
  const closed = readSequenceAutoState({}, NOW);
  assert.equal(closed.enabled, false);
  assert.ok(closed.missing.length === 4, '不足している env 名だけを返す');
});

// ── 計画 ────────────────────────────────────────────────────
test('【重要】ゲートが閉じていれば計画を作らない', () => {
  const p = progressOf([customer('a@example.com')], [delivered('a@example.com', 1)]);
  const plan = planSequenceTick({ progress: p, gates: readSequenceGates({}, NOW) });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.GATES_CLOSED);
});

test('step2 以降は自動で進む', () => {
  const p = progressOf([customer('a@example.com')], [delivered('a@example.com', 1)]);
  const plan = planSequenceTick({ progress: p, gates: readSequenceGates(OPEN_ENV, NOW) });
  assert.equal(plan.ok, true);
  assert.equal(plan.step, 2);
  assert.equal(plan.recipients, 1);
});

test('【重要】step1（初回接触）は自動で撃たない', () => {
  const p = progressOf([customer('a@example.com')], []);
  const plan = planSequenceTick({ progress: p, gates: readSequenceGates(OPEN_ENV, NOW) });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.FIRST_STEP_MANUAL);
});

test('送る相手がいなければ何もしない', () => {
  const p = progressOf([customer('a@example.com')], [delivered('a@example.com', 1, NOW)]);
  const plan = planSequenceTick({ progress: p, gates: readSequenceGates(OPEN_ENV, NOW) });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.NO_DUE);
});

test('上限超過は切り捨てずに中止する', () => {
  const many = Array.from({ length: 3 }, (_, i) => customer(`u${i}@example.com`));
  const d = many.map((c) => delivered(c.fields.Email, 1));
  const plan = planSequenceTick({
    progress: progressOf(many, d), gates: readSequenceGates(OPEN_ENV, NOW), maxRecipients: 2,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.OVER_MAX);
  assert.equal(MAX_RECIPIENTS_PER_TICK, 200);
});

test('要約にアドレスも recordId も含めない', () => {
  const p = progressOf([customer('a@example.com')], [delivered('a@example.com', 1)]);
  const plan = planSequenceTick({ progress: p, gates: readSequenceGates(OPEN_ENV, NOW) });
  const s = summarizeSequenceTick({ campaignId: 'seq-test', plan, enqueued: 1 });
  const json = JSON.stringify(s);
  assert.equal(/@example\.com/.test(json), false);
  assert.equal(/rec-/.test(json), false);
});

test('停止した相手は自動配信の対象にならない', () => {
  const email = 'a@example.com';
  const paid = customer(email, { 'プラン': 'Premium', '有効期限': '2027-01-01' });
  const plan = planSequenceTick({
    progress: progressOf([paid], [delivered(email, 1)]), gates: readSequenceGates(OPEN_ENV, NOW),
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.NO_DUE);
});
