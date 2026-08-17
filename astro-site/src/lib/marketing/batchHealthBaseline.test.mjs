/**
 * batchHealthBaseline.test.mjs — 健全性は「増えたぶん」で見る（静的な除外で止めない）
 *   node --test src/lib/marketing/batchHealthBaseline.test.mjs
 *
 * 2026-08-17 の誤検知: 全コホートの展開を開始した **1 tick 目**で
 * `complaints_detected` により自動停止した。実際に苦情が起きたのではなく、
 * コホートに元から居る**配信基盤の停止リスト該当者 1 名**を苦情として数えていた。
 * 苦情のしきい値は 0 件なので、このままでは**二度と開始できない**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureHealthSnapshot, diffHealthSnapshot, hasHealthBaseline, toStoredBaseline, HEALTH_FIELDS,
} from './batchHealthBaseline.js';
import { canStartNextBatch, BATCH_STOP } from './batchHealth.js';
import { normalizeRolloutState } from './rolloutPlan.js';
import { planRolloutStart } from './rolloutControl.js';

/** 本番で実際に返っていた形（停止リスト 1 名・配信停止 1 名が**ずっと**居る） */
const DUE_SUMMARY = {
  total: 610, due: 0, duplicates: 0,
  byStopReason: { provider_suppressed: 1, not_sendable: 1 },
};

const snap = (over = {}) => captureHealthSnapshot({
  jobsSent: 609, jobsFailed: 0, dueSummary: DUE_SUMMARY, ...over,
});

test('【重要】静的な除外（停止リスト 1 名）では止まらない', () => {
  const baseline = toStoredBaseline(snap(), 1_000);
  // 次のバッチ前。停止リストの 1 名は**そのまま**（新しい苦情は無い）
  const now = snap();
  const delta = diffHealthSnapshot(baseline, now);
  assert.equal(delta.ok, true);
  assert.equal(delta.counts.complaints, 0, '静的な除外を苦情として数えている（開始できなくなる）');
  assert.equal(delta.counts.unsubscribes, 0);

  const health = canStartNextBatch({
    sent: delta.counts.sent, failed: delta.counts.failed, duplicates: delta.counts.duplicates,
    bounces: delta.counts.bounces, complaints: delta.counts.complaints,
    unsubscribes: delta.counts.unsubscribes,
    previousOutstanding: 0, suppressionReadable: true,
  });
  assert.equal(health.ok, true, `止まっている: ${health.reason}`);
});

test('【重要】本当に苦情が増えたら止める（0 件許容は維持）', () => {
  const baseline = toStoredBaseline(snap(), 1_000);
  const after = captureHealthSnapshot({
    jobsSent: 1_109, jobsFailed: 0,
    dueSummary: { ...DUE_SUMMARY, byStopReason: { provider_suppressed: 2, not_sendable: 1 } },
  });
  const delta = diffHealthSnapshot(baseline, after);
  assert.equal(delta.counts.complaints, 1, '増分を拾えていない');
  const health = canStartNextBatch({
    sent: delta.counts.sent, failed: delta.counts.failed, duplicates: delta.counts.duplicates,
    bounces: delta.counts.bounces, complaints: delta.counts.complaints,
    unsubscribes: delta.counts.unsubscribes,
    previousOutstanding: 0, suppressionReadable: true,
  });
  assert.equal(health.ok, false, '新しい苦情を見逃している');
  assert.equal(health.reason, BATCH_STOP.COMPLAINTS);
});

test('【重要】配信停止・バウンスも増分で見る（率のしきい値は据え置き）', () => {
  const baseline = toStoredBaseline(snap(), 1_000);
  // 500 名送って配信停止が 20 名増えた = 4% > 2%
  const after = captureHealthSnapshot({
    jobsSent: 1_109, jobsFailed: 0,
    dueSummary: { ...DUE_SUMMARY, byStopReason: { provider_suppressed: 1, not_sendable: 21 } },
  });
  const d = diffHealthSnapshot(baseline, after);
  assert.equal(d.counts.sent, 500);
  assert.equal(d.counts.unsubscribes, 20);
  const health = canStartNextBatch({
    sent: d.counts.sent, failed: d.counts.failed, duplicates: d.counts.duplicates,
    bounces: d.counts.bounces, complaints: d.counts.complaints, unsubscribes: d.counts.unsubscribes,
    previousOutstanding: 0, suppressionReadable: true,
  });
  assert.equal(health.ok, false);
  assert.equal(health.reason, BATCH_STOP.UNSUBSCRIBE_RATE);
});

test('【重要】数えられない項目があれば差分を出さない（fail closed）', () => {
  const baseline = toStoredBaseline(snap(), 1_000);
  const unreadable = captureHealthSnapshot({ jobsSent: null, jobsFailed: 0, dueSummary: DUE_SUMMARY });
  const d = diffHealthSnapshot(baseline, unreadable);
  assert.equal(d.ok, false);
  assert.equal(d.counts.sent, null, '読めない値を 0 で埋めている');
  assert.ok(d.missing.includes('sent'));

  const health = canStartNextBatch({
    sent: d.counts.sent, failed: d.counts.failed, duplicates: d.counts.duplicates,
    bounces: d.counts.bounces, complaints: d.counts.complaints, unsubscribes: d.counts.unsubscribes,
    previousOutstanding: 0, suppressionReadable: true,
  });
  assert.equal(health.ok, false);
  assert.equal(health.reason, BATCH_STOP.UNREADABLE);
});

test('集計が読めなければスナップショットも null（0 と書かない）', () => {
  const s = captureHealthSnapshot({ jobsSent: 10, jobsFailed: 0, dueSummary: null });
  assert.equal(s.complaints, null);
  assert.equal(s.unsubscribes, null);
  assert.equal(s.bounces, null);
  assert.equal(s.duplicates, null);
  assert.equal(hasHealthBaseline(s), true, '一部でも数があれば基準点として使える');
  assert.equal(hasHealthBaseline(null), false);
  assert.equal(hasHealthBaseline({}), false);
});

test('累積が減っても差分はマイナスにしない（台帳の掃除で誤検知しない）', () => {
  const baseline = toStoredBaseline(snap(), 1_000);
  const shrunk = captureHealthSnapshot({
    jobsSent: 100, jobsFailed: 0,
    dueSummary: { ...DUE_SUMMARY, byStopReason: { provider_suppressed: 0, not_sendable: 0 } },
  });
  const d = diffHealthSnapshot(baseline, shrunk);
  for (const f of HEALTH_FIELDS) assert.ok(d.counts[f] >= 0, `${f} がマイナス`);
});

test('【重要】最初のバッチは比較相手が無いので健全性判定をしない', () => {
  assert.equal(hasHealthBaseline(normalizeRolloutState({}).healthBaseline), false);
  // 開始操作は基準点を捨てる（止まっていた間の変化を 1 バッチの結果と誤認しない）
  const started = planRolloutStart({
    current: { ...normalizeRolloutState({}), healthBaseline: toStoredBaseline(snap(), 1) },
    exists: true,
    nowMs: Date.UTC(2026, 7, 18, 1, 0, 0),
    req: {
      stage: 'scale', dailyLimit: 15_000, batchSize: 500,
      alwaysArmed: true, expectedVersion: 1,
    },
  });
  assert.equal(started.ok, true, started.reason);
  assert.equal(started.state.healthBaseline, null, '古い基準点が残っている');
});

test('状態へ保存する形に PII も secret も入らない', () => {
  const stored = toStoredBaseline(snap(), 1_700_000_000_000);
  const dump = JSON.stringify(stored);
  assert.equal(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(dump), false);
  assert.equal(/rec[A-Za-z0-9]{14}/.test(dump), false);
  assert.deepEqual(Object.keys(stored).sort(), [...HEALTH_FIELDS, 'atMs'].sort());
  // 正規化を通しても落ちない
  const back = normalizeRolloutState({ healthBaseline: stored }).healthBaseline;
  assert.equal(back.complaints, 1);
  assert.equal(back.sent, 609);
});

test('【重要】運転手が累積値をそのまま渡していない（実装の配線確認）', () => {
  const src = readFileSyncSafe('netlify/functions/cron-marketing-rollout.js');
  assert.equal(
    /complaints:\s*due\s*&&\s*due\.summary/.test(src), false,
    '累積の停止理由を苦情として渡している（2026-08-17 の誤検知の形）',
  );
  assert.ok(src.includes('diffHealthSnapshot'), '増分で見ていない');
  assert.ok(src.includes('captureHealthSnapshot'), '基準点を作っていない');
});

function readFileSyncSafe(rel) {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', '..', '..', rel), 'utf8');
}
