/**
 * boundedBatchWrite.test.mjs — 上限つき並行書き込みの契約
 *   node --test src/lib/marketing/boundedBatchWrite.test.mjs
 *
 * ⚠️ ここで守るのは**速さではなく安全**:
 *    並行度の上限 / 429・5xx だけ再試行 / 4xx は再試行しない /
 *    締め切りを越えたら**新しい batch を始めない** /
 *    1 つでも失敗したら全体を失敗として返す（部分成功を成功と呼ばない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runBoundedBatches, isRetryable, DEFAULT_CONCURRENCY, DEFAULT_MAX_RETRIES,
} from './boundedBatchWrite.js';

const noSleep = async () => {};
const batches = (n) => Array.from({ length: n }, (_, i) => ({ i }));

// ══════════════════════════════════════════════════════════════════
//  ① 並行度の上限
// ══════════════════════════════════════════════════════════════════

test('【最重要】同時に走る数が並行度を超えない', async () => {
  let inflight = 0; let peak = 0;
  const r = await runBoundedBatches({
    batches: batches(20), concurrency: 3, sleep: noSleep,
    send: async () => {
      inflight += 1; peak = Math.max(peak, inflight);
      await Promise.resolve();
      inflight -= 1;
      return { ok: true };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.sent, 20);
  assert.ok(peak <= 3, `同時実行が ${peak} まで上がった（上限 3）`);
});

test('【重要】既定の並行度は Airtable 5 req/秒 に対して余裕がある', () => {
  assert.ok(DEFAULT_CONCURRENCY < 5, '既定の並行度が Airtable の上限に張り付いている');
});

test('【重要】並行度は 10 を超えない（暴走防止）', async () => {
  let peak = 0; let inflight = 0;
  await runBoundedBatches({
    batches: batches(30), concurrency: 999, sleep: noSleep,
    send: async () => { inflight += 1; peak = Math.max(peak, inflight); await Promise.resolve(); inflight -= 1; return { ok: true }; },
  });
  assert.ok(peak <= 10, `並行度が ${peak} まで上がった`);
});

// ══════════════════════════════════════════════════════════════════
//  ② 再試行（429 / 5xx だけ）
// ══════════════════════════════════════════════════════════════════

test('【最重要】429 は再試行して成功できる', async () => {
  let calls = 0;
  const r = await runBoundedBatches({
    batches: batches(1), concurrency: 1, sleep: noSleep,
    send: async () => { calls += 1; return calls === 1 ? { ok: false, status: 429 } : { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.retries, 1);
  assert.equal(calls, 2);
});

test('【重要】5xx も再試行する', async () => {
  let calls = 0;
  const r = await runBoundedBatches({
    batches: batches(1), concurrency: 1, sleep: noSleep,
    send: async () => { calls += 1; return calls < 3 ? { ok: false, status: 503 } : { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.equal(calls, 3);
});

test('【最重要】4xx は再試行しない（直らないものを待たない）', async () => {
  let calls = 0;
  const r = await runBoundedBatches({
    batches: batches(1), concurrency: 1, sleep: noSleep,
    send: async () => { calls += 1; return { ok: false, status: 422 }; },
  });
  assert.equal(r.ok, false);
  assert.equal(calls, 1, '4xx を再試行している');
  assert.equal(r.firstFailure.status, 422);
});

test('【重要】再試行の上限を超えたら失敗として返す', async () => {
  let calls = 0;
  const r = await runBoundedBatches({
    batches: batches(1), concurrency: 1, sleep: noSleep,
    send: async () => { calls += 1; return { ok: false, status: 429 }; },
  });
  assert.equal(r.ok, false);
  assert.equal(calls, DEFAULT_MAX_RETRIES + 1);
});

test('【重要】例外もネットワーク断として再試行できる', async () => {
  let calls = 0;
  const r = await runBoundedBatches({
    batches: batches(1), concurrency: 1, sleep: noSleep,
    send: async () => { calls += 1; if (calls === 1) throw new Error('boom'); return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
});

test('【重要】再試行してよい状態の判定', () => {
  for (const s of [429, 500, 502, 503, null, undefined]) assert.equal(isRetryable(s), true, String(s));
  for (const s of [400, 401, 403, 404, 422]) assert.equal(isRetryable(s), false, String(s));
});

// ══════════════════════════════════════════════════════════════════
//  ③ 締め切り — 予約だけ残る事故を増やさない
// ══════════════════════════════════════════════════════════════════

/**
 * ⚠️ 予約（`claimDelivered`）はキュー登録の**前**。途中で打ち切られると
 *    鍵だけが残り、その人へは二度と送られない。時間が無いなら**始めない**。
 */
test('【最重要】締め切りを越えたら新しい batch を始めない', async () => {
  let t = 0;
  const r = await runBoundedBatches({
    batches: batches(10), concurrency: 1, sleep: noSleep,
    nowMs: () => t, deadlineMs: 100,
    send: async () => { t += 40; return { ok: true }; },   // 3 本目で締め切り
  });
  assert.equal(r.ok, false);
  assert.equal(r.abort, 'deadline_reached');
  assert.ok(r.notStarted > 0, '残りを始めてしまっている');
  assert.equal(r.failed, 0, '始めなかったぶんを失敗に数えている');
});

test('【最重要】再試行で締め切りを越えるなら、待たずに失敗させる（延長しない）', async () => {
  let t = 0;
  const r = await runBoundedBatches({
    batches: batches(1), concurrency: 1, sleep: noSleep,
    nowMs: () => t, deadlineMs: 100, retryBaseMs: 1000,
    send: async () => { t += 10; return { ok: false, status: 429 }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.retries, 0, '締め切りを越える待ちに入っている');
});

test('【重要】締め切りが無ければ最後まで流す', async () => {
  const r = await runBoundedBatches({
    batches: batches(7), concurrency: 2, sleep: noSleep, deadlineMs: null,
    send: async () => ({ ok: true }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.sent, 7);
  assert.equal(r.notStarted, 0);
});

// ══════════════════════════════════════════════════════════════════
//  ④ 部分失敗 — 成功と呼ばない
// ══════════════════════════════════════════════════════════════════

test('【最重要】1 つでも失敗したら全体を失敗として返す', async () => {
  const r = await runBoundedBatches({
    batches: batches(10), concurrency: 2, sleep: noSleep,
    send: async (b) => (b.i === 4 ? { ok: false, status: 422 } : { ok: true }),
  });
  assert.equal(r.ok, false, '部分成功を成功と呼んでいる');
  assert.equal(r.failed, 1);
  assert.equal(r.firstFailure.index, 4);
});

test('【最重要】失敗したら新しい batch を始めない（傷口を広げない）', async () => {
  let started = 0;
  const r = await runBoundedBatches({
    batches: batches(20), concurrency: 1, sleep: noSleep,
    send: async (b) => { started += 1; return b.i === 2 ? { ok: false, status: 400 } : { ok: true }; },
  });
  assert.equal(r.ok, false);
  assert.equal(started, 3, `失敗後も送り続けている（${started} 本）`);
  assert.ok(r.notStarted > 0);
});

test('【重要】成功数・失敗数・未開始数の合計が全体と一致する', async () => {
  const r = await runBoundedBatches({
    batches: batches(12), concurrency: 3, sleep: noSleep,
    send: async (b) => (b.i === 7 ? { ok: false, status: 400 } : { ok: true }),
  });
  assert.equal(r.sent + r.failed + r.notStarted, 12, '数が合わない（取りこぼしが見えない）');
});

// ══════════════════════════════════════════════════════════════════
//  ⑤ 縁のケース
// ══════════════════════════════════════════════════════════════════

test('【重要】空なら成功で何もしない', async () => {
  const r = await runBoundedBatches({ batches: [], send: async () => ({ ok: true }) });
  assert.equal(r.ok, true);
  assert.equal(r.attempted, 0);
});

test('【最重要】送信関数が無ければ 1 件も送らずに失敗する', async () => {
  const r = await runBoundedBatches({ batches: batches(5) });
  assert.equal(r.ok, false);
  assert.equal(r.abort, 'no_sender');
  assert.equal(r.attempted, 0);
  assert.equal(r.notStarted, 5);
});

test('【重要】Retry-After が指定されていればそれを使う', async () => {
  const slept = [];
  let calls = 0;
  await runBoundedBatches({
    batches: batches(1), concurrency: 1,
    sleep: async (ms) => { slept.push(ms); },
    send: async () => { calls += 1; return calls === 1 ? { ok: false, status: 429, retryAfterMs: 1234 } : { ok: true }; },
  });
  assert.deepEqual(slept, [1234], 'Retry-After を無視している');
});
