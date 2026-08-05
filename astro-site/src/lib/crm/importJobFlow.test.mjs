/**
 * importJobFlow.test.mjs — 親ジョブ + 子バッチの状態機械と実行を固定する
 *   node --test src/lib/crm/importJobFlow.test.mjs
 *
 * **1 件も本番へ書かない。** Airtable / Redis はすべて注入したモックで受ける。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canStartImportJob, canStepImportJob, cancelImportJob,
  applyChildResult, beginChildBatch, markJobBlocked, markJobRedisUnavailable,
  summarizeJobProgress, describeJobRollback,
  buildJobId, buildJobSource, buildJobConfirmation, buildOperationId,
  countChildBatches, clampChildSize, nextChildIndex,
  JOB_STATUS, JOB_REJECT, JOB_CHILD_MAX_ROWS, TERMINAL_STATUS,
} from './importJobModel.js';
import {
  selectCreateRows, countCreateCandidates, classifyCreateRow,
  orderEntriesDeterministically, SKIP_REASON,
} from './importEligibility.js';
import { runChildBatch, STEP_STOP } from './importJobRunner.js';
import { buildJobRecord } from './importJobAuthority.js';

const REMAINING = 14284;
const NOW_MS = Date.parse('2026-08-05T03:00:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();
const BATCH = 'imp-2026-08-05-004';
const JOB_ID = `job:${BATCH}`;
const ENV_ON = { CUSTOMER_IMPORT_WRITE_ENABLED: 'true' };

const emptyFacts = () => ({
  existing: new Set(), paid: new Set(), duplicateInAk: new Set(),
  unsubscribed: new Set(), hardBounce: new Set(), softBounce: new Set(),
  suspended: new Set(), testAccounts: new Set(),
});

const makeEntries = (n, prefix = 'u') => Array.from({ length: n }, (_, i) => ({
  email: `${prefix}${String(i).padStart(6, '0')}@example.invalid`, name: '', flags: [],
}));

const newJob = (total = REMAINING, over = {}) => ({
  ...buildJobRecord({
    jobId: JOB_ID, batchId: BATCH, source: `customer-import:${BATCH}`,
    fileFingerprint: 'fp-abc', snapshotFingerprint: 'snap-abc', plannedTotal: total,
    fencingToken: '1', operationId: 'op-0', nowIso: NOW_ISO,
  }),
  childSize: JOB_CHILD_MAX_ROWS,
  ...over,
});

/** claim をすべて勝たせる fake（排他の検証は importJobClaim.test.mjs 側）*/
function allowAllClaims() {
  const calls = { claimRows: 0, verifyLockOwnership: 0, markRowsCreated: 0 };
  return {
    calls,
    claims: {
      async claimRows({ emails }) { calls.claimRows += 1; return { won: [...emails], created: [], taken: [], mine: [] }; },
      async verifyLockOwnership() { calls.verifyLockOwnership += 1; return { ok: true, reason: null }; },
      async markRowsCreated({ emails }) { calls.markRowsCreated += 1; return { ok: [...emails], notMine: [], missing: [] }; },
    },
  };
}
const okAuthority = { async verifySnapshot() { return { ok: true, reason: null }; } };

function okWriter() {
  const chunks = [];
  return {
    chunks,
    deps: {
      createRecords: async (a) => { chunks.push(a.length); return { ok: true, status: 200 }; },
      createRecord: async () => ({ ok: true, status: 200 }),
      sleep: async () => {},
    },
  };
}

const runArgs = (over = {}) => ({
  job: newJob(), entries: makeEntries(250), currentOrderedHashes: ['h'],
  facts: emptyFacts(), providerEmails: new Set(), availableFields: new Set(),
  lockToken: '1', operationId: 'op-1', nowMs: NOW_MS, nowIso: NOW_ISO,
  authority: okAuthority, ...over,
});

// ── 分割 ──────────────────────────────────────────────────────

test('14,284 件は 100 件以下の子バッチ 143 個へ分割される', () => {
  assert.equal(countChildBatches(REMAINING, 100), 143);
  assert.equal(REMAINING - 142 * 100, 84);
});

test('子バッチの大きさは 100 件を超えられない', () => {
  assert.equal(clampChildSize(500), 100);
  assert.equal(clampChildSize(101), 100);
  assert.equal(clampChildSize(0), 100);
  assert.equal(JOB_CHILD_MAX_ROWS, 100);
});

test('jobId / ImportBatchId / Source / operationId が一意に決まる', () => {
  assert.equal(buildJobId(BATCH), JOB_ID);
  assert.equal(buildJobSource(BATCH), `customer-import:${BATCH}`);
  assert.equal(buildOperationId({ jobId: JOB_ID, index: 7 }), `${JOB_ID}#0007`);
  assert.notEqual(buildJobSource(BATCH), buildJobSource('imp-2026-08-05-005'));
});

// ── 書き込み ──────────────────────────────────────────────────

test('子バッチ 100 件は 10 件ずつ 10 リクエストになる', async () => {
  const w = okWriter();
  const c = allowAllClaims();
  const out = await runChildBatch(runArgs({ claims: c.claims, deps: w.deps }));
  assert.equal(out.result.created, 100);
  assert.equal(out.result.bulkRequests, 10);
  assert.equal(out.result.singleRequests, 0);
  assert.deepEqual(w.chunks, Array(10).fill(10));
});

test('計画総数を超えて書かない', async () => {
  const w = okWriter();
  const c = allowAllClaims();
  const out = await runChildBatch(runArgs({
    job: newJob(120, { created: 100, attempted: 100 }), claims: c.claims, deps: w.deps,
  }));
  assert.equal(out.result.created, 20);
});

// ── 不変条件: 書き込み直前の所有権再検証 ────────────────────────

test('書き込み直前にロック所有権を再検証する（claim の後・create の前）', async () => {
  const order = [];
  const claims = {
    async claimRows({ emails }) { order.push('claim'); return { won: [...emails], created: [], taken: [], mine: [] }; },
    async verifyLockOwnership() { order.push('verify'); return { ok: true, reason: null }; },
    async markRowsCreated({ emails }) { order.push('mark'); return { ok: [...emails], notMine: [], missing: [] }; },
  };
  const deps = {
    createRecords: async () => { order.push('create'); return { ok: true, status: 200 }; },
    createRecord: async () => ({ ok: true, status: 200 }), sleep: async () => {},
  };
  await runChildBatch(runArgs({ entries: makeEntries(10), claims, deps }));
  assert.equal(order[0], 'claim');
  assert.equal(order[1], 'verify');
  assert.equal(order[2], 'create', 'create が所有権再検証より前にある');
  assert.equal(order[order.length - 1], 'mark');
});

test('所有権を失っていたら Airtable create を 1 件も行わない', async () => {
  let created = 0;
  const claims = {
    async claimRows({ emails }) { return { won: [...emails], created: [], taken: [], mine: [] }; },
    async verifyLockOwnership() { return { ok: false, reason: 'stolen' }; },
    async markRowsCreated() { throw new Error('呼ばれてはいけない'); },
  };
  const deps = {
    createRecords: async () => { created += 1; return { ok: true, status: 200 }; },
    createRecord: async () => { created += 1; return { ok: true, status: 200 }; }, sleep: async () => {},
  };
  const out = await runChildBatch(runArgs({ entries: makeEntries(10), claims, deps }));
  assert.equal(created, 0, 'stale writer が書き込んだ');
  assert.equal(out.stopped, STEP_STOP.LOCK_LOST);
});

test('snapshot が変わっていたら Airtable を書かない', async () => {
  let created = 0;
  const c = allowAllClaims();
  const deps = {
    createRecords: async () => { created += 1; return { ok: true, status: 200 }; },
    createRecord: async () => ({ ok: true, status: 200 }), sleep: async () => {},
  };
  const out = await runChildBatch(runArgs({
    claims: c.claims, deps,
    authority: { async verifySnapshot() { return { ok: false, reason: 'snapshot_changed' }; } },
  }));
  assert.equal(out.stopped, STEP_STOP.SNAPSHOT_CHANGED);
  assert.equal(created, 0);
  assert.equal(c.calls.claimRows, 0, 'snapshot 不一致なのに claim を取った');
});

test('他が確保済みの行は書かない（claim に負けた分を飛ばす）', async () => {
  const entries = makeEntries(10);
  const written = [];
  const claims = {
    async claimRows({ emails }) {
      return { won: emails.slice(0, 4), created: emails.slice(4, 6), taken: emails.slice(6), mine: [] };
    },
    async verifyLockOwnership() { return { ok: true, reason: null }; },
    async markRowsCreated({ emails }) { return { ok: [...emails], notMine: [], missing: [] }; },
  };
  const deps = {
    createRecords: async (a) => { written.push(...a.map((f) => f.Email)); return { ok: true, status: 200 }; },
    createRecord: async () => ({ ok: true, status: 200 }), sleep: async () => {},
  };
  const out = await runChildBatch(runArgs({ entries, claims, deps }));
  assert.equal(written.length, 4, '確保できていない行を書いた');
  assert.equal(out.result.created, 4);
});

test('claim をすべて失ったら書き込み 0 で終わる', async () => {
  let created = 0;
  const claims = {
    async claimRows({ emails }) { return { won: [], created: [], taken: [...emails], mine: [] }; },
    async verifyLockOwnership() { return { ok: true, reason: null }; },
    async markRowsCreated() { return { ok: [], notMine: [], missing: [] }; },
  };
  const deps = {
    createRecords: async () => { created += 1; return { ok: true, status: 200 }; },
    createRecord: async () => ({ ok: true, status: 200 }), sleep: async () => {},
  };
  const out = await runChildBatch(runArgs({ entries: makeEntries(10), claims, deps }));
  assert.equal(created, 0);
  assert.equal(out.result, null);
});

test('書き込みが例外で落ちても claim を解放しない', async () => {
  let released = 0;
  const c = allowAllClaims();
  c.claims.releaseClaimByReconciler = async () => { released += 1; return { released: true }; };
  const deps = {
    createRecords: async () => { throw new Error('boom'); },
    createRecord: async () => { throw new Error('boom'); }, sleep: async () => {},
  };
  const out = await runChildBatch(runArgs({ entries: makeEntries(10), claims: c.claims, deps }));
  assert.equal(out.writeError, true);
  assert.equal(released, 0, 'runner が claim を解放している（reconciler の仕事）');
});

// ── ゲート ────────────────────────────────────────────────────

test('開始ゲート: env / ロック / 確認文字列 / 停止リストのどれか欠けたら開始しない', () => {
  const total = REMAINING;
  const base = {
    confirmation: buildJobConfirmation({ batchId: BATCH, total }), batchId: BATCH,
    plannedTotal: total, existingJob: null, providerOk: true, lockAcquired: true,
  };
  assert.equal(canStartImportJob({ ...base, env: ENV_ON }).allowed, true);
  assert.equal(canStartImportJob({ ...base, env: {} }).reason, JOB_REJECT.WRITE_DISABLED);
  assert.equal(canStartImportJob({ ...base, env: ENV_ON, lockAcquired: false }).reason, JOB_REJECT.LOCKED);
  assert.equal(canStartImportJob({ ...base, env: ENV_ON, confirmation: '' }).reason, JOB_REJECT.NO_CONFIRMATION);
  assert.equal(canStartImportJob({ ...base, env: ENV_ON, confirmation: 'IMPORT-JOB x 1' }).reason, JOB_REJECT.CONFIRMATION_MISMATCH);
  assert.equal(canStartImportJob({ ...base, env: ENV_ON, providerOk: false }).reason, JOB_REJECT.PREVIEW_INVALID);
  assert.equal(canStartImportJob({ ...base, env: ENV_ON, existingJob: newJob() }).reason, JOB_REJECT.JOB_EXISTS);
});

test('ロックが取れていなければ開始も続行もしない（Airtable を読ませない）', () => {
  assert.equal(canStepImportJob({
    env: ENV_ON, job: newJob(), providerOk: true, snapshotOk: true, lockAcquired: false,
  }).reason, JOB_REJECT.LOCKED);
});

test('確認文字列は総件数に紐づくので使い回せない', () => {
  assert.equal(buildJobConfirmation({ batchId: BATCH, total: REMAINING }), `IMPORT-JOB ${BATCH} 14284`);
  assert.notEqual(
    buildJobConfirmation({ batchId: BATCH, total: REMAINING }),
    buildJobConfirmation({ batchId: BATCH, total: REMAINING - 1 }),
  );
});

test('終端状態のジョブは進められない（COMPLETED / FAILED / CANCELLED / BLOCKED）', () => {
  for (const [status, reason] of [
    [JOB_STATUS.COMPLETED, JOB_REJECT.ALREADY_COMPLETED],
    [JOB_STATUS.FAILED, JOB_REJECT.FAILED],
    [JOB_STATUS.CANCELLED, JOB_REJECT.CANCELLED],
    [JOB_STATUS.BLOCKED, JOB_REJECT.BLOCKED],
  ]) {
    assert.equal(canStepImportJob({
      env: ENV_ON, job: newJob(REMAINING, { status }), providerOk: true,
      snapshotOk: true, lockAcquired: true,
    }).reason, reason);
    assert.ok(TERMINAL_STATUS.includes(status));
  }
});

test('CSV 差し替え・snapshot 不一致は進めない', () => {
  const job = newJob();
  assert.equal(canStepImportJob({
    env: ENV_ON, job, fileFingerprint: 'DIFFERENT', providerOk: true, snapshotOk: true, lockAcquired: true,
  }).reason, JOB_REJECT.FILE_CHANGED);
  assert.equal(canStepImportJob({
    env: ENV_ON, job, fileFingerprint: 'fp-abc', providerOk: true, snapshotOk: false, lockAcquired: true,
  }).reason, JOB_REJECT.SNAPSHOT_CHANGED);
});

// ── cancel 境界 ───────────────────────────────────────────────

test('cancel は未処理分だけ止め、作成済みは消さない', () => {
  let job = applyChildResult({
    job: beginChildBatch({ job: newJob(), nowIso: NOW_ISO, operationId: 'op-1', fencingToken: '1' }),
    result: { ok: true, attempted: 100, created: 100, skippedExisting: 0, skippedDone: 0, failed: 0 },
    scannedTo: 100, exhausted: false, nowIso: NOW_ISO,
  });
  const cancelled = cancelImportJob({ job, nowIso: NOW_ISO });
  assert.equal(cancelled.status, JOB_STATUS.CANCELLED);
  assert.equal(cancelled.created, 100, '作成済みが消えた');
  assert.ok(cancelled.cancelledAt);
  assert.ok(cancelled.cancelNote.includes('結果は確定させます'));
  assert.ok(cancelled.cancelNote.includes('reconciler'));
});

test('cancel と step が競合しても、cancel 後は新しい子バッチ claim を取らない', async () => {
  const c = allowAllClaims();
  const w = okWriter();
  const cancelled = cancelImportJob({ job: newJob(), nowIso: NOW_ISO });
  const out = await runChildBatch(runArgs({ job: cancelled, claims: c.claims, deps: w.deps }));
  assert.equal(out.stopped, STEP_STOP.CANCELLED);
  assert.equal(c.calls.claimRows, 0, 'cancel 後に claim を取った');
  assert.equal(w.chunks.length, 0, 'cancel 後に書き込んだ');
});

test('完了済みジョブは取り消せない', () => {
  const done = newJob(REMAINING, { status: JOB_STATUS.COMPLETED });
  assert.equal(cancelImportJob({ job: done, nowIso: NOW_ISO }).status, JOB_STATUS.COMPLETED);
});

// ── 状態遷移 ──────────────────────────────────────────────────

test('failed があれば COMPLETED ではなく PARTIAL', () => {
  const job = applyChildResult({
    job: beginChildBatch({ job: newJob(100), nowIso: NOW_ISO, operationId: 'o', fencingToken: '1' }),
    result: { ok: true, attempted: 100, created: 99, skippedExisting: 0, skippedDone: 0, failed: 1 },
    scannedTo: 100, exhausted: true, nowIso: NOW_ISO,
  });
  assert.equal(job.status, JOB_STATUS.PARTIAL);
});

test('突合が説明できない不一致なら BLOCKED へ落とす', () => {
  const blocked = markJobBlocked({ job: newJob(), reconciliation: { verdict: 'BLOCKED' }, nowIso: NOW_ISO });
  assert.equal(blocked.status, JOB_STATUS.BLOCKED);
  assert.equal(blocked.currentChild, null);
});

test('Redis 異常は BLOCKED として正本に残る', () => {
  const b = markJobRedisUnavailable({ job: newJob(), code: 'unreachable', nowIso: NOW_ISO });
  assert.equal(b.status, JOB_STATUS.BLOCKED);
  assert.match(b.reconciliation.reason, /redis_unavailable/);
});

test('子バッチ履歴に operationId と fencingToken が残る', () => {
  const job = applyChildResult({
    job: beginChildBatch({ job: newJob(), nowIso: NOW_ISO, operationId: 'op-7', fencingToken: '42' }),
    result: { ok: true, attempted: 100, created: 100, skippedExisting: 0, skippedDone: 0, failed: 0 },
    scannedTo: 100, exhausted: false, nowIso: NOW_ISO, claimedNotCreated: 0,
  });
  const h = job.childHistory[0];
  assert.equal(h.operationId, 'op-7');
  assert.equal(h.fencingToken, '42');
  assert.equal(nextChildIndex(job), 2);
});

// ── 対象判定 ──────────────────────────────────────────────────

test('既存化したアドレスは直前判定で外れる', () => {
  const entries = makeEntries(10);
  const facts = { ...emptyFacts(), existing: new Set([entries[3].email, entries[7].email]) };
  const picked = selectCreateRows({ entries, facts, providerEmails: new Set(), cursor: 0, limit: 100 });
  assert.equal(picked.rows.length, 8);
  assert.equal(picked.skipped[SKIP_REASON.EXISTING], 2);
});

test('除外集合 10 種', () => {
  const facts = emptyFacts();
  for (const [key, reason] of [
    ['paid', SKIP_REASON.PAID], ['duplicateInAk', SKIP_REASON.DUPLICATE_IN_AK],
    ['unsubscribed', SKIP_REASON.UNSUBSCRIBED], ['hardBounce', SKIP_REASON.HARD_BOUNCE],
    ['softBounce', SKIP_REASON.SOFT_BOUNCE], ['suspended', SKIP_REASON.SUSPENDED],
    ['testAccounts', SKIP_REASON.TEST_ACCOUNT], ['existing', SKIP_REASON.EXISTING],
  ]) {
    const v = classifyCreateRow({
      entry: { email: 'x@example.invalid', flags: [] },
      facts: { ...facts, [key]: new Set(['x@example.invalid']) }, providerEmails: new Set(),
    });
    assert.equal(v.reason, reason);
  }
  assert.equal(classifyCreateRow({
    entry: { email: 'x@example.invalid', flags: [] }, facts, providerEmails: new Set(['x@example.invalid']),
  }).reason, SKIP_REASON.PROVIDER_SUPPRESSED);
  assert.equal(classifyCreateRow({
    entry: { email: 'x@example.invalid', flags: ['name_conflict'] }, facts, providerEmails: new Set(),
  }).reason, SKIP_REASON.FLAGGED);
});

test('並びは決定的（アドレス昇順）', () => {
  const s = [{ email: 'c@x.invalid' }, { email: 'a@x.invalid' }, { email: 'b@x.invalid' }];
  const a = orderEntriesDeterministically(s).map((e) => e.email);
  assert.deepEqual(a, ['a@x.invalid', 'b@x.invalid', 'c@x.invalid']);
  assert.deepEqual(a, orderEntriesDeterministically([...s].reverse()).map((e) => e.email));
});

test('対象総数は除外を引いた数', () => {
  const entries = makeEntries(100);
  const facts = { ...emptyFacts(), existing: new Set(entries.slice(0, 30).map((e) => e.email)) };
  assert.equal(countCreateCandidates({ entries, facts, providerEmails: new Set() }), 70);
});

test('UPDATE・除外・要確認は 1 件も書かれない', async () => {
  const entries = makeEntries(50);
  const facts = {
    ...emptyFacts(),
    existing: new Set(entries.slice(0, 20).map((e) => e.email)),
    paid: new Set(entries.slice(20, 25).map((e) => e.email)),
  };
  const flagged = entries.slice(25, 30).map((e) => ({ ...e, flags: ['name_conflict'] }));
  const list = orderEntriesDeterministically([...entries.slice(0, 25), ...flagged, ...entries.slice(30)]);
  const c = allowAllClaims();
  const w = okWriter();
  const out = await runChildBatch(runArgs({ entries: list, facts, claims: c.claims, deps: w.deps }));
  assert.equal(out.result.created, 20);
  assert.equal(out.skipped[SKIP_REASON.EXISTING], 20);
  assert.equal(out.skipped[SKIP_REASON.PAID], 5);
  assert.equal(out.skipped[SKIP_REASON.FLAGGED], 5);
});

test('書き込む列は allow-list の 5 列だけ', async () => {
  const seen = [];
  const c = allowAllClaims();
  const deps = {
    createRecords: async (a) => { seen.push(...a); return { ok: true, status: 200 }; },
    createRecord: async () => ({ ok: true, status: 200 }), sleep: async () => {},
  };
  await runChildBatch(runArgs({ entries: makeEntries(10), claims: c.claims, deps }));
  assert.ok(seen.length > 0);
  for (const f of seen) {
    for (const k of Object.keys(f)) {
      assert.ok(['Email', '氏名', 'プラン', 'ポイント', 'Source'].includes(k), `許可外の列: ${k}`);
    }
    assert.equal(f['プラン'], 'Free');
    assert.equal(f['ポイント'], 0);
  }
});

// ── 表示・rollback ────────────────────────────────────────────

test('進捗まとめが画面の必須項目を満たす', () => {
  const job = applyChildResult({
    job: beginChildBatch({ job: newJob(), nowIso: NOW_ISO, operationId: 'o', fencingToken: '1' }),
    result: { ok: true, attempted: 100, created: 98, skippedExisting: 2, skippedDone: 0, failed: 0 },
    scannedTo: 100, exhausted: false, nowIso: NOW_ISO,
  });
  const s = summarizeJobProgress(job);
  for (const k of ['対象総数', '処理済み', '作成済み', '既存スキップ', '失敗', '残件数', '進捗率',
    '子バッチ数', '完了した子バッチ', '現在の子バッチ', '最終更新', 'jobId', 'ImportBatchId',
    'Source', 'status', 'fencingToken', 'operationId', 'snapshotFingerprint']) {
    assert.ok(k in s, `${k} が無い`);
  }
  assert.equal(s.作成済み, 98);
  assert.equal(s.残件数, REMAINING - 98);
  assert.equal(s.再実行可能, true);
});

test('rollback は削除ではなく Source 単位の隔離', () => {
  const r = describeJobRollback(newJob());
  assert.equal(r.Source, `customer-import:${BATCH}`);
  assert.equal(r.既定, '隔離（削除しない）');
  assert.ok(r.steps.join('\n').includes('消さない'));
});
