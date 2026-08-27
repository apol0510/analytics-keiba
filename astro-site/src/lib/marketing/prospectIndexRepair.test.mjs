/**
 * prospectIndexRepair.test.mjs — **名指しした 1 件の索引だけ**を直す
 *   node --test src/lib/marketing/prospectIndexRepair.test.mjs
 *
 * 守る条件:
 *   1. 必要なときしか書かない（既に正しければ **0 コマンド**）
 *   2. レコードは触らない（`SET` を出さない）
 *   3. 保存済みレコードが無い / 抑止台帳に載っている hash には**何もしない**
 *   4. 既定は下見（`apply` と確認文字列が揃わなければ 1 バイトも書かない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createProspectStore, emailHash, prospectKey, blockedKey,
  ACTIVE_INDEX, ENGAGED_INDEX,
} from './prospectStore.js';
import { buildProspect, PROSPECT_STATE } from './prospectPolicy.js';

const NOW = Date.UTC(2026, 7, 27);
const BATCH = 'imp-2026-08-09-001';

function fakeRedis() {
  const kv = new Map(); const sets = new Map(); const commands = [];
  const setOf = (k) => { if (!sets.has(k)) sets.set(k, new Set()); return sets.get(k); };
  const cmd = async (args) => {
    commands.push(args);
    const [op, key, ...rest] = args;
    if (op === 'GET') return kv.has(key) ? kv.get(key) : null;
    if (op === 'SET') { kv.set(key, rest[0]); return 'OK'; }
    if (op === 'EXISTS') return kv.has(key) ? 1 : 0;
    if (op === 'MGET') return [key, ...rest].map((k) => (kv.has(k) ? kv.get(k) : null));
    if (op === 'SADD') { const s = setOf(key); let n = 0; for (const m of rest) if (!s.has(m)) { s.add(m); n += 1; } return n; }
    if (op === 'SREM') { const s = setOf(key); let n = 0; for (const m of rest) if (s.delete(m)) n += 1; return n; }
    if (op === 'SMEMBERS') return [...setOf(key)];
    if (op === 'SCARD') return setOf(key).size;
    if (op === 'SISMEMBER') return setOf(key).has(rest[0]) ? 1 : 0;
    throw new Error(`unsupported ${op}`);
  };
  return { kv, sets, commands, cmd, setOf, active: () => setOf(ACTIVE_INDEX), engaged: () => setOf(ENGAGED_INDEX) };
}

const mk = (email, over = {}) => ({
  ...buildProspect({ email, nowMs: NOW, batchId: BATCH, source: 'csv' }), ...over,
});
/** 事故の再現: レコードだけあって索引に居ない */
function orphan(r, email, over = {}) {
  const p = mk(email, { state: PROSPECT_STATE.SENDING, sends: 2, delivered: 2, ...over });
  const hash = emailHash(email);
  r.kv.set(prospectKey(hash), JSON.stringify(p));
  return hash;
}
const writes = (r) => r.commands.filter((c) => ['SET', 'SADD', 'SREM'].includes(c[0]));

/* ── 1. 本番の 1 件を直す ─────────────────────────────────── */

test('【要件】state=SENDING で active に居ない 1 件を、SADD 1 回だけで直す', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd });
  const hash = orphan(r, 'missing@example.com');
  r.commands.length = 0;

  const res = await store.reindexByHash([hash], { apply: true });

  assert.equal(res.checked, 1);
  assert.equal(res.applied, 1);
  assert.deepEqual(res.planned[0].changes, ['SADD'], '⚠️ SADD 以外の書き込みが混ざっている');
  assert.equal(res.planned[0].state, PROSPECT_STATE.SENDING);
  assert.equal(res.planned[0].isActive, false);
  assert.equal(r.active().has(hash), true);

  const w = writes(r);
  assert.equal(w.length, 1, `⚠️ 書き込みが ${w.length} 回（SADD 1 回だけのはず）`);
  assert.deepEqual(w[0], ['SADD', ACTIVE_INDEX, hash]);
});

test('⚠️【要件】下見では 1 バイトも書かない', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd });
  const hash = orphan(r, 'dry@example.com');
  r.commands.length = 0;

  const res = await store.reindexByHash([hash]);          // apply 無し
  assert.equal(res.applied, 0);
  assert.deepEqual(res.planned[0].changes, ['SADD'], '直す予定は見せる');
  assert.deepEqual(writes(r), [], '⚠️ 下見なのに書いている');
  assert.equal(r.active().has(hash), false);
});

test('既に正しければ 1 コマンドも出さない（冪等）', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd });
  const hash = orphan(r, 'ok@example.com');
  r.active().add(hash);
  r.commands.length = 0;

  const res = await store.reindexByHash([hash], { apply: true });
  assert.equal(res.applied, 0);
  assert.deepEqual(res.planned[0].changes, []);
  assert.deepEqual(writes(r), [], '⚠️ 直す必要が無いのに書いている');
});

test('⚠️ 2 回続けて実行しても 2 回目は何も書かない（再実行が安全）', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd });
  const hash = orphan(r, 'twice@example.com');
  await store.reindexByHash([hash], { apply: true });
  r.commands.length = 0;
  const again = await store.reindexByHash([hash], { apply: true });
  assert.equal(again.applied, 0);
  assert.deepEqual(writes(r), []);
});

/* ── 2. レコードは触らない ────────────────────────────────── */

test('⚠️【要件】レコードへ SET を 1 回も出さない', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd });
  const hash = orphan(r, 'norec@example.com');
  const before = r.kv.get(prospectKey(hash));
  r.commands.length = 0;

  await store.reindexByHash([hash], { apply: true });

  assert.equal(r.commands.some((c) => c[0] === 'SET'), false, '⚠️ レコードを書いている');
  assert.equal(r.kv.get(prospectKey(hash)), before, '⚠️ レコードが変わった');
});

/* ── 3. 触ってはいけない相手 ─────────────────────────────── */

test('⚠️【要件】保存済みレコードが無い hash には何もしない（居ない人を作らない）', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd });
  const ghost = emailHash('ghost@example.com');
  r.commands.length = 0;

  const res = await store.reindexByHash([ghost], { apply: true });
  assert.equal(res.applied, 0);
  assert.deepEqual(res.skipped, [{ hash: ghost, reason: 'no_record' }]);
  assert.deepEqual(writes(r), [], '⚠️ レコードが無いのに索引へ入れた');
  assert.equal(r.active().has(ghost), false);
});

test('⚠️【要件】抑止台帳に載っている相手には何もしない（復活させない）', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd });
  const hash = orphan(r, 'blocked@example.com');
  r.kv.set(blockedKey(hash), JSON.stringify({ hash, kind: 'suppressed' }));
  r.commands.length = 0;

  const res = await store.reindexByHash([hash], { apply: true });
  assert.equal(res.applied, 0);
  assert.deepEqual(res.skipped, [{ hash, reason: 'blocked' }]);
  assert.deepEqual(writes(r), [], '⚠️ 抑止済みを索引へ入れた');
});

test('⚠️ 送信を止めた state なら active から外す（誤って候補に残っている場合）', async () => {
  for (const state of [PROSPECT_STATE.EXHAUSTED, PROSPECT_STATE.SUPPRESSED, PROSPECT_STATE.PROMOTED]) {
    const r = fakeRedis();
    const store = createProspectStore({ cmd: r.cmd });
    const hash = orphan(r, `s-${state}@example.com`, { state });
    r.active().add(hash);
    // eslint-disable-next-line no-await-in-loop
    const res = await store.reindexByHash([hash], { apply: true });
    assert.deepEqual(res.planned[0].changes, ['SREM']);
    assert.equal(r.active().has(hash), false);
  }
});

test('壊れた hash は無視する（例外にしない）', async () => {
  const r = fakeRedis();
  const store = createProspectStore({ cmd: r.cmd });
  const res = await store.reindexByHash(['zz', '', null, 'someone@example.com'], { apply: true });
  assert.equal(res.checked, 0);
  assert.equal(res.applied, 0);
  assert.deepEqual(writes(r), []);
});

/* ── 4. guard: Function 側 ────────────────────────────────── */

const adminSrc = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing.js', import.meta.url),
), 'utf8');
const handlerSrc = adminSrc.slice(
  adminSrc.indexOf('async function handleProspectIndexRepair'),
  adminSrc.indexOf('async function handleProspectIndexAudit'),
);

test('⚠️ guard: 修復は 確認文字列 ＋ apply が揃ったときだけ書く（既定は下見）', () => {
  assert.ok(handlerSrc.length > 200, 'handler が見つからない');
  assert.match(adminSrc, /action === 'prospectIndexRepair'/);
  assert.match(handlerSrc, /const apply = req\.apply === true && confirmed;/,
    '⚠️ 確認文字列なしで書けてしまう');
  assert.match(handlerSrc, /INDEX_REPAIR_MAX/, '⚠️ 件数の上限が無い');
});

test('⚠️ guard: 修復は索引以外を触らない（レコード・送信・Customers）', () => {
  for (const banned of [
    'addIfAbsent', 'addManyIfAbsent', 'recordSend', 'recordDelivered', 'recordEngagement',
    'purge', 'markDelivered', 'claimDelivered', 'sendgrid', 'airtable', 'enqueue',
  ]) {
    assert.equal(handlerSrc.includes(banned), false, `⚠️ 索引以外を触っている: ${banned}`);
  }
  assert.match(handlerSrc, /customersDeleted: 0/);
});
