/**
 * deliveryEventBackfill.test.mjs — 生ログから対象鍵だけを拾う計画
 *   node --test src/lib/webhooks/deliveryEventBackfill.test.mjs
 *
 * 守る性質:
 *   - **対象の鍵だけ**を拾う（ついでに他を入れない）
 *   - resolved でないイベントは索引へ入れない
 *   - 同じ鍵に別 campaign / version が混ざっていたら**書かない**（conflict）
 *   - 件数だけを返す（鍵・アドレスを出さない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planBackfill, describeBackfillPlan, parseNdjson, blobDatePrefix, MAX_BLOBS_PER_RUN,
} from './deliveryEventBackfill.js';

const K1 = '1'.padStart(64, 'a');
const K2 = '2'.padStart(64, 'b');
const K3 = '3'.padStart(64, 'c');
const NOW = Date.parse('2026-08-16T01:10:00Z');

const rec = (over = {}) => ({
  deliveryKey: K1, eventType: 'delivered', eventAtMs: NOW,
  campaignId: 'light-trial-to-premium-sequence', campaignVersion: '1',
  resolutionStatus: 'resolved', providerEventId: 'e1', ...over,
});

test('【重要】対象の鍵だけを拾う', () => {
  const { plan, stats } = planBackfill({
    records: [rec(), rec({ deliveryKey: K2 }), rec({ deliveryKey: K3 })],
    targetKeys: [K1],
  });
  assert.equal(plan.size, 1);
  assert.equal(plan.has(K1), true);
  assert.equal(stats.notTargeted, 2);
});

test('【重要】resolved でないイベントは入れない', () => {
  const { plan, stats } = planBackfill({
    records: [rec({ resolutionStatus: 'unresolved' })], targetKeys: [K1],
  });
  assert.equal(plan.size, 0);
  assert.equal(stats.unresolved, 1);
});

test('【重要】delivered と open だけを拾う', () => {
  const { plan, stats } = planBackfill({
    records: [rec({ eventType: 'click' }), rec({ eventType: 'bounce' }), rec({ eventType: 'open', providerEventId: 'o1' })],
    targetKeys: [K1],
  });
  assert.equal(stats.otherType, 2);
  assert.equal(plan.get(K1).firstOpenAtMs, NOW);
  assert.equal(plan.get(K1).deliveredAtMs, null);
});

test('【重要】同じ鍵に別 campaign が混ざっていたら書かない', () => {
  const { plan, stats } = planBackfill({
    records: [rec(), rec({ campaignId: 'other-campaign', eventType: 'open', providerEventId: 'o2' })],
    targetKeys: [K1],
  });
  assert.equal(stats.conflicts, 1);
  assert.equal(plan.has(K1), false, 'conflict なのに書こうとしている');
});

test('版違いも conflict として扱う', () => {
  const { stats } = planBackfill({
    records: [rec(), rec({ campaignVersion: '2', eventType: 'open', providerEventId: 'o3' })],
    targetKeys: [K1],
  });
  assert.equal(stats.conflicts, 1);
});

test('delivered は最も早い時刻・open は最初と最後', () => {
  const { plan } = planBackfill({
    records: [
      rec({ eventAtMs: NOW + 5000 }), rec({ eventAtMs: NOW }),
      rec({ eventType: 'open', eventAtMs: NOW + 9000, providerEventId: 'o1' }),
      rec({ eventType: 'open', eventAtMs: NOW + 1000, providerEventId: 'o2' }),
    ],
    targetKeys: [K1],
  });
  const p = plan.get(K1);
  assert.equal(p.deliveredAtMs, NOW);
  assert.equal(p.firstOpenAtMs, NOW + 1000);
  assert.equal(p.lastOpenAtMs, NOW + 9000);
  assert.deepEqual(p.openEventIds.sort(), ['o1', 'o2']);
});

test('壊れた鍵は捨てる', () => {
  const { stats } = planBackfill({ records: [rec({ deliveryKey: 'short' })], targetKeys: ['short'] });
  assert.equal(stats.badKey, 1);
});

test('【重要】要約は件数だけ（鍵・アドレスを出さない）', () => {
  const { plan, stats } = planBackfill({
    records: [rec(), rec({ eventType: 'open', providerEventId: 'o1' }), rec({ deliveryKey: K2 })],
    targetKeys: [K1, K2, K3],
  });
  const d = describeBackfillPlan({ plan, stats, targetKeys: [K1, K2, K3], blobsScanned: 3 });
  assert.equal(d.targetKeys, 3);
  assert.equal(d.willWriteKeys, 2);
  assert.equal(d.willWriteDelivered, 2);
  assert.equal(d.willWriteOpen, 1);
  assert.equal(d.missingKeys, 1);
  assert.equal(d.blobsScanned, 3);
  const dump = JSON.stringify(d);
  assert.equal(dump.includes(K1), false, '鍵を出している');
  assert.equal(/@/.test(dump), false);
});

test('NDJSON を読む（壊れた行は捨てる）', () => {
  const rows = parseNdjson('{"a":1}\nbroken\n{"b":2}\n\n');
  assert.deepEqual(rows, [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseNdjson(null), []);
});

test('日付プレフィックスで走査範囲を絞れる', () => {
  assert.equal(blobDatePrefix('2026-08-16'), 'ak/email-events/2026/08/16');
  assert.equal(blobDatePrefix('2026-08-16T01:10:00Z'), 'ak/email-events/2026/08/16');
  assert.equal(blobDatePrefix('bad'), null);
  assert.ok(MAX_BLOBS_PER_RUN <= 500, '走査上限が大きすぎる');
});
