/**
 * importJobUnblock.test.mjs — BLOCKED の解除条件と attempted の会計を固定する
 *   node --test src/lib/crm/importJobUnblock.test.mjs
 *
 * 2026-08-09 の再開で `counters_balanced: 200+0+0 vs 100` により BLOCKED になった。
 * 原因は `writeCreateBatch` が `attempted` を返さず、Function が runner の
 * `out.attempted` を捨てていたこと。BLOCKED は終端なので解除経路も要る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  unblockImportJob, buildUnblockConfirmation, markJobBlocked,
  applyChildResult, beginChildBatch, adoptMeasuredCreated, JOB_STATUS,
} from './importJobModel.js';
import { buildJobRecord, validateJobRecord } from './importJobAuthority.js';
import { reconcileImportJob, RECONCILE_VERDICT } from './importJobReconcile.js';

const base = (over = {}) => ({
  ...buildJobRecord({
    jobId: 'job:t', batchId: 't', source: 'customer-import:t',
    fileFingerprint: 'ff', snapshotFingerprint: 'sf', plannedTotal: 14279, nowIso: 'n',
  }),
  ...over,
});

// ── 1. attempted の会計 ─────────────────────────────────────
test('attempted を渡せば counters_balanced が通る（障害の解消）', () => {
  const adopted = adoptMeasuredCreated({ job: base(), airtableSourceCount: 100, nowIso: 'n' }).job;
  const begun = beginChildBatch({ job: adopted, nowIso: 'n', operationId: 'op', fencingToken: '4' });
  const next = applyChildResult({
    job: begun,
    result: { ok: true, attempted: 100, created: 100, skippedExisting: 0, failed: 0 },
    scannedTo: 200, exhausted: false, nowIso: 'n', claimedNotCreated: 0,
  });
  const r = reconcileImportJob({
    job: next, claimCounts: { CLAIMED: 0, CREATED: 200, RELEASE_PENDING: 0 },
    airtableSourceCount: 200, duplicateEmailPairs: 10, duplicateEmailPairsBaseline: 10,
  });
  assert.equal(r.verdict, RECONCILE_VERDICT.OK, `落ちる: ${JSON.stringify(r.failedChecks)}`);
});

test('attempted を渡さないと counters_balanced が落ちる（障害の再現）', () => {
  const adopted = adoptMeasuredCreated({ job: base(), airtableSourceCount: 100, nowIso: 'n' }).job;
  const begun = beginChildBatch({ job: adopted, nowIso: 'n', operationId: 'op', fencingToken: '4' });
  const next = applyChildResult({
    job: begun,
    result: { ok: true, created: 100, skippedExisting: 0, failed: 0 },   // attempted 無し
    scannedTo: 200, exhausted: false, nowIso: 'n', claimedNotCreated: 0,
  });
  const r = reconcileImportJob({
    job: next, claimCounts: { CLAIMED: 0, CREATED: 200, RELEASE_PENDING: 0 },
    airtableSourceCount: 200, duplicateEmailPairs: 10, duplicateEmailPairsBaseline: 10,
  });
  assert.ok(r.failedChecks.includes('counters_balanced'));
});

test('書き込み側で skip が出ても釣り合う（skip は attempted の内数）', () => {
  const j = base();
  const begun = beginChildBatch({ job: j, nowIso: 'n', operationId: 'op', fencingToken: '4' });
  const next = applyChildResult({
    job: begun,
    result: { ok: true, attempted: 100, created: 70, skippedExisting: 30, failed: 0 },
    scannedTo: 100, exhausted: false, nowIso: 'n', claimedNotCreated: 0,
  });
  const r = reconcileImportJob({
    job: next, claimCounts: { CLAIMED: 0, CREATED: 70, RELEASE_PENDING: 0 },
    airtableSourceCount: 70, duplicateEmailPairs: 10, duplicateEmailPairsBaseline: 10,
  });
  assert.ok(!r.failedChecks.includes('counters_balanced'), JSON.stringify(r.failedChecks));
});

// ── 2. 解除の条件 ──────────────────────────────────────────
const okRecon = { verdict: 'OK', failedChecks: [] };
const ngRecon = { verdict: 'BLOCKED', failedChecks: ['created_matches_airtable'] };

test('突合が OK なら解除できる', () => {
  const j = markJobBlocked({ job: base(), reconciliation: ngRecon, nowIso: 'n' });
  const r = unblockImportJob({ job: j, reconciliation: okRecon, confirmation: buildUnblockConfirmation('t'), nowIso: 'n2' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.job.status, JOB_STATUS.RUNNING);
  assert.equal(validateJobRecord(r.job).ok, true, '解除後の正本が保存できない');
});

test('突合がまだ NG なら解除しない（BLOCKED の意味を保つ）', () => {
  const j = markJobBlocked({ job: base(), reconciliation: ngRecon, nowIso: 'n' });
  const r = unblockImportJob({ job: j, reconciliation: ngRecon, confirmation: buildUnblockConfirmation('t'), nowIso: 'n2' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'still_inconsistent');
  assert.deepEqual(r.failedChecks, ['created_matches_airtable']);
});

test('確認文字列が違えば解除しない', () => {
  const j = markJobBlocked({ job: base(), reconciliation: ngRecon, nowIso: 'n' });
  for (const c of ['', 'UNBLOCK x', 'unblock t', undefined]) {
    assert.equal(unblockImportJob({ job: j, reconciliation: okRecon, confirmation: c, nowIso: 'n' }).ok, false, `c=${c}`);
  }
});

test('BLOCKED 以外は解除対象にしない', () => {
  for (const st of ['PLANNED', 'RUNNING', 'COMPLETED', 'CANCELLED', 'FAILED']) {
    const r = unblockImportJob({ job: base({ status: st }), reconciliation: okRecon, confirmation: buildUnblockConfirmation('t'), nowIso: 'n' });
    assert.equal(r.ok, false, st);
    assert.equal(r.reason, 'not_blocked');
  }
});

test('解除は counters を書き換えない', () => {
  const j = markJobBlocked({ job: base({ created: 200, attempted: 200 }), reconciliation: ngRecon, nowIso: 'n' });
  const r = unblockImportJob({ job: j, reconciliation: okRecon, confirmation: buildUnblockConfirmation('t'), nowIso: 'n2' });
  assert.equal(r.job.created, 200);
  assert.equal(r.job.attempted, 200);
});

// ── 3. Function 側 ────────────────────────────────────────
const FN = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/admin-customer-import-job.js', import.meta.url)), 'utf8');

test('Function は runner の attempted を applyChildResult へ渡す', () => {
  assert.match(FN, /attempted:\s*Number\.isFinite\(out\.attempted\)\s*\?\s*out\.attempted\s*:\s*0/);
});

test('unblock は実測を取り直してから判定する', () => {
  const i = FN.indexOf('async function handleUnblock');
  const body = FN.slice(i, i + 3200);
  assert.match(body, /fetchAllReadOnly\(/, '実測を取り直していない');
  assert.match(body, /reconcileImportJob\(/, '突合していない');
  assert.match(body, /saveFenced\(/, 'fenced save を使っていない');
});
