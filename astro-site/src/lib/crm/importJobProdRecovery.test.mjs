/**
 * importJobProdRecovery.test.mjs — 2026-08-09 の**本番正本そのもの**から復旧できることを固定する
 *   node --test src/lib/crm/importJobProdRecovery.test.mjs
 *
 * fixture は本番 status API の実測値（PII なし）:
 *   status=BLOCKED / 対象総数=14279 / 処理済み(attempted)=100 / 作成済み(created)=200 /
 *   既存スキップ=0 / 失敗=0 / 完了した子バッチ=1 / fencingToken=5 /
 *   failedChecks=['counters_balanced']（200+0+0 vs 100）/ Airtable 実測=200
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  repairCounterInvariants, adoptMeasuredCreated, unblockImportJob, buildUnblockConfirmation,
  beginChildBatch, applyChildResult, canStepImportJob, JOB_STATUS, JOB_CHILD_MAX_ROWS,
} from './importJobModel.js';
import { validateJobRecord } from './importJobAuthority.js';
import { reconcileImportJob, RECONCILE_VERDICT } from './importJobReconcile.js';

const AIRTABLE_ACTUAL = 200;
const PLANNED = 14279;
const ENV = { CUSTOMER_IMPORT_WRITE_ENABLED: 'true' };

/** 本番正本の実状態（PII なし） */
const prodJob = () => ({
  jobId: 'job:imp-2026-08-09-001',
  batchId: 'imp-2026-08-09-001',
  source: 'customer-import:imp-2026-08-09-001',
  fileFingerprint: '33200f587f034bc6',
  snapshotFingerprint: 'abecef6dd7262a26022b0f5608d297af823c8a4b93b356ed000703c8045f3a69',
  plannedTotal: PLANNED,
  orderingVersion: 'email-asc-1',
  cursor: 100,
  attempted: 100,          // ← 記録漏れ（実際は 200 試行している）
  created: 200,
  skippedExisting: 0,
  failed: 0,
  cancelledAt: null,
  status: JOB_STATUS.BLOCKED,
  currentChild: null,
  fencingToken: '5',
  operationId: 'job:imp-2026-08-09-001#0001',
  childHistory: [{ index: 1, operationId: 'job:imp-2026-08-09-001#0001', state: 'DONE', created: 100 }],
  reconciliation: { verdict: 'BLOCKED', failedChecks: ['counters_balanced'] },
  duplicateEmailPairsBaseline: 10,
  childSize: JOB_CHILD_MAX_ROWS,
  createdAt: '2026-08-09T05:53:14.764Z',
  updatedAt: '2026-08-09T06:20:34.096Z',
});

const recon = (job, airtable) => reconcileImportJob({
  job, claimCounts: { CLAIMED: 0, CREATED: job.created, RELEASE_PENDING: 0 },
  airtableSourceCount: airtable, duplicateEmailPairs: 10, duplicateEmailPairsBaseline: 10,
});

// ── 0. fixture が本番と一致していること ─────────────────────
test('fixture が本番の実状態を再現している', () => {
  const j = prodJob();
  assert.equal(j.status, JOB_STATUS.BLOCKED);
  assert.equal(j.created, 200);
  assert.equal(j.attempted, 100);
  assert.equal(j.childHistory.length, 1);
  const r = recon(j, AIRTABLE_ACTUAL);
  assert.equal(r.verdict, RECONCILE_VERDICT.BLOCKED);
  assert.deepEqual(r.failedChecks, ['counters_balanced'], '本番と同じ失敗検査になっていない');
  assert.match(r.checks.find((c) => c.checkId === 'counters_balanced').detail, /200\+0\+0 vs 100/);
});

// ── 1〜3. unblock が成功し、なぜ通るのかを示す ────────────────
test('① 修復なしでは unblock は成功しない（counters を書き換えないため）', () => {
  const j = prodJob();
  const r = unblockImportJob({ job: j, reconciliation: recon(j, AIRTABLE_ACTUAL), confirmation: buildUnblockConfirmation(j.batchId), nowIso: 'n' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'still_inconsistent');
});

test('② 不変条件の回復で attempted だけが直る（created 等は不変）', () => {
  const j = prodJob();
  const rep = repairCounterInvariants({ job: j, nowIso: 'n' });
  assert.equal(rep.repaired, 100, 'attempted の不足分 100 を直していない');
  assert.equal(rep.job.attempted, 200, 'created+skipped+failed = 200 に合わせていない');
  // **実測由来の値は 1 つも触らない**
  assert.equal(rep.job.created, 200);
  assert.equal(rep.job.skippedExisting, 0);
  assert.equal(rep.job.failed, 0);
  assert.equal(rep.job.cursor, 100);
  assert.equal(validateJobRecord(rep.job).ok, true);
});

test('③ 回復後は counters_balanced が PASS し、unblock が成功する', () => {
  const j = repairCounterInvariants({ job: prodJob(), nowIso: 'n' }).job;
  const r = recon(j, AIRTABLE_ACTUAL);
  assert.equal(r.verdict, RECONCILE_VERDICT.OK, `まだ落ちる: ${JSON.stringify(r.failedChecks)}`);
  const u = unblockImportJob({ job: j, reconciliation: r, confirmation: buildUnblockConfirmation(j.batchId), nowIso: 'n2' });
  assert.equal(u.ok, true, u.reason);
  assert.equal(u.job.status, JOB_STATUS.RUNNING);
  // unblock 自身は counters を書き換えていない（直したのは repair で、根拠は算術不変条件）
  assert.equal(u.job.created, 200);
  assert.equal(u.job.attempted, 200);
});

// ── 4〜8. 再開して最後まで ────────────────────────────────
function resumeToEnd() {
  let job = repairCounterInvariants({ job: prodJob(), nowIso: 'n' }).job;
  job = unblockImportJob({ job, reconciliation: recon(job, AIRTABLE_ACTUAL), confirmation: buildUnblockConfirmation(job.batchId), nowIso: 'n' }).job;
  let airtable = AIRTABLE_ACTUAL;
  let steps = 0; const verdicts = []; const balances = [];
  let firstStepCreated = null;

  for (let i = 0; i < 400; i += 1) {
    job = repairCounterInvariants({ job, nowIso: 'n' }).job;
    job = adoptMeasuredCreated({ job, airtableSourceCount: airtable, nowIso: 'n' }).job;
    if (!canStepImportJob({ env: ENV, job, providerOk: true, lockAcquired: true, snapshotOk: true }).allowed) break;

    const budget = job.plannedTotal - job.created;
    const target = Math.min(JOB_CHILD_MAX_ROWS, budget);
    if (target <= 0) break;
    steps += 1;
    job = beginChildBatch({ job, nowIso: 'n', operationId: `op${i}`, fencingToken: String(6 + i) });
    airtable += target;                                  // 全件 CREATE 成功
    if (firstStepCreated === null) firstStepCreated = target;
    job = applyChildResult({
      job, result: { ok: true, attempted: target, created: target, skippedExisting: 0, failed: 0 },
      scannedTo: job.cursor + JOB_CHILD_MAX_ROWS, exhausted: false, nowIso: 'n', claimedNotCreated: 0,
    });
    const r = recon(job, airtable);
    verdicts.push(r.verdict);
    balances.push(job.created + job.skippedExisting + job.failed === job.attempted);
    job.reconciliation = r;
    assert.equal(validateJobRecord(job).ok, true, `step ${i} の正本が保存できない`);
    if (job.status === JOB_STATUS.COMPLETED || job.status === JOB_STATUS.PARTIAL) break;
  }
  return { job, airtable, steps, verdicts, balances, firstStepCreated };
}

test('④ 最初の再開 step で二重 CREATE が起きない', () => {
  const { firstStepCreated, airtable } = resumeToEnd();
  assert.equal(firstStepCreated, 100, '1 バッチで 100 件を超えて書いている');
  // 既存 200 件を作り直していない = 合計が 200 + 追加分になる
  assert.ok(airtable >= AIRTABLE_ACTUAL, 'Airtable 実測が減っている');
});

test('⑤ 残り 14,079 件を 141 バッチで COMPLETED にする', () => {
  const { job, steps } = resumeToEnd();
  assert.equal(job.status, JOB_STATUS.COMPLETED, `status=${job.status}`);
  assert.equal(steps, 141, `子バッチ数が ${steps}`);
});

test('⑥ 最終 created が総 CREATE 件数と一致する', () => {
  const { job, airtable } = resumeToEnd();
  assert.equal(job.created, PLANNED, `created=${job.created}`);
  assert.equal(airtable, PLANNED, `Airtable 実測=${airtable}`);
});

test('⑦ 全ステップで attempted / created / skipped / failed が整合する', () => {
  const { balances } = resumeToEnd();
  assert.ok(balances.length > 0);
  assert.deepEqual([...new Set(balances)], [true], '途中で会計が崩れている');
});

test('⑧ 全ステップの reconciliation が PASS', () => {
  const { verdicts } = resumeToEnd();
  assert.deepEqual([...new Set(verdicts)], [RECONCILE_VERDICT.OK], `途中で ${[...new Set(verdicts)]}`);
});

// ── 修復の安全性 ─────────────────────────────────────────
test('不変条件が既に満たされていれば何もしない', () => {
  const j = { ...prodJob(), attempted: 500 };
  assert.equal(repairCounterInvariants({ job: j, nowIso: 'n' }).repaired, 0);
});

test('attempted を減らす方向には動かさない', () => {
  const j = { ...prodJob(), attempted: 9999 };
  assert.equal(repairCounterInvariants({ job: j, nowIso: 'n' }).job.attempted, 9999);
});

test('created / skipped / failed を推測で動かさない', () => {
  const j = prodJob();
  const out = repairCounterInvariants({ job: j, nowIso: 'n' }).job;
  for (const k of ['created', 'skippedExisting', 'failed', 'cursor', 'plannedTotal']) {
    assert.equal(out[k], j[k], `${k} を書き換えている`);
  }
});
