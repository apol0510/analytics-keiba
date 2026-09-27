/**
 * prospectEventBatch.test.mjs — webhook の反映が**途中で止まっても・同時に来ても壊れない**ことの契約
 *   node --test src/lib/marketing/prospectEventBatch.test.mjs
 *
 * ## 何を守るか（2026-09-26〜27 の本番事故と、その後のレビュー指摘）
 *
 * 大量の打ち切りで webhook が途中で止まり、23 件が不整合になった
 * （EXHAUSTED なのに送信候補索引に残る 5 件 / どの索引にも居ない 18 件）。
 * さらに「読む → 計算 → 書く」の間に同じ相手へ別の更新が入ると、後から書いた方が
 * 先の更新を**黙って消す**（lost update）。
 *
 * 守る条件（MK 指定の 6 項目）:
 *   1. 同一人物へ異なる 2 イベントが並行しても片方を失わない
 *   2. delivered / open / click / 配信停止 などの状態遷移が競合しても後勝ちで消えない
 *   3. `sg_event_id` の冪等性（同じイベントは 1 回だけ）
 *   4. 書き込み失敗 → 再送で正確に 1 回だけ反映
 *   5. 時間切れで途中停止 → 503 → 再送で完全回復
 *   6. レコード・送信候補索引・反応済み索引・抑止台帳が常に整合
 *
 * 偽 Redis は `PROSPECT_CAS_LUA` と同じ意味（比較して書く・1 回の EVAL は原子的）を再現する。
 * 読みにバリアを掛けて「両方が同じ値を読んでから書く」最悪の順序を**決定的に**作る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  applyProspectEventBatch, applyProspectUpdate, PROSPECT_BATCH_CHUNK, PROSPECT_CHUNK_ESTIMATE_MS,
} from './prospectEventBatch.js';
import {
  createProspectStore, emailHash, prospectKey, blockedKey,
  ACTIVE_INDEX, ENGAGED_INDEX, BLOCKED_INDEX, APPLIED_EVENT_IDS_CAP, STORE_FAIL,
  PROSPECT_CAS_LUA, CAS_ATTEMPTS,
} from './prospectStore.js';
import {
  buildProspect, PROSPECT_STATE, classifyEvent, SUPPRESS_REASON, applySuppression,
} from './prospectPolicy.js';
import { planProspectEventUpdates } from './prospectPipeline.js';
import { isProspectCasEval, emulateProspectCas } from './prospectCasFakeForTests.mjs';

const NOW = Date.UTC(2026, 8, 27, 10);
const ENV = {};   // 打ち切り閾値は既定（delivered 10）
const tick = () => new Promise((r) => setImmediate(r));

/**
 * Upstash 相当。EVAL（比較して書く）は**同期的に一気に**実行する＝原子的。
 * - `failNextEval()`: 次の EVAL を 1 回だけ失敗させる（ネットワーク断・何も書かれない）
 * - `holdReads(n)`: 読み（GET / MGET）を n 本そろうまで待たせる（同じ値を読ませる）
 * - `beforeEval(fn)`: EVAL の直前に割り込みを入れる（読んだ後に誰かが書いた、を作る）
 */
function fakeRedis() {
  const kv = new Map();
  const sets = new Map();
  const stats = { reads: 0, evals: 0 };
  let failNextEval = false;
  let barrier = null;
  let hook = null;
  const setOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
  const io = {
    get: (k) => (kv.has(k) ? kv.get(k) : null),
    set: (k, v) => kv.set(k, String(v)),
    del: (k) => kv.delete(k),
    sadd: (k, m) => setOf(k).add(m),
    srem: (k, m) => setOf(k).delete(m),
    has: (k, m) => setOf(k).has(m),
  };
  const waitBarrier = async () => {
    if (!barrier) return;
    barrier.arrived += 1;
    if (barrier.arrived >= barrier.n) { const b = barrier; barrier = null; b.release(); return; }
    await barrier.promise;
  };
  const cmd = async (args) => {
    const op = String(args[0]).toUpperCase();
    await tick();
    if (op === 'GET' || op === 'MGET') {
      stats.reads += 1;
      await waitBarrier();
      if (op === 'GET') return io.get(args[1]);
      return args.slice(1).map(io.get);
    }
    if (isProspectCasEval(args)) {
      stats.evals += 1;
      if (hook) { const h = hook; hook = null; await h(); }
      if (failNextEval) { failNextEval = false; throw new Error('upstash 500'); }
      return emulateProspectCas(args, io);
    }
    if (op === 'EXISTS') return kv.has(args[1]) ? 1 : 0;
    if (op === 'SMEMBERS') return [...setOf(args[1])];
    if (op === 'SCARD') return setOf(args[1]).size;
    if (op === 'SISMEMBER') return setOf(args[1]).has(args[2]) ? 1 : 0;
    throw new Error(`unsupported ${op}`);
  };
  return {
    kv, sets, stats, cmd, setOf,
    failOnce() { failNextEval = true; },
    holdReads(n) {
      let release; const promise = new Promise((r) => { release = r; });
      barrier = { n, arrived: 0, promise, release };
    },
    beforeEval(fn) { hook = fn; },
    record: (email) => { const r = kv.get(prospectKey(emailHash(email))); return r ? JSON.parse(r) : null; },
  };
}

const seed = (r, email, over = {}) => {
  const p = { ...buildProspect({ email, nowMs: NOW - 86_400_000, batchId: 'b', source: 'csv' }), state: PROSPECT_STATE.SENDING, ...over };
  const h = emailHash(email);
  r.kv.set(prospectKey(h), JSON.stringify(p));
  const sendable = p.state === PROSPECT_STATE.NEW || p.state === PROSPECT_STATE.SENDING;
  if (sendable) r.setOf(ACTIVE_INDEX).add(h);
  if (p.state === PROSPECT_STATE.ENGAGED) r.setOf(ENGAGED_INDEX).add(h);
  return h;
};

const ev = (email, event, id) => ({ email, event, sg_event_id: id });
const plan = (events) => planProspectEventUpdates({ events, classify: classifyEvent }).updates;
const storeOf = (r) => createProspectStore({ cmd: r.cmd });

/** 6. 不変条件: レコードの state と 3 つの索引・抑止台帳が一致している */
function assertConsistent(r) {
  const active = r.setOf(ACTIVE_INDEX);
  const engaged = r.setOf(ENGAGED_INDEX);
  const blocked = r.setOf(BLOCKED_INDEX);
  for (const [k, v] of r.kv) {
    if (!k.startsWith('ak:prospect:p:')) continue;
    const h = k.slice('ak:prospect:p:'.length);
    const s = JSON.parse(v).state;
    const sendable = s === PROSPECT_STATE.NEW || s === PROSPECT_STATE.SENDING;
    assert.equal(active.has(h), sendable, `送信候補索引が state=${s} と食い違う`);
    assert.equal(engaged.has(h), s === PROSPECT_STATE.ENGAGED, `反応済み索引が state=${s} と食い違う`);
    if (s === PROSPECT_STATE.EXHAUSTED || s === PROSPECT_STATE.SUPPRESSED) {
      assert.equal(blocked.has(h), true, `抑止索引に居ない（state=${s}）`);
      assert.ok(r.kv.has(blockedKey(h)), '抑止台帳が無い');
    }
  }
}

/**
 * 並行の結果が「どちらかを先に・もう片方を後に」順に処理した結果の**どれか**と一致するか（直列化可能性）。
 * ⚠️ 後勝ちなら、先に書いた方の変化が**どの順序の結果とも一致しない**形で消える。
 * （delivered は ENGAGED / SUPPRESSED の後では数えない仕様なので、順序で delivered の値は変わり得る）
 */
const CORE = ['state', 'delivered', 'opens', 'clicks', 'sends'];
const core = (p) => Object.fromEntries(CORE.map((k) => [k, p[k] ?? 0]));
function serialOutcomes(initial, steps) {
  const perms = steps.length === 2 ? [[0, 1], [1, 0]] : [steps.map((_, i) => i)];
  return perms.map((order) => core(order.reduce((p, i) => steps[i](p), initial)));
}
const stepOf = (update) => (p) => applyProspectUpdate({ prospect: p, update, nowMs: NOW, env: ENV }).next;
function assertSerializable(actual, initial, steps) {
  const options = serialOutcomes(initial, steps);
  const got = core(actual);
  assert.ok(options.some((o) => JSON.stringify(o) === JSON.stringify(got)),
    `どの直列順序の結果とも一致しない（後勝ちで片方が消えた）: got=${JSON.stringify(got)} options=${JSON.stringify(options)}`);
}

// ── 1 / 2. 並行しても片方を失わない（lost update が起きない）───────────────
test('【1】同じ人へ delivered と open が別々の webhook で同時に来ても、両方が残る', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 5 });
  r.holdReads(2);   // 2 つの呼び出しが**同じ値を読んでから**書く（最悪の順序）
  const [x, y] = await Promise.all([
    applyProspectEventBatch({ updates: plan([ev('a@example.test', 'delivered', 'sg-evt-0000000011')]), store: storeOf(r), nowMs: NOW, env: ENV }),
    applyProspectEventBatch({ updates: plan([ev('a@example.test', 'open', 'sg-evt-0000000012')]), store: storeOf(r), nowMs: NOW, env: ENV }),
  ]);
  const rec = r.record('a@example.test');
  assert.equal(rec.opens, 1, 'open が後勝ちで消えた');
  assert.equal(rec.state, PROSPECT_STATE.ENGAGED);
  // 両方のイベントが「反映済み」として残っている（どちらも捨てられていない）
  assert.deepEqual([...rec.appliedEventIds].sort(), ['sg-evt-0000000011', 'sg-evt-0000000012']);
  const initial = { ...buildProspect({ email: 'a@example.test', nowMs: NOW - 86_400_000 }), state: PROSPECT_STATE.SENDING, delivered: 5 };
  assertSerializable(rec, initial, [
    stepOf(plan([ev('a@example.test', 'delivered', 'sg-evt-0000000011')])[0]),
    stepOf(plan([ev('a@example.test', 'open', 'sg-evt-0000000012')])[0]),
  ]);
  assert.equal(x.conflictsRetried + y.conflictsRetried, 1, '衝突した片方が読み直していない');
  assert.equal(x.incomplete || y.incomplete, false);
  assertConsistent(r);
});

test('【2】打ち切り（10 通目の delivered）と click が競合しても、反応が勝ち打ち切られない', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 9 });
  r.holdReads(2);
  await Promise.all([
    applyProspectEventBatch({ updates: plan([ev('a@example.test', 'delivered', 'sg-evt-0000000021')]), store: storeOf(r), nowMs: NOW, env: ENV }),
    applyProspectEventBatch({ updates: plan([ev('a@example.test', 'click', 'sg-evt-0000000022')]), store: storeOf(r), nowMs: NOW, env: ENV }),
  ]);
  const rec = r.record('a@example.test');
  assert.equal(rec.clicks, 1, 'click が消えた');
  assert.equal(rec.delivered >= 9, true);
  // 反応した人は打ち切り（EXHAUSTED）のまま残らない。どちらの順でも ENGAGED か、ENGAGED になった後の delivered
  assert.equal(rec.state, PROSPECT_STATE.ENGAGED, `state=${rec.state}`);
  assertConsistent(r);
});

test('【2】配信停止と delivered が競合しても、配信停止は消えない（復活しない）', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 3 });
  r.holdReads(2);
  const store = storeOf(r);
  await Promise.all([
    applyProspectEventBatch({ updates: plan([ev('a@example.test', 'delivered', 'sg-evt-0000000031')]), store, nowMs: NOW, env: ENV }),
    // 配信停止ページ（unsubscribe.js）と同じ経路
    store.recordSuppression({ email: 'a@example.test', nowMs: NOW, reason: SUPPRESS_REASON.UNSUBSCRIBE }),
  ]);
  const rec = r.record('a@example.test');
  assert.equal(rec.state, PROSPECT_STATE.SUPPRESSED, '配信停止が後勝ちで消えた');
  assert.ok(rec.appliedEventIds.includes('sg-evt-0000000031'), 'delivered イベントが捨てられた');
  const initial = { ...buildProspect({ email: 'a@example.test', nowMs: NOW - 86_400_000 }), state: PROSPECT_STATE.SENDING, delivered: 3 };
  assertSerializable(rec, initial, [
    stepOf(plan([ev('a@example.test', 'delivered', 'sg-evt-0000000031')])[0]),
    (p) => applySuppression({ prospect: p, nowMs: NOW, reason: SUPPRESS_REASON.UNSUBSCRIBE }).prospect,
  ]);
  assertConsistent(r);
});

test('【2】管理 API（送信の記録）と webhook（open）が競合しても両方残る', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { sends: 2, delivered: 2 });
  r.holdReads(2);
  const store = storeOf(r);
  await Promise.all([
    store.recordSend({ email: 'a@example.test', nowMs: NOW, runId: 'run-1' }),
    applyProspectEventBatch({ updates: plan([ev('a@example.test', 'open', 'sg-evt-0000000041')]), store, nowMs: NOW, env: ENV }),
  ]);
  const rec = r.record('a@example.test');
  assert.equal(rec.sends, 3, '送信の記録が消えた');
  assert.equal(rec.opens, 1, 'open が消えた');
  assertConsistent(r);
});

test('【2】同じ人へ 5 本の webhook が同時に来ても、全部 1 回ずつ反映される', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 0 });
  r.holdReads(5);
  await Promise.all(Array.from({ length: 5 }, (_, i) => applyProspectEventBatch({
    updates: plan([ev('a@example.test', 'delivered', `sg-evt-00000005${i}0`)]), store: storeOf(r), nowMs: NOW, env: ENV,
  })));
  assert.equal(r.record('a@example.test').delivered, 5);
  assertConsistent(r);
});

test('書き込みが集中し続けて読み直しが上限に達したら、書かずに未完了として返す', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 1 });
  const store = storeOf(r);
  let n = 0;
  const churn = async () => {       // 毎回、EVAL の直前に誰かが書く
    n += 1;
    const h = emailHash('a@example.test');
    const cur = JSON.parse(r.kv.get(prospectKey(h)));
    r.kv.set(prospectKey(h), JSON.stringify({ ...cur, sends: (cur.sends || 0) + 1 }));
    if (n < CAS_ATTEMPTS) r.beforeEval(churn);
  };
  r.beforeEval(churn);
  const out = await applyProspectEventBatch({
    updates: plan([ev('a@example.test', 'delivered', 'sg-evt-0000000061')]), store, nowMs: NOW, env: ENV,
  });
  assert.equal(out.incomplete, true);
  assert.equal(out.reason, 'cas_conflict');
  assert.equal(out.remaining, 1);
  assert.equal(r.record('a@example.test').delivered, 1, '衝突したまま書いた');
});

test('store の更新も読み直しが上限に達したら CAS_CONFLICT で止まる（黙って上書きしない）', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 1 });
  const store = storeOf(r);
  const churn = async () => {
    const h = emailHash('a@example.test');
    const cur = JSON.parse(r.kv.get(prospectKey(h)));
    r.kv.set(prospectKey(h), JSON.stringify({ ...cur, sends: (cur.sends || 0) + 1 }));
    r.beforeEval(churn);
  };
  r.beforeEval(churn);
  await assert.rejects(
    store.recordDelivered({ email: 'a@example.test', nowMs: NOW, env: ENV }),
    (e) => e.code === STORE_FAIL.CAS_CONFLICT,
  );
  assert.equal(r.record('a@example.test').delivered, 1);
});

// ── 3. sg_event_id の冪等性 ─────────────────────────────────────
test('【3】同じイベントを 2 回流しても delivered は 1 回しか増えない', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 3 });
  const updates = plan([ev('a@example.test', 'delivered', 'sg-evt-0000000071')]);
  await applyProspectEventBatch({ updates, store: storeOf(r), nowMs: NOW, env: ENV });
  const again = await applyProspectEventBatch({ updates, store: storeOf(r), nowMs: NOW, env: ENV });
  assert.equal(r.record('a@example.test').delivered, 4);
  assert.equal(again.duplicate, 1);
  assert.equal(again.delivered, 0);
  assertConsistent(r);
});

test('【3】同じイベントが 2 本の呼び出しで同時に処理されても 1 回だけ数える', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 3 });
  const updates = plan([ev('a@example.test', 'delivered', 'sg-evt-0000000081')]);
  r.holdReads(2);
  await Promise.all([
    applyProspectEventBatch({ updates, store: storeOf(r), nowMs: NOW, env: ENV }),
    applyProspectEventBatch({ updates, store: storeOf(r), nowMs: NOW, env: ENV }),
  ]);
  assert.equal(r.record('a@example.test').delivered, 4, '同じイベントを 2 回数えた');
  assertConsistent(r);
});

test('【3】反映済みの印は古いものから落とし、上限を超えない', () => {
  const ids = Array.from({ length: APPLIED_EVENT_IDS_CAP }, (_, i) => `sg-evt-old-${String(i).padStart(6, '0')}`);
  const res = applyProspectUpdate({
    prospect: { state: PROSPECT_STATE.SENDING, delivered: 1, appliedEventIds: ids },
    update: { email: 'a@example.test', action: 'delivered', eventIds: ['sg-evt-new-000001'] },
    nowMs: NOW, env: ENV,
  });
  assert.equal(res.next.appliedEventIds.length, APPLIED_EVENT_IDS_CAP);
  assert.equal(res.next.appliedEventIds.at(-1), 'sg-evt-new-000001');
  assert.equal(res.next.appliedEventIds[0], ids[1]);
});

// ── 4. 書き込み失敗 → 再送で正確に 1 回 ─────────────────────────────
test('【4】書き込み（EVAL）が失敗したら 1 件も書かず・数えず、再送で正確に 1 回だけ反映', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 9 });
  const before = JSON.stringify([...r.kv]);
  r.failOnce();
  const updates = plan([ev('a@example.test', 'delivered', 'sg-evt-0000000091')]);
  const out = await applyProspectEventBatch({ updates, store: storeOf(r), nowMs: NOW, env: ENV });
  assert.equal(JSON.stringify([...r.kv]), before, '失敗したのに何か書かれている');
  assert.equal(out.incomplete, true);
  assert.equal(out.reason, 'write_failed');
  assert.equal(out.delivered, 0);
  assert.equal(out.changes.length, 0, '書けていないのに list から外そうとしている');
  const retry = await applyProspectEventBatch({ updates, store: storeOf(r), nowMs: NOW, env: ENV });
  const again = await applyProspectEventBatch({ updates, store: storeOf(r), nowMs: NOW, env: ENV });
  assert.equal(retry.exhausted, 1);
  assert.equal(again.duplicate, 1);
  assert.equal(r.record('a@example.test').delivered, 10, '再送で 1 回ちょうどになっていない');
  assert.equal(r.record('a@example.test').state, PROSPECT_STATE.EXHAUSTED);
  assertConsistent(r);
});

test('【4】store の書き込み失敗も何も残さない（配信停止ページ・管理 API の経路）', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 9 });
  const store = storeOf(r);
  r.failOnce();
  await assert.rejects(
    store.recordDelivered({ email: 'a@example.test', nowMs: NOW, env: ENV }),
    (e) => e.code === STORE_FAIL.CAS_FAILED,
  );
  assert.equal(r.record('a@example.test').delivered, 9);
  await store.recordDelivered({ email: 'a@example.test', nowMs: NOW, env: ENV });
  assert.equal(r.record('a@example.test').state, PROSPECT_STATE.EXHAUSTED);
  assertConsistent(r);
});

// ── 5. 時間切れ → 503 → 再送で完全回復 ────────────────────────────
test('【5】時間切れで止まっても、同じバッチを流し直せば全員ちょうど 1 回ずつ数えられる', async () => {
  const r = fakeRedis();
  const emails = Array.from({ length: 180 }, (_, i) => `u${i}@example.test`);
  for (const e of emails) seed(r, e, { delivered: 9 });
  const updates = plan(emails.map((e, i) => ev(e, 'delivered', `sg-evt-${String(i).padStart(10, '0')}`)));

  let t = 0;
  const first = await applyProspectEventBatch({
    updates, store: storeOf(r), nowMs: NOW, env: ENV,
    nowFn: () => { t += 1000; return t; },
    deadlineAtMs: 1000 + PROSPECT_CHUNK_ESTIMATE_MS - 1,   // 2 塊目の開始判定で見積りが 1ms はみ出す
  });
  assert.equal(first.incomplete, true);
  assert.equal(first.reason, 'time_budget_exhausted');
  assert.equal(first.remaining, 180 - PROSPECT_BATCH_CHUNK);
  assertConsistent(r);   // 止まった時点でも不整合が無い

  const second = await applyProspectEventBatch({ updates, store: storeOf(r), nowMs: NOW, env: ENV });
  assert.equal(second.incomplete, false);
  assert.equal(second.duplicate, PROSPECT_BATCH_CHUNK);
  assert.equal(second.exhausted, 180 - PROSPECT_BATCH_CHUNK);
  for (const e of emails) assert.equal(r.record(e).delivered, 10, '二重に数えた・数え漏れた');
  assertConsistent(r);
  assert.equal(second.changes.length, 180, '再送で list から外す対象を積んでいない');
});

// ── 6. 整合（過去の部分書き込みも直る）──────────────────────────────
test('【6】打ち切りは レコード・索引・抑止台帳 が 1 回の EVAL で揃う', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 9 });
  r.stats.evals = 0;
  await applyProspectEventBatch({
    updates: plan([ev('a@example.test', 'delivered', 'sg-evt-0000000101')]), store: storeOf(r), nowMs: NOW, env: ENV,
  });
  assert.equal(r.stats.evals, 1);
  assertConsistent(r);
});

test('【6】過去の部分書き込み（5 名型 / 18 名型）が次のイベントで直る', async () => {
  const r = fakeRedis();
  const h5 = seed(r, 'five@example.test', { delivered: 10 });
  r.kv.set(prospectKey(h5), JSON.stringify({ ...JSON.parse(r.kv.get(prospectKey(h5))), state: PROSPECT_STATE.EXHAUSTED, suppressedReason: 'delivered_without_open' }));
  const h18 = seed(r, 'eighteen@example.test', { delivered: 10, state: PROSPECT_STATE.EXHAUSTED, suppressedReason: 'delivered_without_open' });
  const out = await applyProspectEventBatch({
    updates: plan([ev('five@example.test', 'delivered', 'sg-evt-0000000111'), ev('eighteen@example.test', 'delivered', 'sg-evt-0000000112')]),
    store: storeOf(r), nowMs: NOW, env: ENV,
  });
  assert.equal(out.incomplete, false);
  assertConsistent(r);
  assert.equal(r.setOf(ACTIVE_INDEX).has(h5), false);
  assert.equal(r.setOf(BLOCKED_INDEX).has(h18), true);
});

test('【6】再送（反映済み）のときも、数え直さずに索引だけ張り直す', async () => {
  const r = fakeRedis();
  const h = seed(r, 'a@example.test', { delivered: 10, state: PROSPECT_STATE.EXHAUSTED, appliedEventIds: ['sg-evt-0000000121'] });
  r.setOf(ACTIVE_INDEX).add(h);   // 部分書き込みを再現
  const out = await applyProspectEventBatch({
    updates: plan([ev('a@example.test', 'delivered', 'sg-evt-0000000121')]), store: storeOf(r), nowMs: NOW, env: ENV,
  });
  assert.equal(out.duplicate, 1);
  assert.equal(r.record('a@example.test').delivered, 10);
  assertConsistent(r);
});

test('【6】並行処理の後も、1,000 名ぶんの全員が整合する（2 本の webhook が半分ずつ重なる）', async () => {
  const r = fakeRedis();
  const emails = Array.from({ length: 200 }, (_, i) => `c${i}@example.test`);
  for (const e of emails) seed(r, e, { delivered: 9 });
  const a = plan(emails.map((e, i) => ev(e, 'delivered', `sg-evt-a${String(i).padStart(9, '0')}`)));
  const b = plan(emails.slice(0, 100).map((e, i) => ev(e, 'open', `sg-evt-b${String(i).padStart(9, '0')}`)));
  r.holdReads(2);
  await Promise.all([
    applyProspectEventBatch({ updates: a, store: storeOf(r), nowMs: NOW, env: ENV }),
    applyProspectEventBatch({ updates: b, store: storeOf(r), nowMs: NOW, env: ENV }),
  ]);
  for (const e of emails.slice(0, 100)) {
    const rec = r.record(e);
    assert.equal(rec.opens, 1, 'open が消えた');
    assert.equal(rec.state, PROSPECT_STATE.ENGAGED);
  }
  for (const e of emails.slice(100)) assert.equal(r.record(e).state, PROSPECT_STATE.EXHAUSTED);
  for (const e of emails) assert.equal(r.record(e).delivered >= 9, true);
  assertConsistent(r);
});

// ── 時間内に収める（往復数）────────────────────────────────────────
test('大量打ち切り（1,000 名）でも衝突が無ければ 1 塊 2 往復', async () => {
  const r = fakeRedis();
  const emails = Array.from({ length: 1000 }, (_, i) => `m${i}@example.test`);
  for (const e of emails) seed(r, e, { delivered: 9 });
  r.stats.reads = 0; r.stats.evals = 0;
  const out = await applyProspectEventBatch({
    updates: plan(emails.map((e, i) => ev(e, 'delivered', `sg-evt-m${String(i).padStart(9, '0')}`))),
    store: storeOf(r), nowMs: NOW, env: ENV,
  });
  const chunks = Math.ceil(1000 / PROSPECT_BATCH_CHUNK);
  assert.equal(out.exhausted, 1000);
  assert.equal(r.stats.evals, chunks);
  assert.equal(r.stats.reads, chunks);
  assertConsistent(r);
});

test('見つからない相手（Customers 宛など）は書かずに数えるだけ', async () => {
  const r = fakeRedis();
  const out = await applyProspectEventBatch({
    updates: plan([ev('nobody@example.test', 'delivered', 'sg-evt-0000000131')]), store: storeOf(r), nowMs: NOW, env: ENV,
  });
  assert.equal(out.notFound, 1);
  assert.equal(r.stats.evals, 0);
});

test('イベント ID が欠けた相手は「重複を防げない」と記録する', () => {
  const ups = plan([
    ev('a@example.test', 'delivered', 'sg-evt-0000000141'),
    ev('a@example.test', 'open', 'sg-evt-0000000142'),
    { email: 'b@example.test', event: 'delivered' },
  ]);
  const a = ups.find((u) => u.email === 'a@example.test');
  const b = ups.find((u) => u.email === 'b@example.test');
  assert.deepEqual(a.eventIds, ['sg-evt-0000000141', 'sg-evt-0000000142']);
  assert.equal(a.eventIdsComplete, true);
  assert.equal(b.eventIdsComplete, false);
});

// ── スクリプトと配線 ─────────────────────────────────────────────
test('CAS スクリプトは鍵を KEYS でだけ受け取り、TTL を付けず、SHA1 で比べる', () => {
  assert.match(PROSPECT_CAS_LUA, /redis\.sha1hex\(cur\) == expect/);
  assert.match(PROSPECT_CAS_LUA, /expect == 'ABSENT'/);
  assert.equal(/EXPIRE|'EX'|PEXPIRE/.test(PROSPECT_CAS_LUA), false);
  // 鍵を文字列連結で組み立てない（全部 KEYS）
  assert.equal(/\.\.\s*hash|'ak:prospect:/.test(PROSPECT_CAS_LUA), false);
});

test('store は prospect の record / 索引 / 台帳へ EVAL 以外で書かない', () => {
  const src = readFileSync(fileURLToPath(new URL('./prospectStore.js', import.meta.url)), 'utf8');
  for (const bad of ["call(['SET', prospectKey", "call(['SADD', ACTIVE_INDEX", "call(['SREM', ACTIVE_INDEX",
    "call(['SADD', ENGAGED_INDEX", "call(['SREM', ENGAGED_INDEX", "call(['SET', blockedKey", "call(['SADD', BLOCKED_INDEX",
    "call(['DEL', prospectKey"]) {
    assert.equal(src.includes(bad), false, `比較せずに書いている: ${bad}`);
  }
});

const HOOK = readFileSync(fileURLToPath(new URL('../../../netlify/functions/sendgrid-webhook.js', import.meta.url)), 'utf8');

test('webhook は反映より先に「処理済み」の印を付けない', () => {
  assert.equal(/filterUnseen\(/.test(HOOK), false);
  assert.equal(/createEventOnceStore/.test(HOOK), false);
  assert.match(HOOK, /applyProspectEventBatch\(\{/);
});

test('webhook は反映が終わらなければ（重複を防げるときだけ）再送を求める', () => {
  assert.match(HOOK, /const retryForProspect = prospect\.incomplete === true && prospectGuarded === true/);
  assert.match(HOOK, /updates\.every\(\(u\) => u\.eventIdsComplete === true\)/);
});

test('締め切りは Netlify の 60 秒（変更不可）の手前に、反映 → list 除去の順で置く', () => {
  const num = (name) => Number(String((new RegExp(`const ${name} = ([0-9_]+);`).exec(HOOK) || [])[1] || '').replace(/_/g, ''));
  const prospectMs = num('PROSPECT_DEADLINE_MS');
  const exitMs = num('SELECTION_EXIT_DEADLINE_MS');
  assert.ok(prospectMs > 0 && exitMs > prospectMs, '反映より後に list 除去の締め切りを置いていない');
  assert.ok(exitMs + 1500 <= 60_000 - 5_000, '打ち切り（60 秒）までの余裕が 5 秒未満');
  assert.match(HOOK, /deadlineAtMs: receivedAtMs \+ PROSPECT_DEADLINE_MS/);
});
