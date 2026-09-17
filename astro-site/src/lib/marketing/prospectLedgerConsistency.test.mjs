/**
 * prospectLedgerConsistency.test.mjs — **「Airtable は queued/sent なのに Redis に予約が無い」を数えられる**
 *   node --test src/lib/marketing/prospectLedgerConsistency.test.mjs
 *
 * 守る条件:
 *   1. その 1 件（`activeNotInRedis`）を**他の区分に混ぜない**
 *   2. `failed` / `cancelled` は active ではない（積み直してよい）
 *   3. 知らない Status を「行が無い」に寄せない
 *   4. 読み切れていない集計を**完了として扱わない**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyLedgerConsistency, normalizeLedgerStatus, isActiveStatus,
  LEDGER_STATUS, ACTIVE_STATUSES, deliveredHistogram,
  summarizeJobStatuses, normalizeJobStatus, JOB_STATUS, mergeWindowCounts,
} from './prospectLedgerConsistency.js';

const k = (n) => String(n).padStart(64, '0');

/* ── ① 本件の数（Airtable active × Redis 無し）─────────────────── */

test('【最重要】Airtable が queued なのに Redis に予約が無い件を数える', () => {
  const out = classifyLedgerConsistency({
    keys: [k(1), k(2), k(3)],
    redisPresent: new Set([k(1)]),
    airtableStatusByKey: new Map([[k(1), 'queued'], [k(2), 'queued'], [k(3), 'sent']]),
  });
  assert.equal(out.active, 3);
  assert.equal(out.activeInRedis, 1, 'Redis にもある分を取り違えている');
  assert.equal(out.activeNotInRedis, 2, '積まれない人の数が合っていない');
  assert.equal(out.balanced, true);
});

test('【最重要】`activeNotInRedis` を他の区分に混ぜない', () => {
  const out = classifyLedgerConsistency({
    keys: [k(1)],
    redisPresent: new Set(),
    airtableStatusByKey: new Map([[k(1), 'sent']]),
  });
  assert.equal(out.activeNotInRedis, 1);
  assert.equal(out.neither, 0, '「どちらにも無い」に混ざっている');
  assert.equal(out.redisOnly, 0, '「Redis だけ」に混ざっている');
  assert.equal(out.inactiveInRedis, 0);
});

test('【最重要】prospect の正常形（Airtable に行が無く Redis にある）は別区分', () => {
  const out = classifyLedgerConsistency({
    keys: [k(1), k(2)],
    redisPresent: new Set([k(1), k(2)]),
    airtableStatusByKey: new Map(),
  });
  assert.equal(out.redisOnly, 2, 'prospect の正常形を数えていない');
  assert.equal(out.activeNotInRedis, 0);
  assert.equal(out.byStatus[LEDGER_STATUS.NONE], 2);
  assert.equal(out.balanced, true);
});

test('どちらにも無い人（これから送る）は neither', () => {
  const out = classifyLedgerConsistency({
    keys: [k(1), k(2)], redisPresent: new Set(), airtableStatusByKey: new Map(),
  });
  assert.equal(out.neither, 2);
  assert.equal(out.active, 0);
});

/* ── ② active の定義は tick と同じ ─────────────────────────────── */

test('【最重要】active は queued / sent だけ（failed / cancelled は積み直してよい）', () => {
  assert.deepEqual([...ACTIVE_STATUSES], ['queued', 'sent']);
  assert.equal(isActiveStatus(LEDGER_STATUS.QUEUED), true);
  assert.equal(isActiveStatus(LEDGER_STATUS.SENT), true);
  assert.equal(isActiveStatus(LEDGER_STATUS.FAILED), false);
  assert.equal(isActiveStatus(LEDGER_STATUS.CANCELLED), false);
  assert.equal(isActiveStatus(LEDGER_STATUS.NONE), false);
});

test('failed / cancelled は active に数えない', () => {
  const out = classifyLedgerConsistency({
    keys: [k(1), k(2)],
    redisPresent: new Set(),
    airtableStatusByKey: new Map([[k(1), 'failed'], [k(2), 'cancelled']]),
  });
  assert.equal(out.active, 0);
  assert.equal(out.activeNotInRedis, 0);
  assert.equal(out.neither, 2);
  assert.equal(out.byStatus.failed, 1);
  assert.equal(out.byStatus.cancelled, 1);
});

/* ── ③ 知らない値の扱い ────────────────────────────────────────── */

test('【最重要】知らない Status を「行が無い」に寄せない', () => {
  assert.equal(normalizeLedgerStatus('processing'), LEDGER_STATUS.OTHER);
  assert.equal(normalizeLedgerStatus(''), LEDGER_STATUS.NONE);
  assert.equal(normalizeLedgerStatus(null), LEDGER_STATUS.NONE);
  assert.equal(normalizeLedgerStatus(' QUEUED '), LEDGER_STATUS.QUEUED);
  const out = classifyLedgerConsistency({
    keys: [k(1)], redisPresent: new Set(), airtableStatusByKey: new Map([[k(1), 'processing']]),
  });
  assert.equal(out.byStatus.other, 1);
  assert.equal(out.byStatus.none, 0, '知らない値を「行なし」と数えている');
});

test('同じ鍵が 2 回渡されても 1 人として数える', () => {
  const out = classifyLedgerConsistency({
    keys: [k(1), k(1)], redisPresent: new Set(), airtableStatusByKey: new Map([[k(1), 'queued']]),
  });
  assert.equal(out.total, 1);
  assert.equal(out.activeNotInRedis, 1);
});

test('壊れた入力でも数え方が崩れない（0 件で balanced）', () => {
  const out = classifyLedgerConsistency({});
  assert.equal(out.total, 0);
  assert.equal(out.balanced, true);
});

/* ── ④ delivered 累計の分布 ────────────────────────────────────── */

test('delivered の分布と最大値を出す（打ち切り 10 通の分母）', () => {
  const { histogram, max } = deliveredHistogram([1, 3, 3, 10, 0, 'x', -1, null]);
  assert.equal(histogram['3'], 2);
  assert.equal(histogram['10'], 1);
  assert.equal(histogram['0'], 1);
  assert.equal(max, 10);
});

/* ── ⑤ ジョブ側の集計は打ち切りを成功にしない ─────────────────── */

test('【最重要】ページ打ち切りを「読み切った」と扱わない', () => {
  const partial = summarizeJobStatuses({ statuses: ['SENT', 'SENT'], truncated: true });
  assert.equal(partial.complete, false, '打ち切りを完了として返している');
  assert.equal(partial.counts.SENT, 2);
  const full = summarizeJobStatuses({ statuses: ['SENT', 'PENDING'], truncated: false });
  assert.equal(full.complete, true);
  assert.equal(full.counts.PENDING, 1);
});

test('ジョブの Status は 4 種 + OTHER に寄せる', () => {
  assert.equal(normalizeJobStatus('pending'), JOB_STATUS.PENDING);
  assert.equal(normalizeJobStatus('PROCESSING'), JOB_STATUS.OTHER);
  const out = summarizeJobStatuses({ statuses: ['PENDING', 'SENT', 'FAILED', 'CANCELLED', 'zzz'] });
  assert.equal(out.total, 5);
  assert.equal(out.counts.OTHER, 1);
});

/* ── ⑥ 窓の足し合わせ ──────────────────────────────────────────── */

test('【最重要】読み切れていない窓があれば合計を「確定」としない', () => {
  const merged = mergeWindowCounts([
    { ok: true, counts: { total: 2, active: 1, activeInRedis: 0, activeNotInRedis: 1, inactiveInRedis: 0, redisOnly: 0, neither: 1, balanced: true, byStatus: { queued: 1, none: 1 } } },
    { ok: false },
  ]);
  assert.equal(merged.complete, false, '欠けた窓があるのに確定扱いしている');
  assert.equal(merged.activeNotInRedis, 1, '読めた窓の数は残す');
});

test('全部読み切れたら合計は確定扱い', () => {
  const w = (n) => ({
    ok: true,
    counts: {
      total: n, active: n, activeInRedis: 0, activeNotInRedis: n,
      inactiveInRedis: 0, redisOnly: 0, neither: 0, balanced: true,
      byStatus: { queued: n },
    },
  });
  const merged = mergeWindowCounts([w(50), w(47)]);
  assert.equal(merged.complete, true);
  assert.equal(merged.activeNotInRedis, 97);
  assert.equal(merged.byStatus.queued, 97);
});

test('窓が 1 つも無ければ確定としない', () => {
  assert.equal(mergeWindowCounts([]).complete, false);
});

test('検算が崩れた窓があれば確定としない', () => {
  const merged = mergeWindowCounts([
    { ok: true, counts: { total: 3, active: 1, activeInRedis: 0, activeNotInRedis: 1, inactiveInRedis: 0, redisOnly: 0, neither: 0, balanced: false, byStatus: {} } },
  ]);
  assert.equal(merged.complete, false);
});
