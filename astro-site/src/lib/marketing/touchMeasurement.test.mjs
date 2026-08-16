/**
 * touchMeasurement.test.mjs — 配信台帳 × イベント索引を touch へ結ぶ
 *   node --test src/lib/marketing/touchMeasurement.test.mjs
 *
 * 守る性質（要件そのまま）:
 *   - delivered + open → engaged / delivered + 未開封 → noEngagement=1
 *   - delivered を確認できない → unknown（noEngagement=0）
 *   - **touch1 を後から開いても touch2 を opened 扱いしない**（DeliveryKey 完全一致）
 *   - 索引が読めない → 全部未計測（減速も停止もしない）
 *   - 別 DeliveryKey の open を混同しない
 *   - 率の分母を明示する
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildHistoryByRecipient, summarizeByTouch, campaignIdFromType } from './touchMeasurement.js';
import {
  countConsecutiveNoEngagement, summarizeEngagementHistory, resolveIntervalDays, resolveStop,
} from './sequencePolicy.js';

const ACTIVE = 'light-trial-to-premium-sequence';
const K = (n) => String(n).padStart(64, 'a').slice(0, 64).replace(/[^a-f0-9]/g, 'a');
const K1 = '1'.padStart(64, 'a');
const K2 = '2'.padStart(64, 'b');
const NOW = Date.parse('2026-08-16T02:00:00Z');
const DAY = 86400_000;

const delivery = ({ key, step, sentAtMs = NOW, status = 'sent', email = 'x@example.com' }) => ({
  fields: {
    DeliveryKey: key,
    CampaignType: `${ACTIVE}:v1`,
    Status: status,
    SentAt: new Date(sentAtMs).toISOString(),
    RecipientEmail: email,
  },
});

const idx = (entries, ok = true) => ({ ok, byKey: new Map(entries) });
const steps = (pairs) => new Map(pairs);

// ── 履歴（sequencePolicy へ渡す形）────────────────────────────

test('【重要】delivered + open → 反応あり（無反応 0）', () => {
  const h = buildHistoryByRecipient({
    deliveries: [delivery({ key: K1, step: 1 })],
    stepByDeliveryKey: steps([[K1, 1]]),
    index: idx([[K1, { deliveredAtMs: NOW, firstOpenAtMs: NOW + 1000 }]]),
  });
  const rows = h.get('x@example.com');
  assert.equal(rows[0].measured, true);
  assert.equal(rows[0].opened, true);
  assert.equal(countConsecutiveNoEngagement(rows), 0);
});

test('【重要】delivered + 未開封 → 無反応 1', () => {
  const h = buildHistoryByRecipient({
    deliveries: [delivery({ key: K1, step: 1 })],
    stepByDeliveryKey: steps([[K1, 1]]),
    index: idx([[K1, { deliveredAtMs: NOW, firstOpenAtMs: null }]]),
  });
  const rows = h.get('x@example.com');
  assert.equal(rows[0].measured, true);
  assert.equal(rows[0].opened, false);
  assert.equal(countConsecutiveNoEngagement(rows), 1);
});

test('【重要】delivered を確認できない → 未計測（無反応 0）', () => {
  const h = buildHistoryByRecipient({
    deliveries: [delivery({ key: K1, step: 1 })],
    stepByDeliveryKey: steps([[K1, 1]]),
    index: idx([]),           // 索引にこの鍵が無い
  });
  const rows = h.get('x@example.com');
  assert.equal(rows[0].measured, false);
  assert.equal('opened' in rows[0], false);
  assert.equal(countConsecutiveNoEngagement(rows), 0);
  assert.equal(summarizeEngagementHistory(rows).unknown, true);
});

test('【重要】touch1 を後から開いても touch2 を開封済みにしない', () => {
  // touch1 は後日開かれた。touch2 は届いたが未開封
  const h = buildHistoryByRecipient({
    deliveries: [
      delivery({ key: K1, step: 1, sentAtMs: NOW }),
      delivery({ key: K2, step: 2, sentAtMs: NOW + 3 * DAY }),
    ],
    stepByDeliveryKey: steps([[K1, 1], [K2, 2]]),
    index: idx([
      [K1, { deliveredAtMs: NOW, firstOpenAtMs: NOW + 10 * DAY }],  // ずっと後で開封
      [K2, { deliveredAtMs: NOW + 3 * DAY, firstOpenAtMs: null }],
    ]),
  });
  const rows = h.get('x@example.com');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].opened, true, 'touch1 の開封が落ちている');
  assert.equal(rows[1].opened, false, 'touch1 の開封を touch2 へ持ち込んでいる');
  // 直近（touch2）だけが無反応
  assert.equal(countConsecutiveNoEngagement(rows), 1);
});

test('【重要】別の DeliveryKey の open を混同しない', () => {
  const h = buildHistoryByRecipient({
    deliveries: [delivery({ key: K1, step: 1 })],
    stepByDeliveryKey: steps([[K1, 1]]),
    // K2（別の通）だけ開封されている
    index: idx([[K2, { deliveredAtMs: NOW, firstOpenAtMs: NOW + 1000 }]]),
  });
  const rows = h.get('x@example.com');
  assert.equal(rows[0].measured, false, '別の通の記録を持ち込んでいる');
});

test('【重要】索引が読めない → 全部未計測（減速も停止もしない）', () => {
  const h = buildHistoryByRecipient({
    deliveries: [
      delivery({ key: K1, step: 1 }),
      delivery({ key: K2, step: 2, sentAtMs: NOW + 3 * DAY }),
    ],
    stepByDeliveryKey: steps([[K1, 1], [K2, 2]]),
    index: { ok: false, byKey: new Map() },
  });
  const rows = h.get('x@example.com');
  assert.equal(rows.every((r) => r.measured === false), true);
  const noEng = countConsecutiveNoEngagement(rows);
  assert.equal(noEng, 0);
  // 減速しない
  const days = resolveIntervalDays({
    policy: { minIntervalDays: 3, slowdownAfterNoEngagement: 3, slowdownFactor: 2 },
    state: { consecutiveNoEngagement: noEng }, stepDelayDays: 5,
  });
  assert.equal(days, 5);
  // 停止もしない
  assert.equal(resolveStop({
    policy: { maxSends: 24, stopAfterNoEngagement: 8 },
    state: { sentCount: 2, consecutiveNoEngagement: noEng },
  }).stop, false);
});

test('【重要】送っていない行（queued / skipped）は履歴に入れない', () => {
  const h = buildHistoryByRecipient({
    deliveries: [
      delivery({ key: K1, step: 1, status: 'queued' }),
      delivery({ key: K2, step: 2, status: 'skipped' }),
    ],
    stepByDeliveryKey: steps([[K1, 1], [K2, 2]]),
    index: idx([]),
  });
  assert.equal(h.size, 0);
});

test('履歴は送信の古い順（判定が直近から遡れる）', () => {
  const h = buildHistoryByRecipient({
    deliveries: [
      delivery({ key: K2, step: 2, sentAtMs: NOW + 3 * DAY }),
      delivery({ key: K1, step: 1, sentAtMs: NOW }),
    ],
    stepByDeliveryKey: steps([[K1, 1], [K2, 2]]),
    index: idx([]),
  });
  assert.deepEqual(h.get('x@example.com').map((r) => r.step), [1, 2]);
});

// ── touch 別の集計（管理画面）─────────────────────────────────

test('【重要】touch 別に sent / delivered / opened / measured / unknown を出す', () => {
  const s = summarizeByTouch({
    deliveries: [
      delivery({ key: K1, step: 1, email: 'a@example.com' }),
      delivery({ key: K2, step: 1, email: 'b@example.com' }),
    ],
    stepByDeliveryKey: steps([[K1, 1], [K2, 1]]),
    index: idx([
      [K1, { deliveredAtMs: NOW, firstOpenAtMs: NOW + 1000 }],
      [K2, { deliveredAtMs: NOW, firstOpenAtMs: null }],
    ]),
  });
  const t1 = s.touches.find((x) => x.touch === 1);
  assert.equal(t1.sent, 2);
  assert.equal(t1.delivered, 2);
  assert.equal(t1.opened, 1);
  assert.equal(t1.measured, 2);
  assert.equal(t1.unknown, 0);
  assert.equal(t1.deliveryRate, 1);
  assert.equal(t1.openRate, 0.5);
  assert.deepEqual(t1.rateBasis, { deliveryRate: 'sent', openRate: 'delivered' });
});

test('【重要】分母が 0 のときは率を作らない', () => {
  const s = summarizeByTouch({
    deliveries: [delivery({ key: K1, step: 1 })],
    stepByDeliveryKey: steps([[K1, 1]]),
    index: idx([]),        // delivered を確認できない
  });
  const t1 = s.touches.find((x) => x.touch === 1);
  assert.equal(t1.delivered, 0);
  assert.equal(t1.unknown, 1);
  assert.equal(t1.openRate, null, '0% と書いている');
  assert.equal(t1.deliveryRate, 0);
});

test('【重要】索引が読めないことを画面へ伝える', () => {
  const s = summarizeByTouch({
    deliveries: [delivery({ key: K1, step: 1 })],
    stepByDeliveryKey: steps([[K1, 1]]),
    index: { ok: false, byKey: new Map() },
  });
  assert.equal(s.measurementAvailable, false);
  assert.equal(s.touches[0].unknown, 1);
  assert.equal(s.totals.openRate, null);
});

test('【重要】click は「計測していない」と明示する（0 ではない）', () => {
  const s = summarizeByTouch({ deliveries: [], stepByDeliveryKey: new Map(), index: idx([]) });
  assert.equal(s.clickMeasured, false);
  assert.equal('clicked' in s.totals, false);
});

test('touch が解けない行は集計から外す（推測しない）', () => {
  const s = summarizeByTouch({
    deliveries: [delivery({ key: K1, step: 1 })],
    stepByDeliveryKey: new Map(),   // 対応表が無い
    index: idx([]),
  });
  assert.equal(s.touches.length, 0);
});

test('CampaignType から campaignId を取り出す（壊れていれば空）', () => {
  assert.equal(campaignIdFromType('light-trial-to-premium-sequence:v1'), ACTIVE);
  assert.equal(campaignIdFromType('bad'), '');
  assert.equal(campaignIdFromType(null), '');
});

test('応答に PII を含めない', () => {
  const s = summarizeByTouch({
    deliveries: [delivery({ key: K1, step: 1, email: 'member@example.com' })],
    stepByDeliveryKey: steps([[K1, 1]]),
    index: idx([[K1, { deliveredAtMs: NOW, firstOpenAtMs: NOW }]]),
  });
  assert.equal(/@/.test(JSON.stringify(s)), false);
});
