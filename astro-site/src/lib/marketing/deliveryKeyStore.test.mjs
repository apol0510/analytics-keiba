import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NAMESPACE, buildDeliveredSetKey, assertDeliveryKeys, chunk,
  createDeliveryKeyStore, makeRedisCmd, DeliveryKeyStoreError,
} from './deliveryKeyStore.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const KEY_C = 'c'.repeat(64);
const BASE = { brand: 'analytics-keiba', campaignId: 'dormant-reactivation', version: 2 };

/** 命令列を記録する偽 Redis（SET のふるまいだけ再現） */
function fakeRedis({ failOn = null } = {}) {
  const sets = new Map();
  const calls = [];
  const cmd = async (args) => {
    calls.push(args);
    const op = String(args[0]).toUpperCase();
    if (failOn === op) throw new Error('boom');
    const key = args[1];
    if (op === 'SADD') {
      const s = sets.get(key) || new Set();
      let added = 0;
      for (const m of args.slice(2)) if (!s.has(m)) { s.add(m); added += 1; }
      sets.set(key, s);
      return added;
    }
    if (op === 'SMISMEMBER') {
      const s = sets.get(key) || new Set();
      return args.slice(2).map((m) => (s.has(m) ? 1 : 0));
    }
    if (op === 'SCARD') return (sets.get(key) || new Set()).size;
    if (op === 'SSCAN') return ['0', [...(sets.get(key) || new Set())]];
    throw new Error(`unexpected ${op}`);
  };
  return { cmd, sets, calls };
}

test('set キーは AK 名前空間で campaign×version 単位（受信者を含まない）', () => {
  const k = buildDeliveredSetKey(BASE);
  assert.equal(k, `${NAMESPACE}:analytics-keiba:dormant-reactivation:v2`);
  assert.ok(k.startsWith('ak:'), 'AK 名前空間から外れている');
  assert.doesNotMatch(k, /@/, 'キーにアドレスが入っている');
});

test('壊れた入力でキーを作らない', () => {
  assert.throws(() => buildDeliveredSetKey({ ...BASE, brand: 'a b' }), DeliveryKeyStoreError);
  assert.throws(() => buildDeliveredSetKey({ ...BASE, campaignId: 'x@y' }), DeliveryKeyStoreError);
  assert.throws(() => buildDeliveredSetKey({ ...BASE, version: 0 }), DeliveryKeyStoreError);
  assert.throws(() => buildDeliveredSetKey({ ...BASE, version: 1.5 }), DeliveryKeyStoreError);
});

test('DeliveryKey は sha256 hex しか受け付けない（壊れた値を黙って通さない）', () => {
  assert.doesNotThrow(() => assertDeliveryKeys([KEY_A, KEY_B]));
  assert.throws(() => assertDeliveryKeys(['short']), DeliveryKeyStoreError);
  assert.throws(() => assertDeliveryKeys([`${'A'.repeat(64)}`]), DeliveryKeyStoreError, '大文字は別値になる');
  assert.throws(() => assertDeliveryKeys('notarray'), DeliveryKeyStoreError);
});

test('chunk は分割して全件を保つ', () => {
  const list = Array.from({ length: 450 }, (_, i) => String(i));
  const parts = chunk(list, 200);
  assert.equal(parts.length, 3);
  assert.equal(parts.flat().length, 450);
});

test('markDelivered は冪等（2 回足しても集合は変わらない）', async () => {
  const r = fakeRedis();
  const store = createDeliveryKeyStore({ redisCmd: r.cmd });
  const first = await store.markDelivered({ ...BASE, keys: [KEY_A, KEY_B] });
  const second = await store.markDelivered({ ...BASE, keys: [KEY_A, KEY_B] });
  assert.equal(first.added, 2);
  assert.equal(second.added, 0, '2 回目で増えている');
  assert.equal(await store.count(BASE), 2);
});

test('filterDelivered は送信済みだけを返す', async () => {
  const r = fakeRedis();
  const store = createDeliveryKeyStore({ redisCmd: r.cmd });
  await store.markDelivered({ ...BASE, keys: [KEY_A] });
  const got = await store.filterDelivered({ ...BASE, keys: [KEY_A, KEY_B] });
  assert.deepEqual(got, [KEY_A]);
});

test('200 件を超えても取りこぼさない（分割して全件判定）', async () => {
  const r = fakeRedis();
  const store = createDeliveryKeyStore({ redisCmd: r.cmd });
  const many = Array.from({ length: 450 }, (_, i) => String(i).padStart(64, '0'));
  await store.markDelivered({ ...BASE, keys: many });
  const got = await store.filterDelivered({ ...BASE, keys: many });
  assert.equal(got.length, 450);
});

// ── fail closed ────────────────────────────────────────────────
test('【fail closed】Redis が落ちたら例外。空配列（＝未送信）を返さない', async () => {
  const r = fakeRedis({ failOn: 'SMISMEMBER' });
  const store = createDeliveryKeyStore({ redisCmd: r.cmd });
  await assert.rejects(
    () => store.filterDelivered({ ...BASE, keys: [KEY_A] }),
    (e) => e instanceof DeliveryKeyStoreError && e.reason === 'redis_unavailable',
  );
});

test('【fail closed】応答の形が違えば例外（黙って 0 件にしない）', async () => {
  const store = createDeliveryKeyStore({ redisCmd: async () => 'not-an-array' });
  await assert.rejects(
    () => store.filterDelivered({ ...BASE, keys: [KEY_A, KEY_B] }),
    (e) => e.reason === 'unexpected_response',
  );
});

test('【fail closed】env 未設定なら redisCmd を作らない', () => {
  assert.throws(() => makeRedisCmd({}), (e) => e.reason === 'redis_not_configured');
  assert.throws(() => makeRedisCmd({ UPSTASH_REDIS_REST_URL: 'x' }), (e) => e.reason === 'redis_not_configured');
});

test('例外メッセージに値やアドレスを載せない', () => {
  try {
    makeRedisCmd({});
    assert.fail('throw していない');
  } catch (e) {
    assert.equal(e.message, 'delivery_key_store:redis_not_configured');
    assert.doesNotMatch(e.message, /@|http|token/i);
  }
});

// ── TTL を付けない（期限切れ＝再送になる）────────────────────────
test('【重要】TTL 系のコマンドを一切発行しない', async () => {
  const r = fakeRedis();
  const store = createDeliveryKeyStore({ redisCmd: r.cmd });
  await store.markDelivered({ ...BASE, keys: [KEY_A, KEY_B, KEY_C] });
  await store.filterDelivered({ ...BASE, keys: [KEY_A] });
  const ops = r.calls.map((c) => String(c[0]).toUpperCase());
  for (const forbidden of ['EXPIRE', 'PEXPIRE', 'EXPIREAT', 'SETEX', 'TTL']) {
    assert.equal(ops.includes(forbidden), false, `${forbidden} を発行している（期限切れで再送になる）`);
  }
});

test('members は集合を全部返す（reconciliation 用）', async () => {
  const r = fakeRedis();
  const store = createDeliveryKeyStore({ redisCmd: r.cmd });
  await store.markDelivered({ ...BASE, keys: [KEY_A, KEY_B] });
  const m = await store.members(BASE);
  assert.equal(m.size, 2);
  assert.ok(m.has(KEY_A) && m.has(KEY_B));
});

test('redisCmd を渡さなければ store を作らない（暗黙の no-op を作らない）', () => {
  assert.throws(() => createDeliveryKeyStore({}), (e) => e.reason === 'redis_not_configured');
});
