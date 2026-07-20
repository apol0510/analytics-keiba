/**
 * paymentEmailDispatcher.test.mjs — pending ディスパッチャコアのテスト（実 IO なし・fake 注入）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchPendingBatch, DISPATCH_LOCK_KEY } from './paymentEmailDispatcher.js';

const T0 = Date.UTC(2026, 6, 21, 0, 0, 0);

/** fake deps を組み立てる。listPending の返却と runOne の挙動を差し込める。 */
function makeDeps({ pending = [], runOne, lockOk = true } = {}) {
  const calls = { lock: [], release: [], listPending: [], runOne: [] };
  const deps = {
    acquireLock: async (key) => { calls.lock.push(key); return { ok: lockOk, token: 'tok-1' }; },
    releaseLock: async (key, token) => { calls.release.push({ key, token }); },
    listPending: async (limit) => { calls.listPending.push(limit); return pending.slice(0, limit); },
    runOne: async (recordId, now) => {
      calls.runOne.push({ recordId, now });
      return runOne ? runOne(recordId) : { ok: true, status: 'accepted' };
    },
    log: () => {},
  };
  return { deps, calls };
}

test('dispatcher: pending を worker へ渡し accepted を集計する', async () => {
  const { deps, calls } = makeDeps({ pending: [{ id: 'r1' }, { id: 'r2' }] });
  const r = await dispatchPendingBatch({ now: T0, maxRecords: 10, deps });
  assert.equal(r.ok, true);
  assert.equal(r.listed, 2);
  assert.equal(r.processed, 2);
  assert.equal(r.byOutcome.accepted, 2);
  assert.equal(calls.runOne.length, 2);
  // dispatch ロックを取り、必ず解放する
  assert.deepEqual(calls.lock, [DISPATCH_LOCK_KEY]);
  assert.equal(calls.release.length, 1);
});

test('dispatcher: pending 0 件は正常終了（送信 0）', async () => {
  const { deps, calls } = makeDeps({ pending: [] });
  const r = await dispatchPendingBatch({ now: T0, maxRecords: 10, deps });
  assert.equal(r.ok, true);
  assert.equal(r.listed, 0);
  assert.equal(r.processed, 0);
  assert.equal(calls.runOne.length, 0);
  assert.equal(calls.release.length, 1, 'ロックは 0 件でも解放する');
});

test('dispatcher: dispatch ロックを取れなければ何もしない（重複起動防止）', async () => {
  const { deps, calls } = makeDeps({ pending: [{ id: 'r1' }], lockOk: false });
  const r = await dispatchPendingBatch({ now: T0, maxRecords: 10, deps });
  assert.equal(r.skipped, 'dispatch_locked');
  assert.equal(r.processed, 0);
  assert.equal(calls.listPending.length, 0, 'ロック未取得で列挙してはいけない');
  assert.equal(calls.runOne.length, 0);
  assert.equal(calls.release.length, 0, '取得していないロックを解放してはいけない');
});

test('dispatcher: maxRecords を listPending へ渡し件数を制限する', async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `r${i}` }));
  const { deps, calls } = makeDeps({ pending: many });
  const r = await dispatchPendingBatch({ now: T0, maxRecords: 5, deps });
  assert.equal(calls.listPending[0], 5, 'listPending に上限が渡っていない');
  assert.equal(r.listed, 5);
  assert.equal(r.processed, 5);
});

test('dispatcher: maxRecords 不正なら何もしない', async () => {
  const { deps, calls } = makeDeps({ pending: [{ id: 'r1' }] });
  for (const bad of [0, -1, undefined, 1.5]) {
    const r = await dispatchPendingBatch({ now: T0, maxRecords: bad, deps });
    assert.equal(r.skipped, 'invalid_max');
  }
  assert.equal(calls.lock.length, 0, '不正上限でロックを取ってはいけない');
});

test('dispatcher: 1 件失敗（例外）でも他件を継続し集計する', async () => {
  const { deps } = makeDeps({
    pending: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
    runOne: (id) => { if (id === 'r2') throw new Error('boom'); return { ok: true, status: 'accepted' }; },
  });
  const r = await dispatchPendingBatch({ now: T0, maxRecords: 10, deps });
  assert.equal(r.processed, 2, 'r1 と r3 は処理される');
  assert.equal(r.errors, 1);
  assert.equal(r.byOutcome.accepted, 2);
  assert.equal(r.byOutcome.exception, 1);
});

test('dispatcher: schema 不足 / 送信元不一致は worker が terminal/停止を返し、それを集計する（再送しない）', async () => {
  const { deps } = makeDeps({
    pending: [{ id: 'r1' }, { id: 'r2' }],
    runOne: (id) => id === 'r1'
      ? { ok: false, stage: 'schema', reason: 'schema_incomplete' }
      : { ok: false, status: 'failed_terminal' },
  });
  const r = await dispatchPendingBatch({ now: T0, maxRecords: 10, deps });
  assert.equal(r.byOutcome.schema_incomplete, 1);
  assert.equal(r.byOutcome.failed_terminal, 1);
  assert.equal(r.errors, 0, '正常な worker 応答は error ではない');
});

test('dispatcher: unknown_after_attempt を返した件も集計のみ（dispatcher は再送判断しない）', async () => {
  const { deps, calls } = makeDeps({
    pending: [{ id: 'r1' }],
    runOne: () => ({ ok: false, stage: 'state_write', reason: 'state_write_failed', status: 'unknown_after_attempt' }),
  });
  const r = await dispatchPendingBatch({ now: T0, maxRecords: 10, deps });
  // status を優先集計（unknown_after_attempt）。runOne は 1 回だけ（再送ループしない）
  assert.equal(r.byOutcome.unknown_after_attempt, 1);
  assert.equal(calls.runOne.length, 1);
});

test('dispatcher: id 欠落レコードは error として継続', async () => {
  const { deps } = makeDeps({ pending: [{ id: 'r1' }, {}, { id: 'r3' }] });
  const r = await dispatchPendingBatch({ now: T0, maxRecords: 10, deps });
  assert.equal(r.byOutcome.no_id, 1);
  assert.equal(r.processed, 2);
});

test('dispatcher: 戻り値に PII（recordId / email）を含めない', async () => {
  const { deps } = makeDeps({ pending: [{ id: 'recSECRET1', fields: { Email: 'a@b.com' } }] });
  const r = await dispatchPendingBatch({ now: T0, maxRecords: 10, deps });
  const serialized = JSON.stringify(r);
  assert.ok(!serialized.includes('recSECRET1'), '戻り値に recordId が含まれている');
  assert.ok(!serialized.includes('@'), '戻り値に email らしき値が含まれている');
});

test('dispatcher: deadline 到達後は新規レコードの処理を開始しない（残りは次回へ）', async () => {
  const { deps, calls } = makeDeps({ pending: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] });
  // 1 件処理するごとに時刻が進む fake clock。2 件目開始前に deadline 超過。
  let t = 1000;
  const clock = () => { const v = t; t += 100; return v; };
  const r = await dispatchPendingBatch({ now: T0, maxRecords: 10, deadlineAt: 1150, clock, deps });
  assert.equal(r.deadlineStopped, true);
  assert.ok(r.processed < 3, '時間切れなのに全件処理している');
  assert.ok(r.byOutcome.deadline_skipped >= 1, 'deadline_skipped が集計されていない');
  assert.ok(calls.runOne.length < 3, '時間切れ後に runOne を呼んでいる');
});

test('dispatcher: deadline 未指定なら時間制限なしで全件処理', async () => {
  const { deps } = makeDeps({ pending: [{ id: 'r1' }, { id: 'r2' }] });
  const r = await dispatchPendingBatch({ now: T0, maxRecords: 10, deps });
  assert.equal(r.deadlineStopped, false);
  assert.equal(r.processed, 2);
});
