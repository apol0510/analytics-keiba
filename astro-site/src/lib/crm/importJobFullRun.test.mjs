/**
 * importJobFullRun.test.mjs — 143 子バッチを通しで回し、COMPLETED まで到達することを固定する
 *   node --test src/lib/crm/importJobFullRun.test.mjs
 *
 * ⚠️ この試験を作った理由:
 *    2026-08-09 の本実行で、**会計の不具合を 100 件ずつ本番で発見**する事態になった
 *    （PII 誤検知で保存不可 → stale counters → attempted 未加算）。
 *    どれも純粋関数の範囲で再現できるものだったのに、通しで回す試験が無かった。
 *    本番へ出す前に、ここで最後まで回して BLOCKED にならないことを確かめる。
 *
 * Airtable / Redis は使わない。実際の model + reconcile を通す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  beginChildBatch, applyChildResult, adoptMeasuredCreated,
  canStepImportJob, JOB_STATUS, JOB_CHILD_MAX_ROWS,
} from './importJobModel.js';
import { buildJobRecord, validateJobRecord } from './importJobAuthority.js';
import { reconcileImportJob, RECONCILE_VERDICT } from './importJobReconcile.js';

const ENV = { CUSTOMER_IMPORT_WRITE_ENABLED: 'true' };

/**
 * 1 ジョブを最後まで回す。
 * @param {{ planned:number, preCreated:number, skipPerBatch?:number }} opt
 */
function runToCompletion({ planned, preCreated = 0, skipPerBatch = 0 }) {
  let job = buildJobRecord({
    jobId: 'job:t', batchId: 't', source: 'customer-import:t',
    fileFingerprint: 'ff', snapshotFingerprint: 'sf', plannedTotal: planned, nowIso: 'n',
  });
  job.duplicateEmailPairsBaseline = 10;
  // 取り残し（前回の実行が Airtable にだけ書いた分）
  let airtable = preCreated;
  const verdicts = [];
  let steps = 0;

  for (let i = 0; i < 400; i += 1) {
    // 追いつき（最初の 1 回だけ効く）
    const ad = adoptMeasuredCreated({ job, airtableSourceCount: airtable, nowIso: 'n' });
    job = ad.job;
    assert.equal(validateJobRecord(job).ok, true, `追いつき後の正本が保存できない (step ${i})`);

    const gate = canStepImportJob({
      env: ENV, job, providerOk: true, lockAcquired: true, snapshotOk: true,
    });
    if (!gate.allowed) break;

    steps += 1;
    const budget = job.plannedTotal - job.created;
    const target = Math.min(JOB_CHILD_MAX_ROWS, budget);
    if (target <= 0) break;
    const created = Math.max(0, target - skipPerBatch);
    const skipped = target - created;

    job = beginChildBatch({ job, nowIso: 'n', operationId: `op${i}`, fencingToken: String(i + 3) });
    airtable += created;
    job = applyChildResult({
      job,
      result: { ok: true, attempted: target, created, skippedExisting: skipped, failed: 0 },
      scannedTo: (i + 1) * JOB_CHILD_MAX_ROWS, exhausted: false, nowIso: 'n', claimedNotCreated: 0,
    });

    const recon = reconcileImportJob({
      job,
      claimCounts: { CLAIMED: 0, CREATED: job.created, RELEASE_PENDING: 0 },
      airtableSourceCount: airtable,
      duplicateEmailPairs: 10, duplicateEmailPairsBaseline: 10,
    });
    verdicts.push(recon.verdict);
    job.reconciliation = recon;
    assert.equal(validateJobRecord(job).ok, true, `step ${i} の正本が保存できない`);
    if (recon.verdict === RECONCILE_VERDICT.BLOCKED) {
      throw new Error(`step ${i} で BLOCKED: ${JSON.stringify(recon.failedChecks)} / ${recon.checks.map((c) => `${c.checkId}=${c.detail}`).join(' | ')}`);
    }
    if (job.status === JOB_STATUS.COMPLETED || job.status === JOB_STATUS.PARTIAL) break;
  }
  return { job, airtable, steps, verdicts };
}

test('14,279 件を最初から回すと 143 バッチで COMPLETED になる', () => {
  const { job, airtable, steps } = runToCompletion({ planned: 14279 });
  assert.equal(job.status, JOB_STATUS.COMPLETED, `status=${job.status}`);
  assert.equal(job.created, 14279);
  assert.equal(airtable, 14279);
  assert.equal(steps, 143, `子バッチ数が ${steps}`);
});

test('取り残し 200 件からの再開でも COMPLETED になる（今回の本番状態）', () => {
  const { job, airtable, steps } = runToCompletion({ planned: 14279, preCreated: 200 });
  assert.equal(job.status, JOB_STATUS.COMPLETED, `status=${job.status}`);
  assert.equal(job.created, 14279, '合計が計画と合わない');
  assert.equal(airtable, 14279, 'Airtable 実測が合わない');
  assert.equal(steps, 141, `残り 14,079 なら 141 バッチのはず（実際 ${steps}）`);
});

test('全ステップで reconcile が BLOCKED にならない', () => {
  const { verdicts } = runToCompletion({ planned: 14279, preCreated: 200 });
  assert.ok(verdicts.length > 0);
  assert.deepEqual([...new Set(verdicts)], [RECONCILE_VERDICT.OK], `途中で ${[...new Set(verdicts)]}`);
});

test('書き込み側で skip が混ざっても最後まで通る', () => {
  const { job, verdicts } = runToCompletion({ planned: 1000, skipPerBatch: 20 });
  assert.notEqual(job.status, JOB_STATUS.BLOCKED);
  assert.ok(!verdicts.includes(RECONCILE_VERDICT.BLOCKED));
});

test('計画を超えて書かない', () => {
  const { job, airtable } = runToCompletion({ planned: 14279, preCreated: 200 });
  assert.ok(job.created <= job.plannedTotal, `created ${job.created} > planned ${job.plannedTotal}`);
  assert.ok(airtable <= 14279);
});

test('各ステップの正本が常に保存可能（PII 誤検知で落ちない）', () => {
  // runToCompletion 内で毎ステップ validateJobRecord を assert している
  const { steps } = runToCompletion({ planned: 2000, preCreated: 100 });
  assert.ok(steps > 0);
});
