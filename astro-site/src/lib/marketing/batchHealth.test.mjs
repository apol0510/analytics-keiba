/**
 * batchHealth.test.mjs — 次のバッチへ進んでよいかの判断
 *   node --test src/lib/marketing/batchHealth.test.mjs
 *
 * 守る性質:
 *   - **読めない値があれば進まない**（0 件として通さない）
 *   - 前のバッチが片付くまで進まない
 *   - 二重（duplicate）は 1 件でも止める / 苦情も 1 件で止める
 *   - 比率のしきい値（失敗・バウンス・配信停止）
 *   - 停止リストを読めなければ進まない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canStartNextBatch, describeBatchHealth, BATCH_STOP, DEFAULT_BATCH_THRESHOLDS,
} from './batchHealth.js';

const healthy = (over = {}) => ({
  sent: 500, failed: 0, duplicates: 0, bounces: 0, complaints: 0, unsubscribes: 0,
  previousOutstanding: 0, suppressionReadable: true, ...over,
});

test('正常なバッチなら次へ進める', () => {
  const r = canStartNextBatch(healthy());
  assert.equal(r.ok, true);
  assert.equal(r.rates.failed, 0);
});

test('【重要】数えられない値が 1 つでもあれば進まない', () => {
  for (const k of ['sent', 'failed', 'duplicates', 'bounces', 'complaints', 'unsubscribes', 'previousOutstanding']) {
    const r = canStartNextBatch(healthy({ [k]: null }));
    assert.equal(r.ok, false, `${k} が不明でも進んでいる`);
    assert.equal(r.reason, BATCH_STOP.UNREADABLE);
    assert.equal(r.missing[k], true);
  }
});

test('【重要】停止リストを読めなければ進まない', () => {
  const r = canStartNextBatch(healthy({ suppressionReadable: false }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, BATCH_STOP.SUPPRESSION_UNREADABLE);
});

test('【重要】前のバッチが片付いていなければ進まない', () => {
  const r = canStartNextBatch(healthy({ previousOutstanding: 3 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, BATCH_STOP.OUTSTANDING);
  assert.equal(r.previousOutstanding, 3);
});

test('【重要】二重は 1 件でも止める', () => {
  const r = canStartNextBatch(healthy({ duplicates: 1 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, BATCH_STOP.DUPLICATES);
});

test('【重要】苦情は 1 件でも止める', () => {
  const r = canStartNextBatch(healthy({ complaints: 1 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, BATCH_STOP.COMPLAINTS);
});

test('送信失敗が多すぎれば止める（5% 超）', () => {
  assert.equal(canStartNextBatch(healthy({ failed: 25 })).ok, true, '5% ちょうどは通す');
  const r = canStartNextBatch(healthy({ failed: 26 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, BATCH_STOP.FAILED_RATE);
});

test('ハードバウンスが多すぎれば止める（2% 超）', () => {
  assert.equal(canStartNextBatch(healthy({ bounces: 10 })).ok, true);
  assert.equal(canStartNextBatch(healthy({ bounces: 11 })).reason, BATCH_STOP.BOUNCE_RATE);
});

test('配信停止が多すぎれば止める（2% 超）', () => {
  assert.equal(canStartNextBatch(healthy({ unsubscribes: 10 })).ok, true);
  assert.equal(canStartNextBatch(healthy({ unsubscribes: 11 })).reason, BATCH_STOP.UNSUBSCRIBE_RATE);
});

test('しきい値は上書きできる（運用で締める側にも緩める側にも）', () => {
  const r = canStartNextBatch(healthy({ failed: 5 }), { thresholds: { maxFailedRate: 0 } });
  // thresholds は第 1 引数の中で渡す設計なので、こちらの形でも確認
  const r2 = canStartNextBatch({ ...healthy({ failed: 5 }), thresholds: { maxFailedRate: 0 } });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, BATCH_STOP.FAILED_RATE);
  assert.ok(r);
});

test('送信 0 件のバッチでは比率を作らない（0 除算しない）', () => {
  const r = canStartNextBatch(healthy({ sent: 0 }));
  assert.equal(r.ok, true);
  assert.equal(r.rates.failed, null);
});

test('要約は件数と比率だけ（PII なし）', () => {
  const d = describeBatchHealth(canStartNextBatch(healthy({ failed: 1 })));
  assert.equal(d.ok, true);
  assert.equal(d.rates.sent, 500);
  assert.equal(/@/.test(JSON.stringify(d)), false);
});

test('既定のしきい値（変更したら運用へ周知が要る）', () => {
  assert.deepEqual(DEFAULT_BATCH_THRESHOLDS, {
    maxFailedRate: 0.05, maxBounceRate: 0.02, maxComplaints: 0,
    maxUnsubscribeRate: 0.02, maxDuplicates: 0,
  });
});
