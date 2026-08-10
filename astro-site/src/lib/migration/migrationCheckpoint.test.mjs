import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CHECKPOINT_VERSION, createCheckpoint, isResumable, advanceCheckpoint,
  finishCheckpoint, failCheckpoint, verifyCheckpointBalance,
} from './migrationCheckpoint.js';
import { readAllPages, assertExpectedCount, IncompleteReadError, SAFETY_MAX_PAGES } from './completeRead.js';

const T = '2026-08-09T00:00:00.000Z';

test('job 名は形を検査する（誤った名前で別の checkpoint を上書きしない）', () => {
  assert.doesNotThrow(() => createCheckpoint({ job: 'delivery-key-backfill', startedAt: T }));
  assert.throws(() => createCheckpoint({ job: 'A', startedAt: T }), /bad_job/);
  assert.throws(() => createCheckpoint({ job: '', startedAt: T }), /bad_job/);
});

test('【重要】checkpoint に Airtable の offset を持たない（期限切れで取りこぼす）', () => {
  const cp = createCheckpoint({ job: 'delivery-key-backfill', startedAt: T });
  assert.equal('offset' in cp, false);
  const src = readFileSync(new URL('./migrationCheckpoint.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.equal(/offset/.test(src), false, 'offset を保存する実装になっている');
});

test('別 job / 版違い / 完了済みは再開しない', () => {
  const cp = createCheckpoint({ job: 'delivery-key-backfill', startedAt: T });
  assert.deepEqual(isResumable(cp, { job: 'delivery-key-backfill' }), { ok: true, reason: null });
  assert.equal(isResumable(cp, { job: 'other-job' }).reason, 'job_mismatch');
  assert.equal(isResumable({ ...cp, version: 99 }, { job: cp.job }).reason, 'version_mismatch');
  assert.equal(isResumable(finishCheckpoint(cp, T), { job: cp.job }).reason, 'already_done');
  assert.equal(isResumable(null, { job: cp.job }).reason, 'missing');
  assert.equal(isResumable({ ...cp, recordsRead: -1 }, { job: cp.job }).reason, 'counter_invalid');
});

test('進捗は増える方向のみ（負の delta は例外）', () => {
  const cp = createCheckpoint({ job: 'x-job', startedAt: T });
  const a = advanceCheckpoint(cp, { recordsRead: 100, pagesRead: 1 }, T);
  assert.equal(a.recordsRead, 100);
  assert.throws(() => advanceCheckpoint(a, { recordsRead: -1 }, T), /negative_delta/);
});

test('同じ batchId を 2 回足しても batchesWritten が増えない（冪等の証跡）', () => {
  let cp = createCheckpoint({ job: 'x-job', startedAt: T });
  cp = advanceCheckpoint(cp, { batchesWritten: 1, batchId: 'k1' }, T);
  cp = advanceCheckpoint(cp, { batchesWritten: 1, batchId: 'k1' }, T);
  assert.equal(cp.batchesWritten, 1);
  assert.equal(cp.duplicateBatchSkipped, 1);
  assert.deepEqual(cp.writtenBatchIds, ['k1']);
});

test('読んだ件数と処理した件数が合わなければ balanced=false', () => {
  let cp = createCheckpoint({ job: 'x-job', startedAt: T });
  cp = advanceCheckpoint(cp, { recordsRead: 100, recordsWritten: 90, recordsSkipped: 10 }, T);
  assert.equal(verifyCheckpointBalance(cp).balanced, true);
  cp = advanceCheckpoint(cp, { recordsRead: 5 }, T);
  const b = verifyCheckpointBalance(cp);
  assert.equal(b.balanced, false);
  assert.equal(b.missing, 5);
});

test('失敗の記録に値を残さない（理由コードのみ・長さも切る）', () => {
  const cp = failCheckpoint(createCheckpoint({ job: 'x-job', startedAt: T }), 'x'.repeat(500), T);
  assert.ok(cp.lastError.length <= 120);
});

// ── completeRead ───────────────────────────────────────────────
test('全ページ読み切る', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => i);
  const r = await readAllPages({
    table: 't',
    fetchPage: async (off) => {
      const s = off ? Number(off) : 0;
      return { records: rows.slice(s, s + 100), offset: s + 100 < rows.length ? String(s + 100) : null };
    },
  });
  assert.deepEqual(r, { pages: 3, records: 250 });
});

test('【重要】ページ上限に達したら例外（黙って打ち切らない）', async () => {
  await assert.rejects(() => readAllPages({
    table: 't',
    fetchPage: async () => ({ records: [1], offset: 'always' }),
    maxPages: 5,
  }), IncompleteReadError);
});

test('壊れた応答を 0 件と扱わない', async () => {
  await assert.rejects(() => readAllPages({ table: 't', fetchPage: async () => null }), IncompleteReadError);
  await assert.rejects(() => readAllPages({ table: 't', fetchPage: async () => ({}) }), IncompleteReadError);
});

test('安全弁は 1000 ページ（読む量の制限ではない）', () => {
  assert.equal(SAFETY_MAX_PAGES, 1000);
});

test('期待件数と違えば例外。期待値が無ければ検査しない（推測で落とさない）', () => {
  assert.throws(() => assertExpectedCount({ table: 't', actual: 10, expected: 11 }), /count_mismatch/);
  assert.deepEqual(assertExpectedCount({ table: 't', actual: 10, expected: 10 }), { checked: true, ok: true });
  assert.deepEqual(assertExpectedCount({ table: 't', actual: 10, expected: null }), { checked: false, ok: true });
});
