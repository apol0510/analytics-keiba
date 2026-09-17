/**
 * sendgridMessagePlan.test.mjs — 10 通の通し番号の対応表を固定する
 *
 * ここが崩れると**移行の全部がズレる**（誰が何通目まで受け取ったかが変わる）ので、
 * 期・step 数・鍵の作り方を契約として固定する。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMessagePlan, buildMessageKeys, groupPlanByCampaign,
  PHASE1_CAMPAIGN_ID, PHASE2_CAMPAIGN_ID, TOTAL_MESSAGES, PLAN_FAIL,
} from './sendgridMessagePlan.js';
import { getCampaign } from './campaignCatalog.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';

const BRAND = 'analytics-keiba';
const FROM = 'support@keiba.link';

test('通し番号は 3 + 7 = 10 通で、第 1 期 → 第 2 期の順に並ぶ', () => {
  const r = buildMessagePlan();
  assert.equal(r.ok, true);
  assert.equal(r.plan.length, TOTAL_MESSAGES);
  assert.deepEqual(r.plan.map((p) => p.messageNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(
    r.plan.slice(0, 3).map((p) => [p.campaignId, p.stepNumber]),
    [[PHASE1_CAMPAIGN_ID, 1], [PHASE1_CAMPAIGN_ID, 2], [PHASE1_CAMPAIGN_ID, 3]],
  );
  assert.deepEqual(
    r.plan.slice(3).map((p) => [p.campaignId, p.stepNumber]),
    [1, 2, 3, 4, 5, 6, 7].map((s) => [PHASE2_CAMPAIGN_ID, s]),
  );
});

test('件名は 10 通すべて違う（同じ文面を繰り返さない）', () => {
  const r = buildMessagePlan();
  const subjects = r.plan.map((p) => p.subject);
  assert.equal(new Set(subjects).size, TOTAL_MESSAGES);
  for (const s of subjects) assert.ok(s.length > 0);
});

test('期間外でも対応表は変わらない（includeDisabled で解決する）', () => {
  // catalog の第 1 期は期間で無効になりうる。無効でも plan は 10 通のまま
  const disabled = getCampaign(PHASE1_CAMPAIGN_ID, { includeDisabled: true });
  assert.ok(disabled, '第 1 期は includeDisabled で必ず引ける');
  const r = buildMessagePlan();
  assert.equal(r.ok, true);
  assert.equal(r.plan.length, TOTAL_MESSAGES);
});

test('鍵は既存の computeCampaignDeliveryKey と 1 文字も変わらない', () => {
  const r = buildMessagePlan();
  const email = 'seed-plan@example.test';
  const keys = buildMessageKeys({ plan: r.plan, email, brand: BRAND, fromEmail: FROM });
  assert.ok(keys instanceof Map);
  assert.equal(keys.size, TOTAL_MESSAGES);
  for (const entry of r.plan) {
    const campaign = getCampaign(entry.campaignId, { includeDisabled: true });
    const effective = resolveSequenceStep(campaign, entry.stepNumber);
    const expected = computeCampaignDeliveryKey({
      campaign: effective, recipientEmail: email, brand: BRAND, fromEmail: FROM,
    });
    assert.equal(keys.get(entry.messageNumber), expected);
  }
  // 10 通ぶんすべて別の鍵
  assert.equal(new Set(keys.values()).size, TOTAL_MESSAGES);
});

test('アドレスが無ければ鍵を作らない（推測で埋めない）', () => {
  const r = buildMessagePlan();
  assert.equal(buildMessageKeys({ plan: r.plan, email: '', brand: BRAND, fromEmail: FROM }), null);
});

test('campaign が引けない / step 数が違えば fail closed', () => {
  const missing = buildMessagePlan({ lookup: () => null });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, PLAN_FAIL.CAMPAIGN_MISSING);

  const shortened = buildMessagePlan({
    lookup: (id) => {
      const c = getCampaign(id, { includeDisabled: true });
      if (id !== PHASE2_CAMPAIGN_ID) return c;
      return { ...c, sequence: { ...c.sequence, steps: c.sequence.steps.slice(0, 3) } };
    },
  });
  assert.equal(shortened.ok, false);
  assert.equal(shortened.reason, PLAN_FAIL.STEP_COUNT_MISMATCH);
});

test('campaign 単位にまとめると台帳の引き方と一致する（2 本・3 + 7）', () => {
  const r = buildMessagePlan();
  const groups = groupPlanByCampaign(r.plan);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].campaignId, PHASE1_CAMPAIGN_ID);
  assert.equal(groups[0].entries.length, 3);
  assert.equal(groups[1].campaignId, PHASE2_CAMPAIGN_ID);
  assert.equal(groups[1].entries.length, 7);
  assert.deepEqual(groups[1].entries.map((e) => e.messageNumber), [4, 5, 6, 7, 8, 9, 10]);
});
