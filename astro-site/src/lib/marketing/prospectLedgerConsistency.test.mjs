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
  classifyLedgerConsistency, normalizeLedgerStatus, isActiveStatus, isActiveStatusSet,
  normalizeStatusSet, LEDGER_STATUS, ACTIVE_STATUSES, ACTIVE_SHAPE, deliveredHistogram,
  summarizeJobStatuses, normalizeJobStatus, JOB_STATUS, mergeWindowCounts,
} from './prospectLedgerConsistency.js';

/**
 * **本番 tick と同じ active 判定**（`fetchActiveDeliveryKeys`）をここに写しておく。
 * tick は同じ `DeliveryKey` の行を**全部**見て、1 行でも queued / sent があれば active。
 * 監査がこれと一致することを、同一鍵に複数行があるケースで確かめる。
 */
const tickSaysActive = (statuses) => (Array.isArray(statuses) ? statuses : [])
  .map((x) => String(x || '').trim().toLowerCase())
  .some((st) => st === 'queued' || st === 'sent');

const k = (n) => String(n).padStart(64, '0');

/* ── ① 本件の数（Airtable active × Redis 無し）─────────────────── */

test('【最重要】Airtable が queued なのに Redis に予約が無い件を数える', () => {
  const out = classifyLedgerConsistency({
    keys: [k(1), k(2), k(3)],
    redisPresent: new Set([k(1)]),
    airtableStatusesByKey: new Map([[k(1), ['queued']], [k(2), ['queued']], [k(3), ['sent']]]),
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
    airtableStatusesByKey: new Map([[k(1), ['sent']]]),
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
    airtableStatusesByKey: new Map(),
  });
  assert.equal(out.redisOnly, 2, 'prospect の正常形を数えていない');
  assert.equal(out.activeNotInRedis, 0);
  assert.equal(out.keysWithStatus[LEDGER_STATUS.NONE], 2);
  assert.equal(out.balanced, true);
});

test('どちらにも無い人（これから送る）は neither', () => {
  const out = classifyLedgerConsistency({
    keys: [k(1), k(2)], redisPresent: new Set(), airtableStatusesByKey: new Map(),
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
    airtableStatusesByKey: new Map([[k(1), ['failed']], [k(2), ['cancelled']]]),
  });
  assert.equal(out.active, 0);
  assert.equal(out.activeNotInRedis, 0);
  assert.equal(out.neither, 2);
  assert.equal(out.keysWithStatus.failed, 1);
  assert.equal(out.keysWithStatus.cancelled, 1);
});

/* ── ③ 知らない値の扱い ────────────────────────────────────────── */

test('【最重要】知らない Status を「行が無い」に寄せない', () => {
  assert.equal(normalizeLedgerStatus('processing'), LEDGER_STATUS.OTHER);
  assert.equal(normalizeLedgerStatus(''), LEDGER_STATUS.NONE);
  assert.equal(normalizeLedgerStatus(null), LEDGER_STATUS.NONE);
  assert.equal(normalizeLedgerStatus(' QUEUED '), LEDGER_STATUS.QUEUED);
  const out = classifyLedgerConsistency({
    keys: [k(1)], redisPresent: new Set(), airtableStatusesByKey: new Map([[k(1), ['processing']]]),
  });
  assert.equal(out.keysWithStatus.other, 1);
  assert.equal(out.keysWithStatus.none, 0, '知らない値を「行なし」と数えている');
});

test('同じ鍵が 2 回渡されても 1 人として数える', () => {
  const out = classifyLedgerConsistency({
    keys: [k(1), k(1)], redisPresent: new Set(), airtableStatusesByKey: new Map([[k(1), ['queued']]]),
  });
  assert.equal(out.total, 1);
  assert.equal(out.activeNotInRedis, 1);
});

test('壊れた入力でも数え方が崩れない（0 件で balanced）', () => {
  const out = classifyLedgerConsistency({});
  assert.equal(out.total, 0);
  assert.equal(out.balanced, true);
});

/* ── ③-b 同じ鍵に行が複数あるとき（読み順で結果が変わらない）────── */

/**
 * ⚠️ ここが本題。台帳には同じ `DeliveryKey` の行が複数あり得る。
 *    「最後に読んだ 1 行」で上書きすると、読み順しだいで active が inactive に化ける。
 *    tick は**全行を見て 1 行でも queued / sent なら active**。監査もそれに一致させる。
 */
const MULTI_ROW_CASES = [
  { name: 'sent + cancelled', rows: ['sent', 'cancelled'], shape: ACTIVE_SHAPE.SENT_ONLY },
  { name: 'cancelled + sent（読み順が逆）', rows: ['cancelled', 'sent'], shape: ACTIVE_SHAPE.SENT_ONLY },
  { name: 'queued + failed', rows: ['queued', 'failed'], shape: ACTIVE_SHAPE.QUEUED_ONLY },
  { name: 'failed + queued（読み順が逆）', rows: ['failed', 'queued'], shape: ACTIVE_SHAPE.QUEUED_ONLY },
  { name: 'sent + queued', rows: ['sent', 'queued'], shape: ACTIVE_SHAPE.QUEUED_AND_SENT },
];

for (const c of MULTI_ROW_CASES) {
  test(`【最重要】同一 DeliveryKey に ${c.name} があっても tick の active 判定と一致する`, () => {
    const out = classifyLedgerConsistency({
      keys: [k(1)], redisPresent: new Set(), airtableStatusesByKey: new Map([[k(1), c.rows]]),
    });
    assert.equal(tickSaysActive(c.rows), true, 'この前提では tick は active と判定する');
    assert.equal(out.active, 1, `監査が tick と食い違っている（${c.name}）`);
    assert.equal(out.activeNotInRedis, 1, 'Redis に無い active を数えていない');
    assert.equal(out.neither, 0, 'inactive 側へ落ちている（読み順で化けている）');
    assert.equal(out.activeShape[c.shape], 1, `内訳が違う（${c.name}）`);
    assert.equal(out.balanced, true);
  });
}

test('【最重要】active と failed / cancelled が混ざる鍵を別枠でも数える', () => {
  const out = classifyLedgerConsistency({
    keys: [k(1), k(2), k(3)],
    redisPresent: new Set(),
    airtableStatusesByKey: new Map([
      [k(1), ['sent', 'cancelled']],
      [k(2), ['queued', 'failed']],
      [k(3), ['sent']],
    ]),
  });
  assert.equal(out.active, 3);
  assert.equal(out.activeWithInactiveRows, 2, '混在している鍵の数が合っていない');
  assert.equal(out.activeShape.sentOnly, 2);
  assert.equal(out.activeShape.queuedOnly, 1);
});

test('【最重要】内訳（queuedのみ / sentのみ / 両方）の合計が active と一致する', () => {
  const out = classifyLedgerConsistency({
    keys: [k(1), k(2), k(3), k(4)],
    redisPresent: new Set([k(4)]),
    airtableStatusesByKey: new Map([
      [k(1), ['queued']], [k(2), ['sent']], [k(3), ['queued', 'sent']], [k(4), ['sent']],
    ]),
  });
  const { queuedOnly, sentOnly, queuedAndSent } = out.activeShape;
  assert.equal(queuedOnly + sentOnly + queuedAndSent, out.active, '内訳の合計が active と合わない');
  assert.equal(queuedAndSent, 1);
  assert.equal(out.activeInRedis, 1);
  assert.equal(out.activeNotInRedis, 3);
  assert.equal(out.balanced, true);
});

test('同じ status の行が何本あっても鍵は 1 つとして数える', () => {
  const out = classifyLedgerConsistency({
    keys: [k(1)], redisPresent: new Set(),
    airtableStatusesByKey: new Map([[k(1), ['queued', 'queued', 'queued']]]),
  });
  assert.equal(out.active, 1);
  assert.equal(out.keysWithStatus.queued, 1, '行数を鍵数として数えている');
  assert.equal(out.withRows, 1);
});

test('status の集合ヘルパーが tick と同じ判定になる', () => {
  assert.equal(isActiveStatusSet(normalizeStatusSet(['cancelled', 'sent'])), true);
  assert.equal(isActiveStatusSet(normalizeStatusSet(['cancelled', 'failed'])), false);
  assert.equal(isActiveStatusSet(normalizeStatusSet([])), false);
  assert.equal(isActiveStatusSet(new Set()), false);
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
    { ok: true, counts: { total: 2, active: 1, activeInRedis: 0, activeNotInRedis: 1, inactiveInRedis: 0, redisOnly: 0, neither: 1, balanced: true, keysWithStatus: { queued: 1, none: 1 } } },
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
      keysWithStatus: { queued: n },
    },
  });
  const merged = mergeWindowCounts([w(50), w(47)]);
  assert.equal(merged.complete, true);
  assert.equal(merged.activeNotInRedis, 97);
  assert.equal(merged.keysWithStatus.queued, 97);
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
