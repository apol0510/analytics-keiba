/**
 * importJobPersistable.test.mjs — 「Airtable に書いたのに正本を保存できない」を防ぐ
 *   node --test src/lib/crm/importJobPersistable.test.mjs
 *
 * 2026-08-09 の障害:
 *   子バッチが Airtable へ **100 件 CREATE した後**、正本の保存だけが
 *   `invalid_job` で落ちた。結果、正本は `status=PLANNED / created=0` のまま
 *   Airtable には 100 件存在するという不整合になった。
 *
 *   原因は `reconcileImportJob` が返す `checks[].name` の **キー名 `name`**。
 *   `assertNoPii` は `name` を PII とみなすため、`validateJobRecord` が
 *   `(pii detected)` で false を返していた。
 *
 *   ⚠️ 書き込みの後に保存する設計である以上、**保存できない正本を作らない**ことが要件。
 *      ここでは「実行中に生成されうる正本の形」がすべて保存可能かを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildJobRecord, validateJobRecord, assertNoPii,
} from './importJobAuthority.js';
import {
  beginChildBatch, applyChildResult, markJobBlocked, markJobRedisUnavailable, cancelImportJob,
} from './importJobModel.js';
import { reconcileImportJob } from './importJobReconcile.js';

const base = () => buildJobRecord({
  jobId: 'job:t', batchId: 't', source: 'customer-import:t',
  fileFingerprint: 'ff', snapshotFingerprint: 'sf',
  plannedTotal: 14279, nowIso: '2026-08-09T00:00:00.000Z',
});

const recon = (job) => reconcileImportJob({
  job,
  claimCounts: { CLAIMED: 0, CREATED: 100, RELEASE_PENDING: 0 },
  airtableSourceCount: 100, duplicateEmailPairs: 10, duplicateEmailPairsBaseline: 10,
});

function stepped() {
  const b = beginChildBatch({ job: base(), nowIso: 'n', operationId: 'op', fencingToken: '3' });
  return applyChildResult({
    job: b, result: { ok: true, attempted: 100, created: 100, skippedExisting: 0, failed: 0 },
    scannedTo: 100, exhausted: false, nowIso: 'n', claimedNotCreated: 0,
  });
}

// ── 1. 実行中に生成されうる正本はすべて保存できる ──────────────
test('reconciliation を付けた正本が保存できる（2026-08-09 の障害の再発防止）', () => {
  const j = stepped();
  j.reconciliation = recon(j);
  const v = validateJobRecord(j);
  assert.equal(v.ok, true, `保存できない: ${v.missing.join(',')}`);
});

test('reconcile の結果に PII 判定されるキーが無い', () => {
  const r = recon(stepped());
  assert.ok(assertNoPii(r), 'reconcile の返り値が PII 判定されている');
  for (const c of r.checks) {
    assert.ok(!('name' in c), 'checks に name キーがある（assertNoPii が拒否する）');
    assert.ok('checkId' in c, 'checks に checkId が無い');
  }
});

test('failedChecks は checkId を返す', () => {
  const j = stepped();
  // 意図的に不整合を作る（created が airtable 実測と合わない）
  const r = reconcileImportJob({
    job: j, claimCounts: { CLAIMED: 0, CREATED: 100, RELEASE_PENDING: 0 },
    airtableSourceCount: 999, duplicateEmailPairs: 10, duplicateEmailPairsBaseline: 10,
  });
  assert.ok(r.failedChecks.length > 0, '不整合を検出できていない');
  for (const id of r.failedChecks) assert.equal(typeof id, 'string');
});

test('BLOCKED / Redis 異常 / 取消 の各形も保存できる', () => {
  const j = stepped();
  const r = recon(j);
  for (const [label, rec] of [
    ['markJobBlocked', markJobBlocked({ job: j, reconciliation: r, nowIso: 'n' })],
    ['markJobRedisUnavailable', markJobRedisUnavailable({ job: j, code: 'unreachable', nowIso: 'n' })],
    ['cancelImportJob', cancelImportJob({ job: j, nowIso: 'n' })],
  ]) {
    const v = validateJobRecord(rec);
    assert.equal(v.ok, true, `${label} の結果が保存できない: ${v.missing.join(',')}`);
  }
});

test('子バッチ履歴が積み上がっても保存できる（143 回分）', () => {
  let j = base();
  for (let i = 0; i < 143; i += 1) {
    j = beginChildBatch({ job: j, nowIso: 'n', operationId: `op${i}`, fencingToken: String(i + 3) });
    j = applyChildResult({
      job: j, result: { ok: true, attempted: 100, created: 100, skippedExisting: 0, failed: 0 },
      scannedTo: (i + 1) * 100, exhausted: false, nowIso: 'n', claimedNotCreated: 0,
    });
    j.reconciliation = recon(j);
  }
  const v = validateJobRecord(j);
  assert.equal(v.ok, true, `143 回目で保存できない: ${v.missing.join(',')}`);
});

// ── 2. PII ガード自体は弱めない ────────────────────────────────
test('本物の PII は今も拒否する（ガードを弱めていない）', () => {
  for (const bad of [
    { email: 'a@example.com' }, { 氏名: '山田' }, { rows: [] },
    { nested: { deep: { name: '山田太郎' } } },
  ]) {
    const j = { ...stepped(), extra: bad };
    assert.equal(validateJobRecord(j).ok, false, `PII を通した: ${JSON.stringify(bad)}`);
  }
});
