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
  DISPATCH_LOCK_ROOT, DISPATCH_LOCK_TTL_SEC, DISPATCH_LOCK_BACKGROUND_TTL_SEC,
  assertBackgroundTtlCovers, LOCK_FAIL,
} from './dispatchLock.js';
import { DEFAULT_BACKGROUND_BUDGET_MS } from './sendBudget.js';

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

// ── Background の TTL と延長（2026-08-15 の指摘）────────────────────
//
// Background は最大 8 分動くのに、同期用の 300 秒 TTL を流用すると
// **送信の途中で排他が切れ**、別実行が同じジョブを取って二重送信できる。

test('【重要】background の TTL は 予算 + 1 チャンク + 後片付け を覆う', () => {
  const r = assertBackgroundTtlCovers({
    ttlSec: DISPATCH_LOCK_BACKGROUND_TTL_SEC,
    budgetMs: DEFAULT_BACKGROUND_BUDGET_MS,
    chunkMs: 60_000,
  });
  assert.equal(r.ok, true, `TTL ${DISPATCH_LOCK_BACKGROUND_TTL_SEC}s は ${r.needMs}ms を覆えない`);
  // 同期用の 300 秒では覆えないことも固定（流用の再発防止）
  const sync = assertBackgroundTtlCovers({
    ttlSec: DISPATCH_LOCK_TTL_SEC, budgetMs: DEFAULT_BACKGROUND_BUDGET_MS, chunkMs: 60_000,
  });
  assert.equal(sync.ok, false, '同期用 TTL でも覆えてしまう（テストが意味を持たない）');
});

test('同期用の TTL は壊さない（300 秒のまま）', () => {
  assert.equal(DISPATCH_LOCK_TTL_SEC, 300);
  assert.ok(DISPATCH_LOCK_BACKGROUND_TTL_SEC > DISPATCH_LOCK_TTL_SEC);
});

test('【重要】renew は自分の token のときだけ期限を延ばす', async () => {
  const store = new Map();
  const expires = new Map();
  const cmd = async (args) => {
    const op = String(args[0]).toUpperCase();
    if (op === 'INCR') return '1';
    if (op === 'SET') { store.set(args[1], String(args[2])); expires.set(args[1], Number(args[5])); return 'OK'; }
    if (op === 'EVAL') {
      const script = String(args[1]); const k = args[3]; const tok = String(args[4]);
      const cur = store.get(k);
      if (cur === undefined) return 'LOST';
      if (cur !== tok) return 'STOLEN';
      if (script.includes("redis.call('EXPIRE'")) { expires.set(k, Number(args[5])); return 'OK'; }
      if (script.includes("redis.call('DEL'")) { store.delete(k); return 'OK'; }
      return 'OK';
    }
    return null;
  };
  const lock = createDispatchLock({ cmd });
  const got = await lock.acquire({ jobId: JOB, ttlSec: 600 });
  assert.equal(expires.get(dispatchKey.lock(JOB)), 600);
  // 自分の token なら延ばせる
  const ok = await lock.renew({ jobId: JOB, token: got.token, ttlSec: 1200 });
  assert.equal(ok.ok, true);
  assert.equal(expires.get(dispatchKey.lock(JOB)), 1200, '期限が延びていない');
  // 他人の token では延ばせない
  const bad = await lock.renew({ jobId: JOB, token: 'someone-else', ttlSec: 9999 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'stolen');
  assert.equal(expires.get(dispatchKey.lock(JOB)), 1200, '他人の鍵を延命している');
});

test('【重要】鍵が消えていれば renew は lost（延命で復活させない）', async () => {
  const store = new Map();
  const lock = createDispatchLock({ cmd: fakeRedis(store) });
  const got = await lock.acquire({ jobId: JOB });
  store.delete(dispatchKey.lock(JOB));
  const r = await lock.renew({ jobId: JOB, token: got.token });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'lost');
  assert.equal(store.has(dispatchKey.lock(JOB)), false, '消えた鍵を作り直している');
});

test('【重要】5 分経過しても background の鍵は生きている（2 本目が取れない）', async () => {
  // 実時間相当: TTL 秒数を「経過秒」と突き合わせて期限切れを再現する
  const store = new Map();      // key -> { token, expiresAtSec }
  let nowSec = 0;
  const cmd = async (args) => {
    const op = String(args[0]).toUpperCase();
    const purge = () => {
      for (const [k, v] of store) if (v.expiresAtSec <= nowSec) store.delete(k);
    };
    if (op === 'INCR') return String(Math.floor(nowSec) + 1);
    if (op === 'SET') {
      purge();
      const [, k, v, ...rest] = args;
      const up = rest.map((x) => String(x).toUpperCase());
      if (up.includes('NX') && store.has(k)) return null;
      const ttl = Number(rest[rest.indexOf('EX') + 1] ?? rest[3] ?? 300);
      store.set(k, { token: String(v), expiresAtSec: nowSec + ttl });
      return 'OK';
    }
    if (op === 'EVAL') {
      purge();
      const script = String(args[1]); const k = args[3]; const tok = String(args[4]);
      const cur = store.get(k);
      if (!cur) return 'LOST';
      if (cur.token !== tok) return 'STOLEN';
      if (script.includes("redis.call('EXPIRE'")) { cur.expiresAtSec = nowSec + Number(args[5]); return 'OK'; }
      if (script.includes("redis.call('DEL'")) { store.delete(k); return 'OK'; }
      return 'OK';
    }
    return null;
  };

  const bg = createDispatchLock({ cmd });
  const other = createDispatchLock({ cmd });

  // background が長い TTL で取得
  const got = await bg.acquire({ jobId: JOB, ttlSec: DISPATCH_LOCK_BACKGROUND_TTL_SEC });
  assert.equal(got.ok, true);

  // 5 分（同期用 TTL のぶん）経過 — ここで切れてはいけない
  nowSec += 300;
  assert.equal((await other.acquire({ jobId: JOB })).ok, false, '5 分で切れて 2 本目が取れている');
  assert.equal((await bg.verify({ jobId: JOB, token: got.token })).ok, true, '5 分で自分の鍵を失っている');

  // さらに 8 分（background 予算ぶん）経過。チャンクごとに renew している前提
  for (let i = 0; i < 8; i += 1) {
    nowSec += 60;
    const r = await bg.renew({ jobId: JOB, token: got.token, ttlSec: DISPATCH_LOCK_BACKGROUND_TTL_SEC });
    assert.equal(r.ok, true, `${i + 1} 分目で鍵を失っている`);
    assert.equal((await other.acquire({ jobId: JOB })).ok, false, `${i + 1} 分目に 2 本目が取れている`);
  }

  // 解放すれば次が取れる
  assert.equal((await bg.release({ jobId: JOB, token: got.token })).ok, true);
  assert.equal((await other.acquire({ jobId: JOB })).ok, true, '解放後に取れない');
});

test('【重要】renew しなければ TTL 切れで別実行が取れる（renew が効いている証明）', async () => {
  const store = new Map();
  let nowSec = 0;
  const cmd = async (args) => {
    const op = String(args[0]).toUpperCase();
    for (const [k, v] of store) if (v.expiresAtSec <= nowSec) store.delete(k);
    if (op === 'INCR') return String(nowSec + 1);
    if (op === 'SET') {
      const [, k, v, ...rest] = args;
      if (rest.map((x) => String(x).toUpperCase()).includes('NX') && store.has(k)) return null;
      store.set(k, { token: String(v), expiresAtSec: nowSec + Number(rest[3] ?? 300) });
      return 'OK';
    }
    if (op === 'EVAL') {
      const k = args[3]; const cur = store.get(k);
      if (!cur) return 'LOST';
      if (cur.token !== String(args[4])) return 'STOLEN';
      return 'OK';
    }
    return null;
  };
  const a = createDispatchLock({ cmd });
  const b = createDispatchLock({ cmd });
  await a.acquire({ jobId: JOB, ttlSec: 300 });   // 同期用 TTL のまま
  nowSec += 301;                                   // renew せずに 5 分超
  assert.equal((await b.acquire({ jobId: JOB })).ok, true,
    'TTL 切れを再現できていない（このテストが意味を持たない）');
});
