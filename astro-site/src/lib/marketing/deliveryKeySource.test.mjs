import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DELIVERY_STORE, resolveDeliveryStoreMode, writesAirtable, writesRedis,
  readsAirtable, readsRedis, resolveDeliveredKeys, recordDelivered,
} from './deliveryKeySource.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

test('未設定・未知の値は airtable へ倒す（勝手に新経路へ行かせない）', () => {
  assert.equal(resolveDeliveryStoreMode({}), DELIVERY_STORE.AIRTABLE);
  assert.equal(resolveDeliveryStoreMode({ MARKETING_DELIVERY_STORE: '' }), DELIVERY_STORE.AIRTABLE);
  assert.equal(resolveDeliveryStoreMode({ MARKETING_DELIVERY_STORE: 'yes' }), DELIVERY_STORE.AIRTABLE);
  assert.equal(resolveDeliveryStoreMode({ MARKETING_DELIVERY_STORE: 'REDIS' }), DELIVERY_STORE.REDIS);
  assert.equal(resolveDeliveryStoreMode({ MARKETING_DELIVERY_STORE: 'dual' }), DELIVERY_STORE.DUAL);
});

test('モードごとの読み書き先', () => {
  assert.deepEqual(
    [writesAirtable('airtable'), writesRedis('airtable'), readsAirtable('airtable'), readsRedis('airtable')],
    [true, false, true, false],
  );
  assert.deepEqual(
    [writesAirtable('dual'), writesRedis('dual'), readsAirtable('dual'), readsRedis('dual')],
    [true, true, true, true],
  );
  assert.deepEqual(
    [writesAirtable('redis'), writesRedis('redis'), readsAirtable('redis'), readsRedis('redis')],
    [false, true, false, true],
  );
});

test('dual の判定は和集合（片方にしか無い既送信を見落とさない）', async () => {
  const r = await resolveDeliveredKeys({
    mode: 'dual',
    keys: [A, B, C],
    fetchAirtableDelivered: async () => [A],
    fetchRedisDelivered: async () => [B],
  });
  assert.deepEqual([...r.delivered].sort(), [A, B].sort());
  assert.deepEqual(r.sources, ['airtable', 'redis']);
  assert.equal(r.degraded, null);
});

test('【二重送信防止】dual で Redis が落ちても Airtable の答えで判定を続け、degraded を残す', async () => {
  const r = await resolveDeliveredKeys({
    mode: 'dual',
    keys: [A, B],
    fetchAirtableDelivered: async () => [A],
    fetchRedisDelivered: async () => { throw new Error('redis down'); },
  });
  assert.ok(r.delivered.has(A), 'Airtable 側の既送信を落としている');
  assert.equal(r.degraded, 'redis_unavailable');
  assert.deepEqual(r.sources, ['airtable']);
});

test('【fail closed】redis 単独運用で Redis が落ちたら判定しない（送らない）', async () => {
  await assert.rejects(() => resolveDeliveredKeys({
    mode: 'redis',
    keys: [A],
    fetchRedisDelivered: async () => { throw new Error('redis down'); },
  }));
});

test('reader が無いまま読もうとしたら例外（暗黙に「未送信」にしない）', async () => {
  await assert.rejects(() => resolveDeliveredKeys({ mode: 'airtable', keys: [A] }),
    /airtable_reader_missing/);
  await assert.rejects(() => resolveDeliveredKeys({ mode: 'redis', keys: [A] }),
    /redis_reader_missing/);
});

// ── 記録 ───────────────────────────────────────────────────────
test('dual は両方へ書く', async () => {
  const seen = { a: null, r: null };
  const out = await recordDelivered({
    mode: 'dual',
    keys: [A, B],
    writeAirtable: async (k) => { seen.a = k; },
    writeRedis: async (k) => { seen.r = k; },
  });
  assert.deepEqual(out, { airtable: 'ok', redis: 'ok' });
  assert.deepEqual(seen.a, [A, B]);
  assert.deepEqual(seen.r, [A, B]);
});

test('dual で Redis 書き込みが失敗しても致命にしない（Airtable が正本）', async () => {
  const out = await recordDelivered({
    mode: 'dual',
    keys: [A],
    writeAirtable: async () => {},
    writeRedis: async () => { throw new Error('boom'); },
  });
  assert.deepEqual(out, { airtable: 'ok', redis: 'failed' });
});

test('【致命】Airtable 書き込みの失敗は握り潰さない（台帳が欠ける）', async () => {
  await assert.rejects(() => recordDelivered({
    mode: 'dual',
    keys: [A],
    writeAirtable: async () => { throw new Error('airtable down'); },
    writeRedis: async () => {},
  }), /airtable down/);
});

test('【致命】redis モードで Redis 書き込みが失敗したら例外（次回二重送信になる）', async () => {
  await assert.rejects(() => recordDelivered({
    mode: 'redis',
    keys: [A],
    writeRedis: async () => { throw new Error('boom'); },
  }), /boom/);
});

test('airtable モードでは Redis を触らない', async () => {
  let touched = false;
  const out = await recordDelivered({
    mode: 'airtable',
    keys: [A],
    writeAirtable: async () => {},
    writeRedis: async () => { touched = true; },
  });
  assert.equal(out.redis, 'skipped');
  assert.equal(touched, false);
});
