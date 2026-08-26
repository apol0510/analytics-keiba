/**
 * sequenceMetrics.test.mjs — 連続配信の実績を配信台帳の実データから数える
 *   node --test src/lib/marketing/sequenceMetrics.test.mjs
 *
 * ## 守る条件（2026-08-26 MK 要望）
 *
 * 管理画面で **キャンペーン × ステップごと**に次を目視できること。
 *   対象数 / queue済み / 実送信数 / 除外数 / 失敗数 / 未送信残 / 二重送信数 / 最終実行時刻
 *
 * ⚠️ **queued を「送信済み」として表示しない。**
 *    キュー登録はまだ届いていない。混ぜると「送ったつもりで届いていない」を見逃す
 *    （2026-08-25 に実際 488 通が queued のまま止まっていた）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  emptyMetrics, emptyStepMetrics, accumulateMetrics, describeMetrics,
  createSequenceMetricsStore, metricsKey, LEDGER_STATUS,
} from './sequenceMetrics.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const ADMIN_FN = read('../../../netlify/functions/admin-marketing.js');
const CRON_FN = read('../../../netlify/functions/cron-campaign-sequence.js');
const ADMIN_UI = read('../../../src/pages/admin/premium-plus-eligibility.astro');

const row = (over = {}) => ({
  fields: {
    StepNumber: 1, Status: 'sent', DeliveryKey: `k${Math.random()}`,
    SentAt: '2026-08-25T10:00:00.000Z', ...over,
  },
});

// ── 1. queued を送信済みにしない ───────────────────────────────
test('【要件】queue済みは実送信数に含めない（未送信残として出す）', () => {
  const m = emptyMetrics();
  accumulateMetrics(m, [
    row({ Status: 'sent' }), row({ Status: 'sent' }),
    row({ Status: 'queued', SentAt: null, QueuedAt: '2026-08-25T09:00:00.000Z' }),
    row({ Status: 'queued', SentAt: null, QueuedAt: '2026-08-25T09:00:00.000Z' }),
    row({ Status: 'queued', SentAt: null, QueuedAt: '2026-08-25T09:00:00.000Z' }),
  ]);
  const v = describeMetrics(m, { complete: true, computedAtMs: Date.parse('2026-08-26T00:00:00Z') });
  const s1 = v.steps[0];
  assert.equal(s1.sent, 2, 'queued を送信済みに数えている');
  assert.equal(s1.queued, 3);
  assert.equal(s1.pending, 3, '未送信残が出ていない');
  assert.equal(s1.target, 5, '対象数が合わない');
});

test('【要件】8 つの項目がすべて出る', () => {
  const m = emptyMetrics();
  accumulateMetrics(m, [row()]);
  const s = describeMetrics(m, { complete: true }).steps[0];
  for (const k of ['target', 'queued', 'sent', 'excluded', 'failed', 'pending', 'duplicates', 'lastActivityAt']) {
    assert.ok(k in s, `${k} が出ていない`);
  }
});

// ── 2. 状態の振り分け ────────────────────────────────────────
test('除外は skipped-* をまとめて数える', () => {
  const m = emptyMetrics();
  accumulateMetrics(m, [
    row({ Status: 'skipped-duplicate', SentAt: null, SkippedAt: '2026-08-25T10:00:00.000Z' }),
    row({ Status: 'skipped-unsubscribed', SentAt: null, SkippedAt: '2026-08-25T10:00:00.000Z' }),
    row({ Status: 'skipped-blacklist', SentAt: null, SkippedAt: '2026-08-25T10:00:00.000Z' }),
  ]);
  const s = describeMetrics(m, {}).steps[0];
  assert.equal(s.excluded, 3);
  assert.equal(s.sent, 0);
  assert.equal(s.queued, 0);
});

test('失敗は独立して数える', () => {
  const m = emptyMetrics();
  accumulateMetrics(m, [row({ Status: 'failed', SentAt: null, FailedAt: '2026-08-25T10:00:00.000Z' })]);
  const s = describeMetrics(m, {}).steps[0];
  assert.equal(s.failed, 1);
  assert.equal(s.sent, 0);
});

test('ステップごとに分けて数える', () => {
  const m = emptyMetrics();
  accumulateMetrics(m, [
    row({ StepNumber: 1, Status: 'sent' }),
    row({ StepNumber: 2, Status: 'queued', SentAt: null, QueuedAt: '2026-08-31T00:00:00.000Z' }),
    row({ StepNumber: 2, Status: 'sent' }),
  ]);
  const v = describeMetrics(m, {});
  assert.deepEqual(v.steps.map((s) => s.step), [1, 2]);
  assert.equal(v.steps[0].sent, 1);
  assert.equal(v.steps[1].sent, 1);
  assert.equal(v.steps[1].queued, 1);
});

// ── 3. 二重送信 ──────────────────────────────────────────────
test('【要件】同じ DeliveryKey が 2 行以上あれば二重送信として数える', () => {
  const m = emptyMetrics();
  const state = {};
  accumulateMetrics(m, [
    row({ DeliveryKey: 'dup-1' }), row({ DeliveryKey: 'dup-1' }), row({ DeliveryKey: 'uniq-1' }),
  ], state);
  assert.equal(describeMetrics(m, {}).steps[0].duplicates, 1);
});

test('正常な台帳では二重送信は 0', () => {
  const m = emptyMetrics();
  accumulateMetrics(m, [row({ DeliveryKey: 'a' }), row({ DeliveryKey: 'b' })], {});
  assert.equal(describeMetrics(m, {}).steps[0].duplicates, 0);
});

test('複数回に分けて集計しても二重送信を誤検知しない（周をまたいで持ち回る）', () => {
  const m = emptyMetrics();
  const state = {};
  accumulateMetrics(m, [row({ DeliveryKey: 'x' })], state);
  accumulateMetrics(m, [row({ DeliveryKey: 'y' })], state);
  assert.equal(describeMetrics(m, {}).steps[0].duplicates, 0);
  accumulateMetrics(m, [row({ DeliveryKey: 'x' })], state);
  assert.equal(describeMetrics(m, {}).steps[0].duplicates, 1, '同じ鍵の再出現を検知していない');
});

// ── 4. 最終実行時刻・確定/途中 ────────────────────────────────
test('最終実行時刻はいちばん新しい時刻', () => {
  const m = emptyMetrics();
  accumulateMetrics(m, [
    row({ SentAt: '2026-08-25T10:00:00.000Z' }),
    row({ SentAt: '2026-08-25T12:00:00.000Z' }),
    row({ Status: 'queued', SentAt: null, QueuedAt: '2026-08-25T09:00:00.000Z' }),
  ]);
  assert.equal(describeMetrics(m, {}).steps[0].lastActivityAt, '2026-08-25T12:00:00.000Z');
});

test('確定と途中経過を区別して出す（0 と未集計を混同させない）', () => {
  const done = describeMetrics(emptyMetrics(), { complete: true, computedAtMs: 1 });
  assert.equal(done.complete, true);
  assert.match(done.note, /読み切った/);
  const wip = describeMetrics(emptyMetrics(), { complete: false });
  assert.equal(wip.complete, false);
  assert.match(wip.note, /途中/);
});

test('壊れた入力でも落ちない', () => {
  const m = emptyMetrics();
  accumulateMetrics(m, null);
  accumulateMetrics(m, [null, {}, { fields: null }]);
  assert.ok(describeMetrics(m, {}).steps.length >= 0);
  assert.deepEqual(Object.keys(emptyStepMetrics()).sort(),
    ['duplicates', 'failed', 'lastActivityAtMs', 'queued', 'sent', 'skipped', 'target'].sort());
});

// ── 5. 保存層 ────────────────────────────────────────────────
test('集計はキャンペーンごとに分けて保存する', async () => {
  const mem = new Map();
  const store = createSequenceMetricsStore({
    redisCmd: async ([op, k, v]) => {
      if (op === 'SET') { mem.set(k, v); return 'OK'; }
      if (op === 'GET') return mem.get(k) ?? null;
      throw new Error('unexpected');
    },
  });
  assert.notEqual(metricsKey('a:v1'), metricsKey('b:v1'));
  await store.write('a:v1', { running: { steps: {} }, updatedAtMs: 1 });
  assert.equal((await store.read('a:v1')).updatedAtMs, 1);
  assert.equal(await store.read('b:v1'), null);
});

test('Redis が無くても落ちない（数字が出ないだけ）', async () => {
  const s = createSequenceMetricsStore({});
  assert.equal(s.usable, false);
  assert.equal(await s.read('x'), null);
  assert.equal((await s.write('x', {})).ok, false);
});

// ── 6. 配線 ──────────────────────────────────────────────────
test('【配線】cron が走査のついでに集計する（追加の読み取りをしない）', () => {
  assert.match(CRON_FN, /accumulateMetrics/, 'cron が集計していない');
  assert.match(CRON_FN, /createSequenceMetricsStore/);
  // 走査で読んだ行をそのまま数える（別途 fetch していない）
  assert.match(CRON_FN, /accumulateMetrics\(running, deliveries, state\)/);
});

test('【配線】管理 API が実績を返す（読むだけ・送信しない）', () => {
  assert.match(ADMIN_FN, /action === 'sequenceMetrics'/, '実績 API が無い');
  assert.match(ADMIN_FN, /handleSeqMetrics/);
  assert.match(ADMIN_FN, /describeMetrics/);
  // 読み取り専用であること
  const fn = ADMIN_FN.slice(ADMIN_FN.indexOf('async function handleSeqMetrics'),
    ADMIN_FN.indexOf('async function handleSequence({'));
  assert.equal(/\bsendMail\b|scheduled-emails|PATCH/.test(fn), false, '実績 API が書き込み・送信をしている');
  assert.match(fn, /sideEffects: 'none'/);
});

test('【配線】管理画面が 8 項目を表示し、queue済みを送信済みとして出さない', () => {
  for (const label of ['対象数', 'queue済み', '実送信数', '除外数', '失敗数', '未送信残', '二重送信', '最終実行']) {
    assert.ok(ADMIN_UI.includes(label), `${label} が画面に無い`);
  }
  assert.match(ADMIN_UI, /mkSeqMetrics/, '実績パネルが無い');
  // 送信数のセルは sent、未送信残は pending を使う（取り違えの検知）
  assert.match(ADMIN_UI, /String\(st\.sent\)/);
  assert.match(ADMIN_UI, /String\(st\.pending\)/);
  assert.match(ADMIN_UI, /String\(st\.queued\)/);
});
