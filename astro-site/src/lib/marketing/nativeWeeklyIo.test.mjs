/**
 * 元々の会員の週次 I/O（`nativeWeeklyIo.js`）の制限を固定する。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createNativeSendgrid, createNativeRedis, loadEngagedEmails, loadNativeCustomers,
  writeNativeState, NativeWeeklyIoError,
} from './nativeWeeklyIo.js';
import { emailHash, PROSPECT_ROOT } from './prospectStore.js';
import { nativeListName } from './nativeWeeklySync.js';

function fakeSg({ upsertStatus = () => 202 } = {}) {
  const calls = [];
  const lists = [{ id: 'N1', name: nativeListName('2026-09-30'), contact_count: 0 }, { id: 'E1', name: 'ak-drm-engaged', contact_count: 808 }];
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const u = new URL(url);
    calls.push(`${method} ${u.pathname}${u.search}`);
    const res = (status, body) => ({ ok: status < 400, status, text: async () => (body ? JSON.stringify(body) : '') });
    if (method === 'GET' && u.pathname === '/v3/marketing/lists') return res(200, { result: lists, _metadata: {} });
    if (method === 'POST' && u.pathname === '/v3/marketing/lists') { const b = JSON.parse(init.body); lists.push({ id: 'N2', name: b.name }); return res(201, { id: 'N2' }); }
    if (method === 'PUT' && u.pathname === '/v3/marketing/contacts') {
      const b = JSON.parse(init.body);
      n += 1;
      return res(upsertStatus(b), { job_id: `job-${n}` });
    }
    if (method === 'GET' && /\/v3\/marketing\/contacts\/imports\//.test(u.pathname)) return res(200, { status: 'completed' });
    if (method === 'GET' && /\/contacts\/count$/.test(u.pathname)) return res(200, { contact_count: 3 });
    if (method === 'DELETE') return res(204, null);
    return res(404, {});
  };
  return { fetchImpl, calls };
}

test('SendGrid: native でない名前の list は作らない', async () => {
  const sg = createNativeSendgrid({ apiKey: 'fake-key-for-tests', fetchImpl: fakeSg().fetchImpl });
  await assert.rejects(sg.createList('ak-drm-engaged'), { message: 'native_weekly:list_name_not_native' });
});

test('SendGrid: native でない list へは upsert・人数読み取り・削除をしない', async () => {
  const f = fakeSg();
  const sg = createNativeSendgrid({ apiKey: 'fake-key-for-tests', fetchImpl: f.fetchImpl });
  await sg.listLists();
  for (const p of [sg.upsertToList({ listId: 'E1', emails: ['a@example.jp'] }), sg.getListCount('E1'), sg.deleteList('E1')]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(p, { message: 'native_weekly:list_not_native' });
  }
  assert.ok(!f.calls.some((c) => c.startsWith('PUT') || c.startsWith('DELETE')), f.calls.join(','));
});

test('SendGrid: upsert は native list だけを list_ids に載せる・削除は contact を消さない', async () => {
  const f = fakeSg();
  const sg = createNativeSendgrid({ apiKey: 'fake-key-for-tests', fetchImpl: f.fetchImpl });
  await sg.listLists();
  const r = await sg.upsertToList({ listId: 'N1', emails: ['a@example.jp', 'b@example.jp'] });
  assert.deepEqual([r.accepted, r.rejected, r.jobIds.length], [2, 0, 1]);
  await sg.deleteList('N1');
  assert.ok(f.calls.includes('DELETE /v3/marketing/lists/N1?delete_contacts=false'), f.calls.join(','));
});

test('SendGrid: 400 のときだけ割って壊れたアドレスを弾く', async () => {
  const f = fakeSg({ upsertStatus: (b) => (b.contacts.some((c) => c.email === 'bad') ? 400 : 202) });
  const sg = createNativeSendgrid({ apiKey: 'fake-key-for-tests', fetchImpl: f.fetchImpl });
  await sg.listLists();
  const r = await sg.upsertToList({ listId: 'N1', emails: ['a@example.jp', 'bad', 'c@example.jp', 'd@example.jp'] });
  assert.deepEqual([r.accepted, r.rejected], [3, 1]);
});

test('SendGrid: 429 / 5xx は割らずに中止（人を黙って落とさない）', async () => {
  for (const status of [429, 500, 503]) {
    const f = fakeSg({ upsertStatus: () => status });
    const sg = createNativeSendgrid({ apiKey: 'fake-key-for-tests', fetchImpl: f.fetchImpl });
    // eslint-disable-next-line no-await-in-loop
    await sg.listLists();
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(sg.upsertToList({ listId: 'N1', emails: ['a@example.jp', 'b@example.jp'] }), NativeWeeklyIoError);
    assert.equal(f.calls.filter((c) => c.startsWith('PUT')).length, 1, String(status));
  }
});

test('Redis: 読み取り（native 状態・見込み客レコード）と native 状態の SET だけ', async () => {
  const seen = [];
  const r = createNativeRedis(async (args) => { seen.push(args[0]); return null; });
  await r(['GET', 'ak:native-weekly:v1:latest']);
  await r(['MGET', `${PROSPECT_ROOT}p:abc`, `${PROSPECT_ROOT}p:def`]);
  await r(['SET', 'ak:native-weekly:v1:slot:2026-09-30', '{}', 'EX', '10']);
  for (const bad of [['SET', `${PROSPECT_ROOT}p:abc`, 'x'], ['DEL', 'ak:native-weekly:v1:latest'], ['GET', 'ak:marketing:engagement-blocked:v1'], ['SADD', 'x', 'y'], ['MGET', 'ak:native-weekly:v1:x', 'other:key']]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(r(bad), { message: 'native_weekly:redis_command_forbidden' }, JSON.stringify(bad));
  }
  assert.deepEqual(seen, ['GET', 'MGET', 'SET']);
});

test('反応済み: ENGAGED / PROMOTED の見込み客だけを ak-drm-engaged 側とみなす', async () => {
  const recs = {
    [`${PROSPECT_ROOT}p:${emailHash('a@example.jp')}`]: JSON.stringify({ state: 'ENGAGED' }),
    [`${PROSPECT_ROOT}p:${emailHash('b@example.jp')}`]: JSON.stringify({ state: 'SUPPRESSED' }),
    [`${PROSPECT_ROOT}p:${emailHash('c@example.jp')}`]: JSON.stringify({ state: 'PROMOTED' }),
  };
  const redis = createNativeRedis(async (args) => args.slice(1).map((k) => recs[k] ?? null));
  const s = await loadEngagedEmails({ redis, emails: ['a@example.jp', 'b@example.jp', 'c@example.jp', 'd@example.jp'] });
  assert.deepEqual([...s].sort(), ['a@example.jp', 'c@example.jp']);
  await assert.rejects(loadEngagedEmails({ redis: null, emails: ['a@example.jp'] }));
});

test('Airtable: GET だけ・上限で黙って打ち切らない', async () => {
  const methods = [];
  let page = 0;
  const fetchImpl = async (url, init = {}) => {
    methods.push(String(init.method || 'GET'));
    page += 1;
    return { ok: true, json: async () => ({ records: [{ id: `r${page}`, fields: {} }], offset: 'more' }) };
  };
  await assert.rejects(loadNativeCustomers({ fetchImpl, KEY: 'k', BASE: 'b' }), { message: /scan_limit/ });
  assert.ok(methods.every((m) => m === 'GET'));
});

test('状態にアドレスを保存しない', async () => {
  const redis = createNativeRedis(async () => 'OK');
  await assert.rejects(writeNativeState(redis, '2026-09-30', { note: 'a@example.jp' }), { message: 'native_weekly:state_contains_address' });
  await writeNativeState(redis, '2026-09-30', { status: 'importing', expected: 3 });
});

test('I/O モジュールはメール送信 API・contact 検索・全体停止に触れない', () => {
  const src = readFileSync(new URL('./nativeWeeklyIo.js', import.meta.url), 'utf8');
  for (const banned of ['/v3/mail/send', 'contacts/search', '/v3/asm/', '/singlesends', "'DEL'", 'delete_contacts=true']) {
    assert.ok(!src.includes(banned), banned);
  }
});
