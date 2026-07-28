/**
 * purchaseAnchorLookup.test.mjs — 購入確定日時の取得層（I/O）の fail closed 検証
 *   node --test src/lib/premiumPlus/purchaseAnchorLookup.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lookupSanrenpukuPaidAt, clearAnchorCache, ANCHOR_CACHE_TTL_MS } from './purchaseAnchorLookup.js';

const jst = (y, m, d, h = 0) => Date.UTC(y, m - 1, d, h) - 9 * 60 * 60 * 1000;
const ENV = { AIRTABLE_API_KEY: 'key-test', AIRTABLE_BASE_ID: 'app-test' };

const okFetch = (fields) => async () => ({ ok: true, json: async () => ({ fields }) });

test('Airtable に SanrenpukuPaidAt があればそれを使う', async () => {
  clearAnchorCache();
  const r = await lookupSanrenpukuPaidAt({
    recordId: 'rec1', env: ENV, now: 1000, fetchImpl: okFetch({ SanrenpukuPaidAt: '2026-07-01' }),
  });
  assert.equal(r.source, 'field');
  assert.equal(r.paidAtMs, jst(2026, 7, 1));
});

test('フィールドが無ければ env アンカーへフォールバック', async () => {
  clearAnchorCache();
  const r = await lookupSanrenpukuPaidAt({
    recordId: 'rec2',
    env: { ...ENV, PREMIUM_PLUS_FUNNEL_ANCHOR: '2026-06-01' },
    now: 1000,
    fetchImpl: okFetch({ PaidAt: '2020-01-01' }), // 馬単の入金日は使わない
  });
  assert.equal(r.source, 'anchor');
  assert.equal(r.paidAtMs, jst(2026, 6, 1));
});

test('fail closed: 鍵が無ければ通信せず null', async () => {
  clearAnchorCache();
  let called = false;
  const r = await lookupSanrenpukuPaidAt({
    recordId: 'rec3', env: {}, now: 1000,
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ fields: {} }) }; },
  });
  assert.equal(called, false);
  assert.deepEqual(r, { paidAtMs: null, source: 'none' });
});

test('fail closed: recordId 無し → 通信せず（env アンカーのみ）', async () => {
  clearAnchorCache();
  let called = false;
  const r = await lookupSanrenpukuPaidAt({
    recordId: null, env: { ...ENV, PREMIUM_PLUS_FUNNEL_ANCHOR: '2026-06-01' }, now: 1000,
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ fields: {} }) }; },
  });
  assert.equal(called, false);
  assert.equal(r.source, 'anchor');
});

test('fail closed: 通信失敗・404・JSON 破損はすべて例外を投げず null', async () => {
  const cases = [
    async () => { throw new Error('network'); },
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }),
    async () => ({ ok: true, json: async () => ({}) }),
  ];
  for (const fetchImpl of cases) {
    clearAnchorCache();
    const r = await lookupSanrenpukuPaidAt({ recordId: 'rec4', env: ENV, now: 1000, fetchImpl });
    assert.deepEqual(r, { paidAtMs: null, source: 'none' });
  }
});

test('キャッシュ: TTL 内は再取得しない / TTL 経過後は再取得する', async () => {
  clearAnchorCache();
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ fields: { SanrenpukuPaidAt: '2026-07-01' } }) }; };
  await lookupSanrenpukuPaidAt({ recordId: 'rec5', env: ENV, now: 1000, fetchImpl });
  await lookupSanrenpukuPaidAt({ recordId: 'rec5', env: ENV, now: 1000 + ANCHOR_CACHE_TTL_MS - 1, fetchImpl });
  assert.equal(calls, 1);
  await lookupSanrenpukuPaidAt({ recordId: 'rec5', env: ENV, now: 1000 + ANCHOR_CACHE_TTL_MS + 1, fetchImpl });
  assert.equal(calls, 2);
});

test('Airtable へ書き込みメソッドを使わない（GET のみ・fail closed の読取専用）', async () => {
  clearAnchorCache();
  let seenInit = null;
  await lookupSanrenpukuPaidAt({
    recordId: 'rec6', env: ENV, now: 1000,
    fetchImpl: async (_url, init) => { seenInit = init; return { ok: true, json: async () => ({ fields: {} }) }; },
  });
  assert.ok(!seenInit.method || seenInit.method.toUpperCase() === 'GET');
  assert.equal(seenInit.body, undefined);
});
