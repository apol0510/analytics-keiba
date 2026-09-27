/**
 * prospectEventBatch.test.mjs — webhook の反映が**途中で止まっても壊れない**ことの契約
 *   node --test src/lib/marketing/prospectEventBatch.test.mjs
 *
 * ## 何を守るか（2026-09-26〜27 の本番事故）
 *
 * 大量の打ち切りで webhook が途中で止まり、23 件が不整合になった:
 *   - 5 件: レコードは EXHAUSTED なのに送信候補索引に残る
 *   - 18 件: レコードは EXHAUSTED なのにどの索引にも居ない
 * さらに「処理済み」の印を反映より先に付けていたので、止まった後ろのイベントは再送されても捨てられた。
 *
 * 守る条件:
 *   1. レコード・送信候補索引・反応済み索引・抑止台帳は**全部か何も無いか**（transaction）
 *   2. 反映済みの印はレコードと同じ書き込みの中。**書けなければ印も付かない**
 *   3. 同じイベントを何度流しても delivered は 1 回しか増えない（冪等）
 *   4. 途中で止まっても、**同じバッチを流し直せば**正しい最終状態になる（回復可能）
 *   5. 再送のときは索引・台帳を state に合わせて張り直す（過去の部分書き込みも直る）
 *   6. 1 塊 = 2 往復。締め切りを越えそうなら新しい塊を始めず、残りを未完了として返す
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
} from './prospectStore.js';
import { buildProspect, PROSPECT_STATE, classifyEvent } from './prospectPolicy.js';
import { planProspectEventUpdates } from './prospectPipeline.js';
import { makeRedisTransaction } from './deliveryKeyStore.js';

const NOW = Date.UTC(2026, 8, 27, 10);
const ENV = {};   // 打ち切り閾値は既定（delivered 10）

/** Upstash 相当。transaction は**全部適用か何もしないか**。`failNextTx` で 1 回だけ失敗させる */
function fakeRedis() {
  const kv = new Map();
  const sets = new Map();
  const stats = { cmd: 0, tx: 0, mget: 0 };
  let failNextTx = false;
  const setOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
  const exec = (args) => {
    const [op, key, ...rest] = args;
    switch (String(op).toUpperCase()) {
      case 'GET': return kv.has(key) ? kv.get(key) : null;
      case 'MGET': stats.mget += 1; return [key, ...rest].map((k) => (kv.has(k) ? kv.get(k) : null));
      case 'SET': kv.set(key, rest[0]); return 'OK';
      case 'SADD': { const s = setOf(key); let n = 0; for (const m of rest) if (!s.has(m)) { s.add(m); n += 1; } return n; }
      case 'SREM': { const s = setOf(key); let n = 0; for (const m of rest) if (s.delete(m)) n += 1; return n; }
      case 'SISMEMBER': return setOf(key).has(rest[0]) ? 1 : 0;
      case 'SMEMBERS': return [...setOf(key)];
      case 'SCARD': return setOf(key).size;
      case 'EXISTS': return kv.has(key) ? 1 : 0;
      default: throw new Error(`unsupported ${op}`);
    }
  };
  const cmd = async (args) => { stats.cmd += 1; return exec(args); };
  const transaction = async (commands) => {
    stats.tx += 1;
    if (failNextTx) { failNextTx = false; throw new Error('upstash 500'); }
    // 全部を先に検証してから適用（実物の MULTI/EXEC と同じく途中の 1 つだけ反映しない）
    const snapshotKv = new Map(kv);
    const snapshotSets = new Map([...sets].map(([k, v]) => [k, new Set(v)]));
    try { return commands.map(exec); } catch (e) {
      kv.clear(); for (const [k, v] of snapshotKv) kv.set(k, v);
      sets.clear(); for (const [k, v] of snapshotSets) sets.set(k, v);
      throw e;
    }
  };
  return {
    kv, sets, stats, cmd, transaction,
    failOnce() { failNextTx = true; },
    record: (email) => { const r = kv.get(prospectKey(emailHash(email))); return r ? JSON.parse(r) : null; },
  };
}

const seed = (r, email, over = {}) => {
  const p = { ...buildProspect({ email, nowMs: NOW - 86_400_000, batchId: 'b', source: 'csv' }), state: PROSPECT_STATE.SENDING, ...over };
  const h = emailHash(email);
  r.kv.set(prospectKey(h), JSON.stringify(p));
  const sendable = p.state === PROSPECT_STATE.NEW || p.state === PROSPECT_STATE.SENDING;
  if (sendable) r.sets.has(ACTIVE_INDEX) ? r.sets.get(ACTIVE_INDEX).add(h) : r.sets.set(ACTIVE_INDEX, new Set([h]));
  return h;
};

const deliveredEvent = (email, id) => ({ email, event: 'delivered', sg_event_id: id });
const plan = (events) => planProspectEventUpdates({ events, classify: classifyEvent }).updates;

/** 不変条件: record の state と 3 つの索引・抑止台帳が一致している */
function assertConsistent(r) {
  const active = r.sets.get(ACTIVE_INDEX) || new Set();
  const engaged = r.sets.get(ENGAGED_INDEX) || new Set();
  const blocked = r.sets.get(BLOCKED_INDEX) || new Set();
  for (const [k, v] of r.kv) {
    if (!k.startsWith('ak:prospect:p:')) continue;
    const h = k.slice('ak:prospect:p:'.length);
    const s = JSON.parse(v).state;
    const sendable = s === PROSPECT_STATE.NEW || s === PROSPECT_STATE.SENDING;
    assert.equal(active.has(h), sendable, `送信候補索引が state=${s} と食い違う`);
    assert.equal(engaged.has(h), s === PROSPECT_STATE.ENGAGED, `反応済み索引が state=${s} と食い違う`);
    const shouldBlock = s === PROSPECT_STATE.EXHAUSTED || s === PROSPECT_STATE.SUPPRESSED;
    if (shouldBlock) {
      assert.equal(blocked.has(h), true, `抑止索引に居ない（state=${s}）`);
      assert.ok(r.kv.has(blockedKey(h)), '抑止台帳が無い');
    }
  }
}

const storeOf = (r, { withTx = true } = {}) => createProspectStore({
  cmd: r.cmd, ...(withTx ? { transaction: r.transaction } : {}),
});

// ── 1. 冪等 ─────────────────────────────────────────────────────
test('同じイベントを 2 回流しても delivered は 1 回しか増えない', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 3 });
  const updates = plan([deliveredEvent('a@example.test', 'sg-evt-0000000001')]);
  await applyProspectEventBatch({ updates, store: storeOf(r), nowMs: NOW, env: ENV });
  const again = await applyProspectEventBatch({ updates, store: storeOf(r), nowMs: NOW, env: ENV });
  assert.equal(r.record('a@example.test').delivered, 4);
  assert.equal(again.duplicate, 1);
  assert.equal(again.delivered, 0);
  assert.deepEqual(r.record('a@example.test').appliedEventIds, ['sg-evt-0000000001']);
  assertConsistent(r);
});

test('反映済みの印は古いものから落とし、上限を超えない', () => {
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

// ── 2. 原子性（書けなければ何も残らない・印も付かない）──────────────
test('transaction が失敗したら 1 件も書かず、数えず、未完了として返す', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 9 });
  const before = JSON.stringify([...r.kv]);
  r.failOnce();
  const updates = plan([deliveredEvent('a@example.test', 'sg-evt-0000000002')]);
  const out = await applyProspectEventBatch({ updates, store: storeOf(r), nowMs: NOW, env: ENV });
  assert.equal(JSON.stringify([...r.kv]), before, '失敗したのに何か書かれている');
  assert.equal(out.incomplete, true);
  assert.equal(out.reason, 'write_failed');
  assert.equal(out.delivered, 0);
  assert.equal(out.exhausted, 0);
  assert.equal(out.changes.length, 0, '書けていないのに list から外そうとしている');
  // 再送で回復する（印が先に付いていないので捨てられない）
  const retry = await applyProspectEventBatch({ updates, store: storeOf(r), nowMs: NOW, env: ENV });
  assert.equal(retry.exhausted, 1);
  assert.equal(r.record('a@example.test').state, PROSPECT_STATE.EXHAUSTED);
  assert.equal(r.record('a@example.test').delivered, 10);
  assertConsistent(r);
});

test('transaction が無い store では 1 件も書かない（ばらばらに書いて不整合を作らない）', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 9 });
  const out = await applyProspectEventBatch({
    updates: plan([deliveredEvent('a@example.test', 'sg-evt-0000000003')]),
    store: storeOf(r, { withTx: false }), nowMs: NOW, env: ENV,
  });
  assert.equal(out.incomplete, true);
  assert.equal(out.reason, 'transaction_unavailable');
  assert.equal(r.record('a@example.test').delivered, 9);
});

test('打ち切りは レコード・索引・抑止台帳 が 1 回の transaction で揃う', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 9 });
  const txBefore = r.stats.tx;
  await applyProspectEventBatch({
    updates: plan([deliveredEvent('a@example.test', 'sg-evt-0000000004')]),
    store: storeOf(r), nowMs: NOW, env: ENV,
  });
  assert.equal(r.stats.tx - txBefore, 1);
  assertConsistent(r);
});

test('store.write も transaction があれば 1 回で書き、失敗なら何も残さない', async () => {
  const r = fakeRedis();
  seed(r, 'a@example.test', { delivered: 9 });
  const store = storeOf(r);
  r.failOnce();
  await assert.rejects(
    store.recordDelivered({ email: 'a@example.test', nowMs: NOW, env: ENV }),
    (e) => e.code === STORE_FAIL.TRANSACTION_FAILED,
  );
  assert.equal(r.record('a@example.test').delivered, 9);
  await store.recordDelivered({ email: 'a@example.test', nowMs: NOW, env: ENV });
  assert.equal(r.record('a@example.test').state, PROSPECT_STATE.EXHAUSTED);
  assertConsistent(r);
});

// ── 3. 途中で止まっても流し直せば正しい ────────────────────────────
test('時間切れで止まっても、同じバッチを流し直せば全員ちょうど 1 回ずつ数えられる', async () => {
  const r = fakeRedis();
  const emails = Array.from({ length: 180 }, (_, i) => `u${i}@example.test`);
  for (const e of emails) seed(r, e, { delivered: 9 });
  const updates = plan(emails.map((e, i) => deliveredEvent(e, `sg-evt-${String(i).padStart(10, '0')}`)));

  let t = 0;
  const first = await applyProspectEventBatch({
    updates, store: storeOf(r), nowMs: NOW, env: ENV,
    nowFn: () => { t += 1000; return t; },
    deadlineAtMs: 1000 + PROSPECT_CHUNK_ESTIMATE_MS - 1,   // 2 塊目の開始判定（now=1000）で見積りが 1ms はみ出す
  });
  assert.equal(first.incomplete, true);
  assert.equal(first.reason, 'time_budget_exhausted');
  assert.equal(first.remaining, 180 - PROSPECT_BATCH_CHUNK);
  assertConsistent(r);   // 止まった時点でも不整合が無い

  // SendGrid の再送（同じバッチ）
  const second = await applyProspectEventBatch({ updates, store: storeOf(r), nowMs: NOW, env: ENV });
  assert.equal(second.incomplete, false);
  assert.equal(second.duplicate, PROSPECT_BATCH_CHUNK);
  assert.equal(second.exhausted, 180 - PROSPECT_BATCH_CHUNK);
  for (const e of emails) assert.equal(r.record(e).delivered, 10, '二重に数えた・数え漏れた');
  for (const e of emails) assert.equal(r.record(e).state, PROSPECT_STATE.EXHAUSTED);
  assertConsistent(r);
  // 選別 list から外す対象は再送でも積まれる（前回外し損ねても外せる）
  assert.equal(second.changes.length, 180);
});

// ── 4. 過去の部分書き込みが直る ───────────────────────────────────
test('過去の部分書き込み（送信候補に残る 5 名型 / どこにも居ない 18 名型）が次のイベントで直る', async () => {
  const r = fakeRedis();
  // 5 名型: レコードは EXHAUSTED なのに送信候補索引に居る・抑止台帳に無い
  const h5 = seed(r, 'five@example.test', { delivered: 10 });
  r.kv.set(prospectKey(h5), JSON.stringify({ ...JSON.parse(r.kv.get(prospectKey(h5))), state: PROSPECT_STATE.EXHAUSTED, suppressedReason: 'delivered_without_open' }));
  // 18 名型: レコードは EXHAUSTED でどの索引にも居ない
  const h18 = seed(r, 'eighteen@example.test', { delivered: 10, state: PROSPECT_STATE.EXHAUSTED, suppressedReason: 'delivered_without_open' });
  assert.equal(r.sets.get(ACTIVE_INDEX).has(h5), true);
  assert.equal((r.sets.get(BLOCKED_INDEX) || new Set()).has(h18), false);

  const out = await applyProspectEventBatch({
    updates: plan([
      deliveredEvent('five@example.test', 'sg-evt-0000000101'),
      { email: 'eighteen@example.test', event: 'delivered', sg_event_id: 'sg-evt-0000000102' },
    ]),
    store: storeOf(r), nowMs: NOW, env: ENV,
  });
  assert.equal(out.incomplete, false);
  assertConsistent(r);
  assert.equal(r.sets.get(ACTIVE_INDEX).has(h5), false);
  assert.equal(r.sets.get(BLOCKED_INDEX).has(h18), true);
});

test('再送（反映済み）のときも、数え直さずに索引だけ張り直す', async () => {
  const r = fakeRedis();
  const h = seed(r, 'a@example.test', { delivered: 10, state: PROSPECT_STATE.EXHAUSTED, appliedEventIds: ['sg-evt-0000000201'] });
  // 部分書き込みを再現（送信候補に残っている）
  r.sets.set(ACTIVE_INDEX, new Set([h]));
  const out = await applyProspectEventBatch({
    updates: plan([deliveredEvent('a@example.test', 'sg-evt-0000000201')]),
    store: storeOf(r), nowMs: NOW, env: ENV,
  });
  assert.equal(out.duplicate, 1);
  assert.equal(out.healed, 1);
  assert.equal(r.record('a@example.test').delivered, 10, '再送で数え直した');
  assertConsistent(r);
});

// ── 5. 時間内に収める（往復数）────────────────────────────────────
test('大量打ち切り（1,000 名）でも 1 塊 2 往復・全員が整合する', async () => {
  const r = fakeRedis();
  const emails = Array.from({ length: 1000 }, (_, i) => `m${i}@example.test`);
  for (const e of emails) seed(r, e, { delivered: 9 });
  r.stats.cmd = 0; r.stats.tx = 0; r.stats.mget = 0;
  const out = await applyProspectEventBatch({
    updates: plan(emails.map((e, i) => deliveredEvent(e, `sg-evt-m${String(i).padStart(9, '0')}`))),
    store: storeOf(r), nowMs: NOW, env: ENV,
  });
  const chunks = Math.ceil(1000 / PROSPECT_BATCH_CHUNK);
  assert.equal(out.exhausted, 1000);
  assert.equal(r.stats.tx, chunks, 'transaction の回数が塊数と違う');
  assert.equal(r.stats.cmd, chunks, '読みが塊ごとの MGET 1 回になっていない');
  assertConsistent(r);
});

test('見つからない相手（Customers 宛など）は書かずに数えるだけ', async () => {
  const r = fakeRedis();
  const out = await applyProspectEventBatch({
    updates: plan([deliveredEvent('nobody@example.test', 'sg-evt-0000000301')]),
    store: storeOf(r), nowMs: NOW, env: ENV,
  });
  assert.equal(out.notFound, 1);
  assert.equal(r.stats.tx, 0);
});

// ── 6. 再送の可否（ID が揃っているか）─────────────────────────────
test('イベント ID が欠けた相手は「重複を防げない」と記録する', () => {
  const ups = plan([
    { email: 'a@example.test', event: 'delivered', sg_event_id: 'sg-evt-0000000401' },
    { email: 'a@example.test', event: 'open', sg_event_id: 'sg-evt-0000000402' },
    { email: 'b@example.test', event: 'delivered' },
  ]);
  const a = ups.find((u) => u.email === 'a@example.test');
  const b = ups.find((u) => u.email === 'b@example.test');
  assert.deepEqual(a.eventIds, ['sg-evt-0000000401', 'sg-evt-0000000402']);
  assert.equal(a.eventIdsComplete, true);
  assert.equal(b.eventIdsComplete, false);
});

// ── 7. 配線（webhook）─────────────────────────────────────────────
const HOOK = readFileSync(fileURLToPath(new URL('../../../netlify/functions/sendgrid-webhook.js', import.meta.url)), 'utf8');

test('webhook は反映より先に「処理済み」の印を付けない・transaction で書く', () => {
  assert.equal(/filterUnseen\(/.test(HOOK), false);
  assert.equal(/createEventOnceStore/.test(HOOK), false);
  assert.match(HOOK, /transaction: makeRedisTransaction\(process\.env\)/);
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

test('makeRedisTransaction は /multi-exec へ送り、1 つでも error なら失敗にする', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      const body = JSON.parse(init.body);
      const bad = body.some((c) => c[0] === 'BAD');
      return { ok: true, json: async () => body.map(() => (bad ? { error: 'ERR' } : { result: 'OK' })) };
    };
    const tx = makeRedisTransaction({ UPSTASH_REDIS_REST_URL: 'https://x.test/', UPSTASH_REDIS_REST_TOKEN: 't' });
    assert.deepEqual(await tx([['SET', 'ak:prospect:p:1', 'v']]), ['OK']);
    await assert.rejects(tx([['BAD', 'k']]));
    assert.equal(calls[0], 'https://x.test/multi-exec');
  } finally { globalThis.fetch = orig; }
});
