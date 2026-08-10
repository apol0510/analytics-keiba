import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECON_STATUS, reconcileDeliveryKeys, reconcileEventCounts, summarizeSwitchReadiness,
} from './deliveryStoreReconcile.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

test('完全一致なら切替可', () => {
  const r = reconcileDeliveryKeys({ airtableKeys: [A, B], redisKeys: [A, B] });
  assert.equal(r.status, RECON_STATUS.MATCH);
  assert.equal(r.safeToSwitch, true);
  assert.equal(r.missingInRedis, 0);
});

test('【切替不可】Redis に足りない鍵が 1 つでもあれば止める（その相手へ再送してしまう）', () => {
  const r = reconcileDeliveryKeys({ airtableKeys: [A, B], redisKeys: [A] });
  assert.equal(r.status, RECON_STATUS.REDIS_MISSING);
  assert.equal(r.missingInRedis, 1);
  assert.equal(r.safeToSwitch, false);
});

test('Redis に余分がある分は切替を止めない（送らない方向にしか倒れない）', () => {
  const r = reconcileDeliveryKeys({ airtableKeys: [A], redisKeys: [A, B] });
  assert.equal(r.status, RECON_STATUS.REDIS_EXTRA);
  assert.equal(r.extraInRedis, 1);
  assert.equal(r.safeToSwitch, true);
});

test('両方向に差があれば both_differ で切替不可', () => {
  const r = reconcileDeliveryKeys({ airtableKeys: [A, B], redisKeys: [A, C] });
  assert.equal(r.status, RECON_STATUS.BOTH_DIFFER);
  assert.equal(r.safeToSwitch, false);
});

test('【重要】片側を読めなかったら「一致」と扱わない', () => {
  for (const input of [
    { airtableKeys: null, redisKeys: [A] },
    { airtableKeys: [A], redisKeys: null },
    {},
  ]) {
    const r = reconcileDeliveryKeys(input);
    assert.equal(r.status, RECON_STATUS.UNAVAILABLE);
    assert.equal(r.safeToSwitch, false);
  }
});

test('件数が同じでも中身が違えば不一致（件数比較で済ませない）', () => {
  const r = reconcileDeliveryKeys({ airtableKeys: [A, B], redisKeys: [A, C] });
  assert.equal(r.airtable, r.redis, '前提: 件数は同じ');
  assert.equal(r.safeToSwitch, false);
});

// ── イベント ───────────────────────────────────────────────────
test('種別ごとの件数が一致すれば切替可', () => {
  const r = reconcileEventCounts({
    airtableCounts: { delivered: 10, open: 3 },
    blobCounts: { delivered: 10, open: 3 },
  });
  assert.equal(r.status, RECON_STATUS.MATCH);
  assert.equal(r.safeToSwitch, true);
});

test('【切替不可】Blob 側が少ないと監査記録が欠ける', () => {
  const r = reconcileEventCounts({
    airtableCounts: { delivered: 10 },
    blobCounts: { delivered: 8 },
  });
  assert.equal(r.blobShort, 2);
  assert.equal(r.safeToSwitch, false);
  assert.equal(r.byType.delivered.diff, -2);
});

test('Blob 側が多い分は切替を止めない', () => {
  const r = reconcileEventCounts({
    airtableCounts: { delivered: 10 },
    blobCounts: { delivered: 11 },
  });
  assert.equal(r.blobShort, 0);
  assert.equal(r.safeToSwitch, true);
});

test('片側が無ければ unavailable', () => {
  assert.equal(reconcileEventCounts({ airtableCounts: null, blobCounts: {} }).safeToSwitch, false);
  assert.equal(reconcileEventCounts({}).status, RECON_STATUS.UNAVAILABLE);
});

// ── 総合 ───────────────────────────────────────────────────────
test('両方安全なときだけ ready', () => {
  const ok = { safeToSwitch: true, status: 'match' };
  const ng = { safeToSwitch: false, status: 'redis_missing' };
  assert.deepEqual(summarizeSwitchReadiness({ deliveryRecon: ok, eventRecon: ok }),
    { ready: true, blockers: [] });
  assert.equal(summarizeSwitchReadiness({ deliveryRecon: ng, eventRecon: ok }).ready, false);
  assert.equal(summarizeSwitchReadiness({ deliveryRecon: ok, eventRecon: ng }).ready, false);
});

test('突合そのものが無ければ ready にしない', () => {
  const r = summarizeSwitchReadiness({});
  assert.equal(r.ready, false);
  assert.deepEqual(r.blockers, ['delivery:unavailable', 'events:unavailable']);
});
