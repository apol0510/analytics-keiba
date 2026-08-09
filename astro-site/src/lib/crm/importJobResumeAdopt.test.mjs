/**
 * importJobResumeAdopt.test.mjs — 再開時に正本を実測へ追いつかせる
 *   node --test src/lib/crm/importJobResumeAdopt.test.mjs
 *
 * 2026-08-09 の障害: 子バッチが Airtable へ 100 件 CREATE した直後に正本の保存が
 * 失敗し、`created=0` のまま 100 件が存在する状態になった。
 * そのまま再開すると reconciler の `created_matches_airtable` が必ず落ちて
 * BLOCKED になり、永久に進めない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { adoptMeasuredCreated, applyChildResult, beginChildBatch } from './importJobModel.js';
import { buildJobRecord, validateJobRecord } from './importJobAuthority.js';
import { reconcileImportJob, RECONCILE_VERDICT } from './importJobReconcile.js';

const base = (over = {}) => ({
  ...buildJobRecord({
    jobId: 'job:t', batchId: 't', source: 'customer-import:t',
    fileFingerprint: 'ff', snapshotFingerprint: 'sf',
    plannedTotal: 14279, nowIso: 'n',
  }),
  ...over,
});

// ── 1. 追いつき ─────────────────────────────────────────────
test('created=0 / 実測 100 → 100 へ追いつく', () => {
  const r = adoptMeasuredCreated({ job: base(), airtableSourceCount: 100, nowIso: 'n' });
  assert.equal(r.adopted, 100);
  assert.equal(r.job.created, 100);
  assert.equal(r.job.countersAdopted.from, 0);
  assert.equal(r.job.countersAdopted.to, 100);
  // counters_balanced を保つため attempted も同じだけ上げる
  assert.equal(r.job.attempted, 100);
});

test('追いつき後の残予算が正しい（plannedTotal − created）', () => {
  const r = adoptMeasuredCreated({ job: base(), airtableSourceCount: 100, nowIso: 'n' });
  assert.equal(r.job.plannedTotal - r.job.created, 14179, '残 14,179 にならない');
});

test('追いついた正本は保存できる', () => {
  const r = adoptMeasuredCreated({ job: base(), airtableSourceCount: 100, nowIso: 'n' });
  assert.equal(validateJobRecord(r.job).ok, true);
});

// ── 2. 適用しない条件 ────────────────────────────────────────
test('子バッチを 1 つでも記録済みなら適用しない（実行中のドリフトを飲み込まない）', () => {
  const j = base({ childHistory: [{ index: 1, created: 100 }] });
  const r = adoptMeasuredCreated({ job: j, airtableSourceCount: 999, nowIso: 'n' });
  assert.equal(r.adopted, 0);
  assert.equal(r.reason, 'not_first_step');
  assert.equal(r.job.created, 0, '正本を書き換えている');
});

test('実測が記録以下なら何もしない（削除・巻き戻しを隠さない）', () => {
  for (const [rec, meas] of [[200, 100], [100, 100], [5, 0]]) {
    const r = adoptMeasuredCreated({ job: base({ created: rec }), airtableSourceCount: meas, nowIso: 'n' });
    assert.equal(r.adopted, 0, `recorded=${rec} measured=${meas} で追いついている`);
  }
});

test('plannedTotal を超えて増やさない', () => {
  const r = adoptMeasuredCreated({ job: base({ plannedTotal: 50 }), airtableSourceCount: 999, nowIso: 'n' });
  assert.equal(r.job.created, 50);
});

// ── 3. reconciler が通ること（本障害の再現と解消）────────────
test('追いつかせないと reconciler が BLOCKED になる（障害の再現）', () => {
  const j = base();
  const begun = beginChildBatch({ job: j, nowIso: 'n', operationId: 'op', fencingToken: '4' });
  const next = applyChildResult({
    job: begun, result: { ok: true, attempted: 100, created: 100, skippedExisting: 0, failed: 0 },
    scannedTo: 200, exhausted: false, nowIso: 'n', claimedNotCreated: 0,
  });
  const r = reconcileImportJob({
    job: next, claimCounts: { CLAIMED: 0, CREATED: 200, RELEASE_PENDING: 0 },
    airtableSourceCount: 200, duplicateEmailPairs: 10, duplicateEmailPairsBaseline: 10,
  });
  assert.notEqual(r.verdict, RECONCILE_VERDICT.OK, '不整合を検出できていない');
});

test('追いつかせれば reconciler が通る', () => {
  const adopted = adoptMeasuredCreated({ job: base(), airtableSourceCount: 100, nowIso: 'n' }).job;
  const begun = beginChildBatch({ job: adopted, nowIso: 'n', operationId: 'op', fencingToken: '4' });
  const next = applyChildResult({
    job: begun, result: { ok: true, attempted: 100, created: 100, skippedExisting: 0, failed: 0 },
    scannedTo: 200, exhausted: false, nowIso: 'n', claimedNotCreated: 0,
  });
  assert.equal(next.created, 200);
  const r = reconcileImportJob({
    job: next, claimCounts: { CLAIMED: 0, CREATED: 200, RELEASE_PENDING: 0 },
    airtableSourceCount: 200, duplicateEmailPairs: 10, duplicateEmailPairsBaseline: 10,
  });
  assert.equal(r.verdict, RECONCILE_VERDICT.OK, `まだ落ちる: ${JSON.stringify(r.failedChecks)}`);
});

// ── 4. Function 側の配線 ────────────────────────────────────
const FN = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/admin-customer-import-job.js', import.meta.url)), 'utf8');

test('追いつきは子バッチの実行より前に行う', () => {
  const a = FN.indexOf('adoptMeasuredCreated({');
  const b = FN.indexOf('await runChildBatch({');
  assert.ok(a > -1 && b > a, '子バッチの後に追いついている（意味が無い）');
});

test('追いついた正本は fenced save で保存し、失敗したら進めない', () => {
  const i = FN.indexOf('adoptMeasuredCreated({');
  const body = FN.slice(i, i + 900);
  assert.match(body, /saveFenced\(/, 'fenced save を使っていない');
  assert.match(body, /json\(409/, '保存失敗でも進もうとしている');
});

test('追いつきのログに件数以外を出さない', () => {
  const i = FN.indexOf('counters_adopted');
  assert.ok(i > -1, 'ログが無い');
  const line = FN.slice(FN.lastIndexOf('\n', i), FN.indexOf('\n', i));
  assert.ok(!/email|Email|氏名|token(?!\W*:)/.test(line), `PII らしきものを出している: ${line}`);
});
