/**
 * autoDispatchPlan.test.mjs — 積まれたジョブを人手なしで送り切る計画
 *   node --test src/lib/marketing/autoDispatchPlan.test.mjs
 *
 * 重点:
 *   - **古い順**に起動する（後から積んだ人に追い越させない）
 *   - 1 tick の起動数に上限がある（暴走しない）
 *   - `queue:unverified` は起動しない
 *   - 「送る相手 0 人」だったジョブで**行列の先頭が詰まらない**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planAutoDispatch, resolveMaxJobsPerTick, summarizeAutoDispatch, readWillSend,
  AUTO_DISPATCH_SKIP, DEFAULT_MAX_JOBS_PER_TICK,
} from './autoDispatchPlan.js';

const NOW = Date.UTC(2026, 8, 14, 3, 0);

const job = (jobId, over = {}) => ({
  id: `rec-${jobId}`,
  fields: {
    JobId: jobId,
    Status: 'PENDING',
    ScheduledFor: '2026-09-10T00:00:00.000Z',
    TargetPlan: 'campaign:campaign-discount-free',
    Notes: 'marketing campaign campaign-discount-free v1 sequence step2 content:abc shell:v1',
    ...over,
  },
});

test('古い順に起動する（積んだ順を追い越さない）', () => {
  const plan = planAutoDispatch({
    jobs: [
      job('mkt-c', { ScheduledFor: '2026-09-12T00:00:00.000Z' }),
      job('mkt-a', { ScheduledFor: '2026-09-10T00:00:00.000Z' }),
      job('mkt-b', { ScheduledFor: '2026-09-11T00:00:00.000Z' }),
    ],
    maxJobs: 10,
    nowMs: NOW,
  });
  assert.deepEqual(plan.start.map((j) => j.jobId), ['mkt-a', 'mkt-b', 'mkt-c']);
});

test('同時刻は JobId で安定して並ぶ（tick ごとに順序が揺れない）', () => {
  const rows = [job('mkt-b'), job('mkt-a')];
  const a = planAutoDispatch({ jobs: rows, maxJobs: 10, nowMs: NOW });
  const b = planAutoDispatch({ jobs: rows.slice().reverse(), maxJobs: 10, nowMs: NOW });
  assert.deepEqual(a.start.map((j) => j.jobId), b.start.map((j) => j.jobId));
});

test('1 tick の起動数に上限がある（超えたぶんは次 tick へ）', () => {
  const rows = Array.from({ length: 25 }, (_, i) => job(`mkt-${String(i).padStart(3, '0')}`));
  const plan = planAutoDispatch({ jobs: rows, maxJobs: 10, nowMs: NOW });
  assert.equal(plan.start.length, 10);
  assert.equal(plan.skippedByReason[AUTO_DISPATCH_SKIP.OVER_BUDGET], 15);
  assert.equal(plan.candidates, 25);
});

test('上限は env で変えられる（壊れた値は既定へ）', () => {
  assert.equal(resolveMaxJobsPerTick({}), DEFAULT_MAX_JOBS_PER_TICK);
  assert.equal(resolveMaxJobsPerTick({ MARKETING_DISPATCH_MAX_JOBS_PER_TICK: '25' }), 25);
  for (const bad of ['0', '-3', 'abc', '1000', '']) {
    assert.equal(resolveMaxJobsPerTick({ MARKETING_DISPATCH_MAX_JOBS_PER_TICK: bad }), DEFAULT_MAX_JOBS_PER_TICK, bad);
  }
});

test('【重要】`queue:unverified` は起動しない（配信行の確認が済んでいない）', () => {
  const plan = planAutoDispatch({
    jobs: [job('mkt-a', { Notes: 'content:abc queue:unverified' })], maxJobs: 10, nowMs: NOW,
  });
  assert.equal(plan.start.length, 0);
  assert.equal(plan.skipped[0].reason, AUTO_DISPATCH_SKIP.UNVERIFIED);
});

test('【重要】PENDING 以外は掘り返さない', () => {
  for (const status of ['SENT', 'CANCELLED', 'EXECUTING', 'FAILED', '']) {
    const plan = planAutoDispatch({ jobs: [job('mkt-a', { Status: status })], maxJobs: 10, nowMs: NOW });
    assert.equal(plan.start.length, 0, status);
    assert.equal(plan.skipped[0].reason, AUTO_DISPATCH_SKIP.NOT_PENDING, status);
  }
});

test('【重要】マーケ以外のジョブには触らない', () => {
  const plan = planAutoDispatch({
    jobs: [job('newsletter-1', { TargetPlan: 'all', CreatedBy: 'cron-email-scheduler' })],
    maxJobs: 10,
    nowMs: NOW,
  });
  assert.equal(plan.start.length, 0);
  assert.equal(plan.skipped[0].reason, AUTO_DISPATCH_SKIP.NOT_MARKETING);
});

test('JobId が無い行は起動しない（何を起動したのか記録できない）', () => {
  const plan = planAutoDispatch({ jobs: [job('x', { JobId: '' })], maxJobs: 10, nowMs: NOW });
  assert.equal(plan.start.length, 0);
  assert.equal(plan.skipped[0].reason, AUTO_DISPATCH_SKIP.NO_JOB_ID);
});

test('【重要】「送る相手 0 人」だったジョブが行列の先頭で詰まらない', () => {
  const stuck = job('mkt-stuck', { ScheduledFor: '2026-09-09T00:00:00.000Z' });
  const fresh = job('mkt-fresh', { ScheduledFor: '2026-09-13T00:00:00.000Z' });
  const cooldown = new Map([['mkt-stuck', NOW + 3600_000]]);
  const plan = planAutoDispatch({ jobs: [stuck, fresh], maxJobs: 1, cooldownUntilByJobId: cooldown, nowMs: NOW });
  assert.deepEqual(plan.start.map((j) => j.jobId), ['mkt-fresh'], '詰まったジョブに枠を使っている');
  assert.equal(plan.skippedByReason[AUTO_DISPATCH_SKIP.COOLING_DOWN], 1);
});

test('冷却が切れたら、また見に行く（永久に飛ばさない）', () => {
  const cooldown = new Map([['mkt-a', NOW - 1]]);
  const plan = planAutoDispatch({ jobs: [job('mkt-a')], maxJobs: 10, cooldownUntilByJobId: cooldown, nowMs: NOW });
  assert.equal(plan.start.length, 1);
});

test('壊れた入力で落ちない（空・null・配列でない）', () => {
  for (const jobs of [undefined, null, 'x', [], [null], [{}]]) {
    const plan = planAutoDispatch({ jobs, maxJobs: 5, nowMs: NOW });
    assert.equal(plan.start.length, 0);
  }
});

// ── readWillSend（起動直前の下見の読み取り）─────────────────────
test('dry-run から送る人数を読む（分からなければ起動しない）', () => {
  const ok = readWillSend({ jobResults: [{ jobId: 'mkt-a', willSend: 100, willSkip: 3, alreadySent: 7 }] }, 'mkt-a');
  assert.equal(ok.ok, true);
  assert.equal(ok.willSend, 100);
  assert.equal(readWillSend({ jobResults: [{ jobId: 'other', willSend: 5 }] }, 'mkt-a').ok, false);
  assert.equal(readWillSend({}, 'mkt-a').ok, false);
  for (const bad of [null, undefined, '10', NaN, Infinity]) {
    assert.equal(readWillSend({ jobResults: [{ jobId: 'mkt-a', willSend: bad }] }, 'mkt-a').ok, false, String(bad));
  }
});

test('要約に PII を含めない（件数だけ）', () => {
  const s = summarizeAutoDispatch({ planned: 3, started: 2, skipped: 1, nothingToSend: 1 });
  assert.deepEqual(Object.keys(s), ['対象', '起動', '見送り', '送る相手なし']);
  assert.equal(JSON.stringify(s).includes('@'), false);
});
