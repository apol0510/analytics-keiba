/**
 * 元々の会員の週次 list を段階ごとに進める（`nativeWeeklyRunner.js`）。依存はすべて偽物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runNativeWeeklyStep } from './nativeWeeklyRunner.js';
import { NATIVE_STATUS, nativeListName, BUILD_LEAD_MS, SCHEDULE_DEADLINE_MS } from './nativeWeeklySync.js';
import { ONBOARDING_CAMPAIGN_ID } from './nativeWeeklyAudience.js';
import { getCampaign } from './campaignCatalog.js';
import { indexDeliveries } from './sequenceProgress.js';

const SLOT_ISO = '2026-09-30T10:00:00.000Z';
const SLOT = Date.parse(SLOT_ISO);
const slot = { dateKey: '2026-09-30', sendAt: SLOT_ISO };
const CAMPAIGN = getCampaign(ONBOARDING_CAMPAIGN_ID, { includeDisabled: true });
const OLD = new Date(SLOT - 400 * 86400000).toISOString();
const customers = [1, 2, 3].map((n) => ({ id: `rec${String(n).padStart(14, '0')}`, createdTime: OLD, fields: { Email: `m${n}@example.jp`, Status: 'active' } }));

function world({ inputsError = null, listCountAfter = 3, jobStatus = 'completed', existingList = false, upsertError = null } = {}) {
  const store = new Map();
  const lists = existingList ? [{ id: 'OLD', name: nativeListName('2026-09-30'), contactCount: 7 }] : [];
  const calls = [];
  const sg = {
    async listLists() { calls.push('listLists'); return lists.map((l) => ({ ...l })); },
    async createList(name) { calls.push('createList'); const id = `L${lists.length + 1}`; lists.push({ id, name, contactCount: 0 }); return id; },
    async deleteList(id) { calls.push(`deleteList:${id}`); const i = lists.findIndex((l) => l.id === id); if (i >= 0) lists.splice(i, 1); },
    async upsertToList({ emails }) { calls.push('upsert'); if (upsertError) throw upsertError; return { jobIds: ['job1'], accepted: emails.length, rejected: 0 }; },
    async getImportStatus() { calls.push('import'); return { status: jobStatus }; },
    async getListCount() { calls.push('count'); return listCountAfter; },
  };
  const deps = {
    redis: async () => null,
    readState: async (_r, k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
    writeState: async (_r, k, v) => { store.set(k, JSON.stringify(v)); },
    sendgrid: () => sg,
    loadInputs: async () => {
      if (inputsError) throw inputsError;
      return {
        customers, blacklistHard: new Set(), blacklistSoft: new Set(), providerSuppressed: new Set(),
        onboarding: { campaign: CAMPAIGN, deliveredIndex: indexDeliveries([]), brand: 'analytics-keiba', fromEmail: 'noreply@keiba.link', withinDays: 14 },
        engagedEmails: new Set(),
      };
    },
    referencedListIds: async () => new Set(),
  };
  return { deps, store, calls, lists };
}

const run = (w, nowMs) => runNativeWeeklyStep({ slot, nowMs, deps: w.deps });

test('枠の 12 時間より前は何もしない（Single Send も作らない）', async () => {
  const w = world();
  const r = await run(w, SLOT - BUILD_LEAD_MS - 60e3);
  assert.equal(r.defer, true);
  assert.equal(w.calls.length, 0);
});

test('作る → 確認 → ready で native を足す（通しの流れ）', async () => {
  const w = world();
  const b = await run(w, SLOT - 11 * 3600e3);
  assert.equal(b.defer, true);
  assert.equal(b.summary.reason, 'importing');
  assert.equal(b.summary.expected, 3);
  const st = JSON.parse(w.store.get('2026-09-30'));
  assert.equal(st.status, NATIVE_STATUS.IMPORTING);
  assert.ok(!JSON.stringify(st).includes('@'), '状態にアドレスを残さない');

  const c = await run(w, SLOT - 10 * 3600e3);
  assert.equal(c.defer, false);
  assert.equal(c.ready, true);
  assert.equal(c.listId, st.listId);
  // 次の実行でも ready のまま（予約は呼び出し側）
  const again = await run(w, SLOT - 9 * 3600e3);
  assert.equal(again.ready, true);
});

test('人数が一致しなければ待つ。締め切りを過ぎたら native を足さない', async () => {
  const w = world({ listCountAfter: 2 });
  await run(w, SLOT - 11 * 3600e3);
  const c = await run(w, SLOT - 10 * 3600e3);
  assert.equal(c.defer, true);
  assert.equal(c.summary.reason, 'count_mismatch');
  const d = await run(w, SLOT - SCHEDULE_DEADLINE_MS);
  assert.equal(d.defer, false);
  assert.equal(d.ready, false);
  assert.equal(JSON.parse(w.store.get('2026-09-30')).status, NATIVE_STATUS.FAILED);
});

test('upsert job が失敗なら native を足さない', async () => {
  const w = world({ jobStatus: 'failed' });
  await run(w, SLOT - 11 * 3600e3);
  const c = await run(w, SLOT - 10 * 3600e3);
  assert.equal(c.defer, false);
  assert.equal(c.ready, false);
});

test('判定材料が読めない・upsert が失敗 → native を足さない（例外を外へ出さない）', async () => {
  for (const w of [world({ inputsError: new Error('airtable_down') }), world({ upsertError: Object.assign(new Error('x'), { code: 'sendgrid_429' }) })]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await run(w, SLOT - 11 * 3600e3);
    assert.equal(r.defer, false);
    assert.equal(r.ready, false);
  }
});

test('Redis が無ければ native を足さない（状態を持てないまま進めない）', async () => {
  const w = world();
  w.deps.redis = null;
  const r = await run(w, SLOT - 11 * 3600e3);
  assert.deepEqual([r.defer, r.ready], [false, false]);
  assert.equal(w.calls.length, 0);
});

test('冪等: 状態の無い同名 list（途中で止まった残り）は作り直す', async () => {
  const w = world({ existingList: true });
  await run(w, SLOT - 11 * 3600e3);
  assert.ok(w.calls.includes('deleteList:OLD'));
  assert.equal(w.lists.filter((l) => l.name === nativeListName('2026-09-30')).length, 1);
});

test('冪等: 予約済みの枠では何もしない（状態が scheduled）', async () => {
  const w = world();
  w.store.set('2026-09-30', JSON.stringify({ status: NATIVE_STATUS.SCHEDULED }));
  const r = await run(w, SLOT - 5 * 3600e3);
  // Single Send が無いのに scheduled なら食い違い → native を足さずに作らせる
  assert.deepEqual([r.defer, r.ready], [false, false]);
  assert.equal(w.calls.length, 0);
});

test('要約にアドレスを出さない', async () => {
  const w = world();
  const r = await run(w, SLOT - 11 * 3600e3);
  assert.ok(!JSON.stringify(r).includes('@'));
});
