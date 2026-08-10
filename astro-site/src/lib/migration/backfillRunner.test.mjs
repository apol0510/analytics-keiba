import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { backfillDeliveryKeys, backfillEmailEvents } from './backfillRunner.js';
import { IncompleteReadError } from './completeRead.js';
import { createEmailEventBlobStore } from '../webhooks/emailEventBlobStore.js';
import { createDeliveryKeyStore } from '../marketing/deliveryKeyStore.js';
import { reconcileDeliveryKeys, reconcileEventKeys } from '../marketing/deliveryStoreReconcile.js';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const clock = () => '2026-08-09T00:00:00.000Z';
const AT = Date.UTC(2026, 7, 9, 12, 0, 0);

// ── 本番相当の規模で fixture を作る ─────────────────────────────
const N_DELIVERIES = 14416;
const N_EVENTS = 18793;

const dkey = (i) => sha(`delivery-${i}`);
const deliveryRow = (i) => ({
  id: `recD${i}`,
  fields: {
    DeliveryKey: dkey(i),
    CampaignType: 'dormant-reactivation:v2',
    Status: i % 1000 === 0 ? 'queued' : 'sent',
  },
});
const eventRow = (i) => ({
  id: `recE${i}`,
  fields: {
    EventKey: `sg:evt-${i}`,
    EventType: ['delivered', 'open', 'bounce'][i % 3],
    EventAt: new Date(AT + i * 1000).toISOString(),
    CampaignId: 'dormant-reactivation',
    CampaignVersion: 2,
    DeliveryKey: dkey(i % N_DELIVERIES),
    EmailHash: sha(`e${i}`).slice(0, 16),
  },
});

/** ページ単位で返す偽 Airtable。`failAtPage` で途中失敗を注入できる */
function pager(rows, { pageSize = 100, failAtPage = null, truncateAtPage = null } = {}) {
  return async (offset) => {
    const start = offset ? Number(offset) : 0;
    const page = Math.floor(start / pageSize);
    if (failAtPage !== null && page === failAtPage) throw new Error('airtable boom');
    if (truncateAtPage !== null && page === truncateAtPage) return { notRecords: true }; // 壊れた応答
    const slice = rows.slice(start, start + pageSize);
    const next = start + pageSize;
    return { records: slice, offset: next < rows.length ? String(next) : null };
  };
}

const SCOPE = { brand: 'analytics-keiba', campaignId: 'dormant-reactivation', version: 2 };
const scopeOf = () => SCOPE;
const keyOf = (r) => r.fields?.DeliveryKey || null;
const toEvent = (r) => {
  const f = r.fields || {};
  if (!f.EventKey) return null;
  return {
    eventKey: f.EventKey,
    eventType: f.EventType,
    eventAtMs: Date.parse(f.EventAt),
    campaignId: f.CampaignId,
    campaignVersion: f.CampaignVersion,
    deliveryKey: f.DeliveryKey,
    emailHash: f.EmailHash,
  };
};

/** メモリ上の Redis SET */
function memoryRedis({ failAfterCalls = null } = {}) {
  const sets = new Map();
  let calls = 0;
  const cmd = async (args) => {
    calls += 1;
    if (failAfterCalls !== null && calls > failAfterCalls) throw new Error('redis boom');
    const op = String(args[0]).toUpperCase();
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
  return { cmd, sets, calls: () => calls };
}

/** メモリ上の Blob（キー→本文） */
function memoryBlobs({ failAfterWrites = null } = {}) {
  const store = new Map();
  let writes = 0;
  return {
    store,
    setBlob: async (k, body) => {
      writes += 1;
      if (failAfterWrites !== null && writes > failAfterWrites) throw new Error('blobs boom');
      store.set(k, body);
    },
    writes: () => writes,
  };
}

// ── リハーサル: 本番規模で最後まで通す ──────────────────────────
test('リハーサル: DeliveryKey 14,416 件を Redis へ移し、集合が一致する', async () => {
  const rows = Array.from({ length: N_DELIVERIES }, (_, i) => deliveryRow(i));
  const redis = memoryRedis();
  const store = createDeliveryKeyStore({ redisCmd: redis.cmd });

  const r = await backfillDeliveryKeys({
    fetchPage: pager(rows),
    sadd: (scope, keys) => store.markDelivered({ ...scope, keys }),
    scopeOf,
    keyOf,
    clock,
  });

  assert.equal(r.read, N_DELIVERIES);
  assert.equal(r.written, N_DELIVERIES);
  assert.equal(r.skipped, 0);
  assert.equal(r.pages, Math.ceil(N_DELIVERIES / 100));

  const airtableKeys = new Set(rows.map(keyOf));
  const redisKeys = await store.members(SCOPE);
  const recon = reconcileDeliveryKeys({ airtableKeys, redisKeys });
  assert.equal(recon.airtable, N_DELIVERIES);
  assert.equal(recon.redis, N_DELIVERIES);
  assert.equal(recon.missingInRedis, 0);
  assert.equal(recon.safeToSwitch, true);
});

test('リハーサル: EmailEvents 18,793 件を Blob へ退避し、EventKey 集合が一致する', async () => {
  const rows = Array.from({ length: N_EVENTS }, (_, i) => eventRow(i));
  const blobs = memoryBlobs();
  const blobStore = createEmailEventBlobStore({ setBlob: blobs.setBlob, hashFn: sha });

  const r = await backfillEmailEvents({
    fetchPage: pager(rows),
    writeBatch: (input) => blobStore.writeBatch(input),
    toEvent,
    batchSize: 500,
    receivedAtMs: AT,
    clock,
  });

  assert.equal(r.read, N_EVENTS);
  assert.equal(r.written, N_EVENTS);
  assert.equal(r.skipped, 0);

  // Blob から EventKey 集合を再構成して突合（件数だけで PASS にしない）
  const blobKeys = new Set();
  const counts = {};
  for (const body of blobs.store.values()) {
    for (const line of body.split('\n')) {
      const o = JSON.parse(line);
      blobKeys.add(o.eventKey);
      counts[o.eventType] = (counts[o.eventType] || 0) + 1;
    }
  }
  const airtableCounts = {};
  for (const row of rows) {
    const t = row.fields.EventType;
    airtableCounts[t] = (airtableCounts[t] || 0) + 1;
  }
  const recon = reconcileEventKeys({
    airtableKeys: new Set(rows.map((x) => x.fields.EventKey)),
    blobKeys,
    airtableCounts,
    blobCounts: counts,
  });
  assert.equal(recon.missingInBlob, 0);
  assert.equal(recon.counts.status, 'match');
  assert.equal(recon.safeToSwitch, true);
});

// ── 冪等性 ─────────────────────────────────────────────────────
test('二重実行しても Redis の集合は増えない', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => deliveryRow(i));
  const redis = memoryRedis();
  const store = createDeliveryKeyStore({ redisCmd: redis.cmd });
  const run = () => backfillDeliveryKeys({
    fetchPage: pager(rows), sadd: (s, k) => store.markDelivered({ ...s, keys: k }), scopeOf, keyOf, clock,
  });
  await run();
  const after1 = await store.count(SCOPE);
  await run();
  const after2 = await store.count(SCOPE);
  assert.equal(after1, 1000);
  assert.equal(after2, 1000, '二重実行で増えている');
});

test('二重実行しても Blob が増えない（同じ内容 = 同じキー）', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => eventRow(i));
  const blobs = memoryBlobs();
  const blobStore = createEmailEventBlobStore({ setBlob: blobs.setBlob, hashFn: sha });
  const run = () => backfillEmailEvents({
    fetchPage: pager(rows), writeBatch: (i) => blobStore.writeBatch(i), toEvent,
    batchSize: 500, receivedAtMs: AT, clock,
  });
  await run();
  const keysAfter1 = blobs.store.size;
  await run();
  assert.equal(blobs.store.size, keysAfter1, '二重実行で blob が増えている');
});

test('同一 DeliveryKey が複数行にあっても 1 回しか入れない', async () => {
  const rows = [deliveryRow(1), deliveryRow(1), deliveryRow(2)];
  const redis = memoryRedis();
  const store = createDeliveryKeyStore({ redisCmd: redis.cmd });
  const r = await backfillDeliveryKeys({
    fetchPage: pager(rows), sadd: (s, k) => store.markDelivered({ ...s, keys: k }), scopeOf, keyOf, clock,
  });
  assert.equal(r.duplicates, 1);
  assert.equal(r.written, 2);
  assert.equal(await store.count(SCOPE), 2);
});

// ── dry-run ────────────────────────────────────────────────────
test('dryRun は 1 バイトも書かない', async () => {
  const rows = Array.from({ length: 300 }, (_, i) => deliveryRow(i));
  const redis = memoryRedis();
  const store = createDeliveryKeyStore({ redisCmd: redis.cmd });
  const r = await backfillDeliveryKeys({
    fetchPage: pager(rows), sadd: (s, k) => store.markDelivered({ ...s, keys: k }),
    scopeOf, keyOf, dryRun: true, clock,
  });
  assert.equal(r.read, 300);
  assert.equal(r.dryRun, true);
  assert.equal(await store.count(SCOPE), 0, 'dryRun なのに書いている');
});

test('dryRun は Blob も書かない', async () => {
  const rows = Array.from({ length: 300 }, (_, i) => eventRow(i));
  const blobs = memoryBlobs();
  const blobStore = createEmailEventBlobStore({ setBlob: blobs.setBlob, hashFn: sha });
  await backfillEmailEvents({
    fetchPage: pager(rows), writeBatch: (i) => blobStore.writeBatch(i), toEvent,
    batchSize: 100, receivedAtMs: AT, dryRun: true, clock,
  });
  assert.equal(blobs.store.size, 0);
});

// ── 失敗注入 ───────────────────────────────────────────────────
test('【truncated fetch】壊れた応答を 0 件と扱わず例外にする', async () => {
  const rows = Array.from({ length: 500 }, (_, i) => deliveryRow(i));
  const redis = memoryRedis();
  const store = createDeliveryKeyStore({ redisCmd: redis.cmd });
  await assert.rejects(() => backfillDeliveryKeys({
    fetchPage: pager(rows, { truncateAtPage: 3 }),
    sadd: (s, k) => store.markDelivered({ ...s, keys: k }), scopeOf, keyOf, clock,
  }), IncompleteReadError);
});

test('【Airtable 途中失敗】握り潰さず例外。途中まで入った分は冪等なので再実行で復旧', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => deliveryRow(i));
  const redis = memoryRedis();
  const store = createDeliveryKeyStore({ redisCmd: redis.cmd });
  await assert.rejects(() => backfillDeliveryKeys({
    fetchPage: pager(rows, { failAtPage: 5 }),
    sadd: (s, k) => store.markDelivered({ ...s, keys: k }), scopeOf, keyOf, clock,
  }), /airtable boom/);

  const partial = await store.count(SCOPE);
  assert.ok(partial > 0 && partial < 1000, '部分的にも入っていない / 全部入っている');

  // 再実行で最後まで到達し、集合が完全になる
  const r = await backfillDeliveryKeys({
    fetchPage: pager(rows), sadd: (s, k) => store.markDelivered({ ...s, keys: k }), scopeOf, keyOf, clock,
  });
  assert.equal(r.read, 1000);
  assert.equal(await store.count(SCOPE), 1000);
});

test('【Redis 途中失敗】例外になり、部分適用のまま黙って完了しない', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => deliveryRow(i));
  const redis = memoryRedis({ failAfterCalls: 3 });
  const store = createDeliveryKeyStore({ redisCmd: redis.cmd });
  await assert.rejects(() => backfillDeliveryKeys({
    fetchPage: pager(rows), sadd: (s, k) => store.markDelivered({ ...s, keys: k }), scopeOf, keyOf, clock,
  }), /redis_unavailable/);
});

test('【Blob 途中失敗】例外になり、完了扱いにしない', async () => {
  const rows = Array.from({ length: 2000 }, (_, i) => eventRow(i));
  const blobs = memoryBlobs({ failAfterWrites: 2 });
  const blobStore = createEmailEventBlobStore({ setBlob: blobs.setBlob, hashFn: sha });
  await assert.rejects(() => backfillEmailEvents({
    fetchPage: pager(rows), writeBatch: (i) => blobStore.writeBatch(i), toEvent,
    batchSize: 500, receivedAtMs: AT, clock,
  }), /blobs boom/);
});

test('【partial backfill】途中で止めた集合は reconciliation が missing を検出して切替不可にする', async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => deliveryRow(i));
  const redis = memoryRedis();
  const store = createDeliveryKeyStore({ redisCmd: redis.cmd });
  // 先頭 300 件だけ入れる
  await backfillDeliveryKeys({
    fetchPage: pager(rows.slice(0, 300)),
    sadd: (s, k) => store.markDelivered({ ...s, keys: k }), scopeOf, keyOf, clock,
  });
  const recon = reconcileDeliveryKeys({
    airtableKeys: new Set(rows.map(keyOf)),
    redisKeys: await store.members(SCOPE),
  });
  assert.equal(recon.missingInRedis, 700);
  assert.equal(recon.safeToSwitch, false, '欠けているのに切替可になっている');
});

test('鍵が読めない行は黙って捨てず skipped として数える', async () => {
  const rows = [deliveryRow(1), { id: 'recX', fields: {} }, deliveryRow(2)];
  const redis = memoryRedis();
  const store = createDeliveryKeyStore({ redisCmd: redis.cmd });
  const r = await backfillDeliveryKeys({
    fetchPage: pager(rows), sadd: (s, k) => store.markDelivered({ ...s, keys: k }), scopeOf, keyOf, clock,
  });
  assert.equal(r.read, 3);
  assert.equal(r.written, 2);
  assert.equal(r.skipped, 1);
});

// ── PII ────────────────────────────────────────────────────────
test('【PII】Blob へ生アドレスを書かない（backfill 経由でも）', async () => {
  const rows = [{
    id: 'recE',
    fields: {
      EventKey: 'sg:1', EventType: 'bounce', EventAt: new Date(AT).toISOString(),
      CampaignId: 'c', CampaignVersion: 1,
      ReasonText: '550 user unknown leaked@example.com',
    },
  }];
  const blobs = memoryBlobs();
  const blobStore = createEmailEventBlobStore({ setBlob: blobs.setBlob, hashFn: sha });
  await backfillEmailEvents({
    fetchPage: pager(rows),
    writeBatch: (i) => blobStore.writeBatch(i),
    toEvent: (r) => ({
      eventKey: r.fields.EventKey, eventType: r.fields.EventType,
      eventAtMs: Date.parse(r.fields.EventAt),
      campaignId: r.fields.CampaignId, campaignVersion: r.fields.CampaignVersion,
      reasonText: r.fields.ReasonText,
    }),
    batchSize: 10, receivedAtMs: AT, clock,
  });
  const body = [...blobs.store.values()].join('\n');
  assert.doesNotMatch(body, /leaked@example\.com/, '生アドレスが blob に入っている');
  assert.match(body, /\[addr\]/);
});
