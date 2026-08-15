/**
 * dispatchLock.test.mjs — 実送信の原子的排他（純粋部分）
 *   node --test src/lib/marketing/dispatchLock.test.mjs
 *
 * 守る性質:
 *   - 同じ jobId は 1 本しか取れない（`SET NX`）
 *   - **自分の token でしか解放できない**（他実行の鍵を消さない）
 *   - 状態が読めないときは例外（**送ってよいと言わない**）
 *   - 鍵に PII を入れない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDispatchLock, dispatchKey, isSafeJobId, DispatchLockError,
  DISPATCH_LOCK_ROOT, DISPATCH_LOCK_TTL_SEC, LOCK_FAIL,
} from './dispatchLock.js';

const JOB = 'mkt-light-trial-to-premium-sequence-v1-af3acf8c-1';

/** 偽 Redis。SET NX / EVAL(verify・release) を実挙動どおりに再現する */
function fakeRedis(store = new Map(), counters = { fence: 0 }) {
  return async (args) => {
    const op = String(args[0]).toUpperCase();
    if (op === 'INCR') { counters.fence += 1; return String(counters.fence); }
    if (op === 'SET') {
      const [, key, val, ...rest] = args;
      if (rest.map((x) => String(x).toUpperCase()).includes('NX') && store.has(key)) return null;
      store.set(key, String(val));
      return 'OK';
    }
    if (op === 'EVAL') {
      const script = String(args[1]);
      const key = args[3];
      const token = String(args[4]);
      const cur = store.get(key);
      if (cur === undefined) return 'LOST';
      if (cur !== token) return 'STOLEN';
      if (script.includes("redis.call('DEL'")) store.delete(key);
      return 'OK';
    }
    return null;
  };
}

test('同じ jobId は 1 本しか取れない', async () => {
  const store = new Map();
  const a = createDispatchLock({ cmd: fakeRedis(store) });
  const b = createDispatchLock({ cmd: fakeRedis(store, { fence: 100 }) });
  const first = await a.acquire({ jobId: JOB });
  const second = await b.acquire({ jobId: JOB });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, LOCK_FAIL.BUSY);
});

test('異なる jobId は互いを塞がない', async () => {
  const store = new Map();
  const lock = createDispatchLock({ cmd: fakeRedis(store) });
  assert.equal((await lock.acquire({ jobId: JOB })).ok, true);
  assert.equal((await lock.acquire({ jobId: 'mkt-other-v1-zzz-1' })).ok, true);
});

test('【重要】自分の token でしか解放できない', async () => {
  const store = new Map();
  const lock = createDispatchLock({ cmd: fakeRedis(store) });
  const got = await lock.acquire({ jobId: JOB });
  // 他人の token では消えない
  const wrong = await lock.release({ jobId: JOB, token: 'someone-else' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'stolen');
  assert.equal(store.has(dispatchKey.lock(JOB)), true, '他実行の鍵を消している');
  // 自分の token なら消える
  const mine = await lock.release({ jobId: JOB, token: got.token });
  assert.equal(mine.ok, true);
  assert.equal(store.has(dispatchKey.lock(JOB)), false);
});

test('【重要】奪われた / 消えた鍵は verify が false を返す', async () => {
  const store = new Map();
  const lock = createDispatchLock({ cmd: fakeRedis(store) });
  const got = await lock.acquire({ jobId: JOB });
  assert.deepEqual(await lock.verify({ jobId: JOB, token: got.token }), { ok: true, reason: null });
  store.set(dispatchKey.lock(JOB), 'another-run');
  assert.deepEqual(await lock.verify({ jobId: JOB, token: got.token }), { ok: false, reason: 'stolen' });
  store.delete(dispatchKey.lock(JOB));
  assert.deepEqual(await lock.verify({ jobId: JOB, token: got.token }), { ok: false, reason: 'lost' });
});

test('【重要】Redis へ届かないときは例外（「取れた」と言わない）', async () => {
  const lock = createDispatchLock({ cmd: async () => { throw new Error('boom'); } });
  await assert.rejects(() => lock.acquire({ jobId: JOB }), (e) => e instanceof DispatchLockError);
  await assert.rejects(() => lock.verify({ jobId: JOB, token: '1' }), (e) => e instanceof DispatchLockError);
  // release は投げずに「失敗」を返す（finally から呼ぶため）
  const r = await lock.release({ jobId: JOB, token: '1' });
  assert.equal(r.ok, false);
});

test('【重要】応答が読めないとき（undefined）も例外', async () => {
  const lock = createDispatchLock({ cmd: async () => undefined });
  await assert.rejects(() => lock.acquire({ jobId: JOB }), (e) => e instanceof DispatchLockError);
});

test('【重要】鍵は自分の名前空間の外へ出さない', () => {
  assert.match(dispatchKey.lock(JOB), new RegExp(`^${DISPATCH_LOCK_ROOT}lock:`));
  assert.match(dispatchKey.fence(), new RegExp(`^${DISPATCH_LOCK_ROOT}fence$`));
  const lock = createDispatchLock({ cmd: async () => 'OK' });
  assert.throws(() => lock.assertKey('ak:marketing-automation:lock:x'), /dispatch_lock/);
  assert.throws(() => lock.assertKey('payemail:x'), /dispatch_lock/);
});

test('【重要】鍵に PII を入れない（jobId の形を制限する）', async () => {
  assert.equal(isSafeJobId(JOB), true);
  for (const bad of ['a@example.com', 'job id', '', null, undefined, 'x'.repeat(200), "j';DEL"]) {
    assert.equal(isSafeJobId(bad), false, `${String(bad)} を通している`);
  }
  const lock = createDispatchLock({ cmd: fakeRedis(new Map()) });
  await assert.rejects(() => lock.acquire({ jobId: 'a@example.com' }),
    (e) => e.code === LOCK_FAIL.BAD_JOB_ID);
});

test('TTL は Function の実行上限より十分長い（送信中に切れない）', async () => {
  // Netlify Function の上限は 26 秒。TTL はその 10 倍以上を取る
  assert.ok(DISPATCH_LOCK_TTL_SEC >= 260, `TTL ${DISPATCH_LOCK_TTL_SEC} 秒は短すぎる`);
  const calls = [];
  const lock = createDispatchLock({
    cmd: async (args) => { calls.push(args); return args[0] === 'INCR' ? '1' : 'OK'; },
  });
  await lock.acquire({ jobId: JOB });
  const set = calls.find((a) => String(a[0]).toUpperCase() === 'SET');
  assert.equal(set[3], 'NX');
  assert.equal(set[4], 'EX');
  assert.equal(set[5], String(DISPATCH_LOCK_TTL_SEC));
});

test('fencing token は単調増加（使い回さない）', async () => {
  const store = new Map(); const counters = { fence: 0 };
  const lock = createDispatchLock({ cmd: fakeRedis(store, counters) });
  const a = await lock.acquire({ jobId: 'mkt-a-v1-x-1' });
  const b = await lock.acquire({ jobId: 'mkt-b-v1-x-1' });
  assert.notEqual(a.token, b.token);
  assert.ok(Number(b.token) > Number(a.token));
});
