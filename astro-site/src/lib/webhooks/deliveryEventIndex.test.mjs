/**
 * deliveryEventIndex.test.mjs — 1 通ごとの配信結果を DeliveryKey で引く索引
 *   node --test src/lib/webhooks/deliveryEventIndex.test.mjs
 *
 * 守る性質:
 *   - **DeliveryKey 完全一致**でしか結び付けない（別の通へ誤帰属しない）
 *   - provider の再送で**二重に数えない**
 *   - 生アドレスを保存しない / 名前空間の外へ出ない
 *   - 読めないときは**未計測**（0 件として扱わない）
 *   - click は持たない（観測していないものを false と捏造しない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDeliveryEventIndex, planIndexUpdates, toHistoryRow,
  deliveryEventKey, isSafeDeliveryKey, DELIVERY_EVENT_ROOT, DELIVERY_EVENT_SCHEMA,
  INDEX_FAIL, MAX_READ_KEYS,
} from './deliveryEventIndex.js';

const K1 = 'a'.repeat(64);
const K2 = 'b'.repeat(64);
const NOW = Date.parse('2026-08-16T02:00:00Z');

/** 偽 Redis（HSET / HGET / HSETNX / HINCRBY / HMGET と、使っている Lua の意味） */
function fakeRedis(store = new Map()) {
  const hash = (k) => {
    if (!store.has(k)) store.set(k, new Map());
    return store.get(k);
  };
  return async (args) => {
    const op = String(args[0]).toUpperCase();
    if (op === 'HMGET') {
      const h = store.get(args[1]);
      return args.slice(2).map((f) => (h && h.has(f) ? h.get(f) : null));
    }
    if (op === 'EVAL') {
      const key = args[3];
      const h = hash(key);
      const [schema, delivered, firstOpen, lastOpen] = args.slice(4, 8).map(String);
      const ids = args.slice(8);
      h.set('v', schema);
      const setMin = (f, v) => {
        const n = Number(v);
        if (!n) return;
        const cur = Number(h.get(f));
        if (!Number.isFinite(cur) || n < cur) h.set(f, String(n));
      };
      const setMax = (f, v) => {
        const n = Number(v);
        if (!n) return;
        const cur = Number(h.get(f));
        if (!Number.isFinite(cur) || n > cur) h.set(f, String(n));
      };
      setMin('d', delivered);
      setMin('o', firstOpen);
      setMax('ol', lastOpen);
      for (const id of ids) {
        if (!id) continue;
        const f = `seen:${id}`;
        if (!h.has(f)) {
          h.set(f, '1');
          h.set('oc', String((Number(h.get('oc')) || 0) + 1));
        }
      }
      return 'OK';
    }
    return null;
  };
}

const ev = (over = {}) => ({
  type: 'open', atMs: NOW, providerEventId: 'evt-1',
  customArgs: { deliveryKey: K1 }, ...over,
});

// ── 何を索引に入れるか ────────────────────────────────────────

test('【重要】delivered と open だけを索引する', () => {
  const { updates, skipped } = planIndexUpdates([
    ev({ type: 'delivered' }),
    ev({ type: 'open' }),
    ev({ type: 'click' }),
    ev({ type: 'bounce' }),
    ev({ type: 'unsubscribe' }),
  ]);
  assert.equal(updates.size, 1);
  assert.equal(skipped.otherType, 3, 'click / bounce / unsubscribe を入れている');
});

test('【重要】DeliveryKey が無い / 形が違うイベントは捨てる（推測しない）', () => {
  const { updates, skipped } = planIndexUpdates([
    ev({ customArgs: {} }),
    ev({ customArgs: { deliveryKey: 'short' } }),
    ev({ customArgs: { deliveryKey: K1.toUpperCase() } }),
  ]);
  assert.equal(updates.size, 0);
  assert.equal(skipped.noKey, 1);
  assert.equal(skipped.badKey, 2);
});

test('時刻の無いイベントは捨てる', () => {
  const { skipped } = planIndexUpdates([ev({ atMs: null })]);
  assert.equal(skipped.noTime, 1);
});

test('【重要】別の DeliveryKey は別の行として扱う（混同しない）', () => {
  const { updates } = planIndexUpdates([
    ev({ type: 'delivered', customArgs: { deliveryKey: K1 } }),
    ev({ type: 'open', customArgs: { deliveryKey: K2 } }),
  ]);
  assert.equal(updates.size, 2);
  assert.equal(updates.get(K1).deliveredAtMs, NOW);
  assert.equal(updates.get(K1).firstOpenAtMs, null, '別の通の開封を持ち込んでいる');
  assert.equal(updates.get(K2).firstOpenAtMs, NOW);
});

test('delivered は最も早い時刻、open は最初と最後を残す', () => {
  const { updates } = planIndexUpdates([
    ev({ type: 'delivered', atMs: NOW + 5000 }),
    ev({ type: 'delivered', atMs: NOW }),
    ev({ type: 'open', atMs: NOW + 9000, providerEventId: 'o2' }),
    ev({ type: 'open', atMs: NOW + 1000, providerEventId: 'o1' }),
  ]);
  const u = updates.get(K1);
  assert.equal(u.deliveredAtMs, NOW);
  assert.equal(u.firstOpenAtMs, NOW + 1000);
  assert.equal(u.lastOpenAtMs, NOW + 9000);
  assert.deepEqual(u.openEventIds, ['o2', 'o1']);
});

// ── 冪等性 ────────────────────────────────────────────────────

test('【重要】provider の再送で二重に数えない', async () => {
  const store = new Map();
  const idx = createDeliveryEventIndex({ cmd: fakeRedis(store) });
  const batch = [ev({ type: 'delivered', providerEventId: 'd1' }), ev({ type: 'open', providerEventId: 'o1' })];
  await idx.fold({ events: batch, nowMs: NOW });
  await idx.fold({ events: batch, nowMs: NOW });   // 同じものが再送された
  const r = await idx.read([K1]);
  assert.equal(r.ok, true);
  assert.equal(r.byKey.get(K1).openCount, 1, '同じ open を 2 回数えている');
  assert.equal(r.byKey.get(K1).deliveredAtMs, NOW);
});

test('別々の open は回数が増える', async () => {
  const store = new Map();
  const idx = createDeliveryEventIndex({ cmd: fakeRedis(store) });
  await idx.fold({ events: [ev({ providerEventId: 'o1' })], nowMs: NOW });
  await idx.fold({ events: [ev({ providerEventId: 'o2', atMs: NOW + 60000 })], nowMs: NOW });
  const r = await idx.read([K1]);
  assert.equal(r.byKey.get(K1).openCount, 2);
  assert.equal(r.byKey.get(K1).firstOpenAtMs, NOW);
  assert.equal(r.byKey.get(K1).lastOpenAtMs, NOW + 60000);
});

// ── 安全性 ────────────────────────────────────────────────────

test('【重要】鍵は名前空間の中だけ・PII を含まない', () => {
  assert.equal(deliveryEventKey(K1), `${DELIVERY_EVENT_ROOT}${K1}`);
  assert.ok(deliveryEventKey(K1).startsWith('ak:delivery-events:'));
  assert.equal(/@/.test(deliveryEventKey(K1)), false);
  assert.equal(isSafeDeliveryKey(K1), true);
  assert.equal(isSafeDeliveryKey('x'), false);
});

test('【重要】保存するのは時刻と回数だけ（アドレスを書かない）', async () => {
  const store = new Map();
  const idx = createDeliveryEventIndex({ cmd: fakeRedis(store) });
  await idx.fold({
    events: [ev({ type: 'delivered', email: 'member@example.com' })], nowMs: NOW,
  });
  const dump = JSON.stringify([...store].map(([k, v]) => [k, [...v]]));
  assert.equal(dump.includes('@'), false, 'アドレスを保存している');
});

test('【重要】書き込みが失敗しても例外にしない（webhook を落とさない）', async () => {
  const idx = createDeliveryEventIndex({ cmd: async () => { throw new Error('redis down'); } });
  const r = await idx.fold({ events: [ev()], nowMs: NOW });
  assert.equal(r.failed, 1);
  assert.equal(r.written, 0);
});

test('【重要】読めないときは ok:false（0 件として返さない）', async () => {
  const idx = createDeliveryEventIndex({ cmd: async () => { throw new Error('redis down'); } });
  const r = await idx.read([K1]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, INDEX_FAIL.UNREACHABLE);
  assert.equal(r.byKey.size, 0);
});

test('【重要】一度に読む鍵数に上限がある（全件走査させない）', async () => {
  const idx = createDeliveryEventIndex({ cmd: fakeRedis() });
  const many = Array.from({ length: MAX_READ_KEYS + 1 }, (_, i) => String(i).padStart(64, '0'));
  const r = await idx.read(many);
  assert.equal(r.ok, false);
  assert.equal(r.reason, INDEX_FAIL.TOO_MANY_KEYS);
});

test('版が違う索引は読まない（形が変わっている可能性がある）', async () => {
  const store = new Map();
  store.set(deliveryEventKey(K1), new Map([['v', '99'], ['d', String(NOW)]]));
  const idx = createDeliveryEventIndex({ cmd: fakeRedis(store) });
  const r = await idx.read([K1]);
  assert.equal(r.ok, true);
  assert.equal(r.byKey.has(K1), false);
});

// ── 履歴 1 行への変換 ─────────────────────────────────────────

test('【重要】delivered + open → measured / opened', () => {
  const row = toHistoryRow({
    deliveryKey: K1, step: 1, sentAtMs: NOW,
    entry: { deliveredAtMs: NOW, firstOpenAtMs: NOW + 1000, openCount: 1 },
  });
  assert.equal(row.measured, true);
  assert.equal(row.opened, true);
});

test('【重要】delivered だけ → measured / 未開封', () => {
  const row = toHistoryRow({ deliveryKey: K1, entry: { deliveredAtMs: NOW, firstOpenAtMs: null } });
  assert.equal(row.measured, true);
  assert.equal(row.opened, false);
});

test('【重要】delivered を確認できない → 未計測（opened を作らない）', () => {
  for (const entry of [null, {}, { deliveredAtMs: null, firstOpenAtMs: NOW }]) {
    const row = toHistoryRow({ deliveryKey: K1, entry });
    assert.equal(row.measured, false, JSON.stringify(entry));
    assert.equal('opened' in row, false, '未計測なのに opened を作っている');
  }
});

test('【重要】click は履歴に作らない（観測していないものを false にしない）', () => {
  const row = toHistoryRow({ deliveryKey: K1, entry: { deliveredAtMs: NOW } });
  assert.equal('clicked' in row, false);
});
