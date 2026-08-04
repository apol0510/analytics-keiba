/**
 * importJobPlan.test.mjs — 取り込み実行モデル（親ジョブ / 子バッチ / 冪等 / 再開）
 *   node --test src/lib/crm/importJobPlan.test.mjs
 *
 * 本番 write は**未配線**。だが「実行したら何が起きるか」はここで固定しておく。
 * 大量取り込みで取り返しがつかないのは「多く作る」「二重に作る」こと。
 * 減る方向は許し、増える方向は構造的に禁じる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BATCH_SIZE, MIN_BATCH_SIZE, MAX_BATCH_SIZE,
  IMPORT_JOB_STATE, IMPORT_BATCH_STATE, WRITE_KIND, IMPORT_CREATED_BY, IMPORT_AUDIT_FIELDS,
  isCustomerImportWriteEnabled, planImportJob, nextImportBatch, canWriteRow,
  pauseImportJob, resumeImportJob, cancelPendingImportBatches, planRetryFailed,
  summarizeImportJob, buildImportAuditFields, buildImportAuditEntry, describeImportRollback,
} from './importJobPlan.js';
import { computeRowKey } from './customerImport.js';

const plan = (over = {}) => planImportJob({
  importPreviewId: 'prev-abcdef0123456789',
  batchId: 'imp-2026-08-04-001',
  createCount: 12800,
  updateCount: 100,
  ...over,
});

// ── 書き込みゲート ────────────────────────────────────────────

test('本番書き込みは既定 OFF', () => {
  assert.equal(isCustomerImportWriteEnabled({}), false);
  assert.equal(isCustomerImportWriteEnabled(null), false);
  assert.equal(isCustomerImportWriteEnabled({ CUSTOMER_IMPORT_WRITE_ENABLED: 'false' }), false);
  assert.equal(isCustomerImportWriteEnabled({ CUSTOMER_IMPORT_WRITE_ENABLED: 'TRUE' }), false,
    '大文字を true 扱いしている（綴り揺れで意図せず有効化される）');
  assert.equal(isCustomerImportWriteEnabled({ CUSTOMER_IMPORT_WRITE_ENABLED: 'true' }), true);
});

// ── 計画 ──────────────────────────────────────────────────────

test('作成と更新を別バッチに分ける（戻し方が違うので混ぜない）', () => {
  const job = plan({ createCount: 300, updateCount: 250, batchSize: 200 });
  assert.equal(job.ok, true);
  const kinds = job.batches.map((b) => b.kind);
  assert.deepEqual([...new Set(kinds)], [WRITE_KIND.CREATE, WRITE_KIND.UPDATE]);
  const create = job.batches.filter((b) => b.kind === WRITE_KIND.CREATE);
  const update = job.batches.filter((b) => b.kind === WRITE_KIND.UPDATE);
  assert.equal(create.reduce((n, b) => n + b.size, 0), 300);
  assert.equal(update.reduce((n, b) => n + b.size, 0), 250);
  // バッチキーは一意（再実行の突合に使う）
  assert.equal(new Set(job.batches.map((b) => b.batchKey)).size, job.batches.length);
});

test('バッチ件数は 100〜500 に収める', () => {
  assert.equal(plan({ batchSize: 1 }).batchSize, MIN_BATCH_SIZE);
  assert.equal(plan({ batchSize: 99999 }).batchSize, MAX_BATCH_SIZE);
  assert.equal(plan({}).batchSize, DEFAULT_BATCH_SIZE);
  assert.ok(DEFAULT_BATCH_SIZE >= MIN_BATCH_SIZE && DEFAULT_BATCH_SIZE <= MAX_BATCH_SIZE);
});

test('13,000 件規模でも計画の合計が下見の件数と一致する', () => {
  const job = plan({ createCount: 12800, updateCount: 100, batchSize: 500 });
  const total = job.batches.reduce((n, b) => n + b.size, 0);
  assert.equal(total, 12900);
  assert.equal(job.maxWrites, 12900, '計画より多く書ける上限になっている');
  assert.equal(job.state, IMPORT_JOB_STATE.PLANNED);
});

test('下見が無い / 書く行が無い計画は作らない', () => {
  assert.equal(planImportJob({ batchId: 'imp-1', createCount: 10 }).ok, false);
  assert.equal(plan({ createCount: 0, updateCount: 0 }).ok, false);
  assert.equal(plan({ createCount: 0, updateCount: 0 }).error, 'nothing_to_write');
});

// ── 実行順序 ──────────────────────────────────────────────────

test('同時に 2 つのバッチを走らせない', () => {
  const job = plan({ createCount: 400, updateCount: 0, batchSize: 100 });
  const first = nextImportBatch(job);
  assert.equal(first.ok, true);
  const running = { ...job, batches: job.batches.map((b, i) => (i === 0 ? { ...b, state: IMPORT_BATCH_STATE.RUNNING } : b)) };
  const second = nextImportBatch(running);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'batch_already_running');
});

test('送信済みバッチは二度と実行しない', () => {
  const job = plan({ createCount: 200, updateCount: 0, batchSize: 100 });
  const done = { ...job, batches: job.batches.map((b) => ({ ...b, state: IMPORT_BATCH_STATE.DONE })) };
  assert.equal(nextImportBatch(done).ok, false);
  assert.equal(nextImportBatch(done).reason, 'no_pending_batch');
});

test('一時停止すると次のバッチを出さない / 再開できる', () => {
  const job = { ...plan({ createCount: 300, updateCount: 0 }), state: IMPORT_JOB_STATE.RUNNING };
  const paused = pauseImportJob(job);
  assert.equal(paused.state, IMPORT_JOB_STATE.PAUSED);
  assert.equal(nextImportBatch(paused).reason, 'paused');
  assert.match(paused.pauseNote, /実行中のバッチが終わってから/);
  assert.equal(resumeImportJob(paused).state, IMPORT_JOB_STATE.RUNNING);
});

test('未実行だけ取り消せる。書き込み済みは取り消せない', () => {
  const job = plan({ createCount: 400, updateCount: 0, batchSize: 100 });
  const mid = {
    ...job,
    batches: job.batches.map((b, i) => (i === 0 ? { ...b, state: IMPORT_BATCH_STATE.DONE, written: 100 } : b)),
  };
  const cancelled = cancelPendingImportBatches(mid);
  assert.equal(cancelled.batches[0].state, IMPORT_BATCH_STATE.DONE, '書き込み済みを取り消している');
  assert.ok(cancelled.batches.slice(1).every((b) => b.state === IMPORT_BATCH_STATE.CANCELLED));
  assert.match(cancelled.cancelNote, /書き込み済みの行は取り消せません/);
});

// ── 冪等性 ────────────────────────────────────────────────────

test('同じ行は二度書かない（冪等キー）', () => {
  const key = computeRowKey({ batchId: 'imp-2026-08-04-001', email: 'a@example.com' });
  assert.ok(key && key.length === 32);
  const done = new Set([key]);
  assert.equal(canWriteRow({ rowKey: key, doneRowKeys: done }).ok, false);
  assert.equal(canWriteRow({ rowKey: key, doneRowKeys: done }).reason, 'already_written');
  assert.equal(canWriteRow({ rowKey: key, doneRowKeys: new Set() }).ok, true);
});

test('冪等キーからアドレスを復元できない / batch が違えば別のキー', () => {
  const a = computeRowKey({ batchId: 'imp-1', email: 'a@example.com' });
  const b = computeRowKey({ batchId: 'imp-2', email: 'a@example.com' });
  assert.notEqual(a, b, 'batchId を塩に使っていない');
  assert.equal(a.includes('example.com'), false);
});

test('計画した件数を超えて書けない', () => {
  const job = { ...plan({ createCount: 100, updateCount: 0 }), writesDone: 100, maxWrites: 100 };
  const r = canWriteRow({ rowKey: 'k'.repeat(32), doneRowKeys: new Set(), job });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'write_limit_reached');
});

test('キーの無い行は書かない', () => {
  assert.equal(canWriteRow({ rowKey: '', doneRowKeys: new Set() }).ok, false);
});

// ── 再試行・突合 ──────────────────────────────────────────────

test('失敗したバッチだけ再試行する（成功を巻き込まない）', () => {
  const job = plan({ createCount: 300, updateCount: 0, batchSize: 100 });
  const mixed = {
    ...job,
    batches: [
      { ...job.batches[0], state: IMPORT_BATCH_STATE.DONE, written: 100 },
      { ...job.batches[1], state: IMPORT_BATCH_STATE.FAILED, failed: 100, attempts: 1 },
      { ...job.batches[2], state: IMPORT_BATCH_STATE.PENDING },
    ],
  };
  const retry = planRetryFailed(mixed);
  assert.equal(retry.ok, true);
  assert.equal(retry.batches.length, 1);
  assert.equal(retry.batches[0].state, IMPORT_BATCH_STATE.PENDING);
  assert.equal(retry.batches[0].batchKey, job.batches[1].batchKey);
  assert.equal(planRetryFailed(job).ok, false, '失敗が無いのに再試行しようとしている');
});

test('書いた数が計画を超えていないか毎回検算する', () => {
  const job = plan({ createCount: 200, updateCount: 0, batchSize: 100 });
  const ok = { ...job, batches: job.batches.map((b) => ({ ...b, state: IMPORT_BATCH_STATE.DONE, written: 100 })) };
  const s = summarizeImportJob(ok);
  assert.equal(s.written, 200);
  assert.equal(s.withinPlan, true);
  assert.equal(s.reconciled, true);

  const over = { ...job, batches: job.batches.map((b) => ({ ...b, state: IMPORT_BATCH_STATE.DONE, written: 500 })) };
  assert.equal(summarizeImportJob(over).withinPlan, false, '計画超過を検知できていない');
});

// ── 監査・戻し方 ──────────────────────────────────────────────

test('取り込み由来のレコードだと分かる印を刻む', () => {
  const f = buildImportAuditFields({ batchId: 'imp-2026-08-04-001', nowIso: '2026-08-04T12:00:00.000Z' });
  assert.equal(f.CreatedBy, IMPORT_CREATED_BY);
  assert.equal(f.ImportBatchId, 'imp-2026-08-04-001');
  assert.equal(f.ImportedAt, '2026-08-04T12:00:00.000Z');
  assert.deepEqual(Object.keys(f).sort(), [...IMPORT_AUDIT_FIELDS].sort(), '監査以外の列を書こうとしている');
});

test('監査ログにアドレス・氏名を入れない', () => {
  const e = buildImportAuditEntry({
    batchKey: 'imp-2026-08-04-001-create-001', kind: WRITE_KIND.CREATE,
    rowKey: computeRowKey({ batchId: 'imp-2026-08-04-001', email: 'a@example.com' }),
    result: 'created', atMs: Date.UTC(2026, 7, 4),
  });
  const dumped = JSON.stringify(e);
  assert.equal(dumped.includes('@'), false, '監査ログにアドレスが入っている');
  assert.equal(dumped.includes('example.com'), false);
  assert.equal(e.result, 'created');
});

test('戻し方は「削除」ではなく「印を外す」', () => {
  const r = describeImportRollback('imp-2026-08-04-001');
  assert.match(r.steps.join(' '), /ImportBatchId=imp-2026-08-04-001/);
  assert.match(r.steps.join(' '), /削除ではなく印を外す/);
  assert.match(r.steps.join(' '), /自動統合しません/);
  assert.match(r.warning, /取り込んだ直後に自動送信しない/);
});
