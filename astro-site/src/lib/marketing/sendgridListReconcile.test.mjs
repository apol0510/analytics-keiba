/**
 * sendgridListReconcile.test.mjs — 「予約の直前に AK へ合わせ直す」判定を固定する
 *
 * ここが green でないまま予約すると、**遅れて届いた delivered で番号が進んだ人へ
 * 同じ号をもう一度送る**。3 名を手で直す話にしないため、判定をテストで正本化する。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReconcilePlan, summarizeReconcilePlan, assertReconcileSafety, reconcileSteps,
  classifyContact, runWithSplit,
  RECONCILE_ACTION, RECONCILE_EXCLUDE_STATES, RECONCILE_LIMITS,
} from './sendgridListReconcile.js';

const L = { 1: 'list-1', 2: 'list-2', 3: 'list-3' };
const OTHER = 'list-keiba-intelligence';
const ctx = { listIdByMessage: L, allListIds: ['list-1', 'list-2', 'list-3'] };

const ready = (email, n) => ({ email, nextMessageNumber: n, sendable: true });
const excluded = (email, state) => ({ email, state, sendable: false });

test('正しい list に居る人は何もしない', () => {
  const r = classifyContact(ready('a@example.com', 3), { listIds: ['list-3'], nextMessage: 3 }, ctx);
  assert.equal(r.action, RECONCILE_ACTION.OK);
});

test('【本件】遅れて届いた delivered で番号が進んだ人は、旧 list から外して新 list へ入れる', () => {
  const r = classifyContact(ready('a@example.com', 3), { listIds: ['list-2'], nextMessage: 2 }, ctx);
  assert.equal(r.action, RECONCILE_ACTION.ADD);
  assert.equal(r.addTo, 'list-3');
  assert.deepEqual(r.removeFrom, ['list-2']);
  assert.equal(r.nextMessage, 3);
});

test('【再送防止】remove が add より先に並ぶ（両方に居る瞬間を作らない）', () => {
  const plan = buildReconcilePlan({
    akEntries: [ready('a@example.com', 3)],
    sendgridByEmail: { 'a@example.com': { listIds: ['list-2'], nextMessage: 2 } },
    listIdByMessage: L,
  });
  const steps = reconcileSteps(plan);
  assert.equal(steps[0].op, 'remove');
  assert.equal(steps[steps.length - 1].op, 'add');
});

test('反応・昇格・抑止・打ち切りは 3 本すべてから外す', () => {
  for (const state of RECONCILE_EXCLUDE_STATES) {
    const r = classifyContact(excluded('b@example.com', state), { listIds: ['list-1', 'list-3'] }, ctx);
    assert.equal(r.action, RECONCILE_ACTION.EXIT, state);
    assert.deepEqual(r.removeFrom.sort(), ['list-1', 'list-3']);
    assert.match(r.reason, new RegExp(state));
  }
});

test('AK の list 以外には触らない（KI などの資産を巻き込まない）', () => {
  const r = classifyContact(excluded('b@example.com', 'engaged'), { listIds: [OTHER] }, ctx);
  assert.equal(r.action, RECONCILE_ACTION.OK, 'AK の list に居ないなら何もしない');
  const plan = buildReconcilePlan({
    akEntries: [ready('c@example.com', 1)],
    sendgridByEmail: { 'c@example.com': { listIds: ['list-1', OTHER], nextMessage: 1 } },
    listIdByMessage: L,
  });
  assert.equal(plan.removeByList.has(OTHER), false);
  assert.equal(plan.changes, 0, 'AK 以外の list 在籍は変更理由にしない');
});

test('【本件】SendGrid に居ない人は reconcile では入れない（入れるのは import の仕事）', () => {
  const plan = buildReconcilePlan({
    akEntries: [ready('missing@example.com', 1)],
    sendgridByEmail: {},
    listIdByMessage: L,
  });
  assert.equal(plan.counts[RECONCILE_ACTION.MISSING], 1);
  assert.equal(plan.addByList.size, 0, '入れに行っていない');
  assert.equal(plan.changes, 0);
});

test('明示すれば入れに行ける（既定は入れない）', () => {
  const plan = buildReconcilePlan({
    akEntries: [ready('missing@example.com', 1)],
    sendgridByEmail: {},
    listIdByMessage: L,
    addMissing: true,
  });
  assert.equal(plan.addByList.get('list-1').length, 1);
});

test('【本件】受理されないと分かっている宛先には二度と足さない（明示しても）', () => {
  const hashOf = (e) => `h:${e}`;
  const knownRejected = new Set([hashOf('bad@example.com')]);
  for (const addMissing of [false, true]) {
    const plan = buildReconcilePlan({
      akEntries: [ready('bad@example.com', 1)],
      sendgridByEmail: {},
      listIdByMessage: L,
      knownRejected, hashOf, addMissing,
    });
    assert.equal(plan.counts[RECONCILE_ACTION.PROVIDER_REJECTED], 1, `addMissing=${addMissing}`);
    assert.equal(plan.changes, 0, `addMissing=${addMissing}`);
    assert.equal(summarizeReconcilePlan(plan)['provider rejected（対象外）'], 1);
  }
});

test('【本件】実際の write plan は貼り替えだけになる（rejected への add 試行を含まない）', () => {
  const hashOf = (e) => `h:${e}`;
  const knownRejected = new Set(['a', 'b', 'c'].map((x) => hashOf(`r${x}@example.com`)));
  const ak = [
    ready('moved1@example.com', 3), ready('moved2@example.com', 3), ready('moved3@example.com', 3),
    ready('ra@example.com', 1), ready('rb@example.com', 1), ready('rc@example.com', 1),
  ];
  const sg = {};
  for (const e of ['moved1', 'moved2', 'moved3']) sg[`${e}@example.com`] = { listIds: ['list-2'], nextMessage: 2 };
  const plan = buildReconcilePlan({
    akEntries: ak, sendgridByEmail: sg, listIdByMessage: L, knownRejected, hashOf,
  });
  assert.equal(plan.changes, 6, 'remove 3 + add 3 だけ');
  assert.equal(plan.counts[RECONCILE_ACTION.PROVIDER_REJECTED], 3);
  const steps = reconcileSteps(plan);
  assert.equal(steps.filter((x) => x.op === 'add').reduce((a, x) => a + x.entries.length, 0), 3);
});

test('通し番号が壊れている人は触らない（当て推量で list へ入れない）', () => {
  for (const bad of [0, 11, null, undefined, 2.5, '3']) {
    const r = classifyContact({ email: 'x@example.com', nextMessageNumber: bad, sendable: true }, null, ctx);
    assert.equal(r.action, RECONCILE_ACTION.SKIP, String(bad));
  }
});

test('入れる先の list が無ければ触らない', () => {
  const r = classifyContact(ready('y@example.com', 7), null, ctx);
  assert.equal(r.action, RECONCILE_ACTION.SKIP);
  assert.equal(r.reason, 'no_list_for_message');
});

test('ak_next_message だけずれている人は入れ直して直す', () => {
  const r = classifyContact(ready('z@example.com', 3), { listIds: ['list-3'], nextMessage: 2 }, ctx);
  assert.equal(r.action, RECONCILE_ACTION.ADD);
  assert.equal(r.reason, 'field_mismatch');
});

test('要約にアドレスを入れない', () => {
  const plan = buildReconcilePlan({
    akEntries: [ready('a@example.com', 3), excluded('b@example.com', 'engaged')],
    sendgridByEmail: {
      'a@example.com': { listIds: ['list-2'], nextMessage: 2 },
      'b@example.com': { listIds: ['list-1'] },
    },
    listIdByMessage: L,
  });
  const s = JSON.stringify(summarizeReconcilePlan(plan));
  assert.equal(/@/.test(s), false, `要約にアドレスが混ざっている: ${s}`);
  assert.equal(summarizeReconcilePlan(plan)['変更予定'], 3);
});

test('変更が多すぎるときは実行しない（人に返す）', () => {
  const n = RECONCILE_LIMITS.maxChanges + 1;
  const many = Array.from({ length: n }, (_, i) => ready(`u${i}@example.com`, 3));
  const sg = {};
  for (let i = 0; i < n; i += 1) sg[`u${i}@example.com`] = { listIds: ['list-2'], nextMessage: 2 };
  const plan = buildReconcilePlan({ akEntries: many, sendgridByEmail: sg, listIdByMessage: L });
  const safety = assertReconcileSafety(plan);
  assert.equal(safety.ok, false);
  assert.equal(safety.violation, 'too_many_changes');
});

test('同じ list に対して外すと入れるを同時に出さない', () => {
  const plan = buildReconcilePlan({
    akEntries: [ready('a@example.com', 1)],
    sendgridByEmail: { 'a@example.com': { listIds: ['list-2'], nextMessage: 2 } },
    listIdByMessage: L,
  });
  assert.equal(assertReconcileSafety(plan).ok, true);
});

test('list id が無ければ計画を作らない（fail closed）', () => {
  const plan = buildReconcilePlan({ akEntries: [ready('a@example.com', 1)], sendgridByEmail: {}, listIdByMessage: {} });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'list_ids_missing');
  assert.equal(summarizeReconcilePlan(plan).ok, false);
});

test('同じアドレスが 2 回来ても 1 回しか数えない', () => {
  const plan = buildReconcilePlan({
    akEntries: [ready('a@example.com', 1), ready('a@example.com', 1)],
    sendgridByEmail: { 'a@example.com': { listIds: ['list-2'], nextMessage: 2 } },
    listIdByMessage: L,
  });
  assert.equal(plan.addByList.get('list-1').length, 1);
  assert.equal(plan.changes, 2, 'remove 1 + add 1');
});

test('【現場の形】投入直後の実測（一致 / 番号が進んだ / 反応で離脱）が 1 回で閉じる', () => {
  const ak = [
    ...Array.from({ length: 5 }, (_, i) => ready(`ok${i}@example.com`, 3)),
    ready('moved1@example.com', 3), ready('moved2@example.com', 3), ready('moved3@example.com', 3),
    excluded('left1@example.com', 'engaged'), excluded('left2@example.com', 'promoted'),
  ];
  const sg = {};
  for (let i = 0; i < 5; i += 1) sg[`ok${i}@example.com`] = { listIds: ['list-3'], nextMessage: 3 };
  for (const e of ['moved1', 'moved2', 'moved3']) sg[`${e}@example.com`] = { listIds: ['list-2'], nextMessage: 2 };
  sg['left1@example.com'] = { listIds: ['list-3'], nextMessage: 3 };
  sg['left2@example.com'] = { listIds: ['list-2'], nextMessage: 2 };

  const plan = buildReconcilePlan({ akEntries: ak, sendgridByEmail: sg, listIdByMessage: L });
  const s = summarizeReconcilePlan(plan);
  assert.equal(s['一致'], 5);
  assert.equal(s['入れ直す'], 3);
  assert.equal(s['退出させる'], 2);
  assert.equal(s['provider rejected（対象外）'], 0);
  assert.equal(s['変更予定'], 3 + 3 + 2, 'remove 3 + add 3 + exit 2');
  assert.equal(assertReconcileSafety(plan).ok, true);
});

// ── 受理されない宛先で batch ごと落ちる問題（2026-09-19 本番実測）────────────

test('【本件】壊れた宛先が 1 件混ざっても、良い宛先を巻き添えにしない', async () => {
  const bad = new Set(['bad@@example', 'broken']);
  const seen = [];
  const r = await runWithSplit(
    ['a@example.com', 'bad@@example', 'b@example.com', 'broken', 'c@example.com'],
    async (chunk) => {
      seen.push(chunk.length);
      if (chunk.some((e) => bad.has(e))) throw new Error('sendgrid_api:http_error');
    },
  );
  assert.equal(r.ok, 3, '良い 3 件は通る');
  assert.deepEqual(r.rejected.sort(), ['bad@@example', 'broken']);
  assert.ok(seen.length > 1, '落ちたら割って再試行している');
});

test('全部通るときは 1 リクエストで終わる（無駄に割らない）', async () => {
  let calls = 0;
  const r = await runWithSplit(['a@example.com', 'b@example.com'], async () => { calls += 1; });
  assert.equal(calls, 1);
  assert.equal(r.ok, 2);
  assert.equal(r.rejected.length, 0);
});

test('全部落ちるときは全件を rejected として返す（成功にしない）', async () => {
  const r = await runWithSplit(['a@example.com', 'b@example.com'], async () => { throw new Error('x'); });
  assert.equal(r.ok, 0);
  assert.equal(r.rejected.length, 2);
});

test('空なら 1 リクエストも出さない', async () => {
  let calls = 0;
  const r = await runWithSplit([], async () => { calls += 1; });
  assert.equal(calls, 0);
  assert.equal(r.ok, 0);
});
