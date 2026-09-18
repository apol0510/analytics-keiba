/**
 * sendgridPlanSizing.test.mjs — **最小プランを選ぶ**判断を固定する
 *
 * - 必要要件を満たす**いちばん小さい**プランを返す
 * - 未確認の枠を「収まる」と言わない
 * - 課金変更は必ず MK 承認（自動で契約しない）
 * - コードに**金額を持たない**（料金表を書き写さない）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  estimateSelectionVolume, estimateSteadyVolume, recommendPlan, canDowngrade,
  describePlanTimeline, PLAN_CANDIDATES, MONTHLY_REVIEW_ITEMS,
  STEADY_SENDS_PER_MONTH, SELECTION_MAX_MESSAGES,
} from './sendgridPlanSizing.js';

test('選別中の残送信数は「残りの通数 × 人数」で決まる', () => {
  const v = estimateSelectionVolume({ countsByNextMessage: { 1: 100, 4: 50, 10: 5 } });
  assert.equal(v.contacts, 155);
  assert.equal(v.remainingSends, 100 * 10 + 50 * 7 + 5 * 1);
  assert.equal(v.peakMonthlyEmails, v.remainingSends, '同じ月に始まる前提で多めに見る');
  assert.equal(v.daysToFinish, SELECTION_MAX_MESSAGES - 1, '1 日 1 通なら 10 通で 9 日');
  assert.deepEqual(v.byStart[4], { contacts: 50, sends: 350 });
});

test('選別後は週 2 回 = 月 8 回で見積もる', () => {
  const v = estimateSteadyVolume({ contacts: 5000 });
  assert.equal(v.sendsPerMonth, STEADY_SENDS_PER_MONTH);
  assert.equal(v.monthlyEmails, 40000, '5,000 件 × 8 回 = 40,000 通/月');
});

test('枠に収まるいちばん小さいプランを返す', () => {
  const r = recommendPlan({ contacts: 5000, monthlyEmails: 40000 });
  assert.equal(r.recommended.id, 'advanced-10k');
  assert.equal(r.requiresApproval, true);
  assert.equal(r.requiresQuote, false);
});

test('contact が多すぎるプランは候補から落ち、未確認は「収まる」と言わない', () => {
  // 15,000 件は 10K に入らない。20K は email 枠が**未確認**なので推薦しない
  const r = recommendPlan({ contacts: 15000, monthlyEmails: 90000 });
  assert.equal(r.recommended, null);
  assert.deepEqual(r.tooSmall.map((t) => t.id), ['advanced-10k']);
  assert.deepEqual(r.unverified.map((u) => u.id), ['advanced-20k']);
  assert.equal(r.reason, 'needs_published_values');
  assert.equal(r.requiresQuote, true, '金額を比べる必要がある＝人が公表値を確認する');
});

test('email 枠だけ足りないときも小さいプランを推薦しない', () => {
  const r = recommendPlan({ contacts: 5000, monthlyEmails: 60000 });
  assert.equal(r.recommended, null);
  assert.deepEqual(r.tooSmall, [{ id: 'advanced-10k', reason: 'email_cap' }]);
});

test('1 段階下げられるかを判定する（下げるのも MK 承認）', () => {
  const down = canDowngrade({ currentPlanId: 'advanced-20k', contacts: 5000, monthlyEmails: 40000 });
  assert.equal(down.ok, true);
  assert.equal(down.recommended.id, 'advanced-10k');
  assert.equal(down.requiresApproval, true);

  const already = canDowngrade({ currentPlanId: 'advanced-10k', contacts: 5000, monthlyEmails: 40000 });
  assert.equal(already.ok, false);
  assert.equal(already.reason, 'current_plan_is_minimal');
});

test('契約判断の地点をまとめて出せる（PROGRESS に貼る形）', () => {
  const selection = estimateSelectionVolume({ countsByNextMessage: { 1: 4000, 3: 6000, 4: 2000 } });
  const steady = estimateSteadyVolume({ contacts: 5000 });
  const t = describePlanTimeline({ selection, steady, current: 'advanced-20k' });
  assert.equal(t['選別中']['contact数'], 12000);
  assert.equal(t['選別後']['想定プラン'], 'advanced-10k');
  assert.equal(t['ダウングレード判定'].ok, true);
  assert.deepEqual(t['毎月の確認'], MONTHLY_REVIEW_ITEMS);
  assert.equal(t['課金変更'], 'requires_mk_approval');
});

test('コードに金額を持たない（料金表を書き写さない）', () => {
  const src = readFileSync(fileURLToPath(new URL('./sendgridPlanSizing.js', import.meta.url)), 'utf8');
  assert.equal(/[¥$]\s?\d/.test(src), false, '金額らしき記述がある');
  for (const p of PLAN_CANDIDATES) {
    assert.equal(Object.prototype.hasOwnProperty.call(p, 'price'), false);
  }
});
