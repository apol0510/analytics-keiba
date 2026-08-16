/**
 * touchMeasurementWiring.test.mjs — 実イベントが sequencePolicy まで**実際に渡る**
 *   node --test src/lib/marketing/touchMeasurementWiring.test.mjs
 *
 * webhook 受信 → Redis 索引 → 台帳との結合 → sequencePolicy の判断まで、
 * **本物のモジュールを繋いで**通す（偽物は Redis のコマンドだけ）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDeliveryEventIndex } from '../webhooks/deliveryEventIndex.js';
import { buildHistoryByRecipient, summarizeByTouch } from './touchMeasurement.js';
import {
  countConsecutiveNoEngagement, summarizeEngagementHistory, resolveIntervalDays,
} from './sequencePolicy.js';

const CAMPAIGN = 'light-trial-to-premium-sequence';
const K1 = '1'.padStart(64, 'a');
const K2 = '2'.padStart(64, 'b');
const NOW = Date.parse('2026-08-16T01:10:00Z');
const DAY = 86400_000;
const EMAIL = 'member@example.com';

/** 偽 Redis（索引の Lua の意味だけ再現） */
function fakeRedis(store = new Map()) {
  const hash = (k) => { if (!store.has(k)) store.set(k, new Map()); return store.get(k); };
  return async (args) => {
    const op = String(args[0]).toUpperCase();
    if (op === 'HMGET') {
      const h = store.get(args[1]);
      return args.slice(2).map((f) => (h && h.has(f) ? h.get(f) : null));
    }
    if (op === 'EVAL') {
      const h = hash(args[3]);
      const [schema, d, o, ol] = args.slice(4, 8).map(String);
      h.set('v', schema);
      const setMin = (f, v) => { const n = Number(v); if (!n) return; const c = Number(h.get(f)); if (!Number.isFinite(c) || n < c) h.set(f, String(n)); };
      const setMax = (f, v) => { const n = Number(v); if (!n) return; const c = Number(h.get(f)); if (!Number.isFinite(c) || n > c) h.set(f, String(n)); };
      setMin('d', d); setMin('o', o); setMax('ol', ol);
      for (const id of args.slice(8)) {
        if (!id) continue;
        const f = `seen:${id}`;
        if (!h.has(f)) { h.set(f, '1'); h.set('oc', String((Number(h.get('oc')) || 0) + 1)); }
      }
      return 'OK';
    }
    return null;
  };
}

const delivery = (key, sentAtMs) => ({
  fields: {
    DeliveryKey: key, CampaignType: `${CAMPAIGN}:v1`, Status: 'sent',
    SentAt: new Date(sentAtMs).toISOString(), RecipientEmail: EMAIL,
  },
});

/** webhook が受けた形（resolved 済み） */
const event = (type, key, atMs, id) => ({ type, atMs, deliveryKey: key, providerEventId: id });

async function pipeline({ events, deliveries, stepPairs }) {
  const store = new Map();
  const idx = createDeliveryEventIndex({ cmd: fakeRedis(store) });
  await idx.fold({ events, nowMs: NOW });
  const keys = deliveries.map((d) => d.fields.DeliveryKey);
  const index = await idx.read(keys);
  const stepByDeliveryKey = new Map(stepPairs);
  return {
    history: buildHistoryByRecipient({ deliveries, stepByDeliveryKey, index }),
    summary: summarizeByTouch({ deliveries, stepByDeliveryKey, index }),
    idx, store,
  };
}

test('【重要】touch1 delivered + open → 反応ありとして sequencePolicy に届く', async () => {
  const { history, summary } = await pipeline({
    events: [event('delivered', K1, NOW, 'd1'), event('open', K1, NOW + 60000, 'o1')],
    deliveries: [delivery(K1, NOW)],
    stepPairs: [[K1, 1]],
  });
  const rows = history.get(EMAIL);
  assert.equal(rows[0].measured, true);
  assert.equal(rows[0].opened, true);
  assert.equal(countConsecutiveNoEngagement(rows), 0);
  assert.equal(summary.touches[0].opened, 1);
  assert.equal(summary.touches[0].openRate, 1);
});

test('【重要】touch1 delivered + 未開封 → 無反応 1', async () => {
  const { history, summary } = await pipeline({
    events: [event('delivered', K1, NOW, 'd1')],
    deliveries: [delivery(K1, NOW)],
    stepPairs: [[K1, 1]],
  });
  const rows = history.get(EMAIL);
  assert.equal(countConsecutiveNoEngagement(rows), 1);
  assert.equal(summary.touches[0].delivered, 1);
  assert.equal(summary.touches[0].opened, 0);
  assert.equal(summary.touches[0].openRate, 0);
});

test('【重要】delivered が届いていない → 未計測（無反応 0・減速しない）', async () => {
  const { history, summary } = await pipeline({
    events: [],                                  // まだ何も届いていない
    deliveries: [delivery(K1, NOW)],
    stepPairs: [[K1, 1]],
  });
  const rows = history.get(EMAIL);
  assert.equal(rows[0].measured, false);
  assert.equal(countConsecutiveNoEngagement(rows), 0);
  assert.equal(summarizeEngagementHistory(rows).unknown, true);
  assert.equal(summary.touches[0].unknown, 1);
  assert.equal(summary.touches[0].openRate, null);
  const days = resolveIntervalDays({
    policy: { minIntervalDays: 3, slowdownAfterNoEngagement: 3, slowdownFactor: 2 },
    state: { consecutiveNoEngagement: countConsecutiveNoEngagement(rows) }, stepDelayDays: 5,
  });
  assert.equal(days, 5);
});

test('【重要】touch1 を後から開いても touch2 を開封済みにしない', async () => {
  const { history } = await pipeline({
    events: [
      event('delivered', K1, NOW, 'd1'),
      event('delivered', K2, NOW + 3 * DAY, 'd2'),
      event('open', K1, NOW + 10 * DAY, 'o1'),     // touch1 を後日開封
    ],
    deliveries: [delivery(K1, NOW), delivery(K2, NOW + 3 * DAY)],
    stepPairs: [[K1, 1], [K2, 2]],
  });
  const rows = history.get(EMAIL);
  assert.equal(rows[0].opened, true);
  assert.equal(rows[1].opened, false, 'touch1 の開封が touch2 へ混ざっている');
  assert.equal(countConsecutiveNoEngagement(rows), 1, 'touch2 だけが無反応のはず');
});

test('【重要】touch1 open / touch2 未開封 → touch2 のみ無反応', async () => {
  const { history, summary } = await pipeline({
    events: [
      event('delivered', K1, NOW, 'd1'), event('open', K1, NOW + 60000, 'o1'),
      event('delivered', K2, NOW + 3 * DAY, 'd2'),
    ],
    deliveries: [delivery(K1, NOW), delivery(K2, NOW + 3 * DAY)],
    stepPairs: [[K1, 1], [K2, 2]],
  });
  assert.equal(countConsecutiveNoEngagement(history.get(EMAIL)), 1);
  assert.equal(summary.touches.find((t) => t.touch === 1).opened, 1);
  assert.equal(summary.touches.find((t) => t.touch === 2).opened, 0);
});

test('【重要】Redis が読めない → 未計測（減速も停止もしない）', async () => {
  const idx = createDeliveryEventIndex({ cmd: async () => { throw new Error('down'); } });
  const index = await idx.read([K1]);
  const history = buildHistoryByRecipient({
    deliveries: [delivery(K1, NOW)], stepByDeliveryKey: new Map([[K1, 1]]), index,
  });
  const rows = history.get(EMAIL);
  assert.equal(rows[0].measured, false);
  assert.equal(countConsecutiveNoEngagement(rows), 0);
  const s = summarizeByTouch({
    deliveries: [delivery(K1, NOW)], stepByDeliveryKey: new Map([[K1, 1]]), index,
  });
  assert.equal(s.measurementAvailable, false);
});

test('【重要】同じ webhook が二度届いても二重に数えない', async () => {
  const store = new Map();
  const idx = createDeliveryEventIndex({ cmd: fakeRedis(store) });
  const batch = [event('delivered', K1, NOW, 'd1'), event('open', K1, NOW + 60000, 'o1')];
  await idx.fold({ events: batch, nowMs: NOW });
  await idx.fold({ events: batch, nowMs: NOW });
  const index = await idx.read([K1]);
  assert.equal(index.byKey.get(K1).openCount, 1);
  const s = summarizeByTouch({
    deliveries: [delivery(K1, NOW)], stepByDeliveryKey: new Map([[K1, 1]]), index,
  });
  assert.equal(s.touches[0].opened, 1, '二重に数えている');
  assert.equal(s.touches[0].delivered, 1);
});

test('【重要】別 DeliveryKey の open を混同しない', async () => {
  const { history } = await pipeline({
    events: [event('delivered', K1, NOW, 'd1'), event('open', K2, NOW + 60000, 'o1')],
    deliveries: [delivery(K1, NOW)],
    stepPairs: [[K1, 1]],
  });
  const rows = history.get(EMAIL);
  assert.equal(rows[0].opened, false, '別の通の開封を持ち込んでいる');
  assert.equal(countConsecutiveNoEngagement(rows), 1);
});

test('click は索引にも集計にも作らない（provider 側 OFF）', async () => {
  const { summary, store } = await pipeline({
    events: [event('delivered', K1, NOW, 'd1'), event('click', K1, NOW + 60000, 'c1')],
    deliveries: [delivery(K1, NOW)],
    stepPairs: [[K1, 1]],
  });
  assert.equal(summary.clickMeasured, false);
  const dump = JSON.stringify([...store].map(([k, v]) => [k, [...v]]));
  assert.equal(dump.includes('click'), false);
});
