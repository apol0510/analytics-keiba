/**
 * adminOperationLog.test.mjs — 操作履歴が**嘘をつかない**こと
 *   node --test src/lib/premiumPlus/adminOperationLog.test.mjs
 *
 * 一番危険なのは「通信が切れた操作」を **失敗** と書いてしまうこと。
 * 実際には保存されているのに失敗と読まれると、管理者が同じ操作を繰り返す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createOperationLog, normalizeEntry, describeEntry, opTime,
  OP_RESULT, OP_KIND, OP_LOG_KEY, OP_LOG_MAX, OP_RESULT_LABEL,
} from './adminOperationLog.js';

const T0 = Date.parse('2026-08-13T04:00:00Z');
const REC = 'recAAAAAAAAAAAAAA';

/** sessionStorage の偽物 */
function fakeStorage(initial) {
  const m = new Map(initial ? [[OP_LOG_KEY, initial]] : []);
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), _m: m };
}

const entry = (over = {}) => ({
  at: T0, kind: OP_KIND.ELIGIBILITY, result: OP_RESULT.OK, actor: 'MK',
  recordId: REC, email: 'a@example.com', from: '保留', to: '販売できる', ...over,
});

// ── 記録の正しさ ──────────────────────────────────────────────
test('結果が不正な記録は残さない（嘘の履歴を作らない）', () => {
  for (const r of ['', 'maybe', null, undefined, 'OK']) {
    assert.equal(normalizeEntry(entry({ result: r })), null, `受理された: ${String(r)}`);
  }
  assert.equal(normalizeEntry(entry({ kind: 'unknown-kind' })), null);
  assert.equal(normalizeEntry(entry({ at: 'いま' })), null);
});

test('操作者名は 32 文字までに切る', () => {
  const e = normalizeEntry(entry({ actor: 'x'.repeat(50) }));
  assert.equal(e.actor.length, 32);
});

// ── 3 値の区別（本題）────────────────────────────────────────
test('【重要】通信断は failed ではなく unknown として残す', () => {
  const log = createOperationLog({ storage: fakeStorage() });
  log.add(entry({ result: OP_RESULT.UNKNOWN, detail: '通信が切れました' }));
  const [e] = log.all();
  assert.equal(e.result, 'unknown');
  assert.match(OP_RESULT_LABEL.unknown, /確認/);
  assert.doesNotMatch(OP_RESULT_LABEL.unknown, /^失敗/);
});

test('【重要】結果が分からない操作だけを拾える（確認を促すため）', () => {
  const log = createOperationLog({ storage: fakeStorage() });
  log.add(entry({ at: T0, result: OP_RESULT.OK }));
  log.add(entry({ at: T0 + 1, result: OP_RESULT.FAILED }));
  log.add(entry({ at: T0 + 2, result: OP_RESULT.UNKNOWN }));
  const pending = log.unresolved();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].at, T0 + 2);
});

test('失敗は「保存されていません」と言い切る（成功と混ぜない）', () => {
  assert.match(OP_RESULT_LABEL.failed, /保存されていません/);
  assert.equal(OP_RESULT_LABEL.ok, '成功');
});

// ── 前後の記録 ────────────────────────────────────────────────
test('前後が分かるときだけ矢印を書く', () => {
  assert.match(describeEntry(normalizeEntry(entry())), /保留 → 販売できる/);
  // 前が分からないときに「→」で嘘の変化を書かない
  const noFrom = describeEntry(normalizeEntry(entry({ from: null })));
  assert.equal(noFrom.includes('→'), false, '不明な前状態から矢印を書いている');
  assert.match(noFrom, /販売できる/);
});

test('前後が同じなら変化として書かない', () => {
  const same = describeEntry(normalizeEntry(entry({ from: '保留', to: '保留' })));
  assert.equal(same.includes('→'), false);
});

test('操作者名が無ければ「なし」と明示する（空欄で誤魔化さない）', () => {
  assert.match(describeEntry(normalizeEntry(entry({ actor: '' }))), /操作者名なし/);
});

test('表示は JST の時刻を出す', () => {
  assert.equal(opTime(T0), '08/13 13:00:00');
  assert.equal(opTime(NaN), '—');
});

// ── 保存 ──────────────────────────────────────────────────────
test('新しい順に並ぶ / 会員ごとに絞れる', () => {
  const log = createOperationLog({ storage: fakeStorage() });
  log.add(entry({ at: T0 }));
  log.add(entry({ at: T0 + 1000, recordId: 'recBBBBBBBBBBBBBB' }));
  log.add(entry({ at: T0 + 2000 }));
  assert.deepEqual(log.all().map((e) => e.at), [T0 + 2000, T0 + 1000, T0]);
  assert.deepEqual(log.forRecord(REC).map((e) => e.at), [T0 + 2000, T0]);
  assert.deepEqual(log.forRecord(''), []);
});

test('件数の上限で古いものから捨てる', () => {
  const log = createOperationLog({ storage: fakeStorage(), max: 3 });
  for (let i = 0; i < 5; i += 1) log.add(entry({ at: T0 + i }));
  assert.equal(log.all().length, 3);
  assert.equal(log.all()[0].at, T0 + 4, '新しいものが残っていない');
});

test('保存先が壊れていても落ちない（履歴のために画面を壊さない）', () => {
  const broken = createOperationLog({ storage: fakeStorage('{ではない') });
  assert.deepEqual(broken.all(), []);
  assert.doesNotThrow(() => broken.add(entry()));

  const throwing = createOperationLog({
    storage: { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } },
  });
  assert.deepEqual(throwing.all(), []);
  assert.doesNotThrow(() => throwing.add(entry()));
});

test('保存先が無くても使える（履歴が取れないだけ）', () => {
  const none = createOperationLog({});
  assert.doesNotThrow(() => none.add(entry()));
  assert.deepEqual(none.all(), []);
});

test('既定の保持件数を固定する', () => {
  assert.equal(OP_LOG_MAX, 100);
});
