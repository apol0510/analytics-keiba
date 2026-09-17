/**
 * sendgridMigrationE2E.test.mjs — **非本番相当の E2E**（seed のアドレスだけ）
 *
 * 本番へ 1 リクエストも出さずに、移行後の 1 周を通しで確かめる:
 *
 *   1. 既送信を引き継いで contact を投入する（**1 通目から送り直さない**）
 *   2. 同じ走査をもう一度やっても**二重に増えない**（upsert・冪等）
 *   3. 反応（open）した人は **list から外れる**（Automation から退出）
 *   4. bounce / 配信停止は即時除外になり、以後の投入対象に**戻らない**
 *   5. delivered 10 通・無反応で **EXHAUSTED**（打ち切り）になり、投入対象から外れる
 *   6. ゲートが閉じていれば **SendGrid へ 1 リクエストも出ない**
 *
 * ⚠️ 反応・打ち切りの判定は**既存の単一源**（`classifyEvent` /
 *    `prospectStore.recordDelivered`）をそのまま使う。移行のために作り直さない。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProspectStore, emailHash, ACTIVE_INDEX, prospectKey } from './prospectStore.js';
import { createDeliveryKeyStore } from './deliveryKeyStore.js';
import { PROSPECT_STATE, classifyEvent } from './prospectPolicy.js';
import { planProspectEventUpdates } from './prospectPipeline.js';
import { buildMessagePlan, buildMessageKeys } from './sendgridMessagePlan.js';
import { scanMigrationWindow, toExportEntries } from './sendgridMigrationScan.js';
import { buildContactUpserts, resolveFieldIds, CONTACT_FIELD_NAMES } from './sendgridContactExport.js';
import { buildExitPlan, listNameFor } from './sendgridAutomationPlan.js';
import {
  createSendGridMarketingApi, WRITE_CONFIRM, WRITE_GATE_ENV, SendGridApiError,
} from './sendgridMarketingApi.js';

const BRAND = 'analytics-keiba';
const FROM = 'support@keiba.link';
const PLAN = buildMessagePlan().plan;

/* ── メモリ Redis（走査に要る op だけ）────────────────────────── */
function createMemoryRedis() {
  const strings = new Map();
  const sets = new Map();
  const setOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
  const cmd = async (args) => {
    const op = String(args[0]).toUpperCase();
    if (op === 'GET') return strings.has(args[1]) ? strings.get(args[1]) : null;
    if (op === 'SET') { strings.set(args[1], String(args[2])); return 'OK'; }
    if (op === 'DEL') { strings.delete(args[1]); return 1; }
    if (op === 'EXISTS') return strings.has(args[1]) ? 1 : 0;
    if (op === 'MGET') return args.slice(1).map((k) => (strings.has(k) ? strings.get(k) : null));
    if (op === 'SADD') { const s = setOf(args[1]); const b = s.size; args.slice(2).forEach((m) => s.add(String(m))); return s.size - b; }
    if (op === 'SREM') { const s = setOf(args[1]); let n = 0; args.slice(2).forEach((m) => { if (s.delete(String(m))) n += 1; }); return n; }
    if (op === 'SMEMBERS') return [...setOf(args[1])];
    if (op === 'SCARD') return setOf(args[1]).size;
    if (op === 'SISMEMBER') return setOf(args[1]).has(String(args[2])) ? 1 : 0;
    if (op === 'SMISMEMBER') { const s = setOf(args[1]); return args.slice(2).map((m) => (s.has(String(m)) ? 1 : 0)); }
    throw new Error(`unsupported_op:${op}`);
  };
  return { cmd, strings, sets, setOf };
}

/* ── 偽 SendGrid（Marketing Campaigns の一部だけ）───────────────── */
function createFakeSendGrid() {
  const lists = new Map(); // id → {name, members:Set<email>}
  const contacts = new Map(); // email → {id, custom_fields}
  const requests = [];
  for (let n = 1; n <= 10; n += 1) lists.set(`list-${n}`, { name: listNameFor(n), members: new Set() });

  const fetchImpl = async (url, init) => {
    const path = String(url).replace('https://api.sendgrid.com', '');
    const method = (init && init.method) || 'GET';
    requests.push(`${method} ${path.split('?')[0]}`);
    const body = init && init.body ? JSON.parse(init.body) : null;
    const res = (status, payload) => ({ status, json: async () => payload });

    if (method === 'GET' && path.startsWith('/v3/marketing/field_definitions')) {
      return res(200, { custom_fields: CONTACT_FIELD_NAMES.map((name, i) => ({ id: `f${i + 1}`, name })) });
    }
    if (method === 'GET' && path.startsWith('/v3/marketing/lists')) {
      return res(200, {
        result: [...lists.entries()].map(([id, l]) => ({ id, name: l.name, contact_count: l.members.size })),
        _metadata: {},
      });
    }
    if (method === 'PUT' && path === '/v3/marketing/contacts') {
      for (const c of body.contacts) {
        const email = String(c.email).toLowerCase();
        if (!contacts.has(email)) contacts.set(email, { id: `c-${contacts.size + 1}`, custom_fields: {} });
        contacts.get(email).custom_fields = c.custom_fields;
        for (const id of body.list_ids) lists.get(id).members.add(email);
      }
      return res(202, { job_id: `job-${requests.length}` });
    }
    if (method === 'POST' && path === '/v3/marketing/contacts/search/emails') {
      const result = {};
      for (const e of body.emails) {
        const email = String(e).toLowerCase();
        if (contacts.has(email)) result[email] = { contact: { id: contacts.get(email).id } };
      }
      return res(200, { result });
    }
    if (method === 'DELETE' && path.startsWith('/v3/marketing/lists/')) {
      const listId = path.split('/')[4];
      const ids = new Set(decodeURIComponent(String(url).split('contact_ids=')[1] || '').split(','));
      const list = lists.get(listId);
      for (const [email, c] of contacts) if (ids.has(c.id)) list.members.delete(email);
      return res(202, {});
    }
    return res(404, {});
  };
  return { fetchImpl, lists, contacts, requests };
}

function seedProspect(redis, { email, state = PROSPECT_STATE.SENDING, delivered = 0, opens = 0 }) {
  const hash = emailHash(email);
  redis.strings.set(prospectKey(hash), JSON.stringify({ email, state, delivered, opens }));
  redis.setOf(ACTIVE_INDEX).add(hash);
  return hash;
}
function seedDelivered(redis, { email, upTo }) {
  const keys = buildMessageKeys({ plan: PLAN, email, brand: BRAND, fromEmail: FROM });
  for (const [n, key] of keys) {
    if (n > upTo) continue;
    const entry = PLAN.find((p) => p.messageNumber === n);
    redis.setOf(`ak:mkt:delivered:${BRAND}:${entry.campaignId}:v${entry.version}`).add(key);
  }
}

async function importOnce({ redis, sg, env }) {
  const api = createSendGridMarketingApi({ apiKey: 'seed-key', fetchImpl: sg.fetchImpl, env });
  const scan = await scanMigrationWindow({
    store: createProspectStore({ cmd: redis.cmd }),
    deliveryKeyStore: createDeliveryKeyStore({ redisCmd: redis.cmd }),
    brand: BRAND, fromEmail: FROM, limit: 100,
  });
  assert.equal(scan.ok, true);
  const fields = resolveFieldIds(await api.getFieldDefinitions());
  const listIds = new Map((await api.getLists()).map((l) => [
    Number(String(l.name).replace(listNameFor(''), '')), l.id,
  ]));
  const built = buildContactUpserts({
    entries: toExportEntries(scan.results),
    fieldIds: fields.ids,
    listIdByMessage: listIds,
    migratedAt: '2026-09-18T00:00:00.000Z',
  });
  if (!built.ok) return { scan, built, sent: 0 };
  let sent = 0;
  for (const batch of built.batches) {
    // eslint-disable-next-line no-await-in-loop -- テスト
    const r = await api.upsertContacts({ batch, confirm: WRITE_CONFIRM });
    sent += r.count;
  }
  return { scan, built, sent };
}

test('E2E: 既送信を引き継いで投入し、二度やっても増えない', async () => {
  const env = { [WRITE_GATE_ENV]: 'true' };
  const redis = createMemoryRedis();
  const sg = createFakeSendGrid();

  seedProspect(redis, { email: 'fresh@example.test' });
  seedProspect(redis, { email: 'three@example.test', delivered: 3 });
  seedDelivered(redis, { email: 'three@example.test', upTo: 3 });

  const first = await importOnce({ redis, sg, env });
  assert.equal(first.sent, 2);
  assert.equal(sg.lists.get('list-1').members.has('fresh@example.test'), true);
  assert.equal(sg.lists.get('list-4').members.has('three@example.test'), true, '4 通目始まりへ入る');
  assert.equal(sg.lists.get('list-1').members.has('three@example.test'), false, '1 通目から送り直さない');

  const second = await importOnce({ redis, sg, env });
  assert.equal(second.sent, 2, '同じ 2 件を upsert するだけ');
  assert.equal(sg.contacts.size, 2, 'contact は増えない');
  assert.equal(sg.lists.get('list-4').members.size, 1);
});

test('E2E: ゲートが閉じていれば SendGrid へ 1 リクエストも出ない', async () => {
  const sg = createFakeSendGrid();
  const api = createSendGridMarketingApi({ apiKey: 'seed-key', fetchImpl: sg.fetchImpl, env: {} });
  await assert.rejects(
    () => api.upsertContacts({
      batch: { list_ids: ['list-1'], contacts: [{ email: 'a@example.test' }] },
      confirm: WRITE_CONFIRM,
    }),
    (e) => e instanceof SendGridApiError && e.reason === 'write_gate_closed',
  );
  await assert.rejects(
    () => api.createList({ name: 'x', confirm: 'wrong' }),
    (e) => e.reason === 'write_gate_closed',
  );
  assert.equal(sg.requests.length, 0, '1 リクエストも出していない');
});

test('E2E: 合言葉が違えば書かない', async () => {
  const sg = createFakeSendGrid();
  const api = createSendGridMarketingApi({
    apiKey: 'seed-key', fetchImpl: sg.fetchImpl, env: { [WRITE_GATE_ENV]: 'true' },
  });
  await assert.rejects(
    () => api.upsertContacts({
      batch: { list_ids: ['list-1'], contacts: [{ email: 'a@example.test' }] }, confirm: 'nope',
    }),
    (e) => e.reason === 'confirm_mismatch',
  );
  assert.equal(sg.requests.length, 0);
});

test('E2E: 開封したら Automation から退出し、次の投入対象にも戻らない', async () => {
  const env = { [WRITE_GATE_ENV]: 'true' };
  const redis = createMemoryRedis();
  const sg = createFakeSendGrid();
  seedProspect(redis, { email: 'opener@example.test', delivered: 2 });
  seedDelivered(redis, { email: 'opener@example.test', upTo: 2 });
  await importOnce({ redis, sg, env });
  assert.equal(sg.lists.get('list-3').members.has('opener@example.test'), true);

  // ── SendGrid の open イベント → 既存の単一源で ENGAGED にする
  const store = createProspectStore({ cmd: redis.cmd });
  const { updates } = planProspectEventUpdates({
    events: [{ email: 'opener@example.test', event: 'open' }], classify: classifyEvent,
  });
  for (const u of updates) await store.recordEngagement({ email: u.email, nowMs: Date.now(), kind: u.kind });
  const after = await store.load('opener@example.test');
  assert.equal(after.state, PROSPECT_STATE.ENGAGED);

  // ── 退出（list から外す）
  const api = createSendGridMarketingApi({ apiKey: 'seed-key', fetchImpl: sg.fetchImpl, env });
  const listIds = new Map((await api.getLists()).map((l) => [
    Number(String(l.name).replace(listNameFor(''), '')), l.id,
  ]));
  const exit = buildExitPlan({
    changes: [{ email: 'opener@example.test', state: PROSPECT_STATE.ENGAGED }],
    listIdByMessage: listIds,
  });
  const ids = await api.lookupContactIds(exit.removals.map((r) => r.email));
  for (const listId of exit.removals[0].listIds) {
    // eslint-disable-next-line no-await-in-loop -- テスト
    await api.removeContactsFromList({ listId, contactIds: [...ids.values()], confirm: WRITE_CONFIRM });
  }
  for (const [, list] of sg.lists) {
    assert.equal(list.members.has('opener@example.test'), false, '全 list から外れる');
  }

  // ── 次の走査では投入対象に戻らない（送信候補の索引から外れている）
  const again = await importOnce({ redis, sg, env });
  assert.equal(again.sent, 0);
  assert.equal(again.scan.window.indexSize, 0, '反応した人は送信候補に残らない');
});

test('E2E: bounce / 配信停止は即時除外で、投入対象に戻らない', async () => {
  const env = { [WRITE_GATE_ENV]: 'true' };
  const redis = createMemoryRedis();
  const sg = createFakeSendGrid();
  seedProspect(redis, { email: 'bounced@example.test' });
  seedProspect(redis, { email: 'unsub@example.test' });
  const store = createProspectStore({ cmd: redis.cmd });

  const { updates } = planProspectEventUpdates({
    events: [
      { email: 'bounced@example.test', event: 'bounce' },
      { email: 'unsub@example.test', event: 'group_unsubscribe' },
    ],
    classify: classifyEvent,
  });
  assert.equal(updates.length, 2);
  for (const u of updates) {
    assert.equal(u.action, 'suppress');
    // eslint-disable-next-line no-await-in-loop -- テスト
    await store.recordSuppression({ email: u.email, nowMs: Date.now(), reason: u.reason });
  }
  const out = await importOnce({ redis, sg, env });
  assert.equal(out.sent, 0);
  assert.equal(out.scan.window.indexSize, 0, '除外された人は送信候補に残らない');
  assert.equal(sg.contacts.size, 0);
});

test('E2E: delivered 10 通・無反応で打ち切られ、投入対象から外れる', async () => {
  const env = { [WRITE_GATE_ENV]: 'true' };
  const redis = createMemoryRedis();
  const sg = createFakeSendGrid();
  seedProspect(redis, { email: 'silent@example.test', delivered: 9 });
  seedDelivered(redis, { email: 'silent@example.test', upTo: 9 });
  const store = createProspectStore({ cmd: redis.cmd });

  const before = await importOnce({ redis, sg, env });
  assert.equal(before.sent, 1, '10 通目はまだ送れる');
  assert.equal(sg.lists.get('list-10').members.has('silent@example.test'), true);

  // 10 通目が delivered → 打ち切り（既存の単一源が判定する）
  const d = await store.recordDelivered({ email: 'silent@example.test', nowMs: Date.now(), env: {} });
  assert.equal(d.prospect.state, PROSPECT_STATE.EXHAUSTED);

  const after = await importOnce({ redis, sg, env });
  assert.equal(after.sent, 0);
  assert.equal(after.built.ok, false, '出す相手が 1 人も居ない');
});
